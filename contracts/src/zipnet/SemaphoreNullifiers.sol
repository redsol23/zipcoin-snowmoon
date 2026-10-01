// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISemaphore} from '@semaphore-protocol/contracts/interfaces/ISemaphore.sol';

/**
 * @title SemaphoreNullifiers
 * @notice Consumes Semaphore proofs with a nullifier set kept in this contract.
 * @dev Semaphore v4's `validateProof` has no caller check: anyone who copies a pending proof from the mempool can call
 *      it first and burn the nullifier in Semaphore's per-group set, so the real submission reverts forever (H-1). This
 *      uses the view `verifyProof` instead (it still checks the root is current or unexpired, and the depth) and records
 *      the nullifier here, where only this contract can spend it. Every scope a proof is checked against includes
 *      `address(this)` and `block.chainid`, so nullifiers from different scopes, contracts or chains never collide, and
 *      one set keyed by nullifier is enough.
 */
abstract contract SemaphoreNullifiers {
  /// @notice Semaphore nullifiers this contract has consumed
  mapping(uint256 nullifier => bool) public nullifierUsed;

  error NullifierUsed();
  error InvalidProof();

  /// @dev Checks `_proof` against `_groupId` and spends its nullifier here. Scope and message are the caller's to check.
  function _consumeProof(ISemaphore _semaphore, uint256 _groupId, ISemaphore.SemaphoreProof memory _proof) internal {
    if (nullifierUsed[_proof.nullifier]) revert NullifierUsed();
    _verifyProof(_semaphore, _groupId, _proof);
    nullifierUsed[_proof.nullifier] = true;
  }

  /// @dev Checks `_proof` against `_groupId` without spending anything
  function _verifyProof(ISemaphore _semaphore, uint256 _groupId, ISemaphore.SemaphoreProof memory _proof) internal view {
    if (!_semaphore.verifyProof(_groupId, _proof)) revert InvalidProof();
  }
}
