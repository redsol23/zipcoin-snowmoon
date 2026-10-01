// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from 'forge-std/Test.sol';

import {ZipLiquidityBands} from 'zipnet/ZipLiquidityBands.sol';

import {MockPermit2, MockPoolManager, MockPositionManager} from './BandsMocks.sol';
import {MockZC} from './ZipnetBase.sol';

/// @notice ZipLiquidityBands against a local stand-in for the v4 PositionManager, Permit2 and PoolManager
contract BandsTest is Test {
  uint128 internal constant MAX_DAY_ZC = 10_000_000 ether;
  /// @dev tick 165,930 and its sqrt price: ZC at about 59 ETH FDV, inside the launch range
  int24 internal constant SPOT_TICK = 165_930;
  uint160 internal constant SPOT_SQRT = 317_562_884_112_765_502_424_763_899_389_167;

  MockZC internal zc;
  MockPoolManager internal pm;
  MockPermit2 internal p2;
  MockPositionManager internal posm;
  ZipLiquidityBands internal bands;
  address internal safe = makeAddr('safe');
  address internal hook = makeAddr('hook');
  address internal harvestSource = makeAddr('harvestSource');
  address internal keeper = makeAddr('keeper');
  address internal stranger = makeAddr('stranger');

  function setUp() public {
    vm.warp(1_800_000_000);
    zc = new MockZC();
    pm = new MockPoolManager();
    p2 = new MockPermit2();
    posm = new MockPositionManager(pm, p2, address(zc), hook);
    ZipLiquidityBands.PoolKey memory _key = ZipLiquidityBands.PoolKey(address(0), address(zc), 10_000, 200, hook);
    pm.init(address(posm), keccak256(abi.encode(keccak256(abi.encode(_key)), uint256(6))));
    pm.setPrice(SPOT_SQRT, SPOT_TICK);
    bands = _deploy(_phase1(), [uint16(10_000), 0, 0]);
    for (uint8 _b; _b < 3; ++_b) {
      (int24 _lo, int24 _hi, uint256 _sa, uint256 _sb) = bands.bandRange(_b);
      posm.setSqrt(_lo, _sa);
      posm.setSqrt(_hi, _sb);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------------------------------------------

  function _phase1() internal pure returns (ZipLiquidityBands.Caps memory) {
    return ZipLiquidityBands.Caps({perCallZc: 1_000_000 ether, dayZc: 2_000_000 ether, minZc: 1000 ether, minInterval: 1 days});
  }

  function _deploy(ZipLiquidityBands.Caps memory _caps, uint16[3] memory _w) internal returns (ZipLiquidityBands) {
    return new ZipLiquidityBands(safe, address(zc), address(posm), hook, harvestSource, MAX_DAY_ZC, _caps, _w);
  }

  function _fund(uint256 _zc) internal {
    zc.mint(address(bands), _zc);
  }

  /// @dev ETH arriving the way harvests and rewards do: a plain transfer from someone
  function _sendEth(address _from, uint256 _eth) internal {
    vm.deal(_from, _from.balance + _eth);
    vm.prank(_from);
    (bool _ok,) = address(bands).call{value: _eth}('');
    assertTrue(_ok);
  }

  function _setWeights(uint16[3] memory _w) internal {
    vm.prank(safe);
    bands.setWeights(_w);
  }

  function _loose() internal {
    vm.prank(safe);
    bands.setCaps(ZipLiquidityBands.Caps(MAX_DAY_ZC, MAX_DAY_ZC, 1, 1 hours));
  }

  function _tokenId(uint8 _b) internal view returns (uint256 _id) {
    (_id,,,) = bands.bands(_b);
  }

  function _in(uint8 _b) internal view returns (uint128 _zcIn) {
    (, _zcIn,,) = bands.bands(_b);
  }

  /// @dev Puts the price inside band `_b` (between its edges)
  function _priceInside(uint8 _b) internal {
    (int24 _lo, int24 _hi, uint256 _sa, uint256 _sb) = bands.bandRange(_b);
    int24 _t = _lo + (_hi - _lo) / 2;
    pm.setPrice(uint160((_sa + _sb) / 2), _t);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // configuration
  // ---------------------------------------------------------------------------------------------------------------

  function test_bands_lieAboveTheLaunchRangeOnly_onTheSpacing_andCoverEverythingAbove() public {
    assertEq(bands.BANDS(), 3);
    int24 _prevLo = bands.LAUNCH_LOWER();
    for (uint8 _b; _b < 3; ++_b) {
      (int24 _lo, int24 _hi) = bands.bandTicks(_b);
      assertEq(_hi, _prevLo, 'U bands are contiguous down from the sell-out tick');
      assertLt(_lo, _hi);
      assertEq(_lo % 200, 0);
      assertEq(_hi % 200, 0);
      assertLe(_hi, bands.LAUNCH_LOWER(), 'above the launch range (ticks fall as ZC gets dearer)');
      _prevLo = _lo;
    }
    assertEq(_prevLo, -887_200, 'U3 reaches the lowest usable tick');
    // The old ETH-only bands below the launch range are gone
    for (uint8 _b = 3; _b < 6; ++_b) {
      vm.expectRevert(ZipLiquidityBands.BadBand.selector);
      bands.bandTicks(_b);
    }
    vm.expectRevert(ZipLiquidityBands.BadBand.selector);
    bands.collect(3);
  }

  /**
   * @notice The sqrt-price constants against sqrt(1.0001^tick) * 2^96 computed independently at 80-digit precision.
   *         TickMath rounds up and approximates at the extremes, so they may differ in the last digits only.
   */
  function test_sqrtConstants_matchTheCurve() public view {
    uint256[4] memory _real = [
      uint256(4_310_618_291), // -887200 (TickMath is 2e-10 off here, by design)
      7_959_339_820_541_314_895_926_346_603_110, // 92200
      25_135_685_339_936_509_999_814_510_248_240, // 115200
      46_723_981_960_100_762_045_660_812_846_119 // 127600
    ];
    int24[4] memory _ticks = [int24(-887_200), 92_200, 115_200, 127_600];
    for (uint8 _b; _b < 3; ++_b) {
      (int24 _lo, int24 _hi, uint256 _sa, uint256 _sb) = bands.bandRange(_b);
      for (uint256 _i; _i < 4; ++_i) {
        if (_ticks[_i] == _lo) assertApproxEqRel(_sa, _real[_i], 1e9, 'lower sqrt'); // 1e-9
        if (_ticks[_i] == _hi) assertApproxEqRel(_sb, _real[_i], 1e9, 'upper sqrt');
      }
    }
    // Uniswap's own anchor: sqrt price at tick 165,930 brackets the pool's reported sqrtPriceX96 there
    assertGt(uint256(SPOT_SQRT), 317_558_402_591_283_610_718_687_064_630_023);
  }

  function test_constructor_readsThePool_andChecksIt() public {
    assertEq(address(bands.POOL_MANAGER()), address(pm));
    assertEq(address(bands.PERMIT2()), address(p2));
    assertEq(bands.SAFE(), safe);
    (uint160 _sp, int24 _t) = bands.slot0();
    assertEq(_sp, SPOT_SQRT);
    assertEq(_t, SPOT_TICK);

    pm.setPrice(0, 0);
    vm.expectRevert(ZipLiquidityBands.PoolNotInitialized.selector);
    _deploy(_phase1(), [uint16(10_000), 0, 0]);
    pm.setPrice(SPOT_SQRT, SPOT_TICK);

    ZipLiquidityBands.Caps memory _c = _phase1();
    _c.dayZc = MAX_DAY_ZC + 1;
    vm.expectRevert(ZipLiquidityBands.BadCaps.selector);
    _deploy(_c, [uint16(10_000), 0, 0]);
    vm.expectRevert(ZipLiquidityBands.BadWeights.selector);
    _deploy(_phase1(), [uint16(7000), 2000, 0]);
    vm.expectRevert(ZipLiquidityBands.BadConfig.selector);
    new ZipLiquidityBands(address(0), address(zc), address(posm), hook, address(0), 1, _phase1(), [uint16(0), 0, 0]);
  }

  function test_onlySafe_canConfigureAndExit() public {
    vm.startPrank(stranger);
    vm.expectRevert(ZipLiquidityBands.OnlySafe.selector);
    bands.setCaps(_phase1());
    vm.expectRevert(ZipLiquidityBands.OnlySafe.selector);
    bands.setWeights([uint16(10_000), 0, 0]);
    vm.expectRevert(ZipLiquidityBands.OnlySafe.selector);
    bands.pause();
    vm.expectRevert(ZipLiquidityBands.OnlySafe.selector);
    bands.unpause();
    vm.expectRevert(ZipLiquidityBands.OnlySafe.selector);
    bands.setForwardAll(true);
    vm.expectRevert(ZipLiquidityBands.OnlySafe.selector);
    bands.withdraw(0, 1, 0, 0);
    vm.expectRevert(ZipLiquidityBands.OnlySafe.selector);
    bands.withdrawAll();
    vm.expectRevert(ZipLiquidityBands.OnlySafe.selector);
    bands.release(0);
    vm.expectRevert(ZipLiquidityBands.OnlySafe.selector);
    bands.sweep(address(zc));
    vm.stopPrank();
  }

  /// @notice R2-M1: ETH is accepted from anyone (the escrows' harvests pay the pool's TREASURY, which may be this
  ///         contract), every arrival is logged, and it waits for forwardEth(), which anyone may call.
  function test_receive_acceptsEthFromAnyone_andForwardEthSendsItAllToTheSafe() public {
    address[5] memory _from = [address(zc), address(posm), safe, harvestSource, stranger];
    for (uint256 _i; _i < 5; ++_i) {
      vm.expectEmit(address(bands));
      emit ZipLiquidityBands.EthReceived(_from[_i], 1 ether);
      _sendEth(_from[_i], 1 ether);
    }
    uint256 _safeBefore = safe.balance;
    vm.expectEmit(address(bands));
    emit ZipLiquidityBands.EthToSafe(5 ether);
    vm.prank(stranger);
    assertEq(bands.forwardEth(), 5 ether);
    assertEq(safe.balance - _safeBefore, 5 ether, 'all of it to the Safe');
    assertEq(address(bands).balance, 0);
    assertEq(stranger.balance, 0, 'the caller gains nothing');
    // Nothing to forward: a no-op, not a revert
    assertEq(bands.forwardEth(), 0);
    // Works while paused
    _sendEth(harvestSource, 0.1 ether);
    vm.prank(safe);
    bands.pause();
    assertEq(bands.forwardEth(), 0.1 ether);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // nothing below the launch range (owner decision 2026-09-29)
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * @notice The owner's rule: the treasury only ever adds liquidity ABOVE the launch position's sell-out point, never
   *         below the launch range. At any price, with ZC and plenty of ETH on hand, deposit() mints nothing with a
   *         range reaching below LAUNCH_LOWER (so nothing near or below the start tick 196,600), sends no ETH to the
   *         pool, and every wei of ETH ends at the Safe.
   */
  function testFuzz_deposit_neverAddsBelowTheLaunchRange_andEthGoesToTheSafe(int24 _tick, uint96 _eth, uint16 _w1)
    public
  {
    _tick = int24(bound(_tick, -887_272, 887_272));
    _eth = uint96(bound(_eth, 1, 1000 ether));
    _w1 = uint16(bound(_w1, 0, 10_000));
    _loose();
    _setWeights([_w1, 10_000 - _w1, 0]);
    pm.setPrice(uint160(2 ** 96), _tick);
    _fund(1_000_000 ether);
    _sendEth(harvestSource, _eth);
    _sendEth(safe, 1 ether);
    try bands.deposit() {} catch {}
    vm.warp(block.timestamp + 1 days);
    _fund(1_000_000 ether);
    try bands.deposit() {} catch {}

    for (uint256 _id = 1; _id < posm.nextTokenId(); ++_id) {
      (int24 _lo, int24 _hi,,,,) = posm.pos(_id);
      assertLe(_hi, bands.LAUNCH_LOWER(), 'a position reaches into or below the launch range');
      assertLt(_lo, _hi);
      assertLt(_hi, int24(196_600), 'never at or below the start tick');
    }
    assertEq(address(pm).balance, 0, 'no ETH went into the pool');
    assertEq(address(posm).balance, 0);
    assertEq(address(bands).balance, uint256(_eth) + 1 ether, 'ETH untouched by deposit');
    uint256 _safeBefore = safe.balance;
    bands.forwardEth();
    assertEq(safe.balance - _safeBefore, uint256(_eth) + 1 ether, 'all the ETH to the Safe');
  }

  /// @notice The same at the launch price and below it (ZC cheaper than at launch): nothing at all is added
  function test_deposit_atOrBelowTheLaunchPrice_addsOnlyAboveTheRange() public {
    _loose();
    _setWeights([uint16(7000), 2000, 1000]);
    int24[3] memory _ticks = [int24(196_600), 219_600, 500_000];
    for (uint256 _i; _i < 3; ++_i) {
      pm.setPrice(uint160(2 ** 96), _ticks[_i]);
      _fund(1_000_000 ether);
      _sendEth(harvestSource, 1 ether);
      bands.deposit();
      vm.warp(block.timestamp + 1 hours);
    }
    assertEq(posm.nextTokenId() - 1, 3, 'only the three U bands were minted');
    for (uint256 _id = 1; _id < posm.nextTokenId(); ++_id) {
      (, int24 _hi,,,,) = posm.pos(_id);
      assertLe(_hi, bands.LAUNCH_LOWER());
    }
    assertEq(address(pm).balance, 0, 'no ETH liquidity');
    assertEq(address(bands).balance, 3 ether);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // deposit
  // ---------------------------------------------------------------------------------------------------------------

  function test_deposit_phase1_mintsU1WithZc_ownedByTheContract() public {
    _fund(5_000_000 ether);
    _sendEth(harvestSource, 1 ether);
    (uint256 _dz, bool _ok) = bands.depositable();
    assertEq(_dz, 1_000_000 ether);
    assertTrue(_ok);

    vm.prank(keeper);
    bands.deposit();
    uint256 _u1 = _tokenId(0);
    assertEq(posm.ownerOf(_u1), address(bands));
    assertEq(posm.getPositionLiquidity(_u1), bands.liquidityFor(0, 1_000_000 ether));
    uint128 _zIn = _in(0);
    assertApproxEqRel(_zIn, 1_000_000 ether, 1e3, 'U1 took the ZC share, less rounding dust');
    assertEq(_tokenId(1) + _tokenId(2), 0, 'no other band touched');
    assertEq(zc.balanceOf(address(pm)), _zIn, 'the ZC went to the pool');
    assertEq(address(pm).balance, 0, 'no ETH went to the pool');
    assertEq(address(bands).balance, 1 ether, 'the ETH waits for forwardEth');
    assertEq(bands.lastDeposit(), block.timestamp);
    assertEq(bands.usedZc(), _zIn);

    // One-sided: the position holds only ZC at the current price
    (uint256 _a0, uint256 _a1) = posm.amounts(115_200, 127_600, posm.getPositionLiquidity(_u1), false);
    assertEq(_a0, 0);
    assertGt(_a1, 0);
  }

  function test_deposit_fullWeights_splitsAcrossAllThreeBands() public {
    _setWeights([uint16(7000), 2000, 1000]);
    _fund(1_000_000 ether);
    bands.deposit();
    uint256[3] memory _want = [uint256(700_000 ether), 200_000 ether, 100_000 ether];
    for (uint8 _b; _b < 3; ++_b) {
      assertGt(_tokenId(_b), 0);
      assertApproxEqRel(_in(_b), _want[_b], 1e3);
    }
  }

  function test_deposit_skipsABandThePriceIsIn_andFallsThroughToTheNextOut() public {
    _setWeights([uint16(7000), 2000, 1000]);
    _loose();
    _fund(1_000_000 ether);
    _priceInside(0); // FDV between 2,875 and 9,935 ETH: U1 is live
    vm.expectEmit(address(bands));
    emit ZipLiquidityBands.Skipped(0, ZipLiquidityBands.Skip.InRange, 700_000 ether);
    bands.deposit();
    assertEq(_tokenId(0), 0, 'U1 not touched');
    uint128 _u3 = _in(2);
    assertApproxEqRel(_in(1), 900_000 ether, 1e3, 'U1 share went to U2');
    assertApproxEqRel(_u3, 100_000 ether, 1e3);

    // Price past U1 and inside U2: U1 cannot take ZC-only either, everything goes to U3
    vm.warp(block.timestamp + 1 days);
    _fund(1_000_000 ether);
    _priceInside(1);
    bands.deposit();
    assertApproxEqRel(_in(2) - _u3, 1_000_000 ether, 1e3);
  }

  function test_deposit_everyBandInRange_waits_andRevertsWhenNothingAdded() public {
    _fund(1_000_000 ether);
    _priceInside(2); // above FDV 99,000: every U band is in range or past
    (uint256 _dz, bool _ok) = bands.depositable();
    assertEq(_dz, 0);
    assertFalse(_ok);
    vm.expectRevert(ZipLiquidityBands.NothingToDeposit.selector);
    bands.deposit();
    assertEq(zc.balanceOf(address(bands)), 1_000_000 ether, 'the ZC waits');
  }

  /// @notice ETH alone is nothing to deposit: it is never put into liquidity
  function test_deposit_ethOnly_isNothingToDeposit() public {
    _sendEth(harvestSource, 5 ether);
    (uint256 _dz, bool _ok) = bands.depositable();
    assertEq(_dz, 0);
    assertFalse(_ok);
    vm.expectRevert(ZipLiquidityBands.NothingToDeposit.selector);
    bands.deposit();
  }

  /// @notice The position manager's own guard: the ETH max is 0, so an in-range add reverts
  function test_otherAssetMaxZero_makesAnInRangeAddRevert() public {
    _fund(1_000_000 ether);
    bands.deposit(); // U1 minted while out of range
    uint256 _id = _tokenId(0);
    _priceInside(0);
    // Same call deposit() would build, attempted with the price inside the band
    bytes[] memory _p = new bytes[](2);
    _p[0] = abi.encode(_id, uint256(bands.liquidityFor(0, 1000 ether)), uint128(0), uint128(1000 ether), bytes(''));
    _p[1] = abi.encode(address(0), address(zc));
    vm.prank(address(bands));
    vm.expectPartialRevert(MockPositionManager.MaximumAmountExceeded.selector);
    posm.modifyLiquidities(abi.encode(abi.encodePacked(uint8(0x00), uint8(0x0d)), _p), block.timestamp);
  }

  function test_topUp_flushesFeesToTheSafeFirst_thenIncreases() public {
    _loose();
    _fund(1_000_000 ether);
    bands.deposit();
    uint256 _id = _tokenId(0);
    uint128 _l0 = posm.getPositionLiquidity(_id);

    // The band earned fees in both assets (price passed through and came back)
    vm.deal(address(pm), address(pm).balance + 0.3 ether);
    zc.mint(address(pm), 5000 ether);
    posm.accrue(_id, 0.3 ether, 5000 ether);

    vm.warp(block.timestamp + 1 hours);
    _fund(500_000 ether);
    uint256 _share = zc.balanceOf(address(bands)); // includes the first deposit's rounding dust
    vm.expectEmit(address(bands));
    emit ZipLiquidityBands.FeesCollected(0, 0.3 ether, 5000 ether);
    bands.deposit();
    assertEq(_tokenId(0), _id, 'same position');
    assertEq(posm.getPositionLiquidity(_id), _l0 + bands.liquidityFor(0, _share));
    assertEq(safe.balance, 0.3 ether, 'ETH fees to the Safe');
    assertEq(zc.balanceOf(safe), 5000 ether, 'ZC fees to the Safe');
    (,, uint128 _fe, uint128 _fz) = bands.bands(0);
    assertEq(_fe, 0.3 ether);
    assertEq(_fz, 5000 ether);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // collect, rewards, exits
  // ---------------------------------------------------------------------------------------------------------------

  function test_collect_anyonePaysTheSafe() public {
    vm.expectRevert(ZipLiquidityBands.NoPosition.selector);
    bands.collect(0);
    vm.expectRevert(ZipLiquidityBands.BadBand.selector);
    bands.collect(3);

    _fund(1_000_000 ether);
    bands.deposit();
    uint256 _id = _tokenId(0);
    vm.deal(address(pm), address(pm).balance + 0.01 ether);
    zc.mint(address(pm), 700 ether);
    posm.accrue(_id, 0.01 ether, 700 ether);
    uint128 _l = posm.getPositionLiquidity(_id);

    vm.prank(stranger);
    (uint256 _e, uint256 _z) = bands.collect(0);
    assertEq(_e, 0.01 ether);
    assertEq(_z, 700 ether);
    assertEq(safe.balance, 0.01 ether);
    assertEq(zc.balanceOf(safe), 700 ether);
    assertEq(stranger.balance + zc.balanceOf(stranger), 0, 'the caller gains nothing');
    assertEq(posm.getPositionLiquidity(_id), _l, 'collect removes no liquidity');
  }

  function test_claimRewards_sendsAllTheEthToTheSafe() public {
    _fund(1_000_000 ether);
    _sendEth(harvestSource, 0.5 ether); // harvest ETH waiting here goes along too
    zc.mint(stranger, 1_000_000 ether); // another holder
    zc.distributeRewards{value: 2 ether}();
    uint256 _pending = zc.pendingReward(address(bands));
    assertGt(_pending, 0);

    vm.prank(keeper);
    assertEq(bands.claimRewards(), _pending);
    assertEq(safe.balance, _pending + 0.5 ether, 'all of it to the Safe');
    assertEq(address(bands).balance, 0);

    vm.expectRevert(MockZC.NothingToClaim.selector);
    bands.claimRewards();
  }

  function test_withdraw_release_sweep_payOnlyTheSafe() public {
    _fund(1_000_000 ether);
    _sendEth(harvestSource, 0.05 ether);
    bands.deposit();
    uint256 _id = _tokenId(0);
    uint128 _l = posm.getPositionLiquidity(_id);

    vm.prank(safe);
    (uint256 _e, uint256 _z) = bands.withdraw(0, _l / 2, 0, 0);
    assertEq(_e, 0);
    assertGt(_z, 0);
    assertEq(zc.balanceOf(safe), _z);

    vm.prank(safe);
    bands.release(0);
    assertEq(posm.ownerOf(_id), safe);
    assertEq(_tokenId(0), 0);

    zc.mint(address(bands), 7 ether);
    uint256 _idle = zc.balanceOf(address(bands)); // 7 ZC plus the deposit's rounding dust
    uint256 _before = zc.balanceOf(safe);
    vm.prank(safe);
    bands.sweep(address(zc));
    assertEq(zc.balanceOf(safe) - _before, _idle);
    assertEq(zc.balanceOf(address(bands)), 0);
    vm.prank(safe);
    bands.sweep(address(0));
    assertEq(safe.balance, 0.05 ether);
    assertEq(address(bands).balance, 0);
  }

  function test_withdrawAll_emptiesEverythingToTheSafe_andPauses() public {
    _setWeights([uint16(7000), 2000, 1000]);
    _fund(3_000_000 ether);
    _sendEth(harvestSource, 1 ether);
    _loose();
    bands.deposit();
    vm.prank(safe);
    bands.withdrawAll();
    assertTrue(bands.paused());
    for (uint8 _b; _b < 3; ++_b) {
      assertEq(posm.getPositionLiquidity(_tokenId(_b)), 0);
    }
    assertEq(zc.balanceOf(address(bands)), 0);
    assertEq(address(bands).balance, 0);
    assertApproxEqAbs(zc.balanceOf(safe), 3_000_000 ether, 10, 'all ZC back, less rounding');
    assertEq(safe.balance, 1 ether, 'the idle ETH too');
  }

  function test_pause_stopsDepositOnly() public {
    _fund(1_000_000 ether);
    bands.deposit();
    vm.prank(safe);
    bands.pause();
    vm.warp(block.timestamp + 2 days);
    _fund(1_000_000 ether);
    (, bool _ok) = bands.depositable();
    assertFalse(_ok);
    vm.expectRevert(ZipLiquidityBands.IsPaused.selector);
    bands.deposit();
    bands.collect(0); // still works
    vm.prank(safe);
    bands.unpause();
    bands.deposit();
  }

  function test_forwardAll_sendsEverythingToTheSafe() public {
    _fund(1_000_000 ether);
    _sendEth(harvestSource, 0.2 ether);
    zc.mint(stranger, 1_000_000 ether);
    zc.distributeRewards{value: 1 ether}();
    uint256 _pending = zc.pendingReward(address(bands));
    assertGt(_pending, 0);
    vm.prank(safe);
    bands.setForwardAll(true);
    (uint256 _dz, bool _ok) = bands.depositable();
    assertEq(_dz, 1_000_000 ether);
    assertTrue(_ok);
    vm.prank(keeper);
    bands.deposit();
    assertEq(zc.balanceOf(safe), 1_000_000 ether);
    assertEq(safe.balance, 0.2 ether);
    assertEq(_tokenId(0), 0, 'nothing added to the pool');

    // Rewards earned before the forward are claimed straight through to the Safe
    vm.prank(keeper);
    bands.claimRewards();
    assertEq(safe.balance, 0.2 ether + _pending);
    assertEq(address(bands).balance, 0);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // caps
  // ---------------------------------------------------------------------------------------------------------------

  function test_minInterval_andMinimum() public {
    _fund(1_000_000 ether);
    bands.deposit();
    _fund(1_000_000 ether);
    vm.expectRevert(ZipLiquidityBands.TooSoon.selector);
    bands.deposit();
    vm.warp(block.timestamp + 1 days);
    bands.deposit();

    // Below the minimum: nothing to add
    vm.warp(block.timestamp + 1 days);
    zc.mint(address(bands), 999 ether - zc.balanceOf(address(bands)));
    (uint256 _dz, bool _ok) = bands.depositable();
    assertEq(_dz, 0);
    assertFalse(_ok);
    vm.expectRevert(ZipLiquidityBands.NothingToDeposit.selector);
    bands.deposit();
  }

  function test_setCaps_withinCeilingOnly() public {
    ZipLiquidityBands.Caps memory _c = _phase1();
    vm.startPrank(safe);
    _c.dayZc = MAX_DAY_ZC + 1;
    _c.perCallZc = 1;
    vm.expectRevert(ZipLiquidityBands.BadCaps.selector);
    bands.setCaps(_c);
    _c = _phase1();
    _c.perCallZc = _c.dayZc + 1;
    vm.expectRevert(ZipLiquidityBands.BadCaps.selector);
    bands.setCaps(_c);
    _c = _phase1();
    _c.minInterval = 1 hours - 1;
    vm.expectRevert(ZipLiquidityBands.BadCaps.selector);
    bands.setCaps(_c);
    _c = _phase1();
    _c.dayZc = MAX_DAY_ZC;
    bands.setCaps(_c);
    vm.stopPrank();
  }

  /// @notice Any caps the Safe may set: setCaps accepts exactly those within the ceiling
  function testFuzz_setCaps(uint128 _pz, uint128 _dz, uint32 _iv) public {
    ZipLiquidityBands.Caps memory _c = ZipLiquidityBands.Caps(_pz, _dz, 0, _iv);
    bool _valid = _dz <= MAX_DAY_ZC && _pz <= _dz && _iv >= 1 hours;
    vm.prank(safe);
    if (!_valid) vm.expectRevert(ZipLiquidityBands.BadCaps.selector);
    bands.setCaps(_c);
  }

  /**
   * @notice Random deposits at random times with random inflows: no call ever exceeds the per-call cap, no 24h window
   *         ever exceeds the day cap, deposits are at least minInterval apart, and every wei is accounted for.
   */
  function testFuzz_caps_holdOverAnySequence(uint256 _seed, uint128 _perZc, uint128 _dayZc, uint32 _interval) public {
    _dayZc = uint128(bound(_dayZc, 10_000 ether, MAX_DAY_ZC));
    _perZc = uint128(bound(_perZc, 1000 ether, _dayZc));
    _interval = uint32(bound(_interval, 1 hours, 3 days));
    vm.prank(safe);
    bands.setCaps(ZipLiquidityBands.Caps(_perZc, _dayZc, 1, _interval));
    _setWeights([uint16(7000), 2000, 1000]);

    uint256 _ethSent;
    for (uint256 _i; _i < 12; ++_i) {
      uint256 _r = uint256(keccak256(abi.encode(_seed, _i)));
      _fund(_r % (3 * uint256(_perZc)));
      uint256 _e = (_r >> 128) % 0.3 ether;
      if (_e != 0) _sendEth(harvestSource, _e);
      _ethSent += _e;
      vm.warp(block.timestamp + ((_r >> 64) % 2 days));
      _step();
    }
    // Conservation: all ZC is in the vault or the pool; no ETH ever went to the pool; all ETH is still here
    uint256 _zIn;
    for (uint8 _b; _b < 3; ++_b) {
      _zIn += _in(_b);
    }
    assertEq(zc.balanceOf(address(pm)), _zIn);
    assertEq(address(pm).balance, 0);
    assertEq(address(bands).balance, _ethSent);
    assertEq(zc.balanceOf(safe) + safe.balance, 0);
  }

  uint256 internal fLast;
  uint256 internal fWinStart;
  uint256 internal fWinZc;

  function _step() internal {
    ZipLiquidityBands.Caps memory _c;
    (_c.perCallZc, _c.dayZc,, _c.minInterval) = bands.caps();
    uint256 _zb = zc.balanceOf(address(bands));
    (uint256 _dz, bool _ok) = bands.depositable();
    try bands.deposit() {
      assertTrue(_ok, 'depositable said no');
      uint256 _zUsed = _zb - zc.balanceOf(address(bands));
      assertLe(_zUsed, _c.perCallZc, 'per-call ZC');
      assertLe(_zUsed, _dz, 'more ZC than depositable');
      if (fLast != 0) assertGe(block.timestamp - fLast, _c.minInterval, 'interval');
      if (block.timestamp >= fWinStart + 1 days) (fWinStart, fWinZc) = (block.timestamp, 0);
      fWinZc += _zUsed;
      assertLe(fWinZc, _c.dayZc, 'day ZC');
      fLast = block.timestamp;
    } catch {
      assertFalse(_ok, 'depositable said yes but deposit reverted');
    }
  }

  function testFuzz_setWeights(uint16[3] memory _w) public {
    uint256 _u = uint256(_w[0]) + _w[1] + _w[2];
    vm.prank(safe);
    if (_u != 0 && _u != 10_000) vm.expectRevert(ZipLiquidityBands.BadWeights.selector);
    bands.setWeights(_w);
  }
}
