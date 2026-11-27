// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev An independent model of half-life decay for tests: the Taylor series of
///      `exp(-x ln 2)` at 36 decimals. It shares no constants or technique with DecayMath.
library ReferenceDecay {
    uint256 internal constant SCALE = 1e36;
    uint256 internal constant LN2 = 693147180559945309417232121458176568;

    function decay(uint256 amount, uint256 elapsed, uint256 halfLife) internal pure returns (uint256) {
        uint256 halvings = elapsed / halfLife;
        if (halvings >= 128) return 0;
        uint256 y = (((elapsed % halfLife) * SCALE) / halfLife) * LN2 / SCALE;
        uint256 term = SCALE;
        uint256 positive = SCALE;
        uint256 negative = 0;
        for (uint256 n = 1; term != 0; ++n) {
            term = (term * y) / SCALE / n;
            if (n % 2 == 0) positive += term;
            else negative += term;
        }
        return ((amount * (positive - negative)) / SCALE) >> halvings;
    }
}
