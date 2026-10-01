// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';

import {CommitmentVerifier} from 'contracts/verifiers/CommitmentVerifier.sol';
import {WithdrawalVerifier} from 'contracts/verifiers/WithdrawalVerifier.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';


import {ZcRewardsHarvester} from 'zipnet/ZcRewardsHarvester.sol';
import {ZipBadges} from 'zipnet/ZipBadges.sol';
import {ZipLiquidityBands} from 'zipnet/ZipLiquidityBands.sol';
import {ZipPrivacyPool} from 'zipnet/ZipPrivacyPool.sol';
import {ZipMerchants} from 'zipnet/ZipMerchants.sol';
import {ZipPay} from 'zipnet/ZipPay.sol';
import {ZipPolls} from 'zipnet/ZipPolls.sol';
import {ZipRezip} from 'zipnet/ZipRezip.sol';
import {DeferredPayout} from 'zipnet/lib/DeferredPayout.sol';

import {MockPermit2, MockPoolManager, MockPositionManager} from './BandsMocks.sol';
import {ZipnetBase} from './ZipnetBase.sol';

/// @notice Regression tests for review round 2 (DeFi): each was a PoC that passed against the unfixed code
contract DefiReview2Test is ZipnetBase {
  address internal attacker = makeAddr('attacker');
  address internal victim = makeAddr('victim');
  address internal safe = makeAddr('safe');
  address internal hook = makeAddr('hook');

  function _badges() internal returns (ZipBadges _b) {
    uint256[] memory _t = new uint256[](1);
    _t[0] = 3000 ether;
    _b = new ZipBadges(IPrivacyPool(address(pool)), semaphore, _t);
  }

  /// @dev A wallet lock of `_amount` for 30 days (tier 1), earning for `_who`
  function _lock(ZipBadges _b, address _who, uint256 _amount, uint256 _identity, uint256 _pre) internal {
    zc.mint(_who, _amount);
    vm.startPrank(_who);
    zc.approve(address(_b), _amount);
    _b.lock(_amount, _identity, 30 days, _pre);
    vm.stopPrank();
  }

  function _rewards() internal {
    vm.deal(address(this), 1 ether);
    zc.distributeRewards{value: 1 ether}();
  }

  /// @dev Bands first (HARVEST_SOURCE = the predicted pool), then the pool paying the bands contract: Deploy's order
  function _bandsAndPool() internal returns (ZipLiquidityBands _bands, ZipPrivacyPool _pool2) {
    MockPoolManager _pm = new MockPoolManager();
    MockPermit2 _p2 = new MockPermit2();
    MockPositionManager _posm = new MockPositionManager(_pm, _p2, address(zc), hook);
    ZipLiquidityBands.PoolKey memory _key = ZipLiquidityBands.PoolKey(address(0), address(zc), 10_000, 200, hook);
    _pm.init(address(_posm), keccak256(abi.encode(keccak256(abi.encode(_key)), uint256(6))));
    _pm.setPrice(317_562_884_112_765_502_424_763_899_389_167, 165_930);
    address _wv = address(new WithdrawalVerifier());
    address _rv = address(new CommitmentVerifier());
    uint256 _n = vm.getNonce(address(this));
    address _poolAt = vm.computeCreateAddress(address(this), _n + 1);
    _bands = new ZipLiquidityBands(
      safe,
      address(zc),
      address(_posm),
      hook,
      _poolAt,
      10_000_000 ether,
      ZipLiquidityBands.Caps(1_000_000 ether, 2_000_000 ether, 10_000 ether, 1 days),
      [uint16(10_000), 0, 0]
    );
    _pool2 = new ZipPrivacyPool(address(entrypoint), _wv, _rv, address(zc), payable(address(_bands)));
    assertEq(address(_pool2), _poolAt);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // R2-M1: with HARVEST_TREASURY=bands every escrow harvest() reverted
  // ---------------------------------------------------------------------------------------------------------------

  function test_r2m1_escrowHarvestToBands_works() public {
    (ZipLiquidityBands _bands, ZipPrivacyPool _pool2) = _bandsAndPool();
    assertEq(_pool2.TREASURY(), address(_bands));

    ZipPolls _p = new ZipPolls(IPrivacyPool(address(_pool2)), semaphore);
    zc.mint(victim, 100 ether);
    vm.startPrank(victim);
    zc.approve(address(_p), 100 ether);
    _p.create(1, 'q', 2, 1 days, 0, 10 ether, 10);
    vm.stopPrank();
    _rewards();
    uint256 _earned = zc.pendingReward(address(_p));
    assertGt(_earned, 0);

    vm.prank(makeAddr('anyone'));
    _p.harvest();
    assertEq(zc.pendingReward(address(_p)), 0, 'the escrow ETH is no longer stranded');
    assertEq(address(_bands).balance, _earned, 'it reached the bands contract');
    uint256 _safeBefore = safe.balance;
    vm.prank(makeAddr('anyone'));
    _bands.forwardEth();
    assertEq(safe.balance - _safeBefore, _earned, 'and forwardEth passes all of it to the Safe (never into liquidity)');
  }

  // ---------------------------------------------------------------------------------------------------------------
  // R2-M3: the Entrypoint OWNER could take 99.99% of every contract-made deposit through the vetting fee
  // ---------------------------------------------------------------------------------------------------------------

  function _feeUp() internal {
    vm.prank(owner);
    entrypoint.updatePoolConfiguration(IERC20(address(zc)), 1 ether, 9999, 500);
  }

  function test_r2m3_vettingFee_parksDeferredPayouts_andTheOwnerTakesNothing() public {
    ZipBadges _b = _badges();
    _lock(_b, victim, 1000 ether, 11, 0x777);
    vm.warp(block.timestamp + 30 days);

    _feeUp();
    vm.prank(owner);
    _b.unlock(1, new uint256[][](1)); // anyone may call it
    assertEq(_b.parkedPayout(1), 1000 ether, 'parked, not deposited');

    vm.prank(owner);
    entrypoint.withdrawFees(IERC20(address(zc)), owner);
    assertEq(zc.balanceOf(owner), 0, 'the owner took nothing');
    assertEq(zc.balanceOf(address(_b)), 1000 ether, 'the whole stake is still there for its owner');
  }

  function test_r2m3_vettingFee_revertsRezips() public {
    ZipRezip _r = new ZipRezip(IPrivacyPool(address(pool)));
    zc.mint(victim, 100 ether);
    vm.prank(victim);
    zc.approve(address(_r), 100 ether);
    _feeUp();
    vm.prank(victim);
    vm.expectRevert(abi.encodeWithSelector(DeferredPayout.VettingFeeCharged.selector, 9999));
    _r.zipTo(100 ether, 0x999, '');
    assertEq(zc.balanceOf(victim), 100 ether, 'nothing lost');
  }

  function test_r2m3_vettingFee_revertsZipPayReZips() public {
    ZipMerchants _mer = new ZipMerchants(zc, 1000 ether);
    ZipPay _pay = new ZipPay(
      IPrivacyPool(address(pool)), _mer, 100, 5000, 3000, makeAddr('cp'), makeAddr('tr'), semaphore, 10 ether
    );
    address _shop = makeAddr('shop');
    zc.mint(_shop, 1000 ether);
    vm.startPrank(_shop);
    zc.approve(address(_mer), 1000 ether);
    uint256 _id = _mer.register(_shop, 1000 ether, 'ipfs://x');
    vm.stopPrank();
    zc.mint(victim, 101 ether);
    vm.prank(victim);
    zc.approve(address(_pay), 101 ether);
    _feeUp();
    vm.prank(victim);
    vm.expectRevert(abi.encodeWithSelector(DeferredPayout.VettingFeeCharged.selector, 9999));
    _pay.pay(_id, 100 ether, bytes32(0), 0x1234, 0, '');
    // Paying to the merchant's address still works
    vm.prank(victim);
    _pay.pay(_id, 100 ether, bytes32(0), 0, 0, '');
    assertEq(zc.balanceOf(_shop), 100 ether);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // R2-L4: ETH with nobody earning went to the next staker
  // ---------------------------------------------------------------------------------------------------------------

  function test_r2l4_ethWithNobodyEarning_goesToTheTreasury_notTheNextStaker() public {
    ZipBadges _l = _badges();
    zc.mint(address(_l), 1000 ether); // a donation: ZC no lock owns, earning for nobody
    _rewards();
    uint256 _orphan = zc.pendingReward(address(_l));
    assertGt(_orphan, 0);

    // A late staker arrives: before the fix it collected all of that ETH
    _lock(_l, attacker, 100 ether, 22, 0x999);
    vm.prank(attacker);
    assertEq(_l.claimEth(), 0, 'the late staker gets none of it');
    assertEq(_l.unearnedEth(), _orphan);

    uint256 _before = poolTreasury.balance;
    vm.prank(makeAddr('anyone'));
    assertEq(_l.sweepUnearnedEth(), _orphan);
    assertEq(poolTreasury.balance - _before, _orphan, 'it went to the treasury');
    vm.expectRevert(ZcRewardsHarvester.NoUnearnedEth.selector);
    _l.sweepUnearnedEth();
  }
}
