// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC5805} from "@openzeppelin/contracts/interfaces/IERC5805.sol";
import {IERC6372} from "@openzeppelin/contracts/interfaces/IERC6372.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {ClubRep} from "../src/ClubRep.sol";
import {IClubRep} from "../src/interfaces/IClubRep.sol";
import {AttendanceRegistry} from "../src/AttendanceRegistry.sol";
import {ClubBase} from "./helpers/ClubBase.sol";
import {ReferenceDecay} from "./helpers/ReferenceDecay.sol";

contract ClubRepTest is ClubBase {
    function _credit(address account, uint48 recognizedAt) private {
        vm.prank(address(registry));
        rep.credit(_list(account), recognizedAt);
    }

    function _creditNow(address account) private {
        _credit(account, uint48(block.timestamp));
    }

    function _assertClose(uint256 actual, uint256 expected) private pure {
        assertApproxEqAbs(actual, expected, 8 + expected / 1e15);
    }

    // ── Interface ───────────────────────────────────────────────────────────

    function test_clock_isTimestampMode() public view {
        assertEq(rep.clock(), uint48(block.timestamp));
        assertEq(rep.CLOCK_MODE(), "mode=timestamp");
    }

    function test_metadataAndInterfaces() public view {
        assertEq(rep.name(), "OCP Club Rep");
        assertEq(rep.symbol(), "REP");
        assertEq(rep.decimals(), 18);
        assertEq(rep.REP_PER_CHECKIN(), 10e18);
        assertEq(rep.HALF_LIFE(), HALF_LIFE);
        assertTrue(rep.supportsInterface(type(IVotes).interfaceId));
        assertTrue(rep.supportsInterface(type(IERC6372).interfaceId));
        assertTrue(rep.supportsInterface(type(IAccessControl).interfaceId));
        assertFalse(rep.supportsInterface(0xffffffff));
    }

    function test_abi_hasNoTransferOrApprovalSurface() public {
        _creditNow(alice);
        string[6] memory signatures = [
            "transfer(address,uint256)",
            "transferFrom(address,address,uint256)",
            "approve(address,uint256)",
            "allowance(address,address)",
            "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
            "burn(uint256)"
        ];
        for (uint256 i = 0; i < signatures.length; ++i) {
            vm.prank(alice);
            (bool ok,) = address(rep)
                .call(
                    abi.encodePacked(bytes4(keccak256(bytes(signatures[i]))), abi.encode(bob, uint256(1), uint256(1)))
                );
            assertFalse(ok, signatures[i]);
        }
        assertEq(rep.getVotes(alice), REP);
    }

    function test_delegation_isDisabled() public {
        assertEq(rep.delegates(alice), alice);
        vm.expectRevert(IClubRep.DelegationDisabled.selector);
        rep.delegate(bob);
        vm.expectRevert(IClubRep.DelegationDisabled.selector);
        rep.delegateBySig(bob, 0, block.timestamp, 27, bytes32(0), bytes32(0));
    }

    // ── Decay ───────────────────────────────────────────────────────────────

    function test_decay_100to50to25_withoutAnyTransaction() public {
        _grant(alice, 100e18);
        assertEq(rep.getVotes(alice), 100e18);
        vm.warp(START + HALF_LIFE);
        assertEq(rep.getVotes(alice), 50e18);
        assertEq(rep.balanceOf(alice), 50e18);
        assertEq(rep.totalSupply(), 50e18);
        vm.warp(START + 2 * HALF_LIFE);
        assertEq(rep.getVotes(alice), 25e18);
        assertEq(rep.totalSupply(), 25e18);
    }

    function test_newCredit_doesNotRefreshOldRep() public {
        _creditNow(alice);
        vm.warp(START + HALF_LIFE);
        _creditNow(alice);
        assertEq(rep.getVotes(alice), 15e18);
        vm.warp(START + 2 * HALF_LIFE);
        // 10 aged two half-lives plus 10 aged one: not 15 refreshed.
        assertEq(rep.getVotes(alice), 7.5e18);
    }

    function testFuzz_repeatedParticipation_matchesReferenceModel(uint256[8] memory gaps) public {
        uint256[8] memory times;
        for (uint256 i = 0; i < gaps.length; ++i) {
            skip(bound(gaps[i], 0, 120 days));
            times[i] = block.timestamp;
            _creditNow(alice);
        }
        skip(45 days);
        uint256 expected = 0;
        for (uint256 i = 0; i < times.length; ++i) {
            expected += ReferenceDecay.decay(REP, block.timestamp - times[i], HALF_LIFE);
        }
        _assertClose(rep.getVotes(alice), expected);
        _assertClose(rep.totalSupply(), expected);
    }

    function test_weeklyParticipation_approachesASteadyBalance() public {
        uint256 previousGain = type(uint256).max;
        uint256 balance = 0;
        for (uint256 week = 0; week < 200; ++week) {
            _creditNow(alice);
            uint256 next = rep.getVotes(alice);
            assertLe(next - balance, previousGain);
            previousGain = next - balance;
            balance = next;
            skip(7 days);
        }
        // Limit for 10 Rep a week at a 180-day half-life: 10 / (1 - 2^(-7/180)).
        assertApproxEqRel(balance, 376e18, 0.01e18);
    }

    function test_sameTimestampMutations_accumulate() public {
        _creditNow(alice);
        _creditNow(alice);
        _grant(alice, 5e18);
        _creditNow(bob);
        assertEq(rep.getVotes(alice), 25e18);
        assertEq(rep.totalSupply(), 35e18);
        skip(1);
        assertApproxEqAbs(rep.getPastVotes(alice, START), 25e18, 0);
        assertEq(rep.getPastTotalSupply(START), 35e18);
    }

    function test_longInactivity_decaysToZeroAndStillWorks() public {
        _creditNow(alice);
        skip(100 * 365 days);
        assertEq(rep.getVotes(alice), 0);
        assertEq(rep.totalSupply(), 0);
        assertEq(rep.getPastVotes(alice, START), REP);
        _creditNow(alice);
        assertEq(rep.getVotes(alice), REP);
        assertEq(rep.totalSupply(), REP);
    }

    function test_supplyOverflow_reverts() public {
        vm.prank(address(timelock));
        vm.expectRevert(IClubRep.SupplyOverflow.selector);
        rep.grant(alice, uint256(type(uint128).max) + 1, "r");

        _grant(alice, type(uint128).max);
        vm.prank(address(timelock));
        vm.expectRevert(IClubRep.SupplyOverflow.selector);
        rep.grant(bob, 1, "r");
    }

    // ── History ─────────────────────────────────────────────────────────────

    function test_getPast_rejectsPresentAndFuture() public {
        vm.expectRevert(
            abi.encodeWithSelector(IClubRep.ERC5805FutureLookup.selector, block.timestamp, uint48(block.timestamp))
        );
        rep.getPastVotes(alice, block.timestamp);
        vm.expectRevert(
            abi.encodeWithSelector(IClubRep.ERC5805FutureLookup.selector, block.timestamp + 1, uint48(block.timestamp))
        );
        rep.getPastTotalSupply(block.timestamp + 1);
    }

    function test_past_beforeFirstCheckpoint_isZero() public {
        skip(1 days);
        _creditNow(alice);
        skip(1);
        assertEq(rep.getPastVotes(alice, START), 0);
        assertEq(rep.getPastTotalSupply(START), 0);
    }

    function test_past_neverChanges_afterCreditGrantRevokeAndDecay() public {
        _creditNow(alice);
        _creditNow(bob);
        skip(10 days);
        uint256 snapshot = block.timestamp;
        skip(1);
        uint256 votesA = rep.getPastVotes(alice, snapshot);
        uint256 votesB = rep.getPastVotes(bob, snapshot);
        uint256 supply = rep.getPastTotalSupply(snapshot);
        assertApproxEqAbs(supply, votesA + votesB, 2);

        // A delayed page recognized before the snapshot must not reach back into it.
        _credit(alice, uint48(snapshot - 5 days));
        _grant(bob, 500e18);
        _revoke(alice);
        skip(400 days);

        assertEq(rep.getPastVotes(alice, snapshot), votesA);
        assertEq(rep.getPastVotes(bob, snapshot), votesB);
        assertEq(rep.getPastTotalSupply(snapshot), supply);
    }

    // ── Delayed pages ───────────────────────────────────────────────────────

    function test_delayedCredit_receivesOnlyTheRemainingWeight() public {
        uint48 recognizedAt = uint48(block.timestamp);
        _credit(alice, recognizedAt);
        skip(HALF_LIFE);
        _credit(bob, recognizedAt);
        assertEq(rep.getVotes(alice), 5e18);
        assertEq(rep.getVotes(bob), 5e18);
        assertEq(rep.totalSupply(), 10e18);
        // No power before the page landed.
        assertEq(rep.getPastVotes(bob, recognizedAt), 0);
    }

    function test_credit_rejectsFutureRecognition() public {
        vm.prank(address(registry));
        vm.expectRevert(IClubRep.FutureRecognition.selector);
        rep.credit(_list(alice), uint48(block.timestamp + 1));
    }

    function test_credit_emitsVoteCompatibleEvents() public {
        vm.expectEmit(address(rep));
        emit IVotes.DelegateChanged(alice, address(0), alice);
        vm.expectEmit(address(rep));
        emit IVotes.DelegateVotesChanged(alice, 0, REP);
        vm.expectEmit(address(rep));
        emit IClubRep.RepCredited(alice, REP, REP, uint48(block.timestamp));
        _creditNow(alice);

        skip(HALF_LIFE);
        // The previous value in the event is the decayed one.
        vm.expectEmit(address(rep));
        emit IVotes.DelegateVotesChanged(alice, 5e18, 15e18);
        _creditNow(alice);
    }

    function test_credit_onlyRegistry() public {
        address[4] memory callers = [address(this), address(timelock), relay, officerA];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAccessControl.AccessControlUnauthorizedAccount.selector, callers[i], rep.MINTER_ROLE()
                )
            );
            vm.prank(callers[i]);
            rep.credit(_list(alice), uint48(block.timestamp));
        }
    }

    // ── Grants, revocation and blocking ─────────────────────────────────────

    function test_grant_decaysFromExecutionAndRecordsReason() public {
        _creditNow(alice);
        skip(HALF_LIFE);
        vm.expectEmit(address(rep));
        emit IClubRep.RepGranted(alice, 40e18, "ipfs://reason");
        _grant(alice, 40e18);
        assertEq(rep.getVotes(alice), 45e18);
        skip(HALF_LIFE);
        assertEq(rep.getVotes(alice), 22.5e18);
    }

    function test_grant_rejectsZeroAndNonTimelock() public {
        vm.startPrank(address(timelock));
        vm.expectRevert(IClubRep.ZeroAddress.selector);
        rep.grant(address(0), 1, "r");
        vm.expectRevert(IClubRep.ZeroAmount.selector);
        rep.grant(alice, 0, "r");
        vm.stopPrank();

        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, officerA, bytes32(0))
        );
        vm.prank(officerA);
        rep.grant(alice, 1, "r");
        vm.expectRevert();
        vm.prank(officerA);
        rep.revoke(alice, "r");
        vm.expectRevert();
        vm.prank(officerA);
        rep.unblock(alice);
    }

    function test_revoke_removesPowerBlocksAndSkipsWithoutStalling() public {
        _creditNow(alice);
        _creditNow(bob);
        skip(1 days);
        uint256 balance = rep.getVotes(alice);

        vm.expectEmit(address(rep));
        emit IClubRep.RepRevoked(alice, balance, "ipfs://reason");
        _revoke(alice);
        assertEq(rep.getVotes(alice), 0);
        assertTrue(rep.isBlocked(alice));
        assertApproxEqAbs(rep.totalSupply(), rep.getVotes(bob), 2);

        // A page containing a blocked account still credits the rest.
        address[] memory page = _sorted(alice, bob, carol);
        uint256 before = rep.totalSupply();
        vm.expectEmit(address(rep));
        emit IClubRep.RepCreditSkipped(alice, REP, uint48(block.timestamp));
        vm.prank(address(registry));
        rep.credit(page, uint48(block.timestamp));
        assertEq(rep.getVotes(alice), 0);
        assertEq(rep.getVotes(carol), REP);
        assertEq(rep.totalSupply(), before + 2 * REP);

        vm.prank(address(timelock));
        vm.expectRevert(abi.encodeWithSelector(IClubRep.AccountBlocked.selector, alice));
        rep.grant(alice, 1, "r");
        vm.prank(address(timelock));
        vm.expectRevert(abi.encodeWithSelector(IClubRep.AccountBlocked.selector, alice));
        rep.revoke(alice, "r");
    }

    function test_unblock_allowsEarningAgainWithoutRestoring() public {
        _creditNow(alice);
        _revoke(alice);
        vm.prank(address(timelock));
        rep.unblock(alice);
        assertFalse(rep.isBlocked(alice));
        assertEq(rep.getVotes(alice), 0);
        _creditNow(alice);
        assertEq(rep.getVotes(alice), REP);

        vm.prank(address(timelock));
        vm.expectRevert(abi.encodeWithSelector(IClubRep.AccountNotBlocked.selector, alice));
        rep.unblock(alice);
    }

    function test_revoke_accountWithNoRep_onlyBlocks() public {
        _revoke(carol);
        assertTrue(rep.isBlocked(carol));
        assertEq(rep.totalSupply(), 0);
    }

    function test_revoke_everyHolder_leavesAtMostRoundingDust() public {
        _creditNow(alice);
        skip(33 days + 7);
        _creditNow(bob);
        skip(91 days + 13);
        _revoke(alice);
        _revoke(bob);
        assertLe(rep.totalSupply(), 4);
    }

    // ── Role locks ──────────────────────────────────────────────────────────

    function test_admin_cannotMoveFromTheTimelock() public {
        bytes32 admin = rep.DEFAULT_ADMIN_ROLE();
        vm.startPrank(address(timelock));
        vm.expectRevert(IClubRep.AdminLocked.selector);
        rep.grantRole(admin, alice);
        vm.expectRevert(IClubRep.AdminLocked.selector);
        rep.revokeRole(admin, address(timelock));
        vm.expectRevert(IClubRep.AdminLocked.selector);
        rep.renounceRole(admin, address(timelock));
        vm.stopPrank();
        assertTrue(rep.hasRole(admin, address(timelock)));
        assertFalse(rep.hasRole(admin, address(this)));
    }

    function test_minter_canOnlyBeTheRegistry() public {
        bytes32 minter = rep.MINTER_ROLE();
        vm.prank(address(timelock));
        vm.expectRevert(IClubRep.MinterLocked.selector);
        rep.grantRole(minter, alice);
    }

    function test_importerRights_endAtFinalization() public {
        assertTrue(rep.importFinalized());
        vm.expectRevert(IClubRep.ImportAlreadyFinalized.selector);
        rep.importLegacy(_list(alice), new uint256[](1));
        vm.expectRevert(IClubRep.ImportAlreadyFinalized.selector);
        rep.finalizeImport();
        vm.expectRevert(IClubRep.ImportAlreadyFinalized.selector);
        rep.setRegistry(alice);
    }

    function test_constructor_rejectsBadArguments() public {
        vm.expectRevert(IClubRep.ZeroAddress.selector);
        new ClubRep(address(0), address(legacyRegistry), address(this), HALF_LIFE);
        vm.expectRevert(IClubRep.ZeroAddress.selector);
        new ClubRep(address(timelock), address(0), address(this), HALF_LIFE);
        vm.expectRevert(IClubRep.ZeroAddress.selector);
        new ClubRep(address(timelock), address(legacyRegistry), address(0), HALF_LIFE);
        vm.expectRevert(IClubRep.InvalidHalfLife.selector);
        new ClubRep(address(timelock), address(legacyRegistry), address(this), 30 days - 1);
        vm.expectRevert(IClubRep.InvalidHalfLife.selector);
        new ClubRep(address(timelock), address(legacyRegistry), address(this), 3650 days + 1);
    }
}

