// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title ClubTimelock
/// @notice OpenZeppelin Timelock with a bounded delay and a bootstrap guardian that can only
///         cancel queued operations, for at most 120 days.
/// @dev The Timelock administers itself. During deployment the deployer is a temporary admin
///      so it can give the Governor its roles, and renounces afterwards.
contract ClubTimelock is TimelockController {
    uint256 public constant MIN_DELAY_FLOOR = 1 days;
    uint256 public constant MIN_DELAY_CEILING = 7 days;
    uint256 public constant MAX_GUARDIAN_TERM = 120 days;

    /// @notice Holder of `CANCELLER_ROLE` during bootstrap.
    address public immutable GUARDIAN;
    /// @notice From this time anyone may remove the guardian.
    uint256 public immutable GUARDIAN_EXPIRY;

    uint256 private s_minDelay;

    event GuardianExpired(address indexed guardian);

    error DelayOutOfBounds(uint256 delay);
    error InvalidGuardian();
    error InvalidGuardianExpiry();
    error GuardianNotExpired(uint256 expiry);

    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin,
        address guardian,
        uint256 guardianExpiry
    ) TimelockController(minDelay, proposers, executors, admin) {
        _requireDelayInBounds(minDelay);
        if (guardian == address(0)) revert InvalidGuardian();
        // A proposer is also a canceller; the guardian must only ever be the latter.
        for (uint256 i = 0; i < proposers.length; ++i) {
            if (proposers[i] == guardian) revert InvalidGuardian();
        }
        if (guardianExpiry <= block.timestamp || guardianExpiry > block.timestamp + MAX_GUARDIAN_TERM) {
            revert InvalidGuardianExpiry();
        }
        s_minDelay = minDelay;
        GUARDIAN = guardian;
        GUARDIAN_EXPIRY = guardianExpiry;
        _grantRole(CANCELLER_ROLE, guardian);
    }

    /// @notice Revokes the guardian once its term is over. Callable by anyone, so a guardian
    ///         cannot keep itself in place by cancelling the proposal that would remove it.
    function expireGuardian() external {
        if (block.timestamp < GUARDIAN_EXPIRY) revert GuardianNotExpired(GUARDIAN_EXPIRY);
        if (_revokeRole(CANCELLER_ROLE, GUARDIAN)) emit GuardianExpired(GUARDIAN);
    }

    function getMinDelay() public view override returns (uint256) {
        return s_minDelay;
    }

    /// @dev Same authority as the base contract (only the Timelock itself), plus bounds.
    ///      The base keeps its delay private, so this contract stores its own.
    function updateDelay(uint256 newDelay) external override {
        if (msg.sender != address(this)) revert TimelockUnauthorizedCaller(msg.sender);
        _requireDelayInBounds(newDelay);
        emit MinDelayChange(s_minDelay, newDelay);
        s_minDelay = newDelay;
    }

    function _requireDelayInBounds(uint256 delay) private pure {
        if (delay < MIN_DELAY_FLOOR || delay > MIN_DELAY_CEILING) revert DelayOutOfBounds(delay);
    }
}
