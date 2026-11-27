// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

import {AttendanceRegistry2} from "../src/AttendanceRegistry2.sol";
import {IAttendanceRegistry2} from "../src/interfaces/IAttendanceRegistry2.sol";
import {ClubBase} from "./helpers/ClubBase.sol";

/// @dev A contract wallet whose receiver hook always reverts.
contract HostileReceiver {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert("no");
    }
}

contract AttendanceRegistry2Test is ClubBase {
    uint256 private constant ID = 1;

    function _unauthorized(address caller, bytes32 role) private pure returns (bytes memory) {
        return abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, caller, role);
    }

    function _status() private view returns (IAttendanceRegistry2.RepStatus) {
        return registry.getSignOff(ID).status;
    }

    function _openWith(address[] memory attendees) private {
        _createSession(ID, 300);
        _mintAll(ID, attendees);
    }

    function _pendingWith(address[] memory attendees) private {
        _openWith(attendees);
        _close(ID, attendees);
    }

    // ── Constructor ─────────────────────────────────────────────────────────

    function test_constructor_setsRoles() public view {
        assertTrue(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), address(timelock)));
        assertTrue(registry.hasRole(registry.RELAY_ROLE(), relay));
        assertEq(registry.getRoleMemberCount(registry.ADMIN_ROLE()), 2);
        assertEq(registry.TIMELOCK(), address(timelock));
        assertEq(address(registry.REP()), address(rep));
    }

    function test_constructor_requiresTwoDistinctOfficers() public {
        address[] memory one = _list(officerA);
        vm.expectRevert(IAttendanceRegistry2.OfficerFloor.selector);
        new AttendanceRegistry2(address(timelock), address(rep), one, relay, "c");

        address[] memory duplicate = new address[](2);
        (duplicate[0], duplicate[1]) = (officerA, officerA);
        vm.expectRevert(IAttendanceRegistry2.OfficerFloor.selector);
        new AttendanceRegistry2(address(timelock), address(rep), duplicate, relay, "c");
    }

    function test_officerRole_rejectsAccountsNobodyControls() public {
        bytes32 officerRole = registry.ADMIN_ROLE();
        address[2] memory invalid = [address(0), address(timelock)];
        for (uint256 i = 0; i < invalid.length; ++i) {
            vm.prank(address(timelock));
            vm.expectRevert(abi.encodeWithSelector(IAttendanceRegistry2.InvalidOfficer.selector, invalid[i]));
            registry.grantRole(officerRole, invalid[i]);
        }

        address[] memory officers = new address[](2);
        officers[0] = officerA;
        officers[1] = address(timelock);
        vm.expectRevert(abi.encodeWithSelector(IAttendanceRegistry2.InvalidOfficer.selector, address(timelock)));
        new AttendanceRegistry2(address(timelock), address(rep), officers, relay, "cid");
    }

    function test_constructor_rejectsZeroAddresses() public {
        address[] memory officers = _config().officers;
        vm.expectRevert(IAttendanceRegistry2.ZeroAddress.selector);
        new AttendanceRegistry2(address(0), address(rep), officers, relay, "c");
        vm.expectRevert(IAttendanceRegistry2.ZeroAddress.selector);
        new AttendanceRegistry2(address(timelock), address(0), officers, relay, "c");
        vm.expectRevert(IAttendanceRegistry2.ZeroAddress.selector);
        new AttendanceRegistry2(address(timelock), address(rep), officers, address(0), "c");
        officers[1] = address(0);
        vm.expectRevert(IAttendanceRegistry2.ZeroAddress.selector);
        new AttendanceRegistry2(address(timelock), address(rep), officers, relay, "c");
    }

    // ── Sessions ────────────────────────────────────────────────────────────

    function test_createSession_storesAndEmits() public {
        vm.expectEmit(address(registry));
        emit IAttendanceRegistry2.SessionCreated(ID, 1000, "Kickoff", "Fall 2026", 25, officerA);
        vm.prank(officerA);
        registry.createSession(ID, 1000, "Kickoff", "Fall 2026", 25, "");
        IAttendanceRegistry2.Session memory s = registry.getSession(ID);
        assertEq(s.date, 1000);
        assertEq(s.maxAttendees, 25);
        assertEq(s.minted, 0);
        assertEq(s.name, "Kickoff");
        assertTrue(_status() == IAttendanceRegistry2.RepStatus.None);
    }

    function test_createSession_hasNoTimeLimits() public {
        // Back to back, back-dated and far in the future are all allowed.
        vm.startPrank(officerA);
        registry.createSession(1, 1, "a", "s", 1, "");
        registry.createSession(2, type(uint64).max, "b", "s", 1, "");
        registry.createSession(3, uint64(block.timestamp), "c", "s", 300, "");
        vm.stopPrank();
        skip(1000 days);
        _mint(1, alice);
    }

    function test_createSession_reverts() public {
        vm.startPrank(officerA);
        vm.expectRevert(IAttendanceRegistry2.InvalidDate.selector);
        registry.createSession(ID, 0, "n", "s", 10, "");
        vm.expectRevert(IAttendanceRegistry2.InvalidMaxAttendees.selector);
        registry.createSession(ID, 1, "n", "s", 0, "");
        vm.expectRevert(IAttendanceRegistry2.InvalidMaxAttendees.selector);
        registry.createSession(ID, 1, "n", "s", 301, "");
        registry.createSession(ID, 1, "n", "s", 10, "");
        vm.expectRevert(IAttendanceRegistry2.SessionAlreadyExists.selector);
        registry.createSession(ID, 1, "n", "s", 10, "");
        vm.stopPrank();

        address[3] memory others = [relay, alice, address(timelock)];
        for (uint256 i = 0; i < others.length; ++i) {
            vm.expectRevert(_unauthorized(others[i], registry.ADMIN_ROLE()));
            vm.prank(others[i]);
            registry.createSession(2, 1, "n", "s", 10, "");
        }
    }

    // ── Minting ─────────────────────────────────────────────────────────────

    function test_mint_givesATokenAndNoRep() public {
        _createSession(ID, 10);
        vm.expectEmit(address(registry));
        emit IAttendanceRegistry2.TokenMinted(alice, ID);
        _mint(ID, alice);
        assertEq(registry.balanceOf(alice, ID), 1);
        assertEq(registry.getSession(ID).minted, 1);
        assertEq(rep.getVotes(alice), 0);
        assertEq(rep.totalSupply(), 0);
    }

    function test_mint_reverts() public {
        vm.startPrank(relay);
        vm.expectRevert(IAttendanceRegistry2.SessionDoesNotExist.selector);
        registry.mint(alice, ID);
        vm.stopPrank();

        _createSession(ID, 2);
        vm.startPrank(relay);
        vm.expectRevert(IAttendanceRegistry2.InvalidRecipient.selector);
        registry.mint(address(0), ID);
        registry.mint(alice, ID);
        vm.expectRevert(IAttendanceRegistry2.AlreadyCheckedIn.selector);
        registry.mint(alice, ID);
        registry.mint(bob, ID);
        vm.expectRevert(IAttendanceRegistry2.SessionFull.selector);
        registry.mint(carol, ID);
        vm.stopPrank();

        vm.expectRevert(_unauthorized(officerA, registry.RELAY_ROLE()));
        vm.prank(officerA);
        registry.mint(carol, ID);

        _close(ID, new address[](0));
        vm.prank(relay);
        vm.expectRevert(IAttendanceRegistry2.SessionNotActive.selector);
        registry.mint(carol, ID);
    }

    function test_mintBatch_skipsDuplicatesWithoutReverting() public {
        _createSession(ID, 10);
        _mint(ID, alice);
        address[] memory batch = new address[](4);
        (batch[0], batch[1], batch[2], batch[3]) = (alice, bob, address(0), bob);

        vm.expectEmit(address(registry));
        emit IAttendanceRegistry2.TokenMintSkipped(alice, ID, IAttendanceRegistry2.SkipReason.AlreadyCheckedIn);
        vm.expectEmit(address(registry));
        emit IERC1155.TransferSingle(relay, address(0), bob, ID, 1);
        vm.expectEmit(address(registry));
        emit IAttendanceRegistry2.TokenMinted(bob, ID);
        vm.expectEmit(address(registry));
        emit IAttendanceRegistry2.TokenMintSkipped(address(0), ID, IAttendanceRegistry2.SkipReason.InvalidRecipient);
        vm.expectEmit(address(registry));
        emit IAttendanceRegistry2.TokenMintSkipped(bob, ID, IAttendanceRegistry2.SkipReason.AlreadyCheckedIn);
        vm.prank(relay);
        registry.mintBatch(batch, ID);

        assertEq(registry.balanceOf(bob, ID), 1);
        assertEq(registry.getSession(ID).minted, 2);
    }

    function test_mintBatch_stopsAtTheCap() public {
        _createSession(ID, 2);
        address[] memory batch = _sorted(alice, bob, carol);
        vm.expectEmit(address(registry));
        emit IAttendanceRegistry2.TokenMintSkipped(batch[2], ID, IAttendanceRegistry2.SkipReason.SessionFull);
        vm.prank(relay);
        registry.mintBatch(batch, ID);
        assertEq(registry.getSession(ID).minted, 2);
        assertEq(registry.balanceOf(batch[2], ID), 0);
    }

    function test_mint_toHostileContract_cannotBlockABatch() public {
        address hostile = address(new HostileReceiver());
        _createSession(ID, 10);
        address[] memory batch = new address[](2);
        (batch[0], batch[1]) = (hostile, alice);
        vm.prank(relay);
        registry.mintBatch(batch, ID);
        assertEq(registry.balanceOf(hostile, ID), 1);
        assertEq(registry.balanceOf(alice, ID), 1);

        _createSession(2, 10);
        _mint(2, hostile);
        assertEq(registry.balanceOf(hostile, 2), 1);
    }

    function test_mintBatch_reverts() public {
        _createSession(ID, 300);
        address[] memory tooMany = _members(201);
        vm.prank(relay);
        vm.expectRevert(IAttendanceRegistry2.BatchTooLarge.selector);
        registry.mintBatch(tooMany, ID);

        vm.expectRevert(_unauthorized(alice, registry.RELAY_ROLE()));
        vm.prank(alice);
        registry.mintBatch(_list(alice), ID);

        _close(ID, new address[](0));
        vm.prank(relay);
        vm.expectRevert(IAttendanceRegistry2.SessionNotActive.selector);
        registry.mintBatch(_list(alice), ID);
    }

    // ── Close ───────────────────────────────────────────────────────────────

    function test_closeSession_commitsListAndLeavesRepPending() public {
        address[] memory attendees = _sorted(alice, bob, carol);
        _openWith(attendees);
        vm.expectEmit(address(registry));
        emit IAttendanceRegistry2.SessionClosed(ID, officerA, keccak256(abi.encode(attendees)), attendees);
        _close(ID, attendees);

        IAttendanceRegistry2.SignOff memory s = registry.getSignOff(ID);
        assertTrue(s.status == IAttendanceRegistry2.RepStatus.Pending);
        assertEq(s.closer, officerA);
        assertEq(s.count, 3);
        assertEq(rep.totalSupply(), 0);
        // Pending never expires and carries no power.
        skip(5 * 365 days);
        assertTrue(_status() == IAttendanceRegistry2.RepStatus.Pending);
        assertEq(rep.getVotes(alice), 0);
    }

    function test_closeSession_allowsASubsetOfHolders() public {
        address[] memory all = _sorted(alice, bob, carol);
        _openWith(all);
        _close(ID, _slice(all, 0, 2));
        assertEq(registry.getSignOff(ID).count, 2);
    }

    function test_closeSession_rejectsBadLists() public {
        address[] memory attendees = _sorted(alice, bob, carol);
        _createSession(ID, 10);
        _mintAll(ID, _slice(attendees, 0, 2));
        vm.startPrank(officerA);

        vm.expectRevert(IAttendanceRegistry2.TooManyAttendees.selector);
        registry.closeSession(ID, attendees);

        address[] memory duplicate = new address[](2);
        (duplicate[0], duplicate[1]) = (attendees[0], attendees[0]);
        vm.expectRevert(IAttendanceRegistry2.AttendeesNotIncreasing.selector);
        registry.closeSession(ID, duplicate);

        address[] memory reversed = new address[](2);
        (reversed[0], reversed[1]) = (attendees[1], attendees[0]);
        vm.expectRevert(IAttendanceRegistry2.AttendeesNotIncreasing.selector);
        registry.closeSession(ID, reversed);

        address[] memory outsider = new address[](2);
        (outsider[0], outsider[1]) = (attendees[0], attendees[2]);
        vm.expectRevert(abi.encodeWithSelector(IAttendanceRegistry2.NotAttendee.selector, attendees[2]));
        registry.closeSession(ID, outsider);

        vm.expectRevert(IAttendanceRegistry2.AttendeesNotIncreasing.selector);
        registry.closeSession(ID, _list(address(0)));

        vm.expectRevert(IAttendanceRegistry2.SessionDoesNotExist.selector);
        registry.closeSession(2, new address[](0));
        vm.stopPrank();
    }

    function test_closeSession_onceAndOfficersOnly() public {
        _openWith(_list(alice));
        address[3] memory others = [relay, alice, address(timelock)];
        for (uint256 i = 0; i < others.length; ++i) {
            vm.expectRevert(_unauthorized(others[i], registry.ADMIN_ROLE()));
            vm.prank(others[i]);
            registry.closeSession(ID, _list(alice));
        }
        _close(ID, _list(alice));
        vm.prank(officerB);
        vm.expectRevert(IAttendanceRegistry2.SessionNotActive.selector);
        registry.closeSession(ID, _list(alice));
    }

    // ── Confirm / reject ────────────────────────────────────────────────────

    function test_confirm_byTheCloser_reverts() public {
        _pendingWith(_list(alice));
        vm.prank(officerA);
        vm.expectRevert(IAttendanceRegistry2.SameOfficer.selector);
        registry.confirmSessionRep(ID);
    }

    function test_confirm_fixesRecognitionTimeWithoutCredit() public {
        _pendingWith(_list(alice));
        skip(3 days);
        vm.expectEmit(address(registry));
        emit IAttendanceRegistry2.SessionRepConfirmed(ID, officerB, uint48(block.timestamp), 1);
        _confirm(ID);
        IAttendanceRegistry2.SignOff memory s = registry.getSignOff(ID);
        assertTrue(s.status == IAttendanceRegistry2.RepStatus.Confirmed);
        assertEq(s.recognizedAt, block.timestamp);
        assertEq(s.confirmer, officerB);
        assertEq(rep.getVotes(alice), 0);
    }

    function test_confirm_byTimelock() public {
        _pendingWith(_list(alice));
        vm.prank(address(timelock));
        registry.confirmSessionRep(ID);
        assertTrue(_status() == IAttendanceRegistry2.RepStatus.Confirmed);
    }

    function test_confirm_reverts() public {
        vm.prank(officerB);
        vm.expectRevert(IAttendanceRegistry2.NotPending.selector);
        registry.confirmSessionRep(ID);

        _pendingWith(_list(alice));
        address[3] memory others = [relay, alice, address(this)];
        for (uint256 i = 0; i < others.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(IAttendanceRegistry2.NotOfficerOrTimelock.selector, others[i]));
            vm.prank(others[i]);
            registry.confirmSessionRep(ID);
        }
        _confirm(ID);
        vm.prank(officerB);
        vm.expectRevert(IAttendanceRegistry2.NotPending.selector);
        registry.confirmSessionRep(ID);
    }

    function test_emptySession_completesWithoutCredit() public {
        _pendingWith(new address[](0));
        _confirm(ID);
        assertTrue(_status() == IAttendanceRegistry2.RepStatus.Credited);
        assertEq(rep.totalSupply(), 0);
        vm.expectRevert(IAttendanceRegistry2.NotConfirmed.selector);
        registry.creditSessionRep(ID, new address[](0), 0, 0);
    }

    function test_reject_voidsRepButKeepsTokens() public {
        _pendingWith(_list(alice));
        // Any officer, including the closer.
        vm.prank(officerA);
        registry.rejectSessionRep(ID);
        assertTrue(_status() == IAttendanceRegistry2.RepStatus.Rejected);
        assertEq(registry.balanceOf(alice, ID), 1);

        vm.prank(officerB);
        vm.expectRevert(IAttendanceRegistry2.NotPending.selector);
        registry.confirmSessionRep(ID);
        vm.expectRevert(IAttendanceRegistry2.NotConfirmed.selector);
        registry.creditSessionRep(ID, _list(alice), 0, 1);
    }

    function test_reject_afterConfirm_reverts() public {
        _pendingWith(_list(alice));
        _confirm(ID);
        vm.prank(officerA);
        vm.expectRevert(IAttendanceRegistry2.NotPending.selector);
        registry.rejectSessionRep(ID);
    }

    function test_reject_onlyOfficerOrTimelock() public {
        _pendingWith(_list(alice));
        vm.prank(relay);
        vm.expectRevert(abi.encodeWithSelector(IAttendanceRegistry2.NotOfficerOrTimelock.selector, relay));
        registry.rejectSessionRep(ID);
        vm.prank(address(timelock));
        registry.rejectSessionRep(ID);
    }

    // ── Credit ──────────────────────────────────────────────────────────────

    function test_credit_fullTenRepForEveryAttendee_atAnyClubSize() public {
        address[] memory attendees = _members(300);
        _meeting(ID, attendees);
        for (uint256 i = 0; i < attendees.length; i += 37) {
            assertEq(rep.getVotes(attendees[i]), REP);
        }
        assertEq(rep.getVotes(attendees[299]), REP);
        assertEq(rep.totalSupply(), 3000e18);
        assertTrue(_status() == IAttendanceRegistry2.RepStatus.Credited);
    }

    function test_credit_pagesAreSequentialAndReplaySafe() public {
        address[] memory attendees = _members(250);
        _pendingWith(attendees);
        _confirm(ID);

        // Anyone may submit a page.
        vm.prank(carol);
        registry.creditSessionRep(ID, attendees, 0, 100);
        assertEq(registry.getSignOff(ID).cursor, 100);

        vm.expectRevert(abi.encodeWithSelector(IAttendanceRegistry2.WrongCursor.selector, 100));
        registry.creditSessionRep(ID, attendees, 0, 100);
        vm.expectRevert(abi.encodeWithSelector(IAttendanceRegistry2.WrongCursor.selector, 100));
        registry.creditSessionRep(ID, attendees, 150, 200);
        vm.expectRevert(abi.encodeWithSelector(IAttendanceRegistry2.WrongCursor.selector, 100));
        registry.creditSessionRep(ID, attendees, 50, 150);

        registry.creditSessionRep(ID, attendees, 100, 200);
        registry.creditSessionRep(ID, attendees, 200, 250);
        assertTrue(_status() == IAttendanceRegistry2.RepStatus.Credited);
        assertEq(rep.totalSupply(), 2500e18);
        vm.expectRevert(IAttendanceRegistry2.NotConfirmed.selector);
        registry.creditSessionRep(ID, attendees, 250, 250);
    }

    function test_credit_rejectsSubstitutedListsAndBadPages() public {
        address[] memory attendees = _members(150);
        _pendingWith(attendees);
        vm.expectRevert(IAttendanceRegistry2.NotConfirmed.selector);
        registry.creditSessionRep(ID, attendees, 0, 100);
        _confirm(ID);

        address[] memory forged = _members(150);
        forged[7] = alice;
        vm.expectRevert(IAttendanceRegistry2.AttendeesMismatch.selector);
        registry.creditSessionRep(ID, forged, 0, 100);
        vm.expectRevert(IAttendanceRegistry2.AttendeesMismatch.selector);
        registry.creditSessionRep(ID, _slice(attendees, 0, 100), 0, 100);

        vm.expectRevert(IAttendanceRegistry2.InvalidPage.selector);
        registry.creditSessionRep(ID, attendees, 0, 0);
        vm.expectRevert(IAttendanceRegistry2.InvalidPage.selector);
        registry.creditSessionRep(ID, attendees, 0, 101);
        registry.creditSessionRep(ID, attendees, 0, 100);
        vm.expectRevert(IAttendanceRegistry2.InvalidPage.selector);
        registry.creditSessionRep(ID, attendees, 100, 151);
    }

    function test_credit_delayedPagesAgeFromConfirmation() public {
        address[] memory attendees = _members(120);
        _pendingWith(attendees);
        _confirm(ID);
        registry.creditSessionRep(ID, attendees, 0, 100);
        uint256 firstPageAt = block.timestamp;
        skip(HALF_LIFE);
        registry.creditSessionRep(ID, attendees, 100, 120);

        assertEq(rep.getVotes(attendees[0]), 5e18);
        assertEq(rep.getVotes(attendees[119]), 5e18);
        assertEq(rep.getPastVotes(attendees[119], firstPageAt), 0);
        assertEq(rep.getPastTotalSupply(firstPageAt), 1000e18);
    }

    function test_credit_blockedAttendeeDoesNotStallThePage() public {
        address[] memory attendees = _sorted(alice, bob, carol);
        _pendingWith(attendees);
        _confirm(ID);
        _revoke(bob);
        _creditAll(ID, attendees);
        assertEq(rep.getVotes(bob), 0);
        assertEq(rep.getVotes(alice), REP);
        assertEq(rep.getVotes(carol), REP);
        // Unblocking later cannot replay the skipped award.
        vm.prank(address(timelock));
        rep.unblock(bob);
        vm.expectRevert(IAttendanceRegistry2.NotConfirmed.selector);
        registry.creditSessionRep(ID, attendees, 0, 3);
    }

    // ── Metadata ────────────────────────────────────────────────────────────

    function test_uri_usesBaseCidUnlessTheSessionHasItsOwn() public {
        _createSession(ID, 10);
        assertEq(registry.uri(ID), "ipfs://base-cid/1.json");
        vm.prank(officerB);
        registry.setSessionMetadata(ID, "session-cid");
        assertEq(registry.uri(ID), "ipfs://session-cid");
        vm.prank(officerA);
        registry.setBaseCid("new-base");
        assertEq(registry.uri(2), "ipfs://new-base/2.json");
        vm.prank(officerA);
        registry.createSession(3, 1, "n", "s", 1, "at-create");
        assertEq(registry.uri(3), "ipfs://at-create");
    }

    function test_metadata_officersOnly() public {
        vm.expectRevert(_unauthorized(relay, registry.ADMIN_ROLE()));
        vm.prank(relay);
        registry.setBaseCid("x");
        vm.expectRevert(_unauthorized(alice, registry.ADMIN_ROLE()));
        vm.prank(alice);
        registry.setSessionMetadata(ID, "x");
        vm.prank(officerA);
        vm.expectRevert(IAttendanceRegistry2.SessionDoesNotExist.selector);
        registry.setSessionMetadata(ID, "x");
    }

    // ── Pause ───────────────────────────────────────────────────────────────

    function test_pause_blocksMintingOnlyAndExpires() public {
        _openWith(_list(alice));
        _createSession(2, 10);
        _mint(2, alice);
        _close(2, _list(alice));
        vm.prank(officerB);
        registry.pauseMinting();
        uint64 until = uint64(block.timestamp + 14 days);
        assertEq(registry.pausedUntil(), until);

        vm.prank(relay);
        vm.expectRevert(abi.encodeWithSelector(IAttendanceRegistry2.MintingIsPaused.selector, until));
        registry.mint(bob, ID);
        vm.prank(relay);
        vm.expectRevert(abi.encodeWithSelector(IAttendanceRegistry2.MintingIsPaused.selector, until));
        registry.mintBatch(_list(bob), ID);

        // Sessions, closing, confirming and crediting keep working.
        _createSession(3, 10);
        _close(ID, _list(alice));
        _confirm(ID);
        _creditAll(ID, _list(alice));
        _confirm(2);
        _creditAll(2, _list(alice));

        vm.warp(until);
        _mint(3, bob);
    }

    function test_pause_oncePerOfficerPer30Days() public {
        vm.startPrank(officerA);
        registry.pauseMinting();
        uint256 availableAt = block.timestamp + 30 days;
        assertEq(registry.nextPauseAt(officerA), availableAt);
        vm.warp(availableAt - 1);
        vm.expectRevert(abi.encodeWithSelector(IAttendanceRegistry2.PauseCooldown.selector, availableAt));
        registry.pauseMinting();
        vm.warp(availableAt);
        registry.pauseMinting();
        vm.stopPrank();
        // Another officer has their own allowance.
        assertEq(registry.nextPauseAt(officerB), 0);
        vm.prank(officerB);
        registry.pauseMinting();
    }

    function test_unpause_needsTwoDistinctOfficers() public {
        vm.prank(officerA);
        registry.pauseMinting();
        vm.expectEmit(address(registry));
        emit IAttendanceRegistry2.UnpauseApproved(officerA);
        vm.prank(officerA);
        registry.unpauseMinting();
        assertGt(registry.pausedUntil(), block.timestamp);
        assertEq(registry.unpauseApprover(), officerA);

        vm.prank(officerA);
        vm.expectRevert(IAttendanceRegistry2.AlreadyApproved.selector);
        registry.unpauseMinting();

        vm.expectEmit(address(registry));
        emit IAttendanceRegistry2.MintingUnpaused(officerB);
        vm.prank(officerB);
        registry.unpauseMinting();
        assertEq(registry.pausedUntil(), 0);
        assertEq(registry.unpauseApprover(), address(0));
    }

    function test_unpause_byTimelockAlone() public {
        vm.prank(officerA);
        registry.pauseMinting();
        vm.prank(address(timelock));
        registry.unpauseMinting();
        assertEq(registry.pausedUntil(), 0);
    }

    function test_unpause_approvalDoesNotCarryToANewPauseOrSurviveRemoval() public {
        vm.prank(officerA);
        registry.pauseMinting();
        vm.prank(officerA);
        registry.unpauseMinting();
        // A new pause clears the earlier approval.
        vm.prank(officerB);
        registry.pauseMinting();
        assertEq(registry.unpauseApprover(), address(0));

        vm.prank(officerA);
        registry.unpauseMinting();
        vm.startPrank(address(timelock));
        registry.grantRole(registry.ADMIN_ROLE(), officerC);
        registry.revokeRole(registry.ADMIN_ROLE(), officerA);
        vm.stopPrank();
        // The removed officer's approval no longer counts; B only records theirs.
        vm.prank(officerB);
        registry.unpauseMinting();
        assertGt(registry.pausedUntil(), block.timestamp);
        vm.prank(officerC);
        registry.unpauseMinting();
        assertEq(registry.pausedUntil(), 0);
    }

    function test_unpause_revertsWhenNotPausedOrUnauthorized() public {
        vm.prank(officerA);
        vm.expectRevert(IAttendanceRegistry2.MintingNotPaused.selector);
        registry.unpauseMinting();
        vm.prank(relay);
        vm.expectRevert(abi.encodeWithSelector(IAttendanceRegistry2.NotOfficerOrTimelock.selector, relay));
        registry.unpauseMinting();
        vm.expectRevert(_unauthorized(relay, registry.ADMIN_ROLE()));
        vm.prank(relay);
        registry.pauseMinting();
    }

    // ── Soulbound ───────────────────────────────────────────────────────────

    function test_soulbound_transfersAndApprovalsRevert() public {
        _createSession(ID, 10);
        _mint(ID, alice);
        uint256[] memory ids = new uint256[](1);
        uint256[] memory values = new uint256[](1);
        (ids[0], values[0]) = (ID, 1);

        vm.startPrank(alice);
        vm.expectRevert(IAttendanceRegistry2.Soulbound.selector);
        registry.safeTransferFrom(alice, bob, ID, 1, "");
        vm.expectRevert(IAttendanceRegistry2.Soulbound.selector);
        registry.safeBatchTransferFrom(alice, bob, ids, values, "");
        vm.expectRevert(IAttendanceRegistry2.Soulbound.selector);
        registry.setApprovalForAll(bob, true);
        vm.stopPrank();
    }

    function test_supportsInterface() public view {
        assertTrue(registry.supportsInterface(type(IERC1155).interfaceId));
        assertTrue(registry.supportsInterface(type(IAccessControl).interfaceId));
        assertFalse(registry.supportsInterface(0xffffffff));
    }

    // ── Roles ───────────────────────────────────────────────────────────────

    function test_roles_officersCannotGrantOrRevoke() public {
        bytes32 admin = registry.ADMIN_ROLE();
        bytes32 relayRole = registry.RELAY_ROLE();
        vm.startPrank(officerA);
        vm.expectRevert(_unauthorized(officerA, bytes32(0)));
        registry.grantRole(admin, alice);
        vm.expectRevert(_unauthorized(officerA, bytes32(0)));
        registry.revokeRole(admin, officerB);
        vm.expectRevert(_unauthorized(officerA, bytes32(0)));
        registry.grantRole(relayRole, alice);
        vm.stopPrank();
    }

    function test_roles_officerFloorHoldsAgainstRevokeAndRenounce() public {
        bytes32 admin = registry.ADMIN_ROLE();
        vm.prank(address(timelock));
        vm.expectRevert(IAttendanceRegistry2.OfficerFloor.selector);
        registry.revokeRole(admin, officerA);
        vm.prank(officerA);
        vm.expectRevert(IAttendanceRegistry2.OfficerFloor.selector);
        registry.renounceRole(admin, officerA);

        // Grant before revoke: the swap an election proposal performs.
        vm.startPrank(address(timelock));
        registry.grantRole(admin, officerC);
        registry.revokeRole(admin, officerA);
        vm.stopPrank();
        assertEq(registry.getRoleMemberCount(admin), 2);
        assertFalse(registry.hasRole(admin, officerA));
    }

    function test_roles_renounceAllowedAboveTheFloor() public {
        bytes32 admin = registry.ADMIN_ROLE();
        vm.prank(address(timelock));
        registry.grantRole(admin, officerC);
        vm.prank(officerA);
        registry.renounceRole(admin, officerA);
        assertEq(registry.getRoleMemberCount(admin), 2);
    }

    function test_roles_revokingANonOfficerIsANoOp() public {
        bytes32 admin = registry.ADMIN_ROLE();
        vm.prank(address(timelock));
        registry.revokeRole(admin, alice);
        assertEq(registry.getRoleMemberCount(admin), 2);
    }

    function test_roles_adminLockedToTimelock() public {
        bytes32 admin = registry.DEFAULT_ADMIN_ROLE();
        vm.startPrank(address(timelock));
        vm.expectRevert(IAttendanceRegistry2.AdminLocked.selector);
        registry.grantRole(admin, alice);
        vm.expectRevert(IAttendanceRegistry2.AdminLocked.selector);
        registry.revokeRole(admin, address(timelock));
        vm.expectRevert(IAttendanceRegistry2.AdminLocked.selector);
        registry.renounceRole(admin, address(timelock));
        vm.stopPrank();
    }
}
