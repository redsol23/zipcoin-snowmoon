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
      IPrivacyPool(address(pool)), merchants, 100, 5000, 3000, makeAddr('couriers'), makeAddr('treasury'), semaphore, 10 ether
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
    uint256 _scope = signal.scopeOf(_group, block.timestamp / 1 days, 0);
    ISemaphore.SemaphoreProof memory _p = _semProof('seila', _one(_identity('seila')), uint256(keccak256(bytes(_text))), _scope);

    signal.post(_group, 0, _text, _p);

    vm.expectRevert(); // same member, same slot: nullifier already used
    signal.post(_group, 0, _text, _p);
  }

  function test_anonPost_rejectsTamperedText() public {
    _lock(makeAddr('seila'), 'seila', 1000 ether, 30 days);
    uint256 _group = badges.tierGroups(0);
    uint256 _scope = signal.scopeOf(_group, block.timestamp / 1 days, 1);
    ISemaphore.SemaphoreProof memory _p =
      _semProof('seila', _one(_identity('seila')), uint256(keccak256(bytes('original'))), _scope);
    vm.expectRevert(ZipSignal.BadMessage.selector);
    signal.post(_group, 1, 'forged', _p);
  }

  function test_lockAnon_fromNote_thenUnlockRezips() public {
    Note memory _n = _zip(makeAddr('mov'), 1200 ether);
    uint256 _id = _identity('mov');
    (uint256 _rn, uint256 _rs) = _secrets();
    address _eth = makeAddr('movBadgeEth'); // unlinked address that earns the lock's ETH rewards
    ZipBadges.LockRequest memory _r = ZipBadges.LockRequest(
      _id, 30 days, _precommitment(_rn, _rs), ZipProcessooor.Courier(makeAddr('courier'), 0), _eth
    );
    IPrivacyPool.Withdrawal memory _w = IPrivacyPool.Withdrawal(address(badges), abi.encode(_r));
    (ProofLib.WithdrawProof memory _p,) = _prove(_n, 1000 ether, _w);
    badges.lockAnon(_w, _p);
    _spent(_p);

    (,,,, uint8 _tier) = badges.locks(1);
    assertEq(_tier, 2);
    assertEq(badges.lockRewardTo(1), _eth);
    assertEq(badges.ethStakeOf(_eth), 1000 ether);

    vm.expectRevert(ZipBadges.StillLocked.selector);
    badges.unlock(1, new uint256[][](2));

    vm.warp(block.timestamp + 30 days);
    uint256 _poolBefore = zc.balanceOf(address(pool));
    uint256[][] memory _siblings = new uint256[][](2); // sole member of each tier group: no siblings
    badges.unlock(1, _siblings);
    assertEq(zc.balanceOf(address(pool)), _poolBefore + 1000 ether);
    assertEq(badges.ethStakeOf(_eth), 0);
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

  /**
   * @dev A-5 (review PoC, documented rather than changed): Semaphore dates a root from its creation, so in a tier group
   *      quiet for over an hour any membership change voids a proof in flight against the old root. Nothing is spent,
   *      and a proof against the new root lands; the wallet re-proves once on this error (SDK isRootExpiredError).
   *      Lengthening merkleTreeDuration would make removed and slashed members valid for longer (L-5), so it is kept.
   */
  function test_a5_ffi_rootChangeVoidsInFlightProof_reproofLands() public {
    _lock(makeAddr('voter'), 'voter', 100 ether, 30 days);
    uint256 _group = badges.tierGroups(0);
    vm.prank(makeAddr('asker'));
    uint256 _poll = polls.create(_group, 'ship it?', 2, 7 days, 0, 0, 0);

    vm.warp(block.timestamp + 2 hours);
    address _to = makeAddr('fresh');
    ISemaphore.SemaphoreProof memory _p = _semProof('voter', _one(_identity('voter')), polls.messageOf(1, _to), polls.scopeOf(_poll));
    _lock(makeAddr('griefer'), 'griefer', 100 ether, 30 days);
    vm.expectRevert(bytes4(keccak256('Semaphore__MerkleTreeRootIsExpired()')));
    polls.vote(_poll, 1, _to, _p);

    uint256[] memory _now = new uint256[](2);
    _now[0] = _identity('voter');
    _now[1] = _identity('griefer');
    polls.vote(_poll, 1, _to, _semProof('voter', _now, polls.messageOf(1, _to), polls.scopeOf(_poll)));
    assertEq(polls.tally(_poll, 1), 1);
  }

  /// @dev A-4: a vote may name no reward address at all; its reward burns at once and the escrow still balances
  function test_a4_poll_voteWithoutRewardAddress_burnsItsReward() public {
    _lock(makeAddr('gladias'), 'gladias', 100 ether, 30 days);
    uint256 _group = badges.tierGroups(0);
    address _evelor = makeAddr('evelor');
    zc.mint(_evelor, 200 ether);
    vm.startPrank(_evelor);
    zc.approve(address(polls), 200 ether);
    uint256 _poll = polls.create(_group, 'ship it?', 2, 1 days, 0, 100 ether, 2);
    vm.stopPrank();

    ISemaphore.SemaphoreProof memory _p =
      _semProof('gladias', _one(_identity('gladias')), polls.messageOf(1, address(0)), polls.scopeOf(_poll));
    polls.vote(_poll, 1, address(0), _p);
    assertEq(polls.tally(_poll, 1), 1);
    assertEq(zc.balanceOf(BURN), 100 ether);

    vm.warp(block.timestamp + 1 days);
    polls.close(_poll);
    assertEq(zc.balanceOf(BURN), 200 ether);
    assertEq(zc.balanceOf(address(polls)), 0);
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
      'zei', _one(_zei), uint256(keccak256(bytes(_text))), signal.scopeOf(_group, block.timestamp / 1 days, 0)
    );
    signal.post(_group, 0, _text, _p);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // security review regressions
  // ---------------------------------------------------------------------------------------------------------------

  /// @dev H-1 (PoC test_poc_ffi_semaphoreFrontRunBurnsNullifier): a proof copied from the mempool and fed straight to
  ///      Semaphore.validateProof no longer burns the post, because ZipSignal keeps its own nullifiers
  function test_h1_signal_frontRunAtSemaphoreCannotBurnPost() public {
    _lock(makeAddr('seila'), 'seila', 1000 ether, 30 days);
    uint256 _g = badges.tierGroups(1);
    string memory _text = 'hello';
    ISemaphore.SemaphoreProof memory _p =
      _semProof('seila', _one(_identity('seila')), uint256(keccak256(bytes(_text))), signal.scopeOf(_g, block.timestamp / 1 days, 0));

    vm.prank(makeAddr('attacker'));
    semaphore.validateProof(_g, _p);

    signal.post(_g, 0, _text, _p);
    assertTrue(signal.nullifierUsed(_p.nullifier));
    vm.expectRevert(); // still one post per slot
    signal.post(_g, 0, _text, _p);
  }

  /// @dev H-1: a vote copied to Semaphore first still counts
  function test_h1_polls_frontRunAtSemaphoreCannotCensorVote() public {
    _lock(makeAddr('gladias'), 'gladias', 100 ether, 30 days);
    uint256 _group = badges.tierGroups(0);
    address _evelor = makeAddr('evelor');
    zc.mint(_evelor, 100 ether);
    vm.startPrank(_evelor);
    zc.approve(address(polls), 100 ether);
    uint256 _poll = polls.create(_group, 'q', 2, 1 days, 0, 100 ether, 1);
    vm.stopPrank();

    address _to = makeAddr('fresh');
    ISemaphore.SemaphoreProof memory _p =
      _semProof('gladias', _one(_identity('gladias')), polls.messageOf(1, _to), polls.scopeOf(_poll));
    vm.prank(makeAddr('attacker'));
    semaphore.validateProof(_group, _p);

    polls.vote(_poll, 1, _to, _p);
    assertEq(polls.tally(_poll, 1), 1);
    assertEq(zc.balanceOf(_to), 100 ether);
  }

  /**
   * @dev M-3 (PoC test_poc_ffi_signalSameNullifierAcrossTierGroups): a tier-2 holder is in both tier groups. The same
   *      proof used to post in both, with one public nullifier linking the two posts and doubling the rate limit. Now
   *      the scope names the group: the tier-1 proof is refused in tier 2, and the member's own tier-2 proof for the
   *      same day and slot carries a different nullifier.
   */
  function test_m3_signalNullifierIsPerGroup() public {
    _lock(makeAddr('seila'), 'seila', 1000 ether, 30 days); // tier 2: member of both tier groups
    uint256 _g0 = badges.tierGroups(0);
    uint256 _g1 = badges.tierGroups(1);
    uint256 _day = block.timestamp / 1 days;
    string memory _text = 'hello';
    uint256 _msg = uint256(keccak256(bytes(_text)));
    ISemaphore.SemaphoreProof memory _p0 = _semProof('seila', _one(_identity('seila')), _msg, signal.scopeOf(_g0, _day, 0));
    signal.post(_g0, 0, _text, _p0);

    vm.expectRevert(ZipSignal.BadScope.selector);
    signal.post(_g1, 0, _text, _p0);

    ISemaphore.SemaphoreProof memory _p1 = _semProof('seila', _one(_identity('seila')), _msg, signal.scopeOf(_g1, _day, 0));
    signal.post(_g1, 0, _text, _p1);
    assertTrue(_p0.nullifier != _p1.nullifier, 'posts in two groups are unlinkable');
  }

  /// @dev L-6: scopes are bound to the contract and chain, so a redeploy on the same groups has its own nullifiers
  function test_l6_signalAndPollScopesBoundToContractAndChain() public {
    ZipSignal _twin = new ZipSignal(semaphore);
    ZipPolls _twinPolls = new ZipPolls(IPrivacyPool(address(pool)), semaphore);
    assertTrue(signal.scopeOf(1, 1, 0) != _twin.scopeOf(1, 1, 0));
    assertTrue(polls.scopeOf(1) != _twinPolls.scopeOf(1));
    uint256 _here = polls.scopeOf(1);
    vm.chainId(block.chainid + 1);
    assertTrue(polls.scopeOf(1) != _here);
  }

  /// @dev L-9: a post proved just before midnight still lands if a courier delays it a little past midnight
  function test_l9_postProvedBeforeMidnightLandsWithinGrace() public {
    _lock(makeAddr('seila'), 'seila', 100 ether, 30 days);
    uint256 _g = badges.tierGroups(0);
    vm.warp((block.timestamp / 1 days + 1) * 1 days - 60); // one minute to midnight
    uint256 _day = block.timestamp / 1 days;
    string memory _text = 'late';
    ISemaphore.SemaphoreProof memory _p =
      _semProof('seila', _one(_identity('seila')), uint256(keccak256(bytes(_text))), signal.scopeOf(_g, _day, 0));

    vm.warp(block.timestamp + 2 hours); // past the grace
    vm.expectRevert(ZipSignal.BadScope.selector);
    signal.post(_g, 0, _text, _p);

    vm.warp(block.timestamp - 1 hours - 30 minutes); // 29 minutes past midnight
    vm.expectEmit(true, true, false, true, address(signal));
    emit ZipSignal.Posted(_g, _day, _p.nullifier, _text);
    signal.post(_g, 0, _text, _p);
  }
}
