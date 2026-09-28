// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20, SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {ISemaphore} from '@semaphore-protocol/contracts/interfaces/ISemaphore.sol';

import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {ZipProcessooor} from './ZipProcessooor.sol';

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
 * @dev Tier groups are Semaphore groups administered by this contract. Removing a member needs its Merkle siblings in
 *      each tier group, which the caller supplies (the SDK computes them from `MemberAdded` events). No owner.
 */
contract ZipBadges is ZipProcessooor {
  using SafeERC20 for IERC20;

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
  }

  uint64 public constant MIN_DURATION = 7 days;
  uint64 public constant MAX_DURATION = 730 days;

  ISemaphore public immutable SEMAPHORE;
  IEntrypoint public immutable ENTRYPOINT;

  /// @notice Minimum weight (ZC-wei × days) for each tier, ascending; tier i+1 needs thresholds[i]
  uint256[] public thresholds;
  /// @notice Semaphore group of each tier, index 0 = tier 1
  uint256[] public tierGroups;

  uint256 public lockCount;
  mapping(uint256 => Lock) public locks;

  event Locked(uint256 indexed lockId, uint8 tier, uint256 identityCommitment, uint256 value, uint64 unlockAt);
  event Unlocked(uint256 indexed lockId, uint256 commitment);

  error BadDuration();
  error NoTier();
  error StillLocked();
  error UnknownLock();
  error BadThresholds();

  constructor(IPrivacyPool _pool, ISemaphore _semaphore, uint256[] memory _thresholds) ZipProcessooor(_pool) {
    if (_thresholds.length == 0 || _thresholds.length > 8) revert BadThresholds();
    for (uint256 _i = 1; _i < _thresholds.length; ++_i) {
      if (_thresholds[_i] <= _thresholds[_i - 1]) revert BadThresholds();
    }
    SEMAPHORE = _semaphore;
    ENTRYPOINT = IEntrypoint(address(_pool.ENTRYPOINT()));
    thresholds = _thresholds;
    for (uint256 _i; _i < _thresholds.length; ++_i) {
      tierGroups.push(_semaphore.createGroup(address(this)));
    }
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
    _lock(LockRequest(_identityCommitment, _duration, _returnPrecommitment, Courier(address(0), 0)), _value);
  }

  /**
   * @notice After expiry anyone may unlock: the stake is re-zipped to the owner's precommitment and the identity
   *         leaves its tier groups
   * @param _siblings Merkle siblings of the identity in each of its tier groups (tier 1 first)
   */
  function unlock(uint256 _lockId, uint256[][] calldata _siblings) external {
    Lock memory _l = locks[_lockId];
    if (_l.value == 0) revert UnknownLock();
    if (block.timestamp < _l.unlockAt) revert StillLocked();
    delete locks[_lockId];

    for (uint256 _i; _i < _l.tier; ++_i) {
      SEMAPHORE.removeMember(tierGroups[_i], _l.identityCommitment, _siblings[_i]);
    }
    ZC.forceApprove(address(ENTRYPOINT), _l.value);
    uint256 _commitment = ENTRYPOINT.deposit(ZC, _l.value, _l.returnPrecommitment);
    emit Unlocked(_lockId, _commitment);
  }

  function _lock(LockRequest memory _r, uint256 _value) internal {
    if (_r.duration < MIN_DURATION || _r.duration > MAX_DURATION) revert BadDuration();
    uint8 _tier = tierFor(_value, _r.duration);
    if (_tier == 0) revert NoTier();

    uint256 _id = ++lockCount;
    uint64 _unlockAt = uint64(block.timestamp) + _r.duration;
    locks[_id] = Lock(_r.identityCommitment, _value, _r.returnPrecommitment, _unlockAt, _tier);
    for (uint256 _i; _i < _tier; ++_i) {
      SEMAPHORE.addMember(tierGroups[_i], _r.identityCommitment);
    }
    emit Locked(_id, _tier, _r.identityCommitment, _value, _unlockAt);
  }
}
