// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {AttendanceRegistry} from "../../src/AttendanceRegistry.sol";
import {AttendanceRegistry2} from "../../src/AttendanceRegistry2.sol";
import {ClubGovernor} from "../../src/ClubGovernor.sol";
import {ClubRep} from "../../src/ClubRep.sol";
import {ClubTimelock} from "../../src/ClubTimelock.sol";
import {ClubDeployment} from "../../script/ClubDeployment.sol";

/// @dev A club bootstrapped the way the scripts do it. The test contract is the deployer.
abstract contract ClubBase is Test, ClubDeployment {
    uint256 internal constant HALF_LIFE = 180 days;
    uint256 internal constant REP = 10e18;
    uint256 internal constant START = 1_800_000_000;

    AttendanceRegistry internal legacyRegistry;
    AttendanceRegistry2 internal registry;
    ClubRep internal rep;
    ClubGovernor internal governor;
    ClubTimelock internal timelock;
    Club internal club;

    address internal officerA = makeAddr("officerA");
    address internal officerB = makeAddr("officerB");
    address internal officerC = makeAddr("officerC");
    address internal relay = makeAddr("relay");
    address internal guardian = makeAddr("guardianSafe");
    address internal legacyRelay = makeAddr("legacyRelay");
    address internal legacyOfficer = makeAddr("legacyOfficer");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public virtual {
        vm.warp(START);
        _bootstrap(_emptyLegacy());
    }

    // -------------------------------------------------------------------------
    // Bootstrap
    // -------------------------------------------------------------------------

    /// @dev A legacy registry with the test contract as its admin and no history.
    function _emptyLegacy() internal returns (Legacy memory legacy) {
        legacyRegistry = new AttendanceRegistry(legacyRelay, "legacy-cid");
        legacyRegistry.grantRole(legacyRegistry.ADMIN_ROLE(), legacyOfficer);
        legacy.registry = legacyRegistry;
        legacy.roleHolders = new address[](3);
        legacy.roleHolders[0] = address(this);
        legacy.roleHolders[1] = legacyOfficer;
        legacy.roleHolders[2] = legacyRelay;
    }

    function _legacySession(uint256 id, address[] memory holders) internal {
        vm.prank(legacyOfficer);
        legacyRegistry.createSession(id, uint64(block.timestamp), "Legacy", "Spring 2026");
        for (uint256 i = 0; i < holders.length; ++i) {
            vm.prank(legacyRelay);
            legacyRegistry.mint(holders[i], id);
        }
    }

    function _config() internal view returns (Config memory) {
        address[] memory officers = new address[](2);
        officers[0] = officerA;
        officers[1] = officerB;
        return Config({
            relay: relay,
            guardian: guardian,
            officers: officers,
            baseCid: "base-cid",
            halfLife: HALF_LIFE,
            timelockDelay: 2 days,
            guardianTerm: 120 days,
            governor: _defaultSettings()
        });
    }

    function _deploy(Legacy memory legacy) internal {
        club = _deployClub(_config(), legacy, address(this));
        registry = club.registry;
        rep = club.rep;
        governor = club.governor;
        timelock = club.timelock;
    }

    function _bootstrap(Legacy memory legacy) internal {
        _freezeLegacy(legacy, address(this));
        _deploy(legacy);
        _importLegacy(rep, legacy, 50);
        _finalizeAndHandOff(club, legacy, address(this));
    }

    // -------------------------------------------------------------------------
    // Meetings
    // -------------------------------------------------------------------------

    function _createSession(uint256 id, uint16 maxAttendees) internal {
        vm.prank(officerA);
        registry.createSession(id, uint64(block.timestamp), "Meeting", "Fall 2026", maxAttendees, "");
    }

    function _mint(uint256 id, address account) internal {
        vm.prank(relay);
        registry.mint(account, id);
    }

    function _mintAll(uint256 id, address[] memory accounts) internal {
        for (uint256 start = 0; start < accounts.length; start += 200) {
            uint256 end = start + 200 < accounts.length ? start + 200 : accounts.length;
            vm.prank(relay);
            registry.mintBatch(_slice(accounts, start, end), id);
        }
    }

    function _close(uint256 id, address[] memory attendees) internal {
        vm.prank(officerA);
        registry.closeSession(id, attendees);
    }

    function _confirm(uint256 id) internal {
        vm.prank(officerB);
        registry.confirmSessionRep(id);
    }

    function _creditAll(uint256 id, address[] memory attendees) internal {
        for (uint256 from = 0; from < attendees.length; from += 100) {
            uint256 to = from + 100 < attendees.length ? from + 100 : attendees.length;
            registry.creditSessionRep(id, attendees, uint16(from), uint16(to));
        }
    }

    /// @dev A whole meeting: create, mint, close, confirm and credit.
    function _meeting(uint256 id, address[] memory attendees) internal {
        _createSession(id, 300);
        _mintAll(id, attendees);
        _close(id, attendees);
        _confirm(id);
        _creditAll(id, attendees);
    }

    function _grant(address to, uint256 amount) internal {
        vm.prank(address(timelock));
        rep.grant(to, amount, "ipfs://reason");
    }

    function _revoke(address account) internal {
        vm.prank(address(timelock));
        rep.revoke(account, "ipfs://reason");
    }

    // -------------------------------------------------------------------------
    // Lists
    // -------------------------------------------------------------------------

    function _list(address a) internal pure returns (address[] memory out) {
        out = new address[](1);
        out[0] = a;
    }

    /// @dev Strictly increasing, as `closeSession` requires.
    function _sorted(address a, address b, address c) internal pure returns (address[] memory out) {
        out = new address[](3);
        (out[0], out[1], out[2]) = (a, b, c);
        if (out[0] > out[1]) (out[0], out[1]) = (out[1], out[0]);
        if (out[1] > out[2]) (out[1], out[2]) = (out[2], out[1]);
        if (out[0] > out[1]) (out[0], out[1]) = (out[1], out[0]);
    }

    /// @dev `count` distinct addresses in increasing order.
    function _members(uint256 count) internal pure returns (address[] memory out) {
        out = new address[](count);
        for (uint256 i = 0; i < count; ++i) {
            out[i] = address(uint160(0x100000 + i));
        }
    }

    function _slice(address[] memory all, uint256 from, uint256 to) internal pure returns (address[] memory out) {
        out = new address[](to - from);
        for (uint256 i = from; i < to; ++i) {
            out[i - from] = all[i];
        }
    }
}
