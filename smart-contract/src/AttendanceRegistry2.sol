// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {AccessControlEnumerable} from "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {IAttendanceRegistry2} from "./interfaces/IAttendanceRegistry2.sol";
import {IClubRep} from "./interfaces/IClubRep.sol";

/// @title AttendanceRegistry2
/// @notice Officers run meetings; a relay mints soulbound attendance tokens, which carry no
///         voting power; Rep is credited only after a second officer confirms the list that
///         the first officer closed the session with.
/// @dev Roles: `DEFAULT_ADMIN_ROLE` is the Timelock alone and cannot move. `ADMIN_ROLE`
///      (officers, at least two) and `RELAY_ROLE` change only through governance.
///      No external calls reach attendees: tokens are minted without the receiver hook.
contract AttendanceRegistry2 is IAttendanceRegistry2, ERC1155, AccessControlEnumerable {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant RELAY_ROLE = keccak256("RELAY_ROLE");

    uint16 public constant MAX_ATTENDEES = 300;
    uint256 public constant MAX_MINT_BATCH = 200;
    uint256 public constant MAX_CREDIT_PAGE = 100;
    uint256 public constant MIN_OFFICERS = 2;
    uint64 public constant PAUSE_DURATION = 14 days;
    uint256 public constant PAUSE_COOLDOWN = 30 days;

    address public immutable TIMELOCK;
    IClubRep public immutable REP;

    string private s_baseCid;
    /// @dev `date == 0` means the session does not exist.
    mapping(uint256 sessionId => Session) private s_sessions;
    mapping(uint256 sessionId => SignOff) private s_signOffs;
    uint64 private s_pausedUntil;
    address private s_unpauseApprover;
    mapping(address officer => uint256) private s_lastPauseAt;

    constructor(address timelock, address rep, address[] memory officers, address relay, string memory baseCid)
        ERC1155("")
    {
        if (timelock == address(0) || rep == address(0) || relay == address(0)) revert ZeroAddress();
        TIMELOCK = timelock;
        REP = IClubRep(rep);
        s_baseCid = baseCid;
        _grantRole(DEFAULT_ADMIN_ROLE, timelock);
        _grantRole(RELAY_ROLE, relay);
        for (uint256 i = 0; i < officers.length; ++i) {
            if (officers[i] == address(0)) revert ZeroAddress();
            _grantRole(ADMIN_ROLE, officers[i]);
        }
        // Duplicates collapse into one member, so count the role rather than the array.
        if (getRoleMemberCount(ADMIN_ROLE) < MIN_OFFICERS) revert OfficerFloor();
    }

    modifier onlyOfficerOrTimelock() {
        if (msg.sender != TIMELOCK && !hasRole(ADMIN_ROLE, msg.sender)) {
            revert NotOfficerOrTimelock(msg.sender);
        }
        _;
    }

    // -------------------------------------------------------------------------
    // Sessions (officers)
    // -------------------------------------------------------------------------

    /// @notice Opens a session. There are no time limits: it stays open until closed.
    /// @param maxAttendees Cap on tokens for this session, chosen by the organizer.
    /// @param metadataCid Optional IPFS CID of this session's metadata JSON.
    function createSession(
        uint256 id,
        uint64 date,
        string calldata name,
        string calldata semester,
        uint16 maxAttendees,
        string calldata metadataCid
    ) external onlyRole(ADMIN_ROLE) {
        if (date == 0) revert InvalidDate();
        if (maxAttendees == 0 || maxAttendees > MAX_ATTENDEES) revert InvalidMaxAttendees();
        if (s_sessions[id].date != 0) revert SessionAlreadyExists();
        s_sessions[id] = Session({
            date: date, maxAttendees: maxAttendees, minted: 0, name: name, semester: semester, metadataCid: metadataCid
        });
        emit SessionCreated(id, date, name, semester, maxAttendees, msg.sender);
        if (bytes(metadataCid).length != 0) {
            emit SessionMetadataUpdated(id, metadataCid);
            // False positive: `uri` reads this contract's own storage.
            // forge-lint: disable-next-line(reentrancy-events)
            emit URI(uri(id), id);
        }
    }

    // -------------------------------------------------------------------------
    // Minting (relay)
    // -------------------------------------------------------------------------

    /// @notice Mints one attendance token; reverts if the account already holds it.
    function mint(address to, uint256 sessionId) external onlyRole(RELAY_ROLE) {
        Session storage session = _requireMintable(sessionId);
        if (to == address(0)) revert InvalidRecipient();
        if (balanceOf(to, sessionId) != 0) revert AlreadyCheckedIn();
        if (session.minted >= session.maxAttendees) revert SessionFull();
        ++session.minted;
        _mintAttendance(to, sessionId);
    }

    /// @notice Mints to many accounts, skipping (with an event) any that cannot receive one,
    ///         so a single bad entry never reverts the batch.
    function mintBatch(address[] calldata to, uint256 sessionId) external onlyRole(RELAY_ROLE) {
        if (to.length > MAX_MINT_BATCH) revert BatchTooLarge();
        Session storage session = _requireMintable(sessionId);
        uint16 minted = session.minted;
        uint16 max = session.maxAttendees;
        for (uint256 i = 0; i < to.length; ++i) {
            address account = to[i];
            if (account == address(0)) {
                emit TokenMintSkipped(account, sessionId, SkipReason.InvalidRecipient);
            } else if (balanceOf(account, sessionId) != 0) {
                emit TokenMintSkipped(account, sessionId, SkipReason.AlreadyCheckedIn);
            } else if (minted >= max) {
                emit TokenMintSkipped(account, sessionId, SkipReason.SessionFull);
            } else {
                ++minted;
                _mintAttendance(account, sessionId);
            }
        }
        session.minted = minted;
    }

    // -------------------------------------------------------------------------
    // Two-officer Rep sign-off
    // -------------------------------------------------------------------------

    /// @notice Step 1: closes the session with its attendee list. Rep becomes Pending.
    /// @param attendees Strictly increasing addresses, each holding this session's token.
    ///        Only their hash and count are stored; the list itself is in the event.
    function closeSession(uint256 id, address[] calldata attendees) external onlyRole(ADMIN_ROLE) {
        Session storage session = _requireOpen(id);
        uint256 count = attendees.length;
        if (count > session.minted) revert TooManyAttendees();
        address previous = address(0);
        for (uint256 i = 0; i < count; ++i) {
            address account = attendees[i];
            if (account <= previous) revert AttendeesNotIncreasing();
            if (balanceOf(account, id) == 0) revert NotAttendee(account);
            previous = account;
        }
        bytes32 attendeesHash = keccak256(abi.encode(attendees));
        s_signOffs[id] = SignOff({
            attendeesHash: attendeesHash,
            closer: msg.sender,
            recognizedAt: 0,
            // Safe: count <= session.minted, a uint16.
            // forge-lint: disable-next-line(unsafe-typecast)
            count: uint16(count),
            cursor: 0,
            status: RepStatus.Pending,
            confirmer: address(0)
        });
        emit SessionClosed(id, msg.sender, attendeesHash, attendees);
    }

    /// @notice Step 2: a different officer (or the Timelock) approves the list and fixes the
    ///         time from which every attendee's Rep decays.
    function confirmSessionRep(uint256 id) external onlyOfficerOrTimelock {
        SignOff storage signOff = s_signOffs[id];
        if (signOff.status != RepStatus.Pending) revert NotPending();
        if (msg.sender == signOff.closer) revert SameOfficer();
        // Safe: timestamps fit in 48 bits.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint48 recognizedAt = uint48(block.timestamp);
        uint16 count = signOff.count;
        signOff.recognizedAt = recognizedAt;
        signOff.confirmer = msg.sender;
        signOff.status = count == 0 ? RepStatus.Credited : RepStatus.Confirmed;
        emit SessionRepConfirmed(id, msg.sender, recognizedAt, count);
        if (count == 0) emit SessionRepCredited(id);
    }

    /// @notice Voids a Pending session's Rep for good. Attendance tokens remain.
    function rejectSessionRep(uint256 id) external onlyOfficerOrTimelock {
        SignOff storage signOff = s_signOffs[id];
        if (signOff.status != RepStatus.Pending) revert NotPending();
        signOff.status = RepStatus.Rejected;
        emit SessionRepRejected(id, msg.sender);
    }

    /// @notice Step 3: credits attendees `[from, to)` of a confirmed session. Anyone may call.
    ///         Pages are sequential and cannot overlap, so a replay cannot credit twice.
    function creditSessionRep(uint256 id, address[] calldata attendees, uint16 from, uint16 to) external {
        SignOff storage signOff = s_signOffs[id];
        if (signOff.status != RepStatus.Confirmed) revert NotConfirmed();
        if (keccak256(abi.encode(attendees)) != signOff.attendeesHash) revert AttendeesMismatch();
        if (from != signOff.cursor) revert WrongCursor(signOff.cursor);
        if (to <= from || to > signOff.count || to - from > MAX_CREDIT_PAGE) revert InvalidPage();

        signOff.cursor = to;
        emit SessionRepPage(id, from, to);
        if (to == signOff.count) {
            signOff.status = RepStatus.Credited;
            emit SessionRepCredited(id);
        }
        REP.credit(attendees[from:to], signOff.recognizedAt);
    }

    // -------------------------------------------------------------------------
    // Metadata (officers)
    // -------------------------------------------------------------------------

    function setBaseCid(string calldata baseCid) external onlyRole(ADMIN_ROLE) {
        emit BaseCidUpdated(s_baseCid, baseCid);
        s_baseCid = baseCid;
    }

    function setSessionMetadata(uint256 id, string calldata cid) external onlyRole(ADMIN_ROLE) {
        if (s_sessions[id].date == 0) revert SessionDoesNotExist();
        s_sessions[id].metadataCid = cid;
        emit SessionMetadataUpdated(id, cid);
        // False positive: `uri` reads this contract's own storage.
        // forge-lint: disable-next-line(reentrancy-events)
        emit URI(uri(id), id);
    }

    // -------------------------------------------------------------------------
    // Pause (blocks minting only)
    // -------------------------------------------------------------------------

    /// @notice Stops minting for 14 days. Each officer may do this once per 30 days.
    function pauseMinting() external onlyRole(ADMIN_ROLE) {
        uint256 availableAt = nextPauseAt(msg.sender);
        if (block.timestamp < availableAt) revert PauseCooldown(availableAt);
        s_lastPauseAt[msg.sender] = block.timestamp;
        // Safe: timestamps fit in 64 bits.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 until = uint64(block.timestamp) + PAUSE_DURATION;
        s_pausedUntil = until;
        delete s_unpauseApprover;
        emit MintingPaused(msg.sender, until);
    }

    /// @notice Ends a pause early. The Timelock does it alone; officers need two of them:
    ///         the first call records an approval and the second, by another officer, unpauses.
    function unpauseMinting() external onlyOfficerOrTimelock {
        if (block.timestamp >= s_pausedUntil) revert MintingNotPaused();
        if (msg.sender != TIMELOCK) {
            address approver = s_unpauseApprover;
            if (approver == msg.sender) revert AlreadyApproved();
            // An approval lapses if its officer has since been removed.
            if (approver == address(0) || !hasRole(ADMIN_ROLE, approver)) {
                s_unpauseApprover = msg.sender;
                emit UnpauseApproved(msg.sender);
                return;
            }
        }
        s_pausedUntil = 0;
        delete s_unpauseApprover;
        emit MintingUnpaused(msg.sender);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function uri(uint256 id) public view override returns (string memory) {
        string memory cid = s_sessions[id].metadataCid;
        if (bytes(cid).length != 0) return string.concat("ipfs://", cid);
        return string.concat("ipfs://", s_baseCid, "/", Strings.toString(id), ".json");
    }

    function getSession(uint256 id) external view returns (Session memory) {
        return s_sessions[id];
    }

    function getSignOff(uint256 id) external view returns (SignOff memory) {
        return s_signOffs[id];
    }

    function pausedUntil() external view returns (uint64) {
        return s_pausedUntil;
    }

    /// @notice Earliest time `officer` may pause again (0 if they never have).
    function nextPauseAt(address officer) public view returns (uint256) {
        uint256 last = s_lastPauseAt[officer];
        return last == 0 ? 0 : last + PAUSE_COOLDOWN;
    }

    /// @notice Officer whose unpause approval is waiting for a second one.
    function unpauseApprover() external view returns (address) {
        return s_unpauseApprover;
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155, AccessControlEnumerable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    // -------------------------------------------------------------------------
    // Soulbound and role locks
    // -------------------------------------------------------------------------

    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values) internal override {
        if (from != address(0)) revert Soulbound();
        super._update(from, to, ids, values);
    }

    function _grantRole(bytes32 role, address account) internal override returns (bool) {
        if (role == DEFAULT_ADMIN_ROLE && account != TIMELOCK) revert AdminLocked();
        return super._grantRole(role, account);
    }

    /// @dev Covers both `revokeRole` and `renounceRole`.
    function _revokeRole(bytes32 role, address account) internal override returns (bool) {
        if (role == DEFAULT_ADMIN_ROLE && account == TIMELOCK) revert AdminLocked();
        if (role == ADMIN_ROLE && hasRole(role, account) && getRoleMemberCount(role) <= MIN_OFFICERS) {
            revert OfficerFloor();
        }
        return super._revokeRole(role, account);
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    function _requireOpen(uint256 id) private view returns (Session storage session) {
        session = s_sessions[id];
        if (session.date == 0) revert SessionDoesNotExist();
        if (s_signOffs[id].status != RepStatus.None) revert SessionNotActive();
    }

    function _requireMintable(uint256 id) private view returns (Session storage session) {
        if (block.timestamp < s_pausedUntil) revert MintingIsPaused(s_pausedUntil);
        return _requireOpen(id);
    }

    /// @dev Calls `_update` directly, skipping the ERC-1155 receiver hook.
    function _mintAttendance(address to, uint256 sessionId) private {
        uint256[] memory ids = new uint256[](1);
        uint256[] memory values = new uint256[](1);
        ids[0] = sessionId;
        values[0] = 1;
        _update(address(0), to, ids, values);
        emit TokenMinted(to, sessionId);
    }
}
