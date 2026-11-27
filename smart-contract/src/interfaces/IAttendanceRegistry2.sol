// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Officer-run sessions, soulbound attendance tokens and two-officer Rep sign-off.
interface IAttendanceRegistry2 {
    /// @dev `None` covers both a missing session and an open one.
    enum RepStatus {
        None,
        Pending,
        Confirmed,
        Rejected,
        Credited
    }

    enum SkipReason {
        InvalidRecipient,
        AlreadyCheckedIn,
        SessionFull
    }

    struct Session {
        uint64 date;
        uint16 maxAttendees;
        uint16 minted;
        string name;
        string semester;
        string metadataCid;
    }

    /// @dev Written when a session closes; `status != None` means it is closed.
    struct SignOff {
        bytes32 attendeesHash;
        address closer;
        uint48 recognizedAt;
        uint16 count;
        uint16 cursor;
        RepStatus status;
        address confirmer;
    }

    event SessionCreated(
        uint256 indexed sessionId,
        uint64 date,
        string name,
        string semester,
        uint16 maxAttendees,
        address indexed createdBy
    );
    event TokenMinted(address indexed to, uint256 indexed sessionId);
    event TokenMintSkipped(address indexed to, uint256 indexed sessionId, SkipReason reason);
    event SessionClosed(uint256 indexed sessionId, address indexed closer, bytes32 attendeesHash, address[] attendees);
    event SessionRepConfirmed(uint256 indexed sessionId, address indexed confirmer, uint48 recognizedAt, uint16 count);
    event SessionRepRejected(uint256 indexed sessionId, address indexed rejecter);
    event SessionRepPage(uint256 indexed sessionId, uint16 from, uint16 to);
    event SessionRepCredited(uint256 indexed sessionId);
    event BaseCidUpdated(string oldCid, string newCid);
    event SessionMetadataUpdated(uint256 indexed sessionId, string cid);
    event MintingPaused(address indexed officer, uint64 pausedUntil);
    event UnpauseApproved(address indexed officer);
    event MintingUnpaused(address indexed caller);

    error Soulbound();
    error ZeroAddress();
    error AdminLocked();
    error OfficerFloor();
    error InvalidOfficer(address account);
    error InvalidDate();
    error InvalidMaxAttendees();
    error SessionAlreadyExists();
    error SessionDoesNotExist();
    error SessionNotActive();
    error SessionFull();
    error AlreadyCheckedIn();
    error InvalidRecipient();
    error BatchTooLarge();
    error TooManyAttendees();
    error AttendeesNotIncreasing();
    error NotAttendee(address account);
    error NotOfficerOrTimelock(address caller);
    error NotPending();
    error NotConfirmed();
    error SameOfficer();
    error AttendeesMismatch();
    error WrongCursor(uint16 expected);
    error InvalidPage();
    error MintingIsPaused(uint64 pausedUntil);
    error MintingNotPaused();
    error PauseCooldown(uint256 availableAt);
    error AlreadyApproved();

    function createSession(
        uint256 id,
        uint64 date,
        string calldata name,
        string calldata semester,
        uint16 maxAttendees,
        string calldata metadataCid
    ) external;
    function mint(address to, uint256 sessionId) external;
    function mintBatch(address[] calldata to, uint256 sessionId) external;
    function closeSession(uint256 id, address[] calldata attendees) external;
    function confirmSessionRep(uint256 id) external;
    function rejectSessionRep(uint256 id) external;
    function creditSessionRep(uint256 id, address[] calldata attendees, uint16 from, uint16 to) external;
    function setBaseCid(string calldata baseCid) external;
    function setSessionMetadata(uint256 id, string calldata cid) external;
    function pauseMinting() external;
    function unpauseMinting() external;

    function getSession(uint256 id) external view returns (Session memory);
    function getSignOff(uint256 id) external view returns (SignOff memory);
    function pausedUntil() external view returns (uint64);
    function nextPauseAt(address officer) external view returns (uint256);
    function unpauseApprover() external view returns (address);
}
