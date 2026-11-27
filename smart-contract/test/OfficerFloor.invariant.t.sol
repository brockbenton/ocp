// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AttendanceRegistry2} from "../src/AttendanceRegistry2.sol";
import {ClubBase} from "./helpers/ClubBase.sol";

/// @dev Governance and officers grant, revoke and renounce in any order.
contract OfficerHandler is Test {
    AttendanceRegistry2 private immutable i_registry;
    address private immutable i_timelock;

    constructor(AttendanceRegistry2 registry, address timelock) {
        i_registry = registry;
        i_timelock = timelock;
    }

    function actor(uint256 seed) public pure returns (address) {
        return address(uint160(0x0FF1CE + (seed % 6)));
    }

    function grant(uint256 seed) external {
        bytes32 role = i_registry.ADMIN_ROLE();
        vm.prank(i_timelock);
        i_registry.grantRole(role, actor(seed));
    }

    function revoke(uint256 seed) external {
        bytes32 role = i_registry.ADMIN_ROLE();
        address officer = i_registry.getRoleMember(role, seed % i_registry.getRoleMemberCount(role));
        vm.prank(i_timelock);
        try i_registry.revokeRole(role, officer) {} catch {}
    }

    function renounce(uint256 seed) external {
        bytes32 role = i_registry.ADMIN_ROLE();
        address officer = i_registry.getRoleMember(role, seed % i_registry.getRoleMemberCount(role));
        vm.prank(officer);
        try i_registry.renounceRole(role, officer) {} catch {}
    }
}

contract OfficerFloorInvariantTest is ClubBase {
    function setUp() public override {
        super.setUp();
        targetContract(address(new OfficerHandler(registry, address(timelock))));
    }

    function invariant_atLeastTwoOfficers() public view {
        assertGe(registry.getRoleMemberCount(registry.ADMIN_ROLE()), 2);
    }

    function invariant_onlyTheTimelockAdministers() public view {
        assertTrue(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), address(timelock)));
    }
}
