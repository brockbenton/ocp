// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC5805} from "@openzeppelin/contracts/interfaces/IERC5805.sol";
import {IERC6372} from "@openzeppelin/contracts/interfaces/IERC6372.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IAttendanceRegistry} from "./interfaces/IAttendanceRegistry.sol";
import {IClubRep} from "./interfaces/IClubRep.sol";
import {DecayMath} from "./libraries/DecayMath.sol";

/// @title ClubRep
/// @notice Non-transferable voting power that is earned and then decays with a fixed half-life.
///         There is no transfer, approval or delegation: every account votes for itself.
/// @dev An account's history, and the total's, is a list of checkpoints holding the balance as
///      of the moment it changed. A read at time `t` takes the last checkpoint at or before `t`
///      and decays it to `t`. A change decays the latest checkpoint to now, applies the change
///      and appends a checkpoint, so no read or write iterates over members or history, and a
///      past value can never change.
///
///      Checkpoints use OpenZeppelin's `Trace208`, keyed by timestamp. Because a read needs the
///      checkpoint's own timestamp, the 208-bit value packs `timestamp (48) | balance (160)`.
///      Balances and the total are capped at `type(uint128).max`.
///
///      Rounding: every operation rounds down, and the total is maintained separately from
///      the accounts. After n changes the two differ by at most a few base units (1e-18 Rep)
///      per change plus n * 4e-20 of the amounts involved. Such residue can outlive the Rep
///      that caused it (e.g. a total of a few thousand base units after every holder is
///      revoked), which is far too small to meet a proposal threshold or sway a quorum.
contract ClubRep is IClubRep, AccessControl {
    using Checkpoints for Checkpoints.Trace208;

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    /// @notice Nominal Rep for one verified attendance, in 18-decimal units.
    uint256 public constant REP_PER_CHECKIN = 10e18;
    uint256 public constant MIN_HALF_LIFE = 30 days;
    uint256 public constant MAX_HALF_LIFE = 3650 days;

    /// @notice The only account that may ever hold `DEFAULT_ADMIN_ROLE`.
    address public immutable TIMELOCK;
    IAttendanceRegistry public immutable LEGACY_REGISTRY;
    /// @notice Deployer that wires the registry and imports legacy attendance, until finalized.
    address public immutable IMPORTER;
    /// @notice Seconds for Rep to halve. Fixed so that past votes keep their meaning.
    uint256 public immutable HALF_LIFE;
    /// @notice Recognition time shared by all legacy imports.
    uint48 public immutable MIGRATION_RECOGNIZED_AT;

    address private s_registry;
    bool private s_importFinalized;
    mapping(address account => Checkpoints.Trace208) private s_balances;
    Checkpoints.Trace208 private s_totalSupply;
    mapping(address account => bool) private s_blocked;
    mapping(address account => bool) private s_imported;

    constructor(address timelock, address legacyRegistry, address importer, uint256 halfLife) {
        if (timelock == address(0) || legacyRegistry == address(0) || importer == address(0)) {
            revert ZeroAddress();
        }
        if (halfLife < MIN_HALF_LIFE || halfLife > MAX_HALF_LIFE) revert InvalidHalfLife();
        TIMELOCK = timelock;
        LEGACY_REGISTRY = IAttendanceRegistry(legacyRegistry);
        IMPORTER = importer;
        HALF_LIFE = halfLife;
        // Safe: timestamps fit in 48 bits.
        // forge-lint: disable-next-line(unsafe-typecast)
        MIGRATION_RECOGNIZED_AT = uint48(block.timestamp);
        _grantRole(DEFAULT_ADMIN_ROLE, timelock);
    }

    // -------------------------------------------------------------------------
    // Bootstrap (importer only, before finalization)
    // -------------------------------------------------------------------------

    modifier onlyImporter() {
        if (msg.sender != IMPORTER) revert NotImporter();
        if (s_importFinalized) revert ImportAlreadyFinalized();
        _;
    }

    /// @notice Gives the attendance registry the right to credit Rep. Callable once.
    function setRegistry(address registry_) external onlyImporter {
        if (registry_ == address(0)) revert ZeroAddress();
        if (s_registry != address(0)) revert RegistryAlreadySet();
        s_registry = registry_;
        _grantRole(MINTER_ROLE, registry_);
        emit RegistrySet(registry_);
    }

    /// @notice Credits accounts for attendance recorded on the frozen legacy registry.
    ///         Amounts are read from that contract, never supplied by the caller.
    /// @param legacySessionIds Strictly increasing ids of existing, closed legacy sessions.
    ///        An account is imported once, so pass every session it should be credited for.
    function importLegacy(address[] calldata accounts, uint256[] calldata legacySessionIds) external onlyImporter {
        uint256 sessionCount = legacySessionIds.length;
        if (sessionCount == 0) revert NoSessions();
        for (uint256 i = 0; i < sessionCount; ++i) {
            uint256 id = legacySessionIds[i];
            if (i != 0 && id <= legacySessionIds[i - 1]) revert SessionsNotIncreasing();
            IAttendanceRegistry.Session memory session = LEGACY_REGISTRY.getSession(id);
            if (session.date == 0) revert LegacySessionMissing(id);
            // A closed legacy session can never be minted into again.
            if (session.active) revert LegacySessionOpen(id);
        }

        address[] memory holder = new address[](sessionCount);
        uint256 added = 0;
        for (uint256 i = 0; i < accounts.length; ++i) {
            address account = accounts[i];
            if (s_imported[account]) revert AlreadyImported(account);
            s_imported[account] = true;

            for (uint256 j = 0; j < sessionCount; ++j) {
                holder[j] = account;
            }
            uint256[] memory balances = IERC1155(address(LEGACY_REGISTRY)).balanceOfBatch(holder, legacySessionIds);
            uint256 attendances = 0;
            for (uint256 j = 0; j < sessionCount; ++j) {
                // The legacy registry mints at most one token per session; hold it to that.
                if (balances[j] != 0) ++attendances;
            }
            if (attendances == 0) continue;

            uint256 nominal = attendances * REP_PER_CHECKIN;
            if (s_blocked[account]) {
                emit RepCreditSkipped(account, nominal, MIGRATION_RECOGNIZED_AT);
                continue;
            }
            uint256 amount = _decayedSince(nominal, MIGRATION_RECOGNIZED_AT);
            _increase(account, amount);
            added += amount;
            emit LegacyRepImported(account, attendances, nominal, amount);
        }
        _increaseTotal(added);
    }

    /// @notice Ends the import for good. Proposals are rejected until this has happened.
    function finalizeImport() external onlyImporter {
        if (s_registry == address(0)) revert RegistryNotSet();
        s_importFinalized = true;
        emit ImportFinalized();
    }

    // -------------------------------------------------------------------------
    // Attendance credit (registry only)
    // -------------------------------------------------------------------------

    /// @notice Awards `REP_PER_CHECKIN` to each account, decayed from `recognizedAt`.
    ///         Blocked accounts are skipped with an event so they cannot stall the others.
    function credit(address[] calldata accounts, uint48 recognizedAt) external onlyRole(MINTER_ROLE) {
        if (recognizedAt > block.timestamp) revert FutureRecognition();
        uint256 amount = _decayedSince(REP_PER_CHECKIN, recognizedAt);
        uint256 added = 0;
        for (uint256 i = 0; i < accounts.length; ++i) {
            address account = accounts[i];
            if (s_blocked[account]) {
                emit RepCreditSkipped(account, REP_PER_CHECKIN, recognizedAt);
                continue;
            }
            _increase(account, amount);
            added += amount;
            emit RepCredited(account, REP_PER_CHECKIN, amount, recognizedAt);
        }
        _increaseTotal(added);
    }

    // -------------------------------------------------------------------------
    // Governance (Timelock only)
    // -------------------------------------------------------------------------

    /// @notice Awards Rep that decays from now.
    function grant(address to, uint256 amount, string calldata reasonURI) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (s_blocked[to]) revert AccountBlocked(to);
        _increase(to, amount);
        _increaseTotal(amount);
        emit RepGranted(to, amount, reasonURI);
    }

    /// @notice Removes an account's remaining Rep and blocks further credit until cleared.
    ///         Snapshots taken earlier are unaffected.
    function revoke(address account, string calldata reasonURI) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        if (s_blocked[account]) revert AccountBlocked(account);
        s_blocked[account] = true;
        uint256 balance = getVotes(account);
        if (balance != 0) {
            uint256 total = totalSupply();
            // Independent rounding can leave the total a few units below the account.
            _write(s_totalSupply, total > balance ? total - balance : 0);
            _write(s_balances[account], 0);
            emit DelegateVotesChanged(account, balance, 0);
        }
        emit RepRevoked(account, balance, reasonURI);
    }

    /// @notice Lets a revoked account earn again. Revoked Rep is not restored.
    function unblock(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!s_blocked[account]) revert AccountNotBlocked(account);
        s_blocked[account] = false;
        emit RepUnblocked(account);
    }

    // -------------------------------------------------------------------------
    // IVotes / ERC-6372
    // -------------------------------------------------------------------------

    function clock() public view returns (uint48) {
        // Safe: timestamps fit in 48 bits.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint48(block.timestamp);
    }

    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() external pure returns (string memory) {
        return "mode=timestamp";
    }

    /// @notice Current, decayed voting power.
    function getVotes(address account) public view returns (uint256) {
        return _valueAt(s_balances[account].latest(), block.timestamp);
    }

    /// @notice Voting power as it stood at `timepoint`, which must be in the past.
    function getPastVotes(address account, uint256 timepoint) external view returns (uint256) {
        uint48 past = _requirePast(timepoint);
        return _valueAt(s_balances[account].upperLookupRecent(past), past);
    }

    /// @notice Total voting power as it stood at `timepoint`, which must be in the past.
    function getPastTotalSupply(uint256 timepoint) external view returns (uint256) {
        uint48 past = _requirePast(timepoint);
        return _valueAt(s_totalSupply.upperLookupRecent(past), past);
    }

    /// @notice Current decayed Rep. Not an ERC-20: nothing can move it.
    function balanceOf(address account) external view returns (uint256) {
        return getVotes(account);
    }

    /// @notice Current decayed total, not lifetime awards.
    function totalSupply() public view returns (uint256) {
        return _valueAt(s_totalSupply.latest(), block.timestamp);
    }

    function delegates(address account) external pure returns (address) {
        return account;
    }

    function delegate(address) external pure {
        revert DelegationDisabled();
    }

    function delegateBySig(address, uint256, uint256, uint8, bytes32, bytes32) external pure {
        revert DelegationDisabled();
    }

    // -------------------------------------------------------------------------
    // Metadata and views
    // -------------------------------------------------------------------------

    function name() external pure returns (string memory) {
        return "OCP Club Rep";
    }

    function symbol() external pure returns (string memory) {
        return "REP";
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function importFinalized() external view returns (bool) {
        return s_importFinalized;
    }

    function isBlocked(address account) external view returns (bool) {
        return s_blocked[account];
    }

    function isImported(address account) external view returns (bool) {
        return s_imported[account];
    }

    function registry() external view returns (address) {
        return s_registry;
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IVotes).interfaceId || interfaceId == type(IERC6372).interfaceId
            || super.supportsInterface(interfaceId);
    }

    // -------------------------------------------------------------------------
    // Role locks
    // -------------------------------------------------------------------------

    function _grantRole(bytes32 role, address account) internal override returns (bool) {
        if (role == DEFAULT_ADMIN_ROLE && account != TIMELOCK) revert AdminLocked();
        if (role == MINTER_ROLE && account != s_registry) revert MinterLocked();
        return super._grantRole(role, account);
    }

    function _revokeRole(bytes32 role, address account) internal override returns (bool) {
        if (role == DEFAULT_ADMIN_ROLE && account == TIMELOCK) revert AdminLocked();
        return super._revokeRole(role, account);
    }

    // -------------------------------------------------------------------------
    // Checkpoint accounting
    // -------------------------------------------------------------------------

    function _requirePast(uint256 timepoint) private view returns (uint48) {
        if (timepoint >= block.timestamp) revert ERC5805FutureLookup(timepoint, clock());
        // Safe: below the current timestamp, which fits in 48 bits.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint48(timepoint);
    }

    function _decayedSince(uint256 amount, uint256 since) private view returns (uint256) {
        return DecayMath.decay(SafeCast.toUint128(amount), block.timestamp - since, HALF_LIFE);
    }

    /// @dev Decays a packed checkpoint to `timepoint`, which is at or after its timestamp.
    function _valueAt(uint208 packed, uint256 timepoint) private view returns (uint256) {
        if (packed == 0) return 0;
        uint256 recordedAt = packed >> 160;
        // Truncation is intended: the balance occupies the low bits, below the timestamp.
        // forge-lint: disable-next-line(unsafe-typecast)
        return DecayMath.decay(uint128(packed), timepoint - recordedAt, HALF_LIFE);
    }

    function _write(Checkpoints.Trace208 storage trace, uint256 value) private {
        if (value > type(uint128).max) revert SupplyOverflow();
        uint48 nowTimestamp = clock();
        // Safe: value was just checked to fit in 128 bits.
        // forge-lint: disable-next-line(unsafe-typecast)
        trace.push(nowTimestamp, (uint208(nowTimestamp) << 160) | uint208(value));
    }

    /// @dev Account side of an increase. The caller adds the same amount to the total.
    function _increase(address account, uint256 amount) private {
        Checkpoints.Trace208 storage trace = s_balances[account];
        uint208 latest = trace.latest();
        // Every account is its own delegate; announce it once for vote indexers.
        if (trace.length() == 0) emit DelegateChanged(account, address(0), account);
        uint256 previous = _valueAt(latest, block.timestamp);
        _write(trace, previous + amount);
        emit DelegateVotesChanged(account, previous, previous + amount);
    }

    function _increaseTotal(uint256 amount) private {
        if (amount == 0) return;
        _write(s_totalSupply, totalSupply() + amount);
    }
}