/// @dev Import runs between deployment and finalization, so these set up their own club.
contract ClubRepImportTest is ClubBase {
    Legacy private legacy;

    function setUp() public override {
        vm.warp(START);
        legacy = _emptyLegacy();
        address[] memory all = _sorted(alice, bob, carol);
        _legacySession(100, all);
        _legacySession(200, _list(alice));
        _legacySession(300, _list(alice));
        vm.startPrank(legacyOfficer);
        legacyRegistry.closeSession(100);
        legacyRegistry.closeSession(200);
        legacyRegistry.closeSession(300);
        vm.stopPrank();
        _freezeLegacy(legacy, address(this));
        _deploy(legacy);
    }

    function _ids(uint256 a, uint256 b, uint256 c) private pure returns (uint256[] memory ids) {
        ids = new uint256[](3);
        (ids[0], ids[1], ids[2]) = (a, b, c);
    }

    function test_import_derivesRepFromLegacyTokens() public {
        vm.expectEmit(address(rep));
        emit IClubRep.LegacyRepImported(alice, 3, 30e18, 30e18);
        rep.importLegacy(_list(alice), _ids(100, 200, 300));
        rep.importLegacy(_list(bob), _ids(100, 200, 300));
        assertEq(rep.getVotes(alice), 30e18);
        assertEq(rep.getVotes(bob), 10e18);
        assertEq(rep.totalSupply(), 40e18);
        assertTrue(rep.isImported(alice));
    }

    function test_import_batchesShareOneRecognitionTime() public {
        uint256 recognized = rep.MIGRATION_RECOGNIZED_AT();
        assertEq(recognized, START);
        skip(HALF_LIFE / 2);
        rep.importLegacy(_list(bob), _ids(100, 200, 300));
        skip(HALF_LIFE / 2);
        rep.importLegacy(_list(carol), _ids(100, 200, 300));
        // Imported half a half-life apart, equal today: both age from the same moment.
        assertApproxEqAbs(rep.getVotes(bob), 5e18, 10);
        assertApproxEqAbs(rep.getVotes(carol), 5e18, 10);
        assertApproxEqAbs(rep.totalSupply(), 10e18, 20);
        // No snapshot is back-dated.
        assertEq(rep.getPastVotes(bob, START), 0);
    }

    function test_import_historicalAccountAndTotalPowerAgreeThroughDecay() public {
        skip(9 days);
        rep.importLegacy(_list(alice), _ids(100, 200, 300));
        skip(40 days);
        address[] memory rest = new address[](2);
        (rest[0], rest[1]) = (bob, carol);
        rep.importLegacy(rest, _ids(100, 200, 300));
        uint256 afterImport = block.timestamp;
        skip(HALF_LIFE);

        uint256[2] memory times = [afterImport, block.timestamp - 1];
        for (uint256 i = 0; i < times.length; ++i) {
            uint256 sum =
                rep.getPastVotes(alice, times[i]) + rep.getPastVotes(bob, times[i]) + rep.getPastVotes(carol, times[i]);
            assertApproxEqAbs(rep.getPastTotalSupply(times[i]), sum, 20);
        }
        assertApproxEqAbs(rep.totalSupply(), rep.getVotes(alice) + rep.getVotes(bob) + rep.getVotes(carol), 20);
    }

    function test_import_rejectsDuplicateAccounts() public {
        rep.importLegacy(_list(alice), _ids(100, 200, 300));
        vm.expectRevert(abi.encodeWithSelector(IClubRep.AlreadyImported.selector, alice));
        rep.importLegacy(_list(alice), _ids(100, 200, 300));

        address[] memory twice = new address[](2);
        (twice[0], twice[1]) = (bob, bob);
        vm.expectRevert(abi.encodeWithSelector(IClubRep.AlreadyImported.selector, bob));
        rep.importLegacy(twice, _ids(100, 200, 300));
    }

    function test_import_rejectsMissingUnorderedOrRepeatedSessions() public {
        vm.expectRevert(IClubRep.NoSessions.selector);
        rep.importLegacy(_list(alice), new uint256[](0));
        vm.expectRevert(abi.encodeWithSelector(IClubRep.LegacySessionMissing.selector, 999));
        rep.importLegacy(_list(alice), _ids(100, 200, 999));
        vm.expectRevert(IClubRep.SessionsNotIncreasing.selector);
        rep.importLegacy(_list(alice), _ids(100, 100, 100));
        vm.expectRevert(IClubRep.SessionsNotIncreasing.selector);
        rep.importLegacy(_list(alice), _ids(300, 200, 100));
    }

    function test_import_rejectsAnOpenSession() public {
        // A second legacy registry that was never frozen.
        AttendanceRegistry open_ = new AttendanceRegistry(address(this), "cid");
        open_.createSession(1, 1, "Open", "Fall 2026");
        ClubRep fresh = new ClubRep(address(timelock), address(open_), address(this), HALF_LIFE);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        vm.expectRevert(abi.encodeWithSelector(IClubRep.LegacySessionOpen.selector, 1));
        fresh.importLegacy(_list(alice), ids);
    }

    function test_import_skipsAccountsWithNoAttendance() public {
        address nobody = makeAddr("nobody");
        rep.importLegacy(_list(nobody), _ids(100, 200, 300));
        assertEq(rep.getVotes(nobody), 0);
        assertTrue(rep.isImported(nobody));
    }

    function test_import_onlyImporter() public {
        vm.prank(officerA);
        vm.expectRevert(IClubRep.NotImporter.selector);
        rep.importLegacy(_list(alice), _ids(100, 200, 300));
        vm.prank(officerA);
        vm.expectRevert(IClubRep.NotImporter.selector);
        rep.finalizeImport();
    }

    function test_setRegistry_onceAndRequiredToFinalize() public {
        vm.expectRevert(IClubRep.RegistryAlreadySet.selector);
        rep.setRegistry(alice);

        ClubRep fresh = new ClubRep(address(timelock), address(legacyRegistry), address(this), HALF_LIFE);
        vm.expectRevert(IClubRep.RegistryNotSet.selector);
        fresh.finalizeImport();
        vm.expectRevert(IClubRep.ZeroAddress.selector);
        fresh.setRegistry(address(0));
        vm.prank(alice);
        vm.expectRevert(IClubRep.NotImporter.selector);
        fresh.setRegistry(alice);
    }
}
