// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DecayMath
/// @notice Exponential half-life decay in fixed point: `amount * 2^(-elapsed / halfLife)`.
/// @dev The exponent is split into whole halvings (an exact right shift) and a fraction held
///      in Q64, whose power of two is the product of the Q128 constants `2^(-2^-i)`.
///      Every step rounds down, so a result is never above the exact value except through
///      truncating the fraction to 64 bits, a relative error below 4e-20.
library DecayMath {
    /// @dev Factor 1.0 in Q128.
    uint256 internal constant ONE = 1 << 128;
    /// @dev An amount below 2^128 shifted right by this many halvings is always zero.
    uint256 internal constant MAX_HALVINGS = 128;

    /// @param amount Value at the start. Must not exceed `type(uint128).max`.
    /// @param elapsed Seconds since the value was recorded.
    /// @param halfLife Seconds for the value to halve. Must be non-zero and below 2^64.
    /// @return The decayed value, rounded down. Exact at whole multiples of `halfLife`.
    function decay(uint128 amount, uint256 elapsed, uint256 halfLife) internal pure returns (uint128) {
        uint256 halvings = elapsed / halfLife;
        if (amount == 0 || halvings >= MAX_HALVINGS) return 0;
        uint256 fraction = ((elapsed % halfLife) << 64) / halfLife;
        // amount < 2^128 and factor <= 2^128, so the product fits, and the result <= amount.
        // Safe: the factor is at most 1.0, so the result is at most `amount`.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128((uint256(amount) * _pow2Neg(fraction)) >> (128 + halvings));
    }

    /// @dev `2^(-fraction / 2^64)` in Q128, for `fraction < 2^64`.
    function _pow2Neg(uint256 fraction) private pure returns (uint256 factor) {
        factor = ONE;
        unchecked {
            if (fraction & 0x8000000000000000 != 0) factor = (factor * 0xb504f333f9de6484597d89b3754abe9f) >> 128;
            if (fraction & 0x4000000000000000 != 0) factor = (factor * 0xd744fccad69d6af439a68bb9902d3fde) >> 128;
            if (fraction & 0x2000000000000000 != 0) factor = (factor * 0xeac0c6e7dd24392ed02d75b3706e54fa) >> 128;
            if (fraction & 0x1000000000000000 != 0) factor = (factor * 0xf5257d152486cc2c7b9d0c7aed980fc3) >> 128;
            if (fraction & 0x0800000000000000 != 0) factor = (factor * 0xfa83b2db722a033a7c25bb14315d7fcc) >> 128;
            if (fraction & 0x0400000000000000 != 0) factor = (factor * 0xfd3e0c0cf486c174853f3a5931e0ee03) >> 128;
            if (fraction & 0x0200000000000000 != 0) factor = (factor * 0xfe9e115c7b8f884badd25995e79d2f09) >> 128;
            if (fraction & 0x0100000000000000 != 0) factor = (factor * 0xff4ecb59511ec8a5301ba217ef18dd7c) >> 128;
            if (fraction & 0x0080000000000000 != 0) factor = (factor * 0xffa756521c8daed19f3a1b48fb94c589) >> 128;
            if (fraction & 0x0040000000000000 != 0) factor = (factor * 0xffd3a751c0f7e10bd3b9f8ae012fbe06) >> 128;
            if (fraction & 0x0020000000000000 != 0) factor = (factor * 0xffe9d2b2f7db2755ddf1d28a378a438c) >> 128;
            if (fraction & 0x0010000000000000 != 0) factor = (factor * 0xfff4e91bff1b8c3d88338e0ebf284a4d) >> 128;
            if (fraction & 0x0008000000000000 != 0) factor = (factor * 0xfffa747ea0040664238f92f792405805) >> 128;
            if (fraction & 0x0004000000000000 != 0) factor = (factor * 0xfffd3a3b7814eb53cd7629d70fea116a) >> 128;
            if (fraction & 0x0002000000000000 != 0) factor = (factor * 0xfffe9d1cc60ddab126de1aec4a87e7b8) >> 128;
            if (fraction & 0x0001000000000000 != 0) factor = (factor * 0xffff4e8e25879bfa09ea263360240c1a) >> 128;
            if (fraction & 0x0000800000000000 != 0) factor = (factor * 0xffffa7470363f4515426d76c762b6b61) >> 128;
            if (fraction & 0x0000400000000000 != 0) factor = (factor * 0xffffd3a37dda03133bde87a8379c8932) >> 128;
            if (fraction & 0x0000200000000000 != 0) factor = (factor * 0xffffe9d1bdf703aef21ea4dcfb0682d8) >> 128;
            if (fraction & 0x0000100000000000 != 0) factor = (factor * 0xfffff4e8debe025e24128a3d460731f1) >> 128;
            if (fraction & 0x0000080000000000 != 0) factor = (factor * 0xfffffa746f4fa1506788fbc89750bf71) >> 128;
            if (fraction & 0x0000040000000000 != 0) factor = (factor * 0xfffffd3a37a3f8b07e7c4871dc00d76e) >> 128;
            if (fraction & 0x0000020000000000 != 0) factor = (factor * 0xfffffe9d1bd1065a50971275792f1c83) >> 128;
            if (fraction & 0x0000010000000000 != 0) factor = (factor * 0xffffff4e8de845adac77243cd0914b37) >> 128;
            if (fraction & 0x0000008000000000 != 0) factor = (factor * 0xffffffa746f41376f74124cd483186d4) >> 128;
            if (fraction & 0x0000004000000000 != 0) factor = (factor * 0xffffffd3a37a05e383e14c90273c94f5) >> 128;
            if (fraction & 0x0000002000000000 != 0) factor = (factor * 0xffffffe9d1bd01fbc400bf822dc936b5) >> 128;
            if (fraction & 0x0000001000000000 != 0) factor = (factor * 0xfffffff4e8de80c062846365949b61af) >> 128;
            if (fraction & 0x0000000800000000 != 0) factor = (factor * 0xfffffffa746f4050d1633246a8a0e09a) >> 128;
            if (fraction & 0x0000000400000000 != 0) factor = (factor * 0xfffffffd3a37a02490b9d93da3c1ebcf) >> 128;
            if (fraction & 0x0000000200000000 != 0) factor = (factor * 0xfffffffe9d1bd011525efca410b8eab7) >> 128;
            if (fraction & 0x0000000100000000 != 0) factor = (factor * 0xffffffff4e8de8086bb002532d71e54d) >> 128;
            if (fraction & 0x0000000080000000 != 0) factor = (factor * 0xffffffffa746f40426782229daaa3cfa) >> 128;
            if (fraction & 0x0000000040000000 != 0) factor = (factor * 0xffffffffd3a37a020f641954fda6eedd) >> 128;
            if (fraction & 0x0000000020000000 != 0) factor = (factor * 0xffffffffe9d1bd0106bc0eba82d29b40) >> 128;
            if (fraction & 0x0000000010000000 != 0) factor = (factor * 0xfffffffff4e8de80832087e142666c8b) >> 128;
            if (fraction & 0x0000000008000000 != 0) factor = (factor * 0xfffffffffa746f404180e411a17228bf) >> 128;
            if (fraction & 0x0000000004000000 != 0) factor = (factor * 0xfffffffffd3a37a020bc9a1110c8c656) >> 128;
            if (fraction & 0x0000000002000000 != 0) factor = (factor * 0xfffffffffe9d1bd0105d570a98684e53) >> 128;
            if (fraction & 0x0000000001000000 != 0) factor = (factor * 0xffffffffff4e8de8082e6e05d03521c9) >> 128;
            if (fraction & 0x0000000000800000 != 0) factor = (factor * 0xffffffffffa746f4041727a3091acf87) >> 128;
            if (fraction & 0x0000000000400000 != 0) factor = (factor * 0xffffffffffd3a37a020b8ff98ccd776b) >> 128;
            if (fraction & 0x0000000000200000 != 0) factor = (factor * 0xffffffffffe9d1bd0105c706c876bf9f) >> 128;
            if (fraction & 0x0000000000100000 != 0) factor = (factor * 0xfffffffffff4e8de8082e345e4bf60ca) >> 128;
            if (fraction & 0x0000000000080000 != 0) factor = (factor * 0xfffffffffffa746f404171939280b0a3) >> 128;
            if (fraction & 0x0000000000040000 != 0) factor = (factor * 0xfffffffffffd3a37a020b8c5f1489861) >> 128;
            if (fraction & 0x0000000000020000 != 0) factor = (factor * 0xfffffffffffe9d1bd0105c6202a65c34) >> 128;
            if (fraction & 0x0000000000010000 != 0) factor = (factor * 0xffffffffffff4e8de8082e30c3d3b21b) >> 128;
            if (fraction & 0x0000000000008000 != 0) factor = (factor * 0xffffffffffffa746f40417185289fa0d) >> 128;
            if (fraction & 0x0000000000004000 != 0) factor = (factor * 0xffffffffffffd3a37a020b8c256d0547) >> 128;
            if (fraction & 0x0000000000002000 != 0) factor = (factor * 0xffffffffffffe9d1bd0105c611c084b3) >> 128;
            if (fraction & 0x0000000000001000 != 0) factor = (factor * 0xfffffffffffff4e8de8082e308a2c2dd) >> 128;
            if (fraction & 0x0000000000000800 != 0) factor = (factor * 0xfffffffffffffa746f4041718442018f) >> 128;
            if (fraction & 0x0000000000000400 != 0) factor = (factor * 0xfffffffffffffd3a37a020b8c21d28d0) >> 128;
            if (fraction & 0x0000000000000200 != 0) factor = (factor * 0xfffffffffffffe9d1bd0105c610d9e6a) >> 128;
            if (fraction & 0x0000000000000100 != 0) factor = (factor * 0xffffffffffffff4e8de8082e308691b5) >> 128;
            if (fraction & 0x0000000000000080 != 0) factor = (factor * 0xffffffffffffffa746f404171843397a) >> 128;
            if (fraction & 0x0000000000000040 != 0) factor = (factor * 0xffffffffffffffd3a37a020b8c2198e5) >> 128;
            if (fraction & 0x0000000000000020 != 0) factor = (factor * 0xffffffffffffffe9d1bd0105c610cb7c) >> 128;
            if (fraction & 0x0000000000000010 != 0) factor = (factor * 0xfffffffffffffff4e8de8082e3086580) >> 128;
            if (fraction & 0x0000000000000008 != 0) factor = (factor * 0xfffffffffffffffa746f4041718432b1) >> 128;
            if (fraction & 0x0000000000000004 != 0) factor = (factor * 0xfffffffffffffffd3a37a020b8c21954) >> 128;
            if (fraction & 0x0000000000000002 != 0) factor = (factor * 0xfffffffffffffffe9d1bd0105c610ca9) >> 128;
            if (fraction & 0x0000000000000001 != 0) factor = (factor * 0xffffffffffffffff4e8de8082e308654) >> 128;
        }
    }
}
