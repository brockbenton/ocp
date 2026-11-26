// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Governor} from "@openzeppelin/contracts/governance/Governor.sol";
import {GovernorSettings} from "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import {GovernorCountingSimple} from "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import {GovernorVotes} from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import {
    GovernorVotesQuorumFraction
} from "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import {GovernorTimelockControl} from "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IClubRep} from "./interfaces/IClubRep.sol";

/// @title ClubGovernor
/// @notice Rep-weighted voting. Weights and quorum are fixed at each proposal's snapshot.
///         Every setting governance can change is bounded on-chain.
contract ClubGovernor is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorTimelockControl
{
    uint48 public constant MIN_VOTING_DELAY = 1 hours;
    uint48 public constant MAX_VOTING_DELAY = 7 days;
    uint32 public constant MIN_VOTING_PERIOD = 3 days;
    uint32 public constant MAX_VOTING_PERIOD = 14 days;
    uint256 public constant MIN_PROPOSAL_THRESHOLD = 10e18;
    uint256 public constant MAX_PROPOSAL_THRESHOLD = 1_000e18;
    uint256 public constant MIN_QUORUM_NUMERATOR = 5;
    uint256 public constant MAX_QUORUM_NUMERATOR = 30;

    /// @notice Participation floor, in Rep units. Never above half the snapshot supply.
    uint256 public immutable MIN_QUORUM;

    struct Settings {
        uint48 votingDelay;
        uint32 votingPeriod;
        uint256 proposalThreshold;
        uint256 quorumNumerator;
        uint256 minQuorum;
    }

    error VotingDelayOutOfBounds(uint256 votingDelay);
    error VotingPeriodOutOfBounds(uint256 votingPeriod);
    error ProposalThresholdOutOfBounds(uint256 proposalThreshold);
    error QuorumNumeratorOutOfBounds(uint256 quorumNumerator);
    error InvalidMinQuorum();
    error ImportNotFinalized();
    error TimelockIsFixed();

    constructor(IClubRep rep, TimelockController timelock, Settings memory settings)
        Governor("OCP Club Governor")
        GovernorSettings(settings.votingDelay, settings.votingPeriod, settings.proposalThreshold)
        GovernorVotes(rep)
        GovernorVotesQuorumFraction(settings.quorumNumerator)
        GovernorTimelockControl(timelock)
    {
        if (settings.minQuorum == 0) revert InvalidMinQuorum();
        MIN_QUORUM = settings.minQuorum;
    }

    /// @notice `max(numerator * supply, min(MIN_QUORUM, supply / 2))` at the snapshot, where
    ///         supply is the decayed total. Reachable whenever the supply is positive.
    function quorum(uint256 timepoint) public view override(Governor, GovernorVotesQuorumFraction) returns (uint256) {
        uint256 supply = token().getPastTotalSupply(timepoint);
        uint256 fraction = (supply * quorumNumerator(timepoint)) / quorumDenominator();
        return Math.max(fraction, Math.min(MIN_QUORUM, supply / 2));
    }

    /// @notice Proposals wait until legacy attendance has been imported.
    function propose(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description
    ) public override returns (uint256) {
        if (!IClubRep(address(token())).importFinalized()) revert ImportNotFinalized();
        return super.propose(targets, values, calldatas, description);
    }

    /// @dev The registry and Rep are permanently administered by the original Timelock, so
    ///      pointing the Governor elsewhere would end governance.
    function updateTimelock(TimelockController) external pure override {
        revert TimelockIsFixed();
    }

    // -------------------------------------------------------------------------
    // Bounded settings
    // -------------------------------------------------------------------------

    function _setVotingDelay(uint48 newVotingDelay) internal override {
        if (newVotingDelay < MIN_VOTING_DELAY || newVotingDelay > MAX_VOTING_DELAY) {
            revert VotingDelayOutOfBounds(newVotingDelay);
        }
        super._setVotingDelay(newVotingDelay);
    }

    function _setVotingPeriod(uint32 newVotingPeriod) internal override {
        if (newVotingPeriod < MIN_VOTING_PERIOD || newVotingPeriod > MAX_VOTING_PERIOD) {
            revert VotingPeriodOutOfBounds(newVotingPeriod);
        }
        super._setVotingPeriod(newVotingPeriod);
    }

    function _setProposalThreshold(uint256 newProposalThreshold) internal override {
        if (newProposalThreshold < MIN_PROPOSAL_THRESHOLD || newProposalThreshold > MAX_PROPOSAL_THRESHOLD) {
            revert ProposalThresholdOutOfBounds(newProposalThreshold);
        }
        super._setProposalThreshold(newProposalThreshold);
    }

    function _updateQuorumNumerator(uint256 newQuorumNumerator) internal override {
        if (newQuorumNumerator < MIN_QUORUM_NUMERATOR || newQuorumNumerator > MAX_QUORUM_NUMERATOR) {
            revert QuorumNumeratorOutOfBounds(newQuorumNumerator);
        }
        super._updateQuorumNumerator(newQuorumNumerator);
    }

    // -------------------------------------------------------------------------
    // Overrides required by Solidity
    // -------------------------------------------------------------------------

    function votingDelay() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingDelay();
    }

    function votingPeriod() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingPeriod();
    }

    function proposalThreshold() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.proposalThreshold();
    }

    function state(uint256 proposalId) public view override(Governor, GovernorTimelockControl) returns (ProposalState) {
        return super.state(proposalId);
    }

    function proposalNeedsQueuing(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (bool)
    {
        return super.proposalNeedsQueuing(proposalId);
    }

    function _queueOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint48) {
        return super._queueOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _executeOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) {
        super._executeOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint256) {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }

    function _executor() internal view override(Governor, GovernorTimelockControl) returns (address) {
        return super._executor();
    }
}
