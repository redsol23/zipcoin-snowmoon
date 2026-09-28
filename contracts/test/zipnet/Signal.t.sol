// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISemaphore} from '@semaphore-protocol/contracts/interfaces/ISemaphore.sol';

import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {ZipBadges} from 'zipnet/ZipBadges.sol';
import {ZipMerchants} from 'zipnet/ZipMerchants.sol';
import {ZipPay} from 'zipnet/ZipPay.sol';
import {ZipPolls} from 'zipnet/ZipPolls.sol';
import {ZipProcessooor} from 'zipnet/ZipProcessooor.sol';
import {ZipSignal} from 'zipnet/ZipSignal.sol';

import {ZipnetBase} from './ZipnetBase.sol';

contract SignalTest is ZipnetBase {
  ZipBadges internal badges;
  ZipSignal internal signal;
  ZipPolls internal polls;
  ZipMerchants internal merchants;
  ZipPay internal zipPay;

  function setUp() public override {
    super.setUp();
    uint256[] memory _t = new uint256[](3);
    _t[0] = 3000 ether; // 100 ZC for 30 days
    _t[1] = 30_000 ether;
    _t[2] = 300_000 ether;
    badges = new ZipBadges(IPrivacyPool(address(pool)), semaphore, _t);
    signal = new ZipSignal(semaphore);
    polls = new ZipPolls(IPrivacyPool(address(pool)), semaphore);
    merchants = new ZipMerchants(zc, 1000 ether);
    zipPay = new ZipPay(
      IPrivacyPool(address(pool)), merchants, 100, 5000, 3000, makeAddr('couriers'), makeAddr('treasury'), semaphore
    );
  }

  function _lock(address _who, string memory _secret, uint256 _value, uint64 _duration) internal returns (uint256) {
    zc.mint(_who, _value);
    vm.startPrank(_who);
    zc.approve(address(badges), _value);
    badges.lock(_value, _identity(_secret), _duration, 123);
    vm.stopPrank();
    return badges.lockCount();
  }

  function _one(uint256 _x) internal pure returns (uint256[] memory _a) {
    _a = new uint256[](1);
    _a[0] = _x;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // badges + anonymous posts
  // ---------------------------------------------------------------------------------------------------------------

  function test_badge_tierFromWeight() public view {
    assertEq(badges.tierFor(100 ether, 30 days), 1);
    assertEq(badges.tierFor(1000 ether, 30 days), 2);
    assertEq(badges.tierFor(99 ether, 30 days), 0);
  }

  function test_anonPost_byBadgeTier_oncePerSlot() public {
    _lock(makeAddr('seila'), 'seila', 1000 ether, 30 days);
    uint256 _group = badges.tierGroups(1); // tier 2

    string memory _text = 'I know that you are in the Order. Not reporting you for the bounty.';
    uint256 _scope = signal.scopeOf(block.timestamp / 1 days, 0);
    ISemaphore.SemaphoreProof memory _p = _semProof('seila', _one(_identity('seila')), uint256(keccak256(bytes(_text))), _scope);

    signal.post(_group, 0, _text, _p);

    vm.expectRevert(); // same member, same slot: nullifier already used
    signal.post(_group, 0, _text, _p);
  }

  function test_anonPost_rejectsTamperedText() public {
    _lock(makeAddr('seila'), 'seila', 1000 ether, 30 days);
    uint256 _scope = signal.scopeOf(block.timestamp / 1 days, 1);
    ISemaphore.SemaphoreProof memory _p =
      _semProof('seila', _one(_identity('seila')), uint256(keccak256(bytes('original'))), _scope);
    uint256 _group = badges.tierGroups(0);
    vm.expectRevert(ZipSignal.BadMessage.selector);
    signal.post(_group, 1, 'forged', _p);
  }

  function test_lockAnon_fromNote_thenUnlockRezips() public {
    Note memory _n = _zip(makeAddr('mov'), 1200 ether);
    uint256 _id = _identity('mov');
    (uint256 _rn, uint256 _rs) = _secrets();
    ZipBadges.LockRequest memory _r =
      ZipBadges.LockRequest(_id, 30 days, _precommitment(_rn, _rs), ZipProcessooor.Courier(makeAddr('courier'), 0));
    IPrivacyPool.Withdrawal memory _w = IPrivacyPool.Withdrawal(address(badges), abi.encode(_r));
    (ProofLib.WithdrawProof memory _p,) = _prove(_n, 1000 ether, _w);
    badges.lockAnon(_w, _p);
    _spent(_p);

    (,,,, uint8 _tier) = badges.locks(1);
    assertEq(_tier, 2);

    vm.expectRevert(ZipBadges.StillLocked.selector);
    badges.unlock(1, new uint256[][](2));

    vm.warp(block.timestamp + 30 days);
    uint256 _poolBefore = zc.balanceOf(address(pool));
    uint256[][] memory _siblings = new uint256[][](2); // sole member of each tier group: no siblings
    badges.unlock(1, _siblings);
    assertEq(zc.balanceOf(address(pool)), _poolBefore + 1000 ether);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // polls
  // ---------------------------------------------------------------------------------------------------------------

  function test_poll_votesPaidOncePerMember_leftoverBurned() public {
    _lock(makeAddr('gladias'), 'gladias', 100 ether, 30 days);
    _lock(makeAddr('seila'), 'seila', 100 ether, 30 days);
    uint256 _group = badges.tierGroups(0);
    uint256[] memory _members = new uint256[](2);
    _members[0] = _identity('gladias');
    _members[1] = _identity('seila');

    address _evelor = makeAddr('evelor');
    zc.mint(_evelor, 1300 ether);
    vm.startPrank(_evelor);
    zc.approve(address(polls), 1300 ether);
    // burn 1000 for priority, pay 100 each to up to 3 respondents
    uint256 _poll = polls.create(_group, 'Who would you prefer to run the Veridian military?', 6, 1 days, 1000 ether, 100 ether, 3);
    vm.stopPrank();
    assertEq(zc.balanceOf(BURN), 1000 ether);

    address _to = makeAddr('fresh');
    ISemaphore.SemaphoreProof memory _p =
      _semProof('gladias', _members, polls.messageOf(4, _to), polls.scopeOf(_poll));
    polls.vote(_poll, 4, _to, _p);
    assertEq(zc.balanceOf(_to), 100 ether);
    assertEq(polls.tally(_poll, 4), 1);

    vm.expectRevert(); // nullifier reused
    polls.vote(_poll, 4, _to, _p);

    // a courier cannot redirect the reward
    ISemaphore.SemaphoreProof memory _q = _semProof('seila', _members, polls.messageOf(1, _to), polls.scopeOf(_poll));
    vm.expectRevert(ZipPolls.BadMessage.selector);
    polls.vote(_poll, 1, makeAddr('thief'), _q);
    polls.vote(_poll, 1, _to, _q);

    vm.warp(block.timestamp + 1 days);
    polls.close(_poll);
    assertEq(zc.balanceOf(BURN), 1100 ether); // the unused third reward
  }

  // ---------------------------------------------------------------------------------------------------------------
  // merchant payer groups (reach "all guests from the past half year")
  // ---------------------------------------------------------------------------------------------------------------

  function test_pay_joinsPayerGroup_repeatCustomerDoesNotRevert() public {
    address _m = makeAddr('beautifulPlants');
    zc.mint(_m, 1000 ether);
    vm.startPrank(_m);
    zc.approve(address(merchants), 1000 ether);
    uint256 _mid = merchants.register(_m, 1000 ether, '');
    vm.stopPrank();

    uint256 _zei = _identity('zei');
    address _buyer = makeAddr('buyer');
    zc.mint(_buyer, 202 ether);
    vm.startPrank(_buyer);
    zc.approve(address(zipPay), 202 ether);
    zipPay.pay(_mid, 100 ether, bytes32(0), 0, _zei, '');
    zipPay.pay(_mid, 100 ether, bytes32(0), 0, _zei, '');
    vm.stopPrank();

    assertTrue(zipPay.hasPayerGroup(_mid));
    uint256 _group = zipPay.payerGroup(_mid);

    // Zei can now prove "I ate at Beautiful Plants" without saying who he is
    string memory _text = 'Number Ten is better in Dzego';
    ISemaphore.SemaphoreProof memory _p = _semProof(
      'zei', _one(_zei), uint256(keccak256(bytes(_text))), signal.scopeOf(block.timestamp / 1 days, 0)
    );
    signal.post(_group, 0, _text, _p);
  }
}
