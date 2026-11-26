// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {ClubGovernor} from "../src/ClubGovernor.sol";
import {IClubRep} from "../src/interfaces/IClubRep.sol";
import {GovernanceBase} from "./helpers/GovernanceBase.sol";

contract ClubGovernorTest is GovernanceBase {
    address private voterKey;
    uint256 private voterPk;

    function setUp() public override {
        super.setUp();
        (voterKey, voterPk) = makeAddrAndKey("voter");
        _grant(alice, 60e18);
        _grant(bob, 60e18);
        _grant(voterKey, 40e18);
        skip(1);
    }

    function _noop(string memory description) private view returns (Proposal memory) {
        return _action(address(governor), abi.encodeCall(ClubGovernor.quorum, (1)), description);
    }

    function test_setters_onlyThroughGovernance() public {
        vm.expectRevert(abi.encodeWithSelector(IGovernor.GovernorOnlyExecutor.selector, officerA));
        vm.prank(officerA);
        governor.setProposalThreshold(10e18);
        // Even the Timelock cannot apply a change that no proposal queued.
        vm.expectRevert();
        vm.prank(address(timelock));
        governor.setProposalThreshold(10e18);
    }

    function _setting(bytes memory data, string memory description) private view returns (Proposal memory) {
        return _action(address(governor), data, description);
    }

    // ── Settings ────────────────────────────────────────────────────────────

    function test_defaults() public view {
        assertEq(governor.name(), "OCP Club Governor");
        assertEq(governor.votingDelay(), 1 days);
        assertEq(governor.votingPeriod(), 7 days);
        assertEq(governor.proposalThreshold(), 30e18);
        assertEq(governor.quorumNumerator(), 10);
        assertEq(governor.MIN_QUORUM(), 100e18);
        assertEq(governor.CLOCK_MODE(), "mode=timestamp");
        assertEq(address(governor.token()), address(rep));
        assertEq(governor.timelock(), address(timelock));
        assertEq(timelock.getMinDelay(), 2 days);
    }

    function test_constructor_enforcesBounds() public {
        ClubGovernor.Settings memory s = _defaultSettings();
        s.votingDelay = 1 hours - 1;
        vm.expectRevert(abi.encodeWithSelector(ClubGovernor.VotingDelayOutOfBounds.selector, 1 hours - 1));
        new ClubGovernor(rep, timelock, s);

        s = _defaultSettings();
        s.votingPeriod = 14 days + 1;
        vm.expectRevert(abi.encodeWithSelector(ClubGovernor.VotingPeriodOutOfBounds.selector, 14 days + 1));
        new ClubGovernor(rep, timelock, s);

        s = _defaultSettings();
        s.proposalThreshold = 9e18;
        vm.expectRevert(abi.encodeWithSelector(ClubGovernor.ProposalThresholdOutOfBounds.selector, 9e18));
        new ClubGovernor(rep, timelock, s);

        s = _defaultSettings();
        s.quorumNumerator = 31;
        vm.expectRevert(abi.encodeWithSelector(ClubGovernor.QuorumNumeratorOutOfBounds.selector, 31));
        new ClubGovernor(rep, timelock, s);

        s = _defaultSettings();
        s.minQuorum = 0;
        vm.expectRevert(ClubGovernor.InvalidMinQuorum.selector);
        new ClubGovernor(rep, timelock, s);
    }

    function test_setters_eachBoundRejectsBothSides() public {
        bytes[8] memory bad = [
            abi.encodeCall(governor.setVotingDelay, (1 hours - 1)),
            abi.encodeCall(governor.setVotingDelay, (7 days + 1)),
            abi.encodeCall(governor.setVotingPeriod, (3 days - 1)),
            abi.encodeCall(governor.setVotingPeriod, (14 days + 1)),
            abi.encodeCall(governor.setProposalThreshold, (10e18 - 1)),
            abi.encodeCall(governor.setProposalThreshold, (1_000e18 + 1)),
            abi.encodeCall(governor.updateQuorumNumerator, (4)),
            abi.encodeCall(governor.updateQuorumNumerator, (31))
        ];
        bytes4[8] memory errors = [
            ClubGovernor.VotingDelayOutOfBounds.selector,
            ClubGovernor.VotingDelayOutOfBounds.selector,
            ClubGovernor.VotingPeriodOutOfBounds.selector,
            ClubGovernor.VotingPeriodOutOfBounds.selector,
            ClubGovernor.ProposalThresholdOutOfBounds.selector,
            ClubGovernor.ProposalThresholdOutOfBounds.selector,
            ClubGovernor.QuorumNumeratorOutOfBounds.selector,
            ClubGovernor.QuorumNumeratorOutOfBounds.selector
        ];
        for (uint256 i = 0; i < bad.length; ++i) {
            uint256 snapshot = vm.snapshotState();
            Proposal memory p = _setting(bad[i], "bad setting");
            _propose(p, alice);
            _toVoting();
            _vote(p.id, alice, FOR);
            _vote(p.id, bob, FOR);
            _endVoting();
            _queue(p);
            skip(2 days);
            vm.expectPartialRevert(errors[i]);
            _execute(p);
            assertEq(governor.quorumNumerator(), 10);
            vm.revertToState(snapshot);
        }
    }

    function test_setters_applyWithinBounds() public {
        Proposal memory p;
        p.targets = new address[](5);
        p.values = new uint256[](5);
        p.calldatas = new bytes[](5);
        p.description = "tune";
        for (uint256 i = 0; i < 4; ++i) {
            p.targets[i] = address(governor);
        }
        p.targets[4] = address(timelock);
        p.calldatas[0] = abi.encodeCall(governor.setVotingDelay, (1 hours));
        p.calldatas[1] = abi.encodeCall(governor.setVotingPeriod, (14 days));
        p.calldatas[2] = abi.encodeCall(governor.setProposalThreshold, (1_000e18));
        p.calldatas[3] = abi.encodeCall(governor.updateQuorumNumerator, (30));
        p.calldatas[4] = abi.encodeCall(timelock.updateDelay, (7 days));

        address[] memory voters = new address[](2);
        (voters[0], voters[1]) = (alice, bob);
        _pass(p, alice, voters);

        assertEq(governor.votingDelay(), 1 hours);
        assertEq(governor.votingPeriod(), 14 days);
        assertEq(governor.proposalThreshold(), 1_000e18);
        assertEq(governor.quorumNumerator(), 30);
        assertEq(timelock.getMinDelay(), 7 days);
    }

    function test_updateTimelock_isDisabled() public {
        vm.expectRevert(ClubGovernor.TimelockIsFixed.selector);
        governor.updateTimelock(TimelockController(payable(alice)));
    }

    // ── Proposing ───────────────────────────────────────────────────────────

    function test_propose_requiresFinalizedImport() public {
        // A second club that stops before finalization.
        Legacy memory legacy = _emptyLegacy();
        _freezeLegacy(legacy, address(this));
        _deploy(legacy);
        Proposal memory p = _noop("early");
        vm.expectRevert(ClubGovernor.ImportNotFinalized.selector);
        governor.propose(p.targets, p.values, p.calldatas, p.description);
    }

    function test_propose_thresholdUsesDecayedPower() public {
        address newcomer = makeAddr("newcomer");
        _grant(newcomer, 30e18);
        // Power is read at `clock() - 1`: one second later that is the grant itself.
        skip(1);
        uint256 snapshot = vm.snapshotState();
        _propose(_noop("in time"), newcomer);
        vm.revertToState(snapshot);

        // A second later it reads one second of decay, which is already below 30 Rep.
        skip(1);
        Proposal memory p = _noop("too late");
        vm.prank(newcomer);
        vm.expectPartialRevert(IGovernor.GovernorInsufficientProposerVotes.selector);
        governor.propose(p.targets, p.values, p.calldatas, p.description);

        _grant(newcomer, 1e18);
        skip(1);
        _propose(p, newcomer);
        assertTrue(_state(p.id) == IGovernor.ProposalState.Pending);
    }

    function test_propose_afterALongBreakNobodyQualifiesUntilNewAttendance() public {
        // Documents the current behavior that needs an owner decision (#52): after a long
        // break every account is below the threshold, and there is no officer bypass.
        skip(2 * HALF_LIFE);
        Proposal memory p = _noop("after summer");
        vm.prank(alice);
        vm.expectPartialRevert(IGovernor.GovernorInsufficientProposerVotes.selector);
        governor.propose(p.targets, p.values, p.calldatas, p.description);

        // Recovery path: officers do not depend on Rep, so meetings restore eligibility.
        for (uint256 id = 1; id <= 2; ++id) {
            _meeting(id, _list(alice));
        }
        skip(1);
        _propose(p, alice);
    }

    // ── Quorum ──────────────────────────────────────────────────────────────

    function _quorumFor(uint256 supply) private returns (uint256) {
        _revoke(alice);
        _revoke(bob);
        _revoke(voterKey);
        // Clear the rounding residue so the supply is exactly what is granted.
        skip(130 * HALF_LIFE);
        if (supply != 0) _grant(carol, supply);
        uint256 at = block.timestamp;
        skip(1);
        return governor.quorum(at);
    }

    function test_quorum_zeroSupply() public {
        assertEq(_quorumFor(0), 0);
    }

    function test_quorum_dustSupply_roundsDown() public {
        assertEq(_quorumFor(1), 0);
    }

    function test_quorum_smallSupply_isHalf() public {
        assertEq(_quorumFor(3), 1);
    }

    function test_quorum_belowTwiceTheFloor_isHalf() public {
        assertEq(_quorumFor(150e18), 75e18);
    }

    function test_quorum_midSupply_isTheFloor() public {
        assertEq(_quorumFor(600e18), 100e18);
    }

    function test_quorum_largeSupply_isTheFraction() public {
        assertEq(_quorumFor(5_000e18), 500e18);
    }

    function testFuzz_quorum_matchesTheFormulaAndNeverExceedsHalf(uint256 supply) public {
        supply = bound(supply, 1, 1e30);
        uint256 q = _quorumFor(supply);
        uint256 snapshotSupply = rep.getPastTotalSupply(block.timestamp - 1);
        uint256 fraction = (snapshotSupply * 10) / 100;
        uint256 floor = snapshotSupply / 2 < 100e18 ? snapshotSupply / 2 : 100e18;
        assertEq(q, fraction > floor ? fraction : floor);
        assertLe(q, snapshotSupply / 2);
    }

    function test_quorum_usesDecayedSnapshotSupply() public {
        _grant(carol, 4_000e18);
        skip(HALF_LIFE);
        uint256 at = block.timestamp;
        skip(1);
        assertEq(governor.quorum(at), rep.getPastTotalSupply(at) / 10);
        assertApproxEqRel(governor.quorum(at), 208e18, 0.001e18);
    }

    function test_zeroSupplySnapshot_defeatsTheProposal() public {
        Proposal memory p = _noop("revoked before snapshot");
        _propose(p, alice);
        _revoke(alice);
        _revoke(bob);
        _revoke(voterKey);
        _toVoting();
        _endVoting();
        assertTrue(_state(p.id) == IGovernor.ProposalState.Defeated);
    }

    // ── Snapshots ───────────────────────────────────────────────────────────

    function test_snapshot_weightAndQuorumAreFixed() public {
        Proposal memory p = _noop("snapshot");
        _propose(p, alice);
        _toVoting();
        uint256 snapshot = governor.proposalSnapshot(p.id);
        uint256 weight = governor.getVotes(bob, snapshot);
        uint256 quorum = governor.quorum(snapshot);

        // Everything that can move live power happens after the snapshot.
        _revoke(bob);
        _grant(carol, 10_000e18);
        skip(3 days);

        assertEq(governor.quorum(snapshot), quorum);
        _vote(p.id, bob, FOR);
        _vote(p.id, carol, AGAINST);
        (uint256 against, uint256 forVotes,) = governor.proposalVotes(p.id);
        assertEq(forVotes, weight);
        assertEq(against, 0);
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────

    function test_vote_bySignature_submittedByAnyone() public {
        Proposal memory p = _noop("gasless");
        _propose(p, alice);
        _toVoting();

        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("OCP Club Governor"),
                keccak256("1"),
                block.chainid,
                address(governor)
            )
        );
        bytes32 ballot =
            keccak256(abi.encode(governor.BALLOT_TYPEHASH(), p.id, FOR, voterKey, governor.nonces(voterKey)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(voterPk, keccak256(abi.encodePacked("\x19\x01", domain, ballot)));
        bytes memory signature = abi.encodePacked(r, s, v);

        // The relay cannot change the choice.
        vm.prank(relay);
        vm.expectRevert(abi.encodeWithSelector(IGovernor.GovernorInvalidSignature.selector, voterKey));
        governor.castVoteBySig(p.id, AGAINST, voterKey, signature);

        // Any wallet can submit it, for example an officer's.
        vm.prank(officerB);
        governor.castVoteBySig(p.id, FOR, voterKey, signature);
        assertTrue(governor.hasVoted(p.id, voterKey));

        // And it cannot be replayed.
        vm.expectRevert();
        governor.castVoteBySig(p.id, FOR, voterKey, signature);
    }

    function test_officerElection_grantsThenRevokes() public {
        bytes32 admin = registry.ADMIN_ROLE();
        Proposal memory p;
        p.targets = new address[](2);
        p.values = new uint256[](2);
        p.calldatas = new bytes[](2);
        p.description = "new term";
        p.targets[0] = address(registry);
        p.targets[1] = address(registry);
        p.calldatas[0] = abi.encodeCall(registry.grantRole, (admin, officerC));
        p.calldatas[1] = abi.encodeCall(registry.revokeRole, (admin, officerA));

        address[] memory voters = new address[](2);
        (voters[0], voters[1]) = (alice, bob);
        _pass(p, alice, voters);

        assertTrue(registry.hasRole(admin, officerC));
        assertFalse(registry.hasRole(admin, officerA));
        assertTrue(_state(p.id) == IGovernor.ProposalState.Executed);
    }

    function test_relayRotation_fitsInsideOnePause() public {
        vm.prank(officerA);
        registry.pauseMinting();
        uint256 pausedUntil = registry.pausedUntil();
        address newRelay = makeAddr("newRelay");
        bytes32 role = registry.RELAY_ROLE();

        Proposal memory p;
        p.targets = new address[](2);
        p.values = new uint256[](2);
        p.calldatas = new bytes[](2);
        p.description = "rotate relay";
        p.targets[0] = address(registry);
        p.targets[1] = address(registry);
        p.calldatas[0] = abi.encodeCall(registry.revokeRole, (role, relay));
        p.calldatas[1] = abi.encodeCall(registry.grantRole, (role, newRelay));
        address[] memory voters = new address[](2);
        (voters[0], voters[1]) = (alice, bob);
        _pass(p, alice, voters);

        assertLt(block.timestamp, pausedUntil);
        assertFalse(registry.hasRole(role, relay));
        assertTrue(registry.hasRole(role, newRelay));
    }

    function test_repRevocationByProposal() public {
        Proposal memory p = _action(address(rep), abi.encodeCall(IClubRep.revoke, (bob, "ipfs://why")), "revoke bob");
        address[] memory voters = new address[](2);
        (voters[0], voters[1]) = (alice, bob);
        _pass(p, alice, voters);
        assertEq(rep.getVotes(bob), 0);
        assertTrue(rep.isBlocked(bob));
    }

    function test_executionWaitsForTheTimelock() public {
        Proposal memory p = _noop("wait");
        _propose(p, alice);
        _toVoting();
        _vote(p.id, alice, FOR);
        _vote(p.id, bob, FOR);
        _endVoting();
        assertTrue(_state(p.id) == IGovernor.ProposalState.Succeeded);
        _queue(p);
        skip(2 days - 1);
        vm.expectRevert();
        _execute(p);
        skip(1);
        _execute(p);
    }

    function test_guardian_canVetoDuringBootstrapOnly() public {
        Proposal memory p = _noop("vetoed");
        _propose(p, alice);
        _toVoting();
        _vote(p.id, alice, FOR);
        _vote(p.id, bob, FOR);
        _endVoting();
        _queue(p);
        bytes32 operation = _timelockId(p);
        vm.prank(guardian);
        timelock.cancel(operation);
        assertTrue(_state(p.id) == IGovernor.ProposalState.Canceled);

        skip(120 days);
        timelock.expireGuardian();
        _grant(alice, 60e18);
        _grant(bob, 60e18);
        skip(1);
        Proposal memory next = _noop("after bootstrap");
        _propose(next, alice);
        _toVoting();
        _vote(next.id, alice, FOR);
        _vote(next.id, bob, FOR);
        _endVoting();
        _queue(next);
        bytes32 nextOperation = _timelockId(next);
        vm.prank(guardian);
        vm.expectRevert();
        timelock.cancel(nextOperation);
        skip(2 days);
        _execute(next);
    }
}
