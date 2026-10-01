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

  // M-1 PoC, inverted: rewards earned before an unbond stay claimable, and the address can bond again
  function test_m1_unbondAfterRewards_claimAndRebondStillWork() public {
    zc.mint(address(couriers), 400 ether); // 300 to mov, 100 to zven
    couriers.sync();

    vm.prank(zven);
    couriers.requestUnbond(); // settles: owed = 100, debt = 1000 * acc
    vm.warp(block.timestamp + 14 days);
    vm.prank(zven);
    couriers.unbond();
    assertEq(couriers.owed(zven), 100 ether);
    assertEq(couriers.pending(zven), 100 ether);

    vm.prank(zven);
    assertEq(couriers.claim(), 100 ether);
    assertEq(zc.balanceOf(zven), 1100 ether);

    _bond(zven, 1000 ether); // no stale debt to underflow on
    zc.mint(address(couriers), 400 ether);
    couriers.sync();
    assertEq(couriers.pending(zven), 100 ether);
    assertEq(couriers.pending(mov), 600 ether);
    vm.prank(mov);
    couriers.claim();
    vm.prank(zven);
    couriers.claim();
    assertEq(couriers.rewardReserve(), 0);
  }

  // L-4: tax that arrives while nobody is bonded is burned, not handed to whoever bonds next
  function test_l4_taxWithNobodyBonded_isBurned_notTakenByTheFirstBonder() public {
    ZipCouriers _c = new ZipCouriers(IPrivacyPool(address(pool)), 1000 ether);
    zc.mint(address(_c), 500 ether); // tax, nobody bonded
    uint256 _burned = zc.balanceOf(BURN);

    zc.mint(zven, 1000 ether);
    vm.startPrank(zven);
    zc.approve(address(_c), 1000 ether);
    _c.bond(1000 ether, 'x');
    vm.stopPrank();
    _c.sync();

    assertEq(_c.pending(zven), 0, 'first bonder earns nothing from before it bonded');
    assertEq(zc.balanceOf(BURN), _burned + 500 ether);
  }

  /// @dev A held relay job: the call the courier promised to make, and its receipt
  struct Job {
    ZipCouriers.Receipt receipt;
    address target;
    bytes callData;
    IPrivacyPool.Withdrawal withdrawal;
    ProofLib.WithdrawProof proof;
  }

  function _relayJob(Note memory _n, address _dest, uint64 _deadline) internal returns (Job memory _j) {
    _j.withdrawal = IPrivacyPool.Withdrawal(
      address(entrypoint), abi.encode(IEntrypoint.RelayData({recipient: _dest, feeRecipient: mov, relayFeeBPS: 0}))
    );
    (_j.proof,) = _prove(_n, _n.value, _j.withdrawal);
    _j.target = address(entrypoint);
    _j.callData = abi.encodeCall(entrypoint.relay, (_j.withdrawal, _j.proof, scope));
    _j.receipt =
      ZipCouriers.Receipt(mov, PoseidonT2.hash([_n.nullifier]), couriers.jobHashOf(_j.target, _j.callData), _deadline);
  }

  function _sign(ZipCouriers.Receipt memory _r) internal view returns (bytes memory) {
    (uint8 _v, bytes32 _rr, bytes32 _s) = vm.sign(movKey, couriers.receiptDigest(_r));
    return abi.encodePacked(_rr, _s, _v);
  }

  /// @dev Commit step of a report by `_reporter`; the reveal is valid from the next block
  function _commit(address _reporter, ZipCouriers.Receipt memory _r) internal {
    vm.prank(_reporter);
    couriers.commitReport(couriers.reportCommitment(couriers.receiptDigest(_r), _reporter, 0));
    vm.roll(block.number + 1);
  }

  function test_slash_whenPromisedDeliveryWasPossibleButMissed_andTheReportDelivers() public {
    Note memory _n = _zip(makeAddr('user'), 10 ether);
    address _dest = makeAddr('dest');
    Job memory _j = _relayJob(_n, _dest, uint64(block.timestamp + 1 hours));
    bytes memory _sig = _sign(_j.receipt);
    address _reporter = makeAddr('reporter');
    _commit(_reporter, _j.receipt);

    vm.prank(_reporter);
    vm.expectRevert(ZipCouriers.NotSlashable.selector); // before the deadline
    couriers.report(_j.receipt, _sig, 0, _j.target, _j.callData);

    vm.warp(block.timestamp + 2 hours);
    // M-8: copying the reveal from the mempool doesn't work without an older commitment of one's own
    vm.prank(makeAddr('copier'));
    vm.expectRevert(ZipCouriers.NotCommitted.selector);
    couriers.report(_j.receipt, _sig, 0, _j.target, _j.callData);
    // H-1: the call must be the one the receipt names
    vm.prank(_reporter);
    vm.expectRevert(ZipCouriers.WrongJob.selector);
    couriers.report(_j.receipt, _sig, 0, _j.target, abi.encodePacked(_j.callData, uint8(0)));

    vm.prank(_reporter);
    couriers.report(_j.receipt, _sig, 0, _j.target, _j.callData);
    assertEq(zc.balanceOf(_reporter), 150 ether); // half of 10% of 3000
    (uint256 _stake,,) = couriers.couriers(mov);
    assertEq(_stake, 2700 ether);
    assertEq(zc.balanceOf(_dest), 10 ether, 'the report delivered the job: the user got its withdrawal');
    assertTrue(pool.nullifierHashes(_j.receipt.nullifierHash));

    vm.prank(_reporter);
    vm.expectRevert(ZipCouriers.AlreadyReported.selector);
    couriers.report(_j.receipt, _sig, 0, _j.target, _j.callData);
  }

  function test_noSlash_whenAspRootMovedOn() public {
    Note memory _n = _zip(makeAddr('user'), 10 ether);
    Job memory _j = _relayJob(_n, makeAddr('dest'), uint64(block.timestamp + 1 hours));
    bytes memory _sig = _sign(_j.receipt);
    _zip(makeAddr('other'), 10 ether); // pushes a new ASP root: the held proof went stale, not the courier's fault
    vm.warp(block.timestamp + 2 hours);
    _commit(address(this), _j.receipt);
    vm.expectRevert(ZipCouriers.NotSlashable.selector);
    couriers.report(_j.receipt, _sig, 0, _j.target, _j.callData);
  }

  function test_noSlash_whenDelivered() public {
    Note memory _n = _zip(makeAddr('user'), 10 ether);
    Job memory _j = _relayJob(_n, makeAddr('dest'), uint64(block.timestamp + 1 hours));
    bytes memory _sig = _sign(_j.receipt);
    vm.prank(mov);
    entrypoint.relay(_j.withdrawal, _j.proof, scope);

    vm.warp(block.timestamp + 2 hours);
    _commit(address(this), _j.receipt);
    vm.expectRevert(ZipCouriers.NotSlashable.selector);
    couriers.report(_j.receipt, _sig, 0, _j.target, _j.callData);
  }
}
