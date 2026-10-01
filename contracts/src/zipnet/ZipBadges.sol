// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20, SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {Semaphore} from '@semaphore-protocol/contracts/Semaphore.sol';
import {ISemaphore} from '@semaphore-protocol/contracts/interfaces/ISemaphore.sol';
import {ISemaphoreVerifier} from '@semaphore-protocol/contracts/interfaces/ISemaphoreVerifier.sol';

import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {ZcRewardsHarvester} from './ZcRewardsHarvester.sol';
import {ZipProcessooor} from './ZipProcessooor.sol';
import {DeferredPayout} from './lib/DeferredPayout.sol';
import {SoloProof} from './lib/SoloProof.sol';

/**
 * @title ZipBadges
 * @notice Reputation you can prove without saying who you are (Snowmoon ch. 1: "Anonymous · Rep score ≥ 200 ·
 *         Verified ✓").
 *
 * Lock ZC for a while; the weight of the lock (amount × days) earns a tier, and a Semaphore identity you choose joins
 * the group of every tier up to it. Anyone in a tier group can then post, vote or be reached with a proof that says
 * "some member of tier N" and nothing else.
 *
 * Locking from a zipped note (`lockAnon`) hides the wallet as well; either way the stake goes back into the pool as a
 * new note under the `returnPrecommitment` chosen at lock time, so unlocking never reveals the owner and anyone may
 * trigger it once the lock expires.
 *
 * ETH rewards: locked ZC earns ZC's ETH holder rewards, which go to the lockers pro rata by locked value over time
 * (ZcRewardsHarvester). Each lock names a `rewardTo` address that earns for it: the caller for `lock`, and for
 * `lockAnon` whatever the request names (the wallet uses an address derived from the zip key, so the badge stays
 * unlinked; `claimEthFor` lets anyone, e.g. a courier, pay it out without that address holding gas). A lockAnon request
 * with rewardTo = 0 does not earn, and its share goes to the other lockers. A lock earns until it is unlocked.
 *
 * Getting the stake back never depends on the pool accepting the deposit (C-1): if the re-zip under
 * `returnPrecommitment` fails (someone used that public precommitment first, the stake is
 * below the pool's minimum, the pool was removed or wound down), the stake is parked for the lock instead. The lock's
 * identity then proves ownership (a Semaphore proof over the one-member group {identity}) to re-zip it under a new
 * precommitment (`redirectPayout`) or send it to an address (`releasePayout`).
 *
 * Trust assumption (M-12): a returned note's depositor is this contract, so only this contract can ragequit it. If the
 * ASP never approves the note, `ragequitPayout` is the owner's public exit: the ragequit proof shows knowledge of the
 * note, the identity's proof names the recipient, and this contract ragequits and forwards the value.
 * @dev Tier groups are Semaphore groups administered by this contract. Removing a member needs its Merkle siblings in
 *      each tier group, which the caller supplies (the SDK computes them from `MemberAdded` events). No owner.
 */
