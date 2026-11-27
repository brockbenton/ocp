// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DecayMath} from "../src/libraries/DecayMath.sol";
import {ReferenceDecay} from "./helpers/ReferenceDecay.sol";

contract DecayMathTest is Test {
    uint256 private constant H = 180 days;

    /// @dev Documented tolerance: one base unit plus one part in 10^18.
    function _assertClose(uint256 actual, uint256 expected) private pure {
        assertApproxEqAbs(actual, expected, 1 + expected / 1e18);
    }

    function test_decay_halvesExactlyAtEachHalfLife() public pure {
        assertEq(DecayMath.decay(100e18, 0, H), 100e18);
        assertEq(DecayMath.decay(100e18, H, H), 50e18);
        assertEq(DecayMath.decay(100e18, 2 * H, H), 25e18);
        assertEq(DecayMath.decay(100e18, 10 * H, H), uint256(100e18) >> 10);
    }

    /// @dev Expected values computed with 60-digit decimal arithmetic outside the EVM.
    function test_decay_matchesHighPrecisionVectors() public pure {
        _assertClose(DecayMath.decay(100e18, H / 2, H), 70710678118654752440);
        _assertClose(DecayMath.decay(100e18, 1, H), 99999995543035203746);
        _assertClose(DecayMath.decay(10e18, 1 days, H), 9961565872205752176);
        _assertClose(DecayMath.decay(10e18, 7 days, H), 9734043393240234570);
        _assertClose(DecayMath.decay(100e18, 3 * H + 12345, H), 12493124237783502909);
        _assertClose(DecayMath.decay(3000e18, 3650 days, H), 2359945090299518);
        _assertClose(DecayMath.decay(1e30, H / 3, H), 793700525984099737375852819636);
    }

    function testFuzz_decay_matchesReferenceModel(uint128 amount, uint256 elapsed, uint256 halfLife) public pure {
        halfLife = bound(halfLife, 30 days, 3650 days);
        elapsed = bound(elapsed, 0, 130 * halfLife);
        _assertClose(DecayMath.decay(amount, elapsed, halfLife), ReferenceDecay.decay(amount, elapsed, halfLife));
    }

    function testFuzz_decay_neverIncreasesWithTime(uint128 amount, uint256 elapsed, uint256 more) public pure {
        elapsed = bound(elapsed, 0, 140 * H);
        more = bound(more, 0, 140 * H);
        assertLe(DecayMath.decay(amount, elapsed + more, H), DecayMath.decay(amount, elapsed, H));
        assertLe(DecayMath.decay(amount, elapsed, H), amount);
    }

    function testFuzz_decay_neverIncreasesOverOneSecond(uint128 amount, uint256 elapsed) public pure {
        elapsed = bound(elapsed, 0, 129 * H);
        assertLe(DecayMath.decay(amount, elapsed + 1, H), DecayMath.decay(amount, elapsed, H));
    }

    function testFuzz_decay_inStepsAgreesWithOneStep(uint128 amount, uint256 first, uint256 second) public pure {
        first = bound(first, 0, 20 * H);
        second = bound(second, 0, 20 * H);
        uint256 stepped = DecayMath.decay(DecayMath.decay(amount, first, H), second, H);
        uint256 direct = DecayMath.decay(amount, first + second, H);
        assertApproxEqAbs(stepped, direct, 2 + direct / 1e18);
    }

    function test_decay_boundsAndDust() public pure {
        // The largest balance neither overflows nor survives 128 half-lives.
        assertEq(DecayMath.decay(type(uint128).max, 0, H), type(uint128).max);
        assertEq(DecayMath.decay(type(uint128).max, 128 * H, H), 0);
        assertEq(DecayMath.decay(type(uint128).max, type(uint64).max, H), 0);
        // 10 Rep is below one base unit after 64 half-lives (2^63 < 10^19 < 2^64).
        assertGt(DecayMath.decay(10e18, 63 * H, H), 0);
        assertEq(DecayMath.decay(10e18, 64 * H, H), 0);
        // A single base unit rounds down to nothing as soon as any time passes.
        assertEq(DecayMath.decay(1, 1, H), 0);
        assertEq(DecayMath.decay(0, 1, H), 0);
    }
}
