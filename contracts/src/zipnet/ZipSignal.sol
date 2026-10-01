// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISemaphore} from '@semaphore-protocol/contracts/interfaces/ISemaphore.sol';

import {SemaphoreNullifiers} from './SemaphoreNullifiers.sol';

/**
 * @title ZipSignal
 * @notice Anonymous posts from inside a group: "some tier-3 badge holder says…", "someone who ate at Beautiful Plants
 *         says…" (Snowmoon ch. 1: "Anonymous · Rep score ≥ 200 · Verified ✓").
 * @dev A Semaphore proof binds the text (`message == keccak(text)`) and a per-group, per-day slot (`scope`), so each
 *      member gets at most POSTS_PER_DAY posts per group per day and nobody can link two of them. The group is in the
 *      scope, so a member of several tier groups gets a different nullifier in each: posts in two groups can't be
 *      linked, and the rate limit is per group rather than shared or multiplied across them. Anyone may submit the
 *      proof, so posts arrive through couriers. No owner, no funds.
 */
contract ZipSignal is SemaphoreNullifiers {
  uint256 public constant POSTS_PER_DAY = 5;
  uint256 public constant MAX_MESSAGE_BYTES = 560;
  /// @notice A proof made for yesterday's slot is still accepted this long into the new day (a courier's delay)
  uint256 public constant DAY_GRACE = 1 hours;

  ISemaphore public immutable SEMAPHORE;

  event Posted(uint256 indexed groupId, uint256 indexed day, uint256 nullifier, string message);

  error BadSlot();
  error BadScope();
  error BadMessage();
  error TooLong();

  constructor(ISemaphore _semaphore) {
    SEMAPHORE = _semaphore;
  }

  function scopeOf(uint256 _groupId, uint256 _day, uint256 _slot) public view returns (uint256) {
    return uint256(keccak256(abi.encode('zipnet.post', address(this), block.chainid, _groupId, _day, _slot)));
  }

  function messageOf(string calldata _text) public pure returns (uint256) {
    return uint256(keccak256(bytes(_text)));
  }

  function post(uint256 _groupId, uint256 _slot, string calldata _text, ISemaphore.SemaphoreProof calldata _proof)
    external
  {
    if (_slot >= POSTS_PER_DAY) revert BadSlot();
    if (bytes(_text).length > MAX_MESSAGE_BYTES) revert TooLong();
    uint256 _day = block.timestamp / 1 days;
    if (_proof.scope != scopeOf(_groupId, _day, _slot)) {
      // Made just before midnight and delayed past it: still yesterday's slot, still one post per slot (L-9)
      if (_day == 0 || block.timestamp % 1 days >= DAY_GRACE || _proof.scope != scopeOf(_groupId, _day - 1, _slot)) {
        revert BadScope();
      }
      _day -= 1;
    }
    if (_proof.message != messageOf(_text)) revert BadMessage();

    _consumeProof(SEMAPHORE, _groupId, _proof);
    emit Posted(_groupId, _day, _proof.nullifier, _text);
  }
}
