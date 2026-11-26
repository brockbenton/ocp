// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";
import {ClubBase} from "./ClubBase.sol";

/// @dev Drives proposals through the Governor and Timelock.
abstract contract GovernanceBase is ClubBase {
    struct Proposal {
        address[] targets;
        uint256[] values;
        bytes[] calldatas;
        string description;
        uint256 id;
    }

    uint8 internal constant AGAINST = 0;
    uint8 internal constant FOR = 1;

    function _action(address target, bytes memory data, string memory description)
        internal
        pure
        returns (Proposal memory p)
    {
        p.targets = new address[](1);
        p.values = new uint256[](1);
        p.calldatas = new bytes[](1);
        (p.targets[0], p.calldatas[0], p.description) = (target, data, description);
    }

    function _propose(Proposal memory p, address proposer) internal returns (uint256) {
        vm.prank(proposer);
        p.id = governor.propose(p.targets, p.values, p.calldatas, p.description);
        return p.id;
    }

    function _vote(uint256 id, address voter, uint8 support) internal {
        vm.prank(voter);
        governor.castVote(id, support);
    }

    function _state(uint256 id) internal view returns (IGovernor.ProposalState) {
        return governor.state(id);
    }

    function _toVoting() internal {
        skip(governor.votingDelay() + 1);
    }

    function _endVoting() internal {
        skip(governor.votingPeriod() + 1);
    }

    function _queue(Proposal memory p) internal {
        governor.queue(p.targets, p.values, p.calldatas, keccak256(bytes(p.description)));
    }

    function _execute(Proposal memory p) internal {
        governor.execute(p.targets, p.values, p.calldatas, keccak256(bytes(p.description)));
    }

    function _timelockId(Proposal memory p) internal view returns (bytes32) {
        bytes32 salt = bytes20(address(governor)) ^ keccak256(bytes(p.description));
        return timelock.hashOperationBatch(p.targets, p.values, p.calldatas, 0, salt);
    }

    /// @dev Propose, vote it through, queue and execute.
    function _pass(Proposal memory p, address proposer, address[] memory voters) internal {
        _propose(p, proposer);
        _toVoting();
        for (uint256 i = 0; i < voters.length; ++i) {
            _vote(p.id, voters[i], FOR);
        }
        _endVoting();
        _queue(p);
        skip(timelock.getMinDelay());
        _execute(p);
    }
}
