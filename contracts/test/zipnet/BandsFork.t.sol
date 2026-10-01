// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {Test} from 'forge-std/Test.sol';

import {ZipLiquidityBands} from 'zipnet/ZipLiquidityBands.sol';

interface ISendItFactory {
  function poolKeyFor(address token) external view returns (ZipLiquidityBands.PoolKey memory);
  function startTickOf(address token) external view returns (int24);
}

interface IV4PositionManager {
  function ownerOf(uint256 id) external view returns (address);
  function getPositionLiquidity(uint256 id) external view returns (uint128);
  function getPoolAndPositionInfo(uint256 id) external view returns (ZipLiquidityBands.PoolKey memory, uint256 info);
  function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
}

interface IZcToken {
  function market() external view returns (address);
  function rewardSource() external view returns (address);
  function pendingReward(address) external view returns (uint256);
  function notifyReward(uint256) external payable;
}

struct SwapParams {
  bool zeroForOne;
  int256 amountSpecified;
  uint160 sqrtPriceLimitX96;
}

interface IV4PoolManager {
  function unlock(bytes calldata data) external returns (bytes memory);
  function swap(ZipLiquidityBands.PoolKey memory key, SwapParams memory params, bytes calldata hookData)
    external
    returns (int256);
  function settle() external payable returns (uint256);
  function take(address currency, address to, uint256 amount) external;
}

/// @notice Buys ZC with ETH through the real PoolManager (exact input, up to a price limit)
contract TestBuyRouter {
  IV4PoolManager internal immutable PM;
  address internal immutable ZC;

  constructor(address _pm, address _zc) {
    (PM, ZC) = (IV4PoolManager(_pm), _zc);
  }

  function buy(ZipLiquidityBands.PoolKey memory _key, uint256 _ethIn, uint160 _limit) external payable {
    PM.unlock(abi.encode(_key, _ethIn, _limit, msg.sender));
  }

  function unlockCallback(bytes calldata _data) external returns (bytes memory) {
    require(msg.sender == address(PM));
    (ZipLiquidityBands.PoolKey memory _key, uint256 _ethIn, uint160 _limit, address _to) =
      abi.decode(_data, (ZipLiquidityBands.PoolKey, uint256, uint160, address));
    int256 _delta = PM.swap(_key, SwapParams(true, -int256(_ethIn), _limit), '');
    int128 _a0 = int128(_delta >> 128);
    int128 _a1 = int128(_delta);
    PM.settle{value: uint256(uint128(-_a0))}();
    PM.take(ZC, _to, uint256(uint128(_a1)));
    return '';
  }

  receive() external payable {}
}

interface IV4PoolManagerSync {
  function sync(address currency) external;
}

/// @notice Sells ZC for ETH through the real PoolManager (exact input, up to a price limit); keeps unsold ZC
contract TestSellRouter {
  IV4PoolManager internal immutable PM;
  address internal immutable ZC;

  constructor(address _pm, address _zc) {
    (PM, ZC) = (IV4PoolManager(_pm), _zc);
  }

  function sell(ZipLiquidityBands.PoolKey memory _key, uint256 _zcIn, uint160 _limit) external {
    PM.unlock(abi.encode(_key, _zcIn, _limit));
  }

  function unlockCallback(bytes calldata _data) external returns (bytes memory) {
    require(msg.sender == address(PM));
    (ZipLiquidityBands.PoolKey memory _key, uint256 _zcIn, uint160 _limit) =
      abi.decode(_data, (ZipLiquidityBands.PoolKey, uint256, uint160));
    int256 _delta = PM.swap(_key, SwapParams(false, -int256(_zcIn), _limit), '');
    int128 _a0 = int128(_delta >> 128);
    int128 _a1 = int128(_delta);
    IV4PoolManagerSync(address(PM)).sync(ZC);
    IERC20(ZC).transfer(address(PM), uint256(uint128(-_a1)));
    PM.settle();
    if (_a0 > 0) PM.take(address(0), address(this), uint256(uint128(_a0)));
    return '';
  }

  receive() external payable {}
}

/**
 * @notice ZipLiquidityBands against the real ZC pool on a mainnet fork: the real v4 PositionManager, Permit2,
 *         PoolManager, ZC token and launch hook.
 *
 *   ETHEREUM_MAINNET_RPC=<url> forge test --match-contract BandsForkTest -vv
 *
 * Skipped when ETHEREUM_MAINNET_RPC is unset.
 */
