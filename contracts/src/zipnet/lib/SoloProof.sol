// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISemaphore} from '@semaphore-protocol/contracts/interfaces/ISemaphore.sol';
import {ISemaphoreVerifier} from '@semaphore-protocol/contracts/interfaces/ISemaphoreVerifier.sol';

/**
 * @title SoloProof
 * @notice "The holder of identity X signs this": a Semaphore v4 proof over the one-member group {X}, whose Merkle root
 *         is X itself. No group or root history is involved, so nothing can be front-run or burned at Semaphore; the
 *         caller binds the action through `scope` and `message` and handles replay itself (e.g. a nonce in the scope).
 */
library SoloProof {
  /// @notice True when `_p` is a valid proof by `_identity` with exactly `_scope` and `_message`
  function verify(
    ISemaphoreVerifier _verifier,
    ISemaphore.SemaphoreProof calldata _p,
    uint256 _identity,
    uint256 _scope,
    uint256 _message
  ) internal view returns (bool) {
    if (_identity == 0 || _p.merkleTreeRoot != _identity || _p.scope != _scope || _p.message != _message) return false;
    if (_p.merkleTreeDepth < 1 || _p.merkleTreeDepth > 32) return false;
    return _verifier.verifyProof(
      [_p.points[0], _p.points[1]],
      [[_p.points[2], _p.points[3]], [_p.points[4], _p.points[5]]],
      [_p.points[6], _p.points[7]],
      [_p.merkleTreeRoot, _p.nullifier, _hash(_p.message), _hash(_p.scope)],
      _p.merkleTreeDepth
    );
  }

  function _hash(uint256 _x) private pure returns (uint256) {
    return uint256(keccak256(abi.encodePacked(_x))) >> 8;
  }
}
