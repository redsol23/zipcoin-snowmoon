// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PoseidonT2} from 'poseidon/PoseidonT2.sol';

import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {ZipCouriers} from 'zipnet/ZipCouriers.sol';

import {ZipnetBase} from './ZipnetBase.sol';

contract CouriersTest is ZipnetBase {
  ZipCouriers internal couriers;
  address internal mov;
  uint256 internal movKey;
  address internal zven = makeAddr('zven');

  function setUp() public override {
    super.setUp();
    couriers = new ZipCouriers(IPrivacyPool(address(pool)), 1000 ether);
    (mov, movKey) = makeAddrAndKey('mov');
    _bond(mov, 3000 ether);
    _bond(zven, 1000 ether);
  }

  function _bond(address _who, uint256 _amount) internal {
    zc.mint(_who, _amount);
    vm.startPrank(_who);
    zc.approve(address(couriers), _amount);
    couriers.bond(_amount, 'https://courier.example');
    vm.stopPrank();
  }

  function test_rewardsSplitByStake() public {
    zc.mint(address(couriers), 400 ether); // e.g. the courier share of sales tax
    couriers.sync();
    assertEq(couriers.pending(mov), 300 ether);
    assertEq(couriers.pending(zven), 100 ether);

    vm.prank(mov);
    couriers.claim();
    assertEq(zc.balanceOf(mov), 300 ether);
  }

  function test_unbondingStopsRewardsAndWaits() public {
    vm.prank(zven);
    couriers.requestUnbond();
    zc.mint(address(couriers), 300 ether);
    couriers.sync();
    assertEq(couriers.pending(mov), 300 ether);
    assertEq(couriers.pending(zven), 0);

    vm.prank(zven);
    vm.expectRevert(ZipCouriers.TooEarly.selector);
    couriers.unbond();
    vm.warp(block.timestamp + 14 days);
    vm.prank(zven);
    couriers.unbond();
    assertEq(zc.balanceOf(zven), 1000 ether);
  }

  function _receipt(Note memory _n, uint64 _deadline) internal view returns (ZipCouriers.Receipt memory) {
    return ZipCouriers.Receipt(mov, PoseidonT2.hash([_n.nullifier]), entrypoint.latestRoot(), pool.currentRoot(), _deadline);
  }

  function _sign(ZipCouriers.Receipt memory _r) internal view returns (bytes memory) {
    (uint8 _v, bytes32 _rr, bytes32 _s) = vm.sign(movKey, couriers.receiptDigest(_r));
    return abi.encodePacked(_rr, _s, _v);
  }

  function test_slash_whenPromisedDeliveryWasPossibleButMissed() public {
    Note memory _n = _zip(makeAddr('user'), 10 ether);
    ZipCouriers.Receipt memory _r = _receipt(_n, uint64(block.timestamp + 1 hours));
    bytes memory _sig = _sign(_r);

    vm.expectRevert(ZipCouriers.NotSlashable.selector);
    couriers.report(_r, _sig);

    vm.warp(block.timestamp + 2 hours);
    address _reporter = makeAddr('reporter');
    vm.prank(_reporter);
    couriers.report(_r, _sig);
    assertEq(zc.balanceOf(_reporter), 150 ether); // half of 10% of 3000
    (uint256 _stake,,) = couriers.couriers(mov);
    assertEq(_stake, 2700 ether);

    vm.expectRevert(ZipCouriers.AlreadyReported.selector);
    couriers.report(_r, _sig);
  }

  function test_noSlash_whenAspRootMovedOn() public {
    Note memory _n = _zip(makeAddr('user'), 10 ether);
    ZipCouriers.Receipt memory _r = _receipt(_n, uint64(block.timestamp + 1 hours));
    bytes memory _sig = _sign(_r);
    _zip(makeAddr('other'), 10 ether); // pushes a new ASP root: the held proof went stale, not the courier's fault
    vm.warp(block.timestamp + 2 hours);
    vm.expectRevert(ZipCouriers.NotSlashable.selector);
    couriers.report(_r, _sig);
  }

  function test_noSlash_whenDelivered() public {
    Note memory _n = _zip(makeAddr('user'), 10 ether);
    ZipCouriers.Receipt memory _r = _receipt(_n, uint64(block.timestamp + 1 hours));
    bytes memory _sig = _sign(_r);

    IPrivacyPool.Withdrawal memory _w = IPrivacyPool.Withdrawal(
      address(entrypoint), abi.encode(IEntrypoint.RelayData({recipient: makeAddr('dest'), feeRecipient: mov, relayFeeBPS: 0}))
    );
    (ProofLib.WithdrawProof memory _p,) = _prove(_n, 10 ether, _w);
    vm.prank(mov);
    entrypoint.relay(_w, _p, scope);

    vm.warp(block.timestamp + 2 hours);
    vm.expectRevert(ZipCouriers.NotSlashable.selector);
    couriers.report(_r, _sig);
  }
}
