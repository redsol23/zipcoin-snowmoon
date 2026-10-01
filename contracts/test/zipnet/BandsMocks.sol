// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {Math} from '@oz/utils/math/Math.sol';

import {ZipLiquidityBands} from 'zipnet/ZipLiquidityBands.sol';

/// @notice Holds the pool's ETH and ZC and answers slot0 through extsload, like the v4 PoolManager
contract MockPoolManager {
  address public posm;
  bytes32 public expectedSlot;
  uint160 public sqrtPriceX96;
  int24 public tick;

  function init(address _posm, bytes32 _slot) external {
    posm = _posm;
    expectedSlot = _slot;
  }

  function setPrice(uint160 _sqrtP, int24 _tick) external {
    (sqrtPriceX96, tick) = (_sqrtP, _tick);
  }

  function extsload(bytes32 _slot) external view returns (bytes32) {
    if (_slot != expectedSlot) return bytes32(0);
    return bytes32(uint256(sqrtPriceX96) | (uint256(uint24(tick)) << 160));
  }

  function pay(address _token, address _to, uint256 _amount) external {
    require(msg.sender == posm, 'only posm');
    if (_amount == 0) return;
    if (_token == address(0)) {
      (bool _ok,) = _to.call{value: _amount}('');
      require(_ok, 'eth');
    } else {
      IERC20(_token).transfer(_to, _amount);
    }
  }

  receive() external payable {}
}

/// @notice Permit2's allowance transfer: approve with an amount and an expiry, then transferFrom by the spender
contract MockPermit2 {
  struct Allowance {
    uint160 amount;
    uint48 expiration;
  }

  mapping(address => mapping(address => mapping(address => Allowance))) public allowance;

  error AllowanceExpired();
  error InsufficientAllowance();

  function approve(address _token, address _spender, uint160 _amount, uint48 _expiration) external {
    allowance[msg.sender][_token][_spender] = Allowance(_amount, _expiration);
  }

  function transferFrom(address _from, address _to, uint160 _amount, address _token) external {
    Allowance storage _a = allowance[_from][_token][msg.sender];
    if (block.timestamp > _a.expiration) revert AllowanceExpired();
    if (_a.amount < _amount) revert InsufficientAllowance();
    _a.amount -= _amount;
    IERC20(_token).transferFrom(_from, _to, _amount);
  }
}

/**
 * @notice The subset of the v4 PositionManager ZipLiquidityBands uses, with v4's amount maths (SqrtPriceMath rounding,
 *         MaximumAmountExceeded, DeltaNotNegative / DeltaNotPositive, CurrencyNotSettled) and fees a test can accrue.
 */
