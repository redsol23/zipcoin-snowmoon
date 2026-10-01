// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';

import {ZipLiquidityBands} from 'zipnet/ZipLiquidityBands.sol';
import {TickMath} from 'zipnet/lib/TickMath.sol';

/// @notice The Uniswap v4 PoolManager surface ForkSwapper uses
interface IForkPoolManager {
  struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
  }

  function unlock(bytes calldata data) external returns (bytes memory);
  function swap(ZipLiquidityBands.PoolKey memory key, SwapParams memory params, bytes calldata hookData)
    external
    returns (int256);
  function sync(address currency) external;
  function settle() external payable returns (uint256);
  function take(address currency, address to, uint256 amount) external;
}

/// @notice Swaps exact input through the real PoolManager (to make fees and move prices in the fork tests)
contract ForkSwapper {
  IForkPoolManager internal immutable PM;

  constructor(address _pm) {
    PM = IForkPoolManager(_pm);
  }

  function swap(ZipLiquidityBands.PoolKey memory _key, bool _zeroForOne, uint256 _in) external payable {
    uint160 _limit = _zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
    PM.unlock(abi.encode(_key, _zeroForOne, _in, msg.sender, _limit));
  }

  function unlockCallback(bytes calldata _data) external returns (bytes memory) {
    require(msg.sender == address(PM));
    (ZipLiquidityBands.PoolKey memory _k, bool _z, uint256 _in, address _to, uint160 _limit) =
      abi.decode(_data, (ZipLiquidityBands.PoolKey, bool, uint256, address, uint160));
    int256 _d = PM.swap(_k, IForkPoolManager.SwapParams(_z, -int256(_in), _limit), '');
    int128 _a0 = int128(_d >> 128);
    int128 _a1 = int128(_d);
    (address _cin, address _cout, int128 _pay, int128 _get) =
      _z ? (_k.currency0, _k.currency1, _a0, _a1) : (_k.currency1, _k.currency0, _a1, _a0);
    if (_cin == address(0)) {
      PM.settle{value: uint256(uint128(-_pay))}();
    } else {
      PM.sync(_cin);
      IERC20(_cin).transfer(address(PM), uint256(uint128(-_pay)));
      PM.settle();
    }
    PM.take(_cout, _to, uint256(uint128(_get)));
    return '';
  }

  receive() external payable {}
}
