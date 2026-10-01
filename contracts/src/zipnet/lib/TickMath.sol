// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title TickMath
 * @notice sqrt(1.0001^tick) · 2^96, as Uniswap computes it (TickMath.getSqrtPriceAtTick): the same algorithm and magic
 *         constants, so the result is bit-for-bit Uniswap's. Tested against the exact values Uniswap's pools use (the
 *         band edges in ZipLiquidityBands and the v4 bounds) and on a mainnet fork against the live PoolManager.
 */
library TickMath {
  int24 internal constant MIN_TICK = -887_272;
  int24 internal constant MAX_TICK = 887_272;
  /// @notice getSqrtPriceAtTick(MIN_TICK) and getSqrtPriceAtTick(MAX_TICK)
  uint160 internal constant MIN_SQRT_PRICE = 4_295_128_739;
  uint160 internal constant MAX_SQRT_PRICE = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342;

  error TickOutOfRange(int24 tick);

  function getSqrtPriceAtTick(int24 _tick) internal pure returns (uint160) {
    unchecked {
      uint256 _abs = _tick < 0 ? uint256(-int256(_tick)) : uint256(int256(_tick));
      if (_abs > uint256(int256(MAX_TICK))) revert TickOutOfRange(_tick);

      uint256 _r = _abs & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
      if (_abs & 0x2 != 0) _r = (_r * 0xfff97272373d413259a46990580e213a) >> 128;
      if (_abs & 0x4 != 0) _r = (_r * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
      if (_abs & 0x8 != 0) _r = (_r * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
      if (_abs & 0x10 != 0) _r = (_r * 0xffcb9843d60f6159c9db58835c926644) >> 128;
      if (_abs & 0x20 != 0) _r = (_r * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
      if (_abs & 0x40 != 0) _r = (_r * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
      if (_abs & 0x80 != 0) _r = (_r * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
      if (_abs & 0x100 != 0) _r = (_r * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
      if (_abs & 0x200 != 0) _r = (_r * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
      if (_abs & 0x400 != 0) _r = (_r * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
      if (_abs & 0x800 != 0) _r = (_r * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
      if (_abs & 0x1000 != 0) _r = (_r * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
      if (_abs & 0x2000 != 0) _r = (_r * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
      if (_abs & 0x4000 != 0) _r = (_r * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
      if (_abs & 0x8000 != 0) _r = (_r * 0x31be135f97d08fd981231505542fcfa6) >> 128;
      if (_abs & 0x10000 != 0) _r = (_r * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
      if (_abs & 0x20000 != 0) _r = (_r * 0x5d6af8dedb81196699c329225ee604) >> 128;
      if (_abs & 0x40000 != 0) _r = (_r * 0x2216e584f5fa1ea926041bedfe98) >> 128;
      if (_abs & 0x80000 != 0) _r = (_r * 0x48a170391f7dc42444e8fa2) >> 128;

      if (_tick > 0) _r = type(uint256).max / _r;
      // Q128.128 -> Q64.96, rounding up so getTickAtSqrtPrice of the result is the tick
      return uint160((_r >> 32) + (_r % (1 << 32) == 0 ? 0 : 1));
    }
  }
}
