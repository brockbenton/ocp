// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ClubRep} from "../src/ClubRep.sol";
import {ClubBase} from "./helpers/ClubBase.sol";

/// @dev Random credits, grants, revocations and time, remembering past values as it goes.
contract RepHandler is Test {
    ClubRep private immutable i_rep;
    address private immutable i_registry;
    address private immutable i_timelock;

    address[5] public actors;
    uint256 public operations;
    /// @dev Largest total ever seen; fixed-point truncation scales with it.
    uint256 public peakSupply;

    struct Snapshot {
        uint256 timepoint;
        uint256 supply;
        uint256 account;
        uint256 votes;
    }

    Snapshot[] public snapshots;

    constructor(ClubRep rep, address registry, address timelock) {
        i_rep = rep;
        i_registry = registry;
        i_timelock = timelock;
        for (uint256 i = 0; i < actors.length; ++i) {
            actors[i] = address(uint160(0xA11CE + i));
        }
    }

    function credit(uint256 mask, uint256 age) external {
        address[] memory page = new address[](actors.length);
        uint256 count = 0;
        for (uint256 i = 0; i < actors.length; ++i) {
            if (mask & (1 << i) != 0) page[count++] = actors[i];
        }
        assembly {
            mstore(page, count)
        }
        age = bound(age, 0, 400 days);
        if (age > block.timestamp) age = block.timestamp;
        vm.prank(i_registry);
        i_rep.credit(page, uint48(block.timestamp - age));
        _record();
    }

    function grant(uint256 who, uint256 amount) external {
        address account = actors[who % actors.length];
        if (i_rep.isBlocked(account)) return;
        vm.prank(i_timelock);
        i_rep.grant(account, bound(amount, 1, 1_000_000e18), "r");
        _record();
    }

    function revokeOrUnblock(uint256 who) external {
        address account = actors[who % actors.length];
        bool blocked = i_rep.isBlocked(account);
        vm.prank(i_timelock);
        if (blocked) i_rep.unblock(account);
        else i_rep.revoke(account, "r");
        _record();
    }

    function wait(uint256 time, uint256 who) external {
        uint256 timepoint = block.timestamp;
        skip(bound(time, 1, 200 days));
        address account = actors[who % actors.length];
        snapshots.push(
            Snapshot(
                timepoint,
                i_rep.getPastTotalSupply(timepoint),
                uint256(uint160(account)),
                i_rep.getPastVotes(account, timepoint)
            )
        );
    }

    function _record() private {
        ++operations;
        uint256 supply = i_rep.totalSupply();
        if (supply > peakSupply) peakSupply = supply;
    }

    function snapshotCount() external view returns (uint256) {
        return snapshots.length;
    }
}

contract ClubRepInvariantTest is ClubBase {
    RepHandler private handler;

    function setUp() public override {
        super.setUp();
        handler = new RepHandler(rep, address(registry), address(timelock));
        targetContract(address(handler));
    }

    /// @dev Documented tolerance: a few base units per operation, plus one part in 10^16 of
    ///      the largest supply seen. The second term is what truncating the exponent to 64
    ///      bits leaves behind, and it can remain after the Rep that caused it is revoked.
    function invariant_totalMatchesSumOfAccounts() public view {
        uint256 sum = 0;
        for (uint256 i = 0; i < 5; ++i) {
            sum += rep.getVotes(handler.actors(i));
        }
        uint256 tolerance = 8 * handler.operations() + 8 + handler.peakSupply() / 1e16;
        assertApproxEqAbs(rep.totalSupply(), sum, tolerance);
    }

    function invariant_pastValuesNeverChange() public view {
        uint256 count = handler.snapshotCount();
        for (uint256 i = 0; i < count; ++i) {
            (uint256 timepoint, uint256 supply, uint256 account, uint256 votes) = handler.snapshots(i);
            assertEq(rep.getPastTotalSupply(timepoint), supply);
            assertEq(rep.getPastVotes(address(uint160(account)), timepoint), votes);
        }
    }

    function invariant_blockedAccountsHaveNoPower() public view {
        for (uint256 i = 0; i < 5; ++i) {
            if (rep.isBlocked(handler.actors(i))) assertEq(rep.getVotes(handler.actors(i)), 0);
        }
    }
}