contract MockPositionManager {
  struct Pos {
    int24 lo;
    int24 hi;
    uint128 liq;
    address owner;
    uint256 feesEth;
    uint256 feesZc;
  }

  uint256 private constant Q96 = 2 ** 96;

  MockPoolManager public immutable poolManager;
  MockPermit2 public immutable permit2;
  address public immutable zc;
  address public immutable hooks;
  uint256 public nextTokenId = 1;
  mapping(uint256 => Pos) public pos;
  mapping(int24 => uint256) public sqrtAt;
  int256 private _d0;
  int256 private _d1;
  uint256 private _ethIn;

  error MaximumAmountExceeded(uint128 maximumAmount, uint128 amountRequested);
  error MinimumAmountInsufficient(uint128 minimumAmount, uint128 amountReceived);
  error DeltaNotNegative(address currency);
  error DeltaNotPositive(address currency);
  error CurrencyNotSettled();
  error NotApproved(address caller);
  error DeadlinePassed(uint256 deadline);

  constructor(MockPoolManager _pm, MockPermit2 _permit2, address _zc, address _hooks) {
    (poolManager, permit2, zc, hooks) = (_pm, _permit2, _zc, _hooks);
  }

  function setSqrt(int24 _tick, uint256 _sqrt) external {
    sqrtAt[_tick] = _sqrt;
  }

  /// @notice Test helper: fees the position has earned (the test funds the pool manager)
  function accrue(uint256 _id, uint256 _eth, uint256 _zc) external {
    pos[_id].feesEth += _eth;
    pos[_id].feesZc += _zc;
  }

  function getPositionLiquidity(uint256 _id) external view returns (uint128) {
    return pos[_id].liq;
  }

  function ownerOf(uint256 _id) external view returns (address) {
    return pos[_id].owner;
  }

  function transferFrom(address _from, address _to, uint256 _id) external {
    require(pos[_id].owner == _from && msg.sender == _from, 'not owner');
    pos[_id].owner = _to;
  }

  /// @notice Amounts for `_liq` at the current price; `_up` rounds up (adding) or down (removing), as v4 does
  function amounts(int24 _lo, int24 _hi, uint128 _liq, bool _up) public view returns (uint256 _a0, uint256 _a1) {
    uint256 _sa = sqrtAt[_lo];
    uint256 _sb = sqrtAt[_hi];
    require(_sa != 0 && _sb != 0, 'unknown tick');
    int24 _tick = poolManager.tick();
    uint256 _sp = poolManager.sqrtPriceX96();
    if (_tick < _lo) {
      _a0 = _amount0(_sa, _sb, _liq, _up);
    } else if (_tick < _hi) {
      _a0 = _amount0(_sp, _sb, _liq, _up);
      _a1 = _amount1(_sa, _sp, _liq, _up);
    } else {
      _a1 = _amount1(_sa, _sb, _liq, _up);
    }
  }

  function modifyLiquidities(bytes calldata _data, uint256 _deadline) external payable {
    if (_deadline < block.timestamp) revert DeadlinePassed(_deadline);
    (bytes memory _actions, bytes[] memory _params) = abi.decode(_data, (bytes, bytes[]));
    _ethIn = msg.value;
    for (uint256 _i; _i < _actions.length; ++_i) {
      uint8 _a = uint8(_actions[_i]);
      if (_a == 0x02) _mint(_params[_i]);
      else if (_a == 0x00) _increase(_params[_i]);
      else if (_a == 0x01) _decrease(_params[_i]);
      else if (_a == 0x0d) _settlePair();
      else if (_a == 0x11) _takePair(_params[_i]);
      else if (_a == 0x14) _sweep(_params[_i]);
      else revert('unsupported action');
    }
    if (_d0 != 0 || _d1 != 0) revert CurrencyNotSettled();
  }

  function _mint(bytes memory _p) internal {
    (
      ZipLiquidityBands.PoolKey memory _key,
      int24 _lo,
      int24 _hi,
      uint256 _liq,
      uint128 _max0,
      uint128 _max1,
      address _owner,
    ) = abi.decode(_p, (ZipLiquidityBands.PoolKey, int24, int24, uint256, uint128, uint128, address, bytes));
    require(_key.currency0 == address(0) && _key.currency1 == zc && _key.fee == 10_000, 'key');
    require(_key.tickSpacing == 200 && _key.hooks == hooks, 'key');
    require(_lo % 200 == 0 && _hi % 200 == 0 && _lo < _hi, 'ticks');
    (uint256 _a0, uint256 _a1) = amounts(_lo, _hi, uint128(_liq), true);
    _checkMax(_a0, _a1, _max0, _max1);
    pos[nextTokenId++] = Pos(_lo, _hi, uint128(_liq), _owner, 0, 0);
    _d0 -= int256(_a0);
    _d1 -= int256(_a1);
  }

  function _increase(bytes memory _p) internal {
    (uint256 _id, uint256 _liq, uint128 _max0, uint128 _max1,) =
      abi.decode(_p, (uint256, uint256, uint128, uint128, bytes));
    Pos storage _pos = pos[_id];
    if (_pos.owner != msg.sender) revert NotApproved(msg.sender);
    (uint256 _a0, uint256 _a1) = amounts(_pos.lo, _pos.hi, uint128(_liq), true);
    _checkMax(_a0, _a1, _max0, _max1);
    _pos.liq += uint128(_liq);
    // like v4: accrued fees are credited to the caller on any modify
    _d0 += int256(_pos.feesEth) - int256(_a0);
    _d1 += int256(_pos.feesZc) - int256(_a1);
    (_pos.feesEth, _pos.feesZc) = (0, 0);
  }

  function _decrease(bytes memory _p) internal {
    (uint256 _id, uint256 _liq, uint128 _min0, uint128 _min1,) =
      abi.decode(_p, (uint256, uint256, uint128, uint128, bytes));
    Pos storage _pos = pos[_id];
    if (_pos.owner != msg.sender) revert NotApproved(msg.sender);
    (uint256 _a0, uint256 _a1) = amounts(_pos.lo, _pos.hi, uint128(_liq), false);
    if (_a0 < _min0) revert MinimumAmountInsufficient(_min0, uint128(_a0));
    if (_a1 < _min1) revert MinimumAmountInsufficient(_min1, uint128(_a1));
    _pos.liq -= uint128(_liq);
    _d0 += int256(_a0 + _pos.feesEth);
    _d1 += int256(_a1 + _pos.feesZc);
    (_pos.feesEth, _pos.feesZc) = (0, 0);
  }

  function _settlePair() internal {
    if (_d0 > 0) revert DeltaNotNegative(address(0));
    if (_d1 > 0) revert DeltaNotNegative(zc);
    uint256 _eth = uint256(-_d0);
    require(_ethIn >= _eth, 'not enough ETH sent');
    _ethIn -= _eth;
    if (_eth != 0) {
      (bool _ok,) = address(poolManager).call{value: _eth}('');
      require(_ok);
    }
    if (_d1 != 0) permit2.transferFrom(msg.sender, address(poolManager), uint160(uint256(-_d1)), zc);
    (_d0, _d1) = (0, 0);
  }

  function _takePair(bytes memory _p) internal {
    (,, address _to) = abi.decode(_p, (address, address, address));
    if (_d0 < 0) revert DeltaNotPositive(address(0));
    if (_d1 < 0) revert DeltaNotPositive(zc);
    poolManager.pay(address(0), _to, uint256(_d0));
    poolManager.pay(zc, _to, uint256(_d1));
    (_d0, _d1) = (0, 0);
  }

  function _sweep(bytes memory _p) internal {
    (address _currency, address _to) = abi.decode(_p, (address, address));
    require(_currency == address(0), 'eth only');
    uint256 _bal = address(this).balance;
    _ethIn = 0;
    if (_bal != 0) {
      (bool _ok,) = _to.call{value: _bal}('');
      require(_ok, 'sweep');
    }
  }

  function _checkMax(uint256 _a0, uint256 _a1, uint128 _max0, uint128 _max1) internal pure {
    if (_a0 > _max0) revert MaximumAmountExceeded(_max0, uint128(_a0));
    if (_a1 > _max1) revert MaximumAmountExceeded(_max1, uint128(_a1));
  }

  function _amount0(uint256 _sa, uint256 _sb, uint128 _liq, bool _up) internal pure returns (uint256) {
    uint256 _n1 = uint256(_liq) << 96;
    if (!_up) return Math.mulDiv(_n1, _sb - _sa, _sb) / _sa;
    return Math.ceilDiv(Math.mulDiv(_n1, _sb - _sa, _sb, Math.Rounding.Ceil), _sa);
  }

  function _amount1(uint256 _sa, uint256 _sb, uint128 _liq, bool _up) internal pure returns (uint256) {
    return Math.mulDiv(_liq, _sb - _sa, Q96, _up ? Math.Rounding.Ceil : Math.Rounding.Floor);
  }
}
