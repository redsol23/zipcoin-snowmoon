// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {ISemaphore} from '@semaphore-protocol/contracts/interfaces/ISemaphore.sol';

import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';
import {IState} from 'interfaces/IState.sol';

import {ZipBadges} from 'zipnet/ZipBadges.sol';
import {DeferredPayout} from 'zipnet/lib/DeferredPayout.sol';

import {ZipnetBase} from './ZipnetBase.sol';

/// @notice C-1 / M-12: getting a badge stake back never depends on the pool accepting the deferred deposit
contract BadgesTest is ZipnetBase {
  ZipBadges internal badges;
  address internal gladias = makeAddr('gladias');
  address internal attacker = makeAddr('attacker');
  uint256 internal identity;
  uint256 internal lockId;
  uint256 internal preNullifier;
  uint256 internal preSecret;

  function setUp() public override {
    super.setUp();
    uint256[] memory _t = new uint256[](1);
    _t[0] = 3000 ether;
    badges = new ZipBadges(IPrivacyPool(address(pool)), semaphore, _t);
    identity = _identity('gladias');
    (preNullifier, preSecret) = _secrets();
    lockId = _lock(100 ether, _precommitment(preNullifier, preSecret));
  }

  function _lock(uint256 _value, uint256 _pre) internal returns (uint256) {
    zc.mint(gladias, _value);
    vm.startPrank(gladias);
    zc.approve(address(badges), _value);
    badges.lock(_value, identity, 30 days, _pre);
    vm.stopPrank();
    return badges.lockCount();
  }

  /// @dev The report's attack: a 1 ZC deposit under the lock's public precommitment
  function _poison(uint256 _pre) internal {
    zc.mint(attacker, 1 ether);
    vm.startPrank(attacker);
    zc.approve(address(entrypoint), 1 ether);
    entrypoint.deposit(IERC20(address(zc)), 1 ether, _pre);
    vm.stopPrank();
  }

  function _auth(string memory _who, uint256 _lockId, uint8 _action, uint256 _target)
    internal
    returns (ISemaphore.SemaphoreProof memory)
  {
    uint256[] memory _m = new uint256[](1);
    _m[0] = _identity(_who);
    return _semProof(_who, _m, badges.payoutMessage(_action, _target), badges.payoutScope(_lockId));
  }

  function _unlockNow(uint256 _lockId) internal {
    vm.warp(block.timestamp + 30 days);
    badges.unlock(_lockId, new uint256[][](1));
  }

  // C-1 PoC, inverted: the poisoned unlock now parks the stake instead of reverting forever
  function test_c1_poisonedPrecommitment_parks_ownerRedirects() public {
    (,, uint256 _pre,,) = badges.locks(lockId); // public
    _poison(_pre);
    _unlockNow(lockId);
    assertEq(badges.parkedPayout(lockId), 100 ether, 'parked, not frozen');
    assertEq(zc.balanceOf(address(badges)), 100 ether);

    (uint256 _n, uint256 _s) = _secrets();
    uint256 _newPre = _precommitment(_n, _s);
    ISemaphore.SemaphoreProof memory _p = _auth('gladias', lockId, badges.PAYOUT_REDIRECT(), _newPre);

    // a mempool copier can't point it elsewhere: the proof binds the precommitment
    vm.prank(attacker);
    vm.expectRevert(ZipBadges.NotOwner.selector);
    badges.redirectPayout(lockId, 0xbad, _p);

    uint256 _poolBefore = zc.balanceOf(address(pool));
    vm.prank(attacker); // anyone may submit the owner's proof (e.g. a courier)
    badges.redirectPayout(lockId, _newPre, _p);
    assertEq(zc.balanceOf(address(pool)), _poolBefore + 100 ether, 're-zipped under the new precommitment');
    assertEq(badges.parkedPayout(lockId), 0);
    assertEq(zc.balanceOf(address(badges)), 0);

    // the proof is single-use
    vm.expectRevert(ZipBadges.NotOwner.selector);
    badges.redirectPayout(lockId, _newPre, _p);
  }

  function test_c1_someoneElsesIdentityCantRecover() public {
    (,, uint256 _pre,,) = badges.locks(lockId);
    _poison(_pre);
    _unlockNow(lockId);
    ISemaphore.SemaphoreProof memory _p = _auth('seila', lockId, badges.PAYOUT_RELEASE(), uint160(attacker));
    vm.expectRevert(ZipBadges.NotOwner.selector);
    badges.releasePayout(lockId, attacker, _p);
  }

  // The Entrypoint owner raises the pool's minimum deposit above the stake: the stake parks and the owner releases it
  function test_c1_belowMinimum_parks_ownerReleases() public {
    vm.prank(owner);
    entrypoint.updatePoolConfiguration(IERC20(address(zc)), 1000 ether, 0, 500);
    _unlockNow(lockId);
    assertEq(badges.parkedPayout(lockId), 100 ether);

    address _to = makeAddr('fresh');
    badges.releasePayout(lockId, _to, _auth('gladias', lockId, badges.PAYOUT_RELEASE(), uint160(_to)));
    assertEq(zc.balanceOf(_to), 100 ether);
  }

  // The Entrypoint owner winds the pool down: nothing can be re-zipped, the stake still comes out
  function test_c1_poolWoundDown_parks_ownerReleases() public {
    vm.prank(owner);
    entrypoint.windDownPool(IPrivacyPool(address(pool)));
    _unlockNow(lockId);
    assertEq(badges.parkedPayout(lockId), 100 ether);

    (uint256 _n, uint256 _s) = _secrets();
    uint256 _newPre = _precommitment(_n, _s);
    ISemaphore.SemaphoreProof memory _p = _auth('gladias', lockId, badges.PAYOUT_REDIRECT(), _newPre);
    vm.expectRevert(IState.PoolIsDead.selector);
    badges.redirectPayout(lockId, _newPre, _p); // still parked

    badges.releasePayout(lockId, gladias, _auth('gladias', lockId, badges.PAYOUT_RELEASE(), uint160(gladias)));
    assertEq(zc.balanceOf(gladias), 100 ether);
  }

  // M-12: the returned note's depositor is ZipBadges, so only ZipBadges can ragequit it. If the ASP never approves
  // the label, the owner exits through ragequitPayout.
  function test_m12_ragequitPayout_whenAspNeverApproves() public {
    _unlockNow(lockId);
    uint256 _label = badges.payoutLabel(lockId);
    assertEq(pool.depositors(_label), address(badges));
    ProofLib.RagequitProof memory _rq = _exitProof(100 ether, _label, preNullifier, preSecret);

    // upstream ragequit is closed to the owner
    vm.prank(gladias);
    vm.expectRevert(IPrivacyPool.OnlyOriginalDepositor.selector);
    pool.ragequit(_rq);

    address _to = makeAddr('exit');
    ISemaphore.SemaphoreProof memory _p = _auth('gladias', lockId, badges.PAYOUT_RAGEQUIT(), uint160(_to));
    vm.expectRevert(ZipBadges.NotOwner.selector);
    badges.ragequitPayout(lockId, _rq, attacker, _p); // recipient is bound

    badges.ragequitPayout(lockId, _rq, _to, _p);
    assertEq(zc.balanceOf(_to), 100 ether);
  }

  function test_ragequitPayout_onlyThatLocksNote() public {
    Note memory _other = _zip(gladias, 5 ether);
    _unlockNow(lockId);
    ProofLib.RagequitProof memory _rq = _exitProof(_other.value, _other.label, _other.nullifier, _other.secret);
    ISemaphore.SemaphoreProof memory _p = _auth('gladias', lockId, badges.PAYOUT_RAGEQUIT(), uint160(gladias));
    vm.expectRevert(DeferredPayout.NotThisPayout.selector);
    badges.ragequitPayout(lockId, _rq, gladias, _p);
  }

  function test_lock_rejectsAnAlreadyUsedPrecommitment() public {
    _poison(0x123);
    zc.mint(gladias, 100 ether);
    vm.startPrank(gladias);
    zc.approve(address(badges), 100 ether);
    vm.expectRevert(ZipBadges.PrecommitmentUsed.selector);
    badges.lock(100 ether, _identity('seila'), 30 days, 0x123);
    vm.stopPrank();
  }

  function test_unlock_happyPath_rezipsAndRecordsLabel() public {
    uint256 _poolBefore = zc.balanceOf(address(pool));
    _unlockNow(lockId);
    assertEq(zc.balanceOf(address(pool)), _poolBefore + 100 ether);
    assertEq(badges.parkedPayout(lockId), 0);
    (uint256 _id, uint256 _value,,, uint8 _tier) = badges.locks(lockId);
    assertEq(_id, identity, 'identity kept for payout recovery');
    assertEq(_value, 0);
    assertEq(_tier, 0);
    vm.expectRevert(ZipBadges.UnknownLock.selector);
    badges.unlock(lockId, new uint256[][](1));
  }

  function _exitProof(uint256 _value, uint256 _label, uint256 _nullifier, uint256 _secret)
    internal
    returns (ProofLib.RagequitProof memory)
  {
    string[] memory _a = new string[](5);
    _a[0] = 'exit';
    _a[1] = vm.toString(_value);
    _a[2] = vm.toString(_label);
    _a[3] = vm.toString(_nullifier);
    _a[4] = vm.toString(_secret);
    return abi.decode(_ffi(_a), (ProofLib.RagequitProof));
  }
}