contract BandsForkTest is Test {
  address internal constant ZC = 0x2CA7B61B23b15e75aC7AB60Dd6f627895d64a46E;
  address internal constant FACTORY = 0x8D37c2981bdF809567092fd458B6bf3e97ee860c;
  address internal constant HOOK = 0xCb69D5aBe0589AF4c57b0dCCA292980D5E52C0c0;
  address internal constant POSM = 0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e;
  address internal constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
  address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
  bytes32 internal constant POOL_ID = 0x29f8c48856bf83141d3089dfa621683c711dddba3a25e13e5cbf2fad90146eb9; // guard:allow (public pool id)
  uint256 internal constant LOCKED_TOKEN_ID = 418_643;

  bool internal forked;
  ZipLiquidityBands internal bands;
  address internal safe = makeAddr('safe');
  address internal keeper = makeAddr('keeper');
  address internal buyer = makeAddr('buyer');

  function setUp() public {
    string memory _rpc = vm.envOr('ETHEREUM_MAINNET_RPC', string(''));
    if (bytes(_rpc).length == 0) return;
    vm.createSelectFork(_rpc);
    forked = true;
    bands = new ZipLiquidityBands(
      safe,
      ZC,
      POSM,
      HOOK,
      address(0),
      10_000_000 ether,
      ZipLiquidityBands.Caps(1_000_000 ether, 2_000_000 ether, 1000 ether, 1 days),
      [uint16(7000), 2000, 1000]
    );
    // The test deployer's first-contract address holds stray mainnet ETH; start from zero so balances read cleanly
    vm.deal(address(bands), 0);
  }

  modifier onFork() {
    if (!forked) vm.skip(true);
    _;
  }

  /// @dev Real ZC transfers out of the market (as MainnetFork.t.sol), so ZC's own accounting runs
  function _fundZc(address _to, uint256 _value) internal {
    vm.prank(IZcToken(ZC).market());
    IERC20(ZC).transfer(_to, _value);
  }

  /// @dev ETH arriving the way a harvest does (a plain transfer from someone else than the Safe)
  function _fundEth(uint256 _value) internal {
    vm.deal(buyer, buyer.balance + _value);
    vm.prank(buyer);
    (bool _ok,) = address(bands).call{value: _value}('');
    assertTrue(_ok);
  }

  /// @dev Every position this contract ever minted lies entirely above the launch range (upper tick <= LAUNCH_LOWER)
  function _assertAllAboveTheLaunchRange() internal view {
    for (uint8 _b; _b < 3; ++_b) {
      uint256 _id = _tokenId(_b);
      if (_id == 0) continue;
      (, uint256 _info) = IV4PositionManager(POSM).getPoolAndPositionInfo(_id);
      int24 _lo = int24(uint24(_info >> 8));
      int24 _hi = int24(uint24(_info >> 32));
      assertLt(_lo, _hi);
      assertLe(_hi, bands.LAUNCH_LOWER(), 'a treasury position reaches into or below the launch range');
    }
  }

  /// @dev Marks the contracts a deposit touches cold again (vm.cool), so later measurements are not flattered by
  ///      storage an earlier call in the same test warmed
  function _cool() internal {
    address[8] memory _a =
      [address(bands), POSM, POOL_MANAGER, PERMIT2, ZC, 0x8B72b9B8E544F944cdcDf0CDb6194F917AC1Eba5, HOOK, safe];
    for (uint256 _i; _i < _a.length; ++_i) {
      (bool _ok,) = address(vm).call(abi.encodeWithSignature('cool(address)', _a[_i]));
      _ok; // older Foundry without vm.cool: measurements are then warm
    }
  }

  function _tokenId(uint8 _b) internal view returns (uint256 _id) {
    (_id,,,) = bands.bands(_b);
  }

  function test_fork_poolKeyAndLaunchRangeMatchTheChain() public onFork {
    ZipLiquidityBands.PoolKey memory _k = ISendItFactory(FACTORY).poolKeyFor(ZC);
    ZipLiquidityBands.PoolKey memory _ours = bands.poolKey();
    assertEq(keccak256(abi.encode(_k)), keccak256(abi.encode(_ours)), 'pool key');
    assertEq(bands.POOL_ID(), POOL_ID);
    assertEq(address(bands.POOL_MANAGER()), POOL_MANAGER);
    assertEq(address(bands.PERMIT2()), PERMIT2);
    assertEq(ISendItFactory(FACTORY).startTickOf(ZC), bands.LAUNCH_UPPER(), 'launch start tick');

    // The locked launch position's own ticks, from the position manager
    (, uint256 _info) = IV4PositionManager(POSM).getPoolAndPositionInfo(LOCKED_TOKEN_ID);
    int24 _lo = int24(uint24(_info >> 8));
    int24 _hi = int24(uint24(_info >> 32));
    assertEq(_lo, bands.LAUNCH_LOWER());
    assertEq(_hi, bands.LAUNCH_UPPER());
    for (uint8 _b; _b < 3; ++_b) {
      (, int24 _bh) = bands.bandTicks(_b);
      assertLe(_bh, _lo, 'band is not above the launch position');
    }
    (uint160 _sp, int24 _t) = bands.slot0();
    assertGt(_sp, 0);
    assertTrue(_t > _lo && _t < _hi, 'price is inside the launch range today');
  }

  function test_fork_depositMintsAllThreeBands_outOfRange_thenSkipsTheLiveBand_andCollectPaysTheSafe() public onFork {
    _firstDeposit();
    _topUp();
    _buyIntoU1();
    _depositSkipsTheLiveBand();
    _inRangeAddReverts();
    _collectPaysTheSafe();
    _assertAllAboveTheLaunchRange();
  }

  function _firstDeposit() internal {
    _fundZc(address(bands), 1_000_000 ether);
    _fundEth(0.05 ether);
    (uint256 _dz, bool _ok) = bands.depositable();
    assertEq(_dz, 1_000_000 ether);
    assertTrue(_ok);

    uint256 _pmEth = POOL_MANAGER.balance;
    _cool();
    uint256 _g = gasleft();
    vm.prank(keeper);
    bands.deposit();
    emit log_named_uint('gas: first deposit, mints all three bands', _g - gasleft());

    uint256[3] memory _want = [uint256(700_000 ether), 200_000 ether, 100_000 ether];
    for (uint8 _b; _b < 3; ++_b) {
      uint256 _id = _tokenId(_b);
      assertEq(IV4PositionManager(POSM).ownerOf(_id), address(bands), 'NFT held by the contract');
      assertEq(IV4PositionManager(POSM).getPositionLiquidity(_id), bands.liquidityFor(_b, _want[_b]));
      assertTrue(bands.outOfRange(_b), 'band is out of range');
      (, uint128 _z,,) = bands.bands(_b);
      assertApproxEqRel(_z, _want[_b], 1e3);
      assertLe(_z, _want[_b]);
    }
    _assertAllAboveTheLaunchRange();
    assertEq(POOL_MANAGER.balance, _pmEth, 'no ETH went into the pool');
    assertEq(address(bands).balance, 0.05 ether, 'the ETH is untouched by deposit');
    assertEq(POSM.balance, 0, 'no ETH in the position manager');

    // ... and goes to the Safe
    uint256 _safeEth = safe.balance;
    vm.prank(keeper);
    assertEq(bands.forwardEth(), 0.05 ether);
    assertEq(safe.balance - _safeEth, 0.05 ether);
  }

  /// @dev After the interval: flush (nothing accrued yet) + increase, on the same NFTs
  function _topUp() internal {
    vm.warp(block.timestamp + 1 days);
    _fundZc(address(bands), 1_000_000 ether);
    _fundEth(0.05 ether);
    uint256 _u1 = _tokenId(0);
    uint128 _l1 = IV4PositionManager(POSM).getPositionLiquidity(_u1);
    _cool();
    uint256 _g = gasleft();
    bands.deposit();
    emit log_named_uint('gas: top-up deposit, all three bands', _g - gasleft());
    assertEq(_tokenId(0), _u1, 'same U1 position');
    assertGt(IV4PositionManager(POSM).getPositionLiquidity(_u1), _l1);
    assertEq(address(bands).balance, 0.05 ether, 'ETH still untouched');
  }

  /**
   * @notice The owner's rule on the real pool: sell ZC until the price is BELOW the launch price (tick above 196,600,
   *         ZC cheaper than at launch), with ETH on hand. deposit() still only adds ZC to the U bands above the launch
   *         range: no position below it, no ETH into the pool, and the ETH goes to the Safe.
   */
  function test_fork_priceBelowTheLaunchRange_nothingIsAddedBelow_andEthGoesToTheSafe() public onFork {
    // Sell ZC into the pool: the market's ZC through a sell router, down past the launch price
    TestSellRouter _router = new TestSellRouter(POOL_MANAGER, ZC);
    // In rounds (each sale returns the ZC to the PoolManager, which is where _fundZc takes it from). Limit: the sqrt
    // price at tick 219,600 (FDV about 0.29 ETH, far below the launch price)
    int24 _t;
    for (uint256 _i; _i < 10 && _t <= bands.LAUNCH_UPPER(); ++_i) {
      _fundZc(address(_router), 100_000_000 ether);
      _router.sell(bands.poolKey(), 100_000_000 ether, 4_647_234_453_782_180_201_253_421_590_937_911);
      (, _t) = bands.slot0();
    }
    emit log_named_int('tick after the sell', _t);
    assertGt(_t, bands.LAUNCH_UPPER(), 'price is below the launch price');

    _fundZc(address(bands), 1_000_000 ether);
    _fundEth(1 ether);
    uint256 _pmEth = POOL_MANAGER.balance;
    bands.deposit();
    for (uint8 _b; _b < 3; ++_b) {
      assertGt(_tokenId(_b), 0, 'the ZC still went to the U bands, above the range');
    }
    _assertAllAboveTheLaunchRange();
    assertEq(POOL_MANAGER.balance, _pmEth, 'no ETH went into the pool');
    uint256 _safeEth = safe.balance;
    bands.forwardEth();
    assertEq(safe.balance - _safeEth, 1 ether, 'all the ETH to the Safe');
  }

  /// @dev Buys ZC until the price is inside U1 (FDV above the launch sell-out); the trade crosses U1 and pays it fees
  function _buyIntoU1() internal {
    (,, uint256 _sa, uint256 _sb) = bands.bandRange(0);
    TestBuyRouter _router = new TestBuyRouter(POOL_MANAGER, ZC);
    vm.deal(buyer, 1000 ether);
    vm.prank(buyer);
    _router.buy{value: 500 ether}(bands.poolKey(), 500 ether, uint160((_sa + _sb) / 2));
    (, int24 _t) = bands.slot0();
    emit log_named_int('tick after the buy', _t);
    assertTrue(_t >= 115_200 && _t < 127_600, 'price not inside U1');
    assertFalse(bands.outOfRange(0));
  }

  /// @dev A deposit now skips U1 (its share goes to U2) and never adds to the live band
  function _depositSkipsTheLiveBand() internal {
    vm.warp(block.timestamp + 1 days);
    _fundZc(address(bands), 1_000_000 ether);
    uint256 _u1 = _tokenId(0);
    uint128 _u1Liq = IV4PositionManager(POSM).getPositionLiquidity(_u1);
    (, uint128 _u2Before,,) = bands.bands(1);
    vm.expectEmit(true, false, false, false, address(bands));
    emit ZipLiquidityBands.Skipped(0, ZipLiquidityBands.Skip.InRange, 0);
    bands.deposit();
    assertEq(IV4PositionManager(POSM).getPositionLiquidity(_u1), _u1Liq, 'U1 unchanged');
    (, uint128 _u2After,,) = bands.bands(1);
    assertApproxEqRel(_u2After - _u2Before, 900_000 ether, 1e15, 'U1 share went to U2');
  }

  /// @dev The real PositionManager's own guard: adding ZC-only to the live band reverts (the ETH max is 0)
  function _inRangeAddReverts() internal {
    bytes[] memory _p = new bytes[](2);
    _p[0] =
      abi.encode(_tokenId(0), uint256(bands.liquidityFor(0, 1000 ether)), uint128(0), uint128(1000 ether), bytes(''));
    _p[1] = abi.encode(address(0), ZC);
    vm.prank(address(bands));
    vm.expectRevert();
    IV4PositionManager(POSM)
      .modifyLiquidities(abi.encode(abi.encodePacked(uint8(0x00), uint8(0x0d)), _p), block.timestamp);
  }

  /// @dev Anyone collects; only the Safe receives
  function _collectPaysTheSafe() internal {
    uint256 _safeEth = safe.balance;
    uint256 _safeZc = IERC20(ZC).balanceOf(safe);
    _cool();
    uint256 _g = gasleft();
    vm.prank(keeper);
    (uint256 _fe, uint256 _fz) = bands.collect(0);
    emit log_named_uint('gas: collect', _g - gasleft());
    emit log_named_decimal_uint('U1 ETH fees collected', _fe, 18);
    assertGt(_fe, 0, 'U1 earned ETH fees');
    assertEq(safe.balance - _safeEth, _fe);
    assertEq(IERC20(ZC).balanceOf(safe) - _safeZc, _fz);
    assertEq(keeper.balance + IERC20(ZC).balanceOf(keeper), 0, 'the caller gains nothing');
  }

  function test_fork_everyExitPaysOnlyTheSafe() public onFork {
    _fundZc(address(bands), 1_000_000 ether);
    _fundEth(0.05 ether);
    bands.deposit();
    uint256 _vaultZc = IERC20(ZC).balanceOf(address(bands));
    uint256 _poolZcBefore = IERC20(ZC).balanceOf(POOL_MANAGER);

    address[3] memory _others = [keeper, address(this), buyer];
    uint256[3] memory _before;
    for (uint256 _i; _i < 3; ++_i) {
      _before[_i] = _others[_i].balance + IERC20(ZC).balanceOf(_others[_i]);
    }

    // Strangers can't exit
    vm.prank(keeper);
    vm.expectRevert(ZipLiquidityBands.OnlySafe.selector);
    bands.withdrawAll();

    uint256 _u3 = _tokenId(2);
    uint128 _u3Liq = IV4PositionManager(POSM).getPositionLiquidity(_u3);
    vm.prank(safe);
    bands.release(2); // U3's NFT to the Safe (its liquidity goes with it)
    assertEq(IV4PositionManager(POSM).ownerOf(_u3), safe);

    vm.prank(safe);
    bands.withdrawAll();
    assertEq(IERC20(ZC).balanceOf(address(bands)), 0);
    assertEq(address(bands).balance, 0);
    // U1 and U2's ZC plus idle dust reached the Safe (U3's stays in the released NFT), less v4's rounding of a few
    // wei; the idle ETH (never put into liquidity) too
    assertApproxEqRel(IERC20(ZC).balanceOf(safe), 900_000 ether, 1e12);
    assertGt(_u3Liq, 0);
    assertEq(safe.balance, 0.05 ether, 'the idle ETH');
    assertApproxEqAbs(
      _poolZcBefore - IERC20(ZC).balanceOf(POOL_MANAGER), IERC20(ZC).balanceOf(safe) - _vaultZc, 10
    );
    for (uint256 _i; _i < 3; ++_i) {
      assertEq(_others[_i].balance + IERC20(ZC).balanceOf(_others[_i]), _before[_i], 'someone else received funds');
    }
  }

  /// @notice Gas at the launch weights (U1 only): first mint, then a top-up, then forwarding ETH
  function test_fork_launchWeightsGas() public onFork {
    vm.prank(safe);
    bands.setWeights([uint16(10_000), 0, 0]);
    _fundZc(address(bands), 1_000_000 ether);
    _cool();
    uint256 _g = gasleft();
    bands.deposit();
    emit log_named_uint('gas: first deposit, U1', _g - gasleft());
    vm.warp(block.timestamp + 1 days);
    _fundZc(address(bands), 1_000_000 ether);
    _cool();
    _g = gasleft();
    bands.deposit();
    emit log_named_uint('gas: top-up deposit, U1', _g - gasleft());
    _cool();
    _g = gasleft();
    bands.collect(0);
    emit log_named_uint('gas: collect (nothing accrued)', _g - gasleft());
    _fundEth(0.05 ether);
    _cool();
    _g = gasleft();
    bands.forwardEth();
    emit log_named_uint('gas: forwardEth', _g - gasleft());
  }

  function test_fork_releaseSendsTheNftToTheSafe() public onFork {
    _fundZc(address(bands), 1_000_000 ether);
    bands.deposit();
    uint256 _id = _tokenId(0);
    vm.prank(safe);
    bands.release(0);
    assertEq(IV4PositionManager(POSM).ownerOf(_id), safe);
  }

  function test_fork_claimRewards_onIdleZc() public onFork {
    IZcToken _zc = IZcToken(ZC);
    _fundZc(address(bands), 1_000_000 ether);
    address _source = _zc.rewardSource();
    vm.deal(_source, 100 ether);
    vm.prank(_source);
    _zc.notifyReward{value: 100 ether}(100 ether);
    uint256 _pending = _zc.pendingReward(address(bands));
    assertGt(_pending, 0, 'idle ZC earns holder rewards');
    vm.prank(keeper);
    bands.claimRewards();
    assertEq(safe.balance, _pending, 'all of it to the Safe');
    assertEq(address(bands).balance, 0, 'none kept for liquidity');
  }
}
