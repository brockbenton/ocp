// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GovernanceBase} from "./helpers/GovernanceBase.sol";

/// @dev Forge cheatcode that makes an account's storage cold again.
interface VmCool {
    function cool(address target) external;
}

/// @notice Every officer, relay and member transaction must stay under 10M gas, including a
///         300-attendee meeting and reads after long inactivity. `isolate` runs each call as
///         its own transaction, so figures include intrinsic gas and cold storage.
///         Measurements are written to `snapshots/Phase5.json`.
/// forge-config: default.isolate = true
contract GasTest is GovernanceBase {
    uint256 private constant LIMIT = 10_000_000;
    string private constant GROUP = "Phase5";

    function _record(string memory name) private returns (uint256 gasUsed) {
        gasUsed = vm.snapshotGasLastCall(GROUP, name);
        assertLt(gasUsed, LIMIT, name);
    }

    function test_gas_meetingOf300() public {
        address[] memory attendees = _members(300);
        vm.prank(officerA);
        registry.createSession(1, uint64(block.timestamp), "Biggest meeting", "Fall 2026", 300, "");
        _record("createSession");

        vm.prank(relay);
        registry.mintBatch(_slice(attendees, 0, 200), 1);
        _record("mintBatch_200");
        vm.prank(relay);
        registry.mintBatch(_slice(attendees, 200, 300), 1);
        _record("mintBatch_100");

        vm.prank(officerA);
        registry.closeSession(1, attendees);
        _record("closeSession_300");
        vm.prank(officerB);
        registry.confirmSessionRep(1);
        _record("confirmSessionRep");

        registry.creditSessionRep(1, attendees, 0, 100);
        _record("creditPage_100_firstCredit_of300");
        registry.creditSessionRep(1, attendees, 100, 200);
        _record("creditPage_100_middle_of300");
        registry.creditSessionRep(1, attendees, 200, 300);
        _record("creditPage_100_last_of300");

        // The same members a long break later: every balance and the total must decay.
        skip(20 * 365 days);
        _meeting(2, _slice(attendees, 0, 100));
        _createSession(3, 100);
        _mintAll(3, _slice(attendees, 0, 100));
        _close(3, _slice(attendees, 0, 100));
        _confirm(3);
        skip(20 * 365 days);
        registry.creditSessionRep(3, _slice(attendees, 0, 100), 0, 100);
        _record("creditPage_100_afterLongInactivity");
    }

    function test_gas_singleTransactions() public {
        _createSession(1, 10);
        vm.prank(relay);
        registry.mint(alice, 1);
        _record("mint");
        _close(1, _list(alice));
        vm.prank(officerB);
        registry.rejectSessionRep(1);
        _record("rejectSessionRep");

        vm.prank(officerA);
        registry.pauseMinting();
        _record("pauseMinting");
        vm.prank(officerA);
        registry.unpauseMinting();
        vm.prank(officerB);
        registry.unpauseMinting();
        _record("unpauseMinting");

        vm.prank(address(timelock));
        rep.grant(alice, 100e18, "ipfs://r");
        _record("grant");
        skip(400 days);
        vm.prank(address(timelock));
        rep.grant(bob, 100e18, "ipfs://r");
        vm.prank(address(timelock));
        rep.revoke(alice, "ipfs://r");
        _record("revoke");
    }

    function test_gas_governance() public {
        _grant(alice, 200e18);
        skip(1);
        Proposal memory p = _action(address(rep), abi.encodeCall(rep.grant, (bob, 1e18, "r")), "grant");
        vm.prank(alice);
        p.id = governor.propose(p.targets, p.values, p.calldatas, p.description);
        _record("propose");
        _toVoting();
        vm.prank(alice);
        governor.castVote(p.id, FOR);
        _record("castVote");
        _endVoting();
        _queue(p);
        _record("queue");
        skip(2 days);
        _execute(p);
        _record("execute");
    }

    function test_gas_importBatch() public {
        // 20 legacy meetings and the default batch size for them.
        Legacy memory legacy = _emptyLegacy();
        address[] memory accounts = _members(_defaultBatchSize(20));
        legacy.sessionIds = new uint256[](20);
        for (uint256 id = 1; id <= 20; ++id) {
            _legacySession(id, accounts);
            legacy.sessionIds[id - 1] = id;
        }
        legacy.accounts = accounts;
        _freezeLegacy(legacy, address(this));
        _deploy(legacy);
        rep.importLegacy(accounts, legacy.sessionIds);
        _record("importLegacy_30accounts_20sessions");
    }

    /// @dev Historical reads are a binary search plus one decay, whatever the history length.
    function test_gas_historicalReads_boundedByLogOfHistory() public {
        for (uint256 i = 0; i < 8; ++i) {
            _creditOne(alice);
            skip(1 hours);
        }
        uint256 early = block.timestamp - 4 hours;
        skip(50 * 365 days);
        (uint256 votesShort, uint256 supplyShort, uint256 currentShort) = _readCosts(alice, early);

        for (uint256 i = 0; i < 1000; ++i) {
            _creditOne(alice);
            skip(1 hours);
        }
        early = block.timestamp - 500 hours;
        skip(50 * 365 days);
        (uint256 votesLong, uint256 supplyLong, uint256 currentLong) = _readCosts(alice, early);

        vm.snapshotValue(GROUP, "getPastVotes_8checkpoints", votesShort);
        vm.snapshotValue(GROUP, "getPastVotes_1008checkpoints", votesLong);
        vm.snapshotValue(GROUP, "getPastTotalSupply_1008checkpoints", supplyLong);
        vm.snapshotValue(GROUP, "getVotes_1008checkpoints", currentLong);

        // 126 times the history costs about 7 more binary-search steps (~2.5k gas each).
        assertLt(votesLong, 60_000);
        assertLt(supplyLong, 60_000);
        assertLt(currentLong, 30_000);
        assertLt(votesLong, votesShort + 25_000);
        assertLt(supplyLong, supplyShort + 25_000);
        assertLt(currentLong, currentShort + 2_000);
    }

    function _creditOne(address account) private {
        vm.prank(address(registry));
        rep.credit(_list(account), uint48(block.timestamp));
    }

    function _readCosts(address account, uint256 at) private returns (uint256 past, uint256 supply, uint256 current) {
        VmCool(address(vm)).cool(address(rep));
        uint256 before = gasleft();
        rep.getPastVotes(account, at);
        past = before - gasleft();

        VmCool(address(vm)).cool(address(rep));
        before = gasleft();
        rep.getPastTotalSupply(at);
        supply = before - gasleft();

        VmCool(address(vm)).cool(address(rep));
        before = gasleft();
        rep.getVotes(account);
        current = before - gasleft();
    }
}
