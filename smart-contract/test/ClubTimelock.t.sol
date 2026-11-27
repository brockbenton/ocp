// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ClubTimelock} from "../src/ClubTimelock.sol";
import {ClubBase} from "./helpers/ClubBase.sol";

contract ClubTimelockTest is ClubBase {
    function _new(uint256 delay, address[] memory proposers, address guardian_, uint256 expiry)
        private
        returns (ClubTimelock)
    {
        return new ClubTimelock(delay, proposers, new address[](1), address(this), guardian_, expiry);
    }

    function test_constructor_grantsGuardianCancelOnly() public view {
        assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), guardian));
        assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), guardian));
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), guardian));
        assertEq(timelock.GUARDIAN(), guardian);
        assertEq(timelock.GUARDIAN_EXPIRY(), START + 120 days);
    }

    function test_constructor_boundsTheDelay() public {
        address[] memory none = new address[](0);
        vm.expectRevert(abi.encodeWithSelector(ClubTimelock.DelayOutOfBounds.selector, 1 days - 1));
        _new(1 days - 1, none, guardian, block.timestamp + 1);
        vm.expectRevert(abi.encodeWithSelector(ClubTimelock.DelayOutOfBounds.selector, 7 days + 1));
        _new(7 days + 1, none, guardian, block.timestamp + 1);
        assertEq(_new(1 days, none, guardian, block.timestamp + 1).getMinDelay(), 1 days);
        assertEq(_new(7 days, none, guardian, block.timestamp + 1).getMinDelay(), 7 days);
    }

    function test_constructor_rejectsBadGuardians() public {
        address[] memory none = new address[](0);
        vm.expectRevert(ClubTimelock.InvalidGuardian.selector);
        _new(2 days, none, address(0), block.timestamp + 1);
        vm.expectRevert(ClubTimelock.InvalidGuardian.selector);
        _new(2 days, _list(guardian), guardian, block.timestamp + 1);
        vm.expectRevert(ClubTimelock.InvalidGuardianExpiry.selector);
        _new(2 days, none, guardian, block.timestamp);
        vm.expectRevert(ClubTimelock.InvalidGuardianExpiry.selector);
        _new(2 days, none, guardian, block.timestamp + 120 days + 1);
    }

    function test_updateDelay_onlySelfAndBounded() public {
        vm.expectRevert(abi.encodeWithSelector(TimelockController.TimelockUnauthorizedCaller.selector, address(this)));
        timelock.updateDelay(3 days);
        vm.startPrank(address(timelock));
        vm.expectRevert(abi.encodeWithSelector(ClubTimelock.DelayOutOfBounds.selector, 0));
        timelock.updateDelay(0);
        vm.expectRevert(abi.encodeWithSelector(ClubTimelock.DelayOutOfBounds.selector, 8 days));
        timelock.updateDelay(8 days);
        vm.expectEmit(address(timelock));
        emit TimelockController.MinDelayChange(2 days, 3 days);
        timelock.updateDelay(3 days);
        vm.stopPrank();
        assertEq(timelock.getMinDelay(), 3 days);
    }

    function test_schedule_respectsTheCurrentDelay() public {
        vm.prank(address(timelock));
        timelock.updateDelay(5 days);
        vm.prank(address(governor));
        vm.expectRevert(abi.encodeWithSelector(TimelockController.TimelockInsufficientDelay.selector, 2 days, 5 days));
        timelock.schedule(address(rep), 0, "", 0, 0, 2 days);
    }

    function test_guardian_cannotSchedule() public {
        vm.prank(guardian);
        vm.expectRevert();
        timelock.schedule(address(rep), 0, "", 0, 0, 2 days);
    }

    function test_expireGuardian_afterTheTermByAnyone() public {
        uint256 expiry = START + 120 days;
        vm.warp(expiry - 1);
        vm.expectRevert(abi.encodeWithSelector(ClubTimelock.GuardianNotExpired.selector, expiry));
        timelock.expireGuardian();
        vm.warp(expiry);
        vm.expectEmit(address(timelock));
        emit ClubTimelock.GuardianExpired(guardian);
        vm.prank(carol);
        timelock.expireGuardian();
        assertFalse(timelock.hasRole(timelock.CANCELLER_ROLE(), guardian));
        // Calling again is harmless.
        timelock.expireGuardian();
    }

    function test_guardian_canRenounceEarly() public {
        bytes32 canceller = timelock.CANCELLER_ROLE();
        vm.prank(guardian);
        timelock.renounceRole(canceller, guardian);
        assertFalse(timelock.hasRole(canceller, guardian));
    }
}
