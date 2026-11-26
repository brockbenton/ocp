// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC5805} from "@openzeppelin/contracts/interfaces/IERC5805.sol";

/// @notice Soulbound, decay-aware voting power earned by verified attendance.
interface IClubRep is IERC5805 {
    event RegistrySet(address indexed registry);
    /// @param nominalAmount Rep as awarded. @param amount Rep after decay since `recognizedAt`.
    event RepCredited(address indexed account, uint256 nominalAmount, uint256 amount, uint48 recognizedAt);
    event RepCreditSkipped(address indexed account, uint256 nominalAmount, uint48 recognizedAt);
    event RepGranted(address indexed account, uint256 amount, string reasonURI);
    event RepRevoked(address indexed account, uint256 amount, string reasonURI);
    event RepUnblocked(address indexed account);
    event LegacyRepImported(address indexed account, uint256 attendances, uint256 nominalAmount, uint256 amount);
    event ImportFinalized();

    /// @dev Same signature as OpenZeppelin `Votes`, which vote tooling recognizes.
    error ERC5805FutureLookup(uint256 timepoint, uint48 clock);
    error AdminLocked();
    error MinterLocked();
    error DelegationDisabled();
    error NotImporter();
    error ImportAlreadyFinalized();
    error RegistryAlreadySet();
    error RegistryNotSet();
    error ZeroAddress();
    error ZeroAmount();
    error InvalidHalfLife();
    error SupplyOverflow();
    error FutureRecognition();
    error AccountBlocked(address account);
    error AccountNotBlocked(address account);
    error AlreadyImported(address account);
    error NoSessions();
    error SessionsNotIncreasing();
    error LegacySessionMissing(uint256 sessionId);
    error LegacySessionOpen(uint256 sessionId);

    function REP_PER_CHECKIN() external view returns (uint256);
    function credit(address[] calldata accounts, uint48 recognizedAt) external;
    function grant(address to, uint256 amount, string calldata reasonURI) external;
    function revoke(address account, string calldata reasonURI) external;
    function unblock(address account) external;
    function setRegistry(address registry_) external;
    function importLegacy(address[] calldata accounts, uint256[] calldata legacySessionIds) external;
    function finalizeImport() external;

    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function importFinalized() external view returns (bool);
    function isBlocked(address account) external view returns (bool);
    function isImported(address account) external view returns (bool);
    function registry() external view returns (address);
}