contract ZipBadges is ZipProcessooor, ZcRewardsHarvester {
  using SafeERC20 for IERC20;
  using DeferredPayout for DeferredPayout.Book;

  struct Lock {
    uint256 identityCommitment;
    uint256 value;
    uint256 returnPrecommitment;
    uint64 unlockAt;
    uint8 tier;
  }

  struct LockRequest {
    uint256 identityCommitment;
    uint64 duration;
    uint256 returnPrecommitment;
    Courier courier;
    /// @notice Who earns the lock's ETH rewards (0 = nobody)
    address rewardTo;
  }

  uint64 public constant MIN_DURATION = 7 days;
  uint64 public constant MAX_DURATION = 730 days;

  /// @notice Payout recovery actions, bound into the owner's proof message (`payoutMessage`)
  uint8 public constant PAYOUT_REDIRECT = 1;
  uint8 public constant PAYOUT_RELEASE = 2;
  uint8 public constant PAYOUT_RAGEQUIT = 3;

  ISemaphore public immutable SEMAPHORE;
  ISemaphoreVerifier public immutable VERIFIER;
  IEntrypoint public immutable ENTRYPOINT;

  /// @notice Minimum weight (ZC-wei × days) for each tier, ascending; tier i+1 needs thresholds[i]
  uint256[] public thresholds;
  /// @notice Semaphore group of each tier, index 0 = tier 1
  uint256[] public tierGroups;

  uint256 public lockCount;
  mapping(uint256 => Lock) public locks;
  /// @notice The address earning each lock's ETH rewards (kept outside Lock so the `locks` getter is unchanged)
  mapping(uint256 => address) public lockRewardTo;

  /// @dev Stakes whose re-zip failed at unlock, and the notes the others became
  DeferredPayout.Book internal _payouts;

  event Locked(uint256 indexed lockId, uint8 tier, uint256 identityCommitment, uint256 value, uint64 unlockAt);
  event Unlocked(uint256 indexed lockId, uint256 commitment);

  error BadDuration();
  error NoTier();
  error StillLocked();
  error UnknownLock();
  error BadThresholds();
  error PrecommitmentUsed();
  error NotOwner();

  constructor(IPrivacyPool _pool, ISemaphore _semaphore, uint256[] memory _thresholds)
    ZipProcessooor(_pool)
    ZcRewardsHarvester(_pool.ASSET())
  {
    if (_thresholds.length == 0 || _thresholds.length > 8) revert BadThresholds();
    for (uint256 _i = 1; _i < _thresholds.length; ++_i) {
      if (_thresholds[_i] <= _thresholds[_i - 1]) revert BadThresholds();
    }
    SEMAPHORE = _semaphore;
    VERIFIER = Semaphore(address(_semaphore)).verifier();
    ENTRYPOINT = IEntrypoint(address(_pool.ENTRYPOINT()));
    thresholds = _thresholds;
    for (uint256 _i; _i < _thresholds.length; ++_i) {
      tierGroups.push(_semaphore.createGroup(address(this)));
    }
  }

  /// @dev ETH earned while no lock is earning (e.g. only lockAnon locks with rewardTo = 0, or parked stakes) goes to
  ///      the pool's TREASURY (R2-L4)
  function _unearnedEthTo() internal view override returns (address payable) {
    return _poolTreasury(address(POOL));
  }

  function tierCount() external view returns (uint256) {
    return thresholds.length;
  }

  /// @notice The tier a lock of `_value` for `_duration` earns (0 = none)
  function tierFor(uint256 _value, uint64 _duration) public view returns (uint8 _tier) {
    uint256 _weight = _value * (_duration / 1 days);
    for (uint256 _i; _i < thresholds.length; ++_i) {
      if (_weight >= thresholds[_i]) _tier = uint8(_i + 1);
    }
  }

  /// @notice Lock from a zipped note: nobody learns which wallet stands behind the badge
  function lockAnon(IPrivacyPool.Withdrawal calldata _withdrawal, ProofLib.WithdrawProof calldata _proof) external {
    LockRequest memory _r = abi.decode(_withdrawal.data, (LockRequest));
    (, uint256 _net) = _spend(_withdrawal, _proof, _r.courier);
    _lock(_r, _net);
  }

  /// @notice Lock from a wallet
  function lock(uint256 _value, uint256 _identityCommitment, uint64 _duration, uint256 _returnPrecommitment) external {
    ZC.safeTransferFrom(msg.sender, address(this), _value);
    _lock(LockRequest(_identityCommitment, _duration, _returnPrecommitment, Courier(address(0), 0), msg.sender), _value);
  }

  /**
   * @notice After expiry anyone may unlock: the stake is re-zipped to the owner's precommitment and the identity
   *         leaves its tier groups. If the re-zip fails the stake is parked for the owner (`parkedPayout`) and
   *         `Unlocked` carries commitment 0.
   * @param _siblings Merkle siblings of the identity in each of its tier groups (tier 1 first)
   */
  function unlock(uint256 _lockId, uint256[][] calldata _siblings) external {
    Lock memory _l = locks[_lockId];
    if (_l.value == 0) revert UnknownLock();
    if (block.timestamp < _l.unlockAt) revert StillLocked();
    // The identity stays on record: it is what authorises recovering the payout
    locks[_lockId] = Lock(_l.identityCommitment, 0, 0, 0, 0);
    _releaseLockStake(_lockId, _l.value);
    delete lockRewardTo[_lockId];

    _removeMember(_l.identityCommitment, _l.tier, _siblings);
    (, uint256 _commitment) = _payouts.payOrPark(ENTRYPOINT, ZC, _lockId, _l.value, _l.returnPrecommitment);
    emit Unlocked(_lockId, _commitment);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // payout recovery (the lock's identity authorises, see `payoutScope` / `payoutMessage`)
  // ---------------------------------------------------------------------------------------------------------------

  /// @notice ZC of lock `_lockId` waiting for its owner after a failed re-zip
  function parkedPayout(uint256 _lockId) external view returns (uint256) {
    return _payouts.parked[_lockId];
  }

  /// @notice Label of the note lock `_lockId`'s stake became (0 = none), for `ragequitPayout`
  function payoutLabel(uint256 _lockId) external view returns (uint256) {
    return _payouts.labelOf[_lockId];
  }

  /// @notice Scope of the owner's next payout proof for lock `_lockId`; it changes after every use
  function payoutScope(uint256 _lockId) public view returns (uint256) {
    return uint256(
      keccak256(abi.encode('zipnet.badge.payout', address(this), block.chainid, _lockId, _payouts.nonceOf(_lockId)))
    );
  }

  /// @notice Message of a payout proof: the action and its target (a precommitment, or an address as uint160)
  function payoutMessage(uint8 _action, uint256 _target) public pure returns (uint256) {
    return uint256(keccak256(abi.encode(_action, _target)));
  }

  /// @notice Re-zip a parked stake under a new precommitment
  function redirectPayout(uint256 _lockId, uint256 _precommitment, ISemaphore.SemaphoreProof calldata _auth)
    external
    returns (uint256 _commitment)
  {
    _authorise(_lockId, PAYOUT_REDIRECT, _precommitment, _auth);
    _commitment = _payouts.redirect(ENTRYPOINT, ZC, _lockId, _precommitment);
  }

  /// @notice Send a parked stake to `_to` (e.g. when the pool is gone, or the stake is below its minimum)
  function releasePayout(uint256 _lockId, address _to, ISemaphore.SemaphoreProof calldata _auth)
    external
    returns (uint256)
  {
    _authorise(_lockId, PAYOUT_RELEASE, uint160(_to), _auth);
    return _payouts.release(ZC, _lockId, _to);
  }

  /// @notice Ragequit the note the stake became (or its change) to `_to`: the exit if the ASP never approves it
  function ragequitPayout(
    uint256 _lockId,
    ProofLib.RagequitProof calldata _proof,
    address _to,
    ISemaphore.SemaphoreProof calldata _auth
  ) external returns (uint256) {
    _authorise(_lockId, PAYOUT_RAGEQUIT, uint160(_to), _auth);
    return _payouts.ragequit(ZC, _lockId, _proof, _to);
  }

  function _authorise(uint256 _lockId, uint8 _action, uint256 _target, ISemaphore.SemaphoreProof calldata _auth)
    internal
  {
    uint256 _identity = locks[_lockId].identityCommitment;
    if (!SoloProof.verify(VERIFIER, _auth, _identity, payoutScope(_lockId), payoutMessage(_action, _target))) {
      revert NotOwner();
    }
    _payouts.useNonce(_lockId);
  }

  function _removeMember(uint256 _identity, uint8 _groups, uint256[][] calldata _siblings) internal {
    for (uint256 _i; _i < _groups; ++_i) {
      SEMAPHORE.removeMember(tierGroups[_i], _identity, _siblings[_i]);
    }
  }

  function _lock(LockRequest memory _r, uint256 _value) internal {
    if (_r.duration < MIN_DURATION || _r.duration > MAX_DURATION) revert BadDuration();
    uint8 _tier = tierFor(_value, _r.duration);
    if (_tier == 0) revert NoTier();
    // A reused precommitment fails now rather than at unlock (where it would park the stake)
    if (ENTRYPOINT.usedPrecommitments(_r.returnPrecommitment)) revert PrecommitmentUsed();

    uint256 _id = ++lockCount;
    uint64 _unlockAt = uint64(block.timestamp) + _r.duration;
    locks[_id] = Lock(_r.identityCommitment, _value, _r.returnPrecommitment, _unlockAt, _tier);
    if (_r.rewardTo != address(0)) {
      lockRewardTo[_id] = _r.rewardTo;
      _addEthStake(_r.rewardTo, _value);
    }
    for (uint256 _i; _i < _tier; ++_i) {
      SEMAPHORE.addMember(tierGroups[_i], _r.identityCommitment);
    }
    emit Locked(_id, _tier, _r.identityCommitment, _value, _unlockAt);
  }

  /// @dev `_amount` of lock `_lockId`'s ZC stops earning ETH rewards (unlock, and anything else that takes ZC out)
  function _releaseLockStake(uint256 _lockId, uint256 _amount) internal {
    address _to = lockRewardTo[_lockId];
    if (_to != address(0) && _amount != 0) _subEthStake(_to, _amount);
  }
}
