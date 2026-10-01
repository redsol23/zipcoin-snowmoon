// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from '@oz/utils/cryptography/ECDSA.sol';

/**
 * @title SigningKeys
 * @notice The EOA key a staked operator (a merchant or a courier) signs its evidence with, and its delayed rotation.
 *
 * Evidence (invoices, receipts) is checked with plain ECDSA only (`ECDSA.tryRecover`, low-s enforced), never ERC-1271:
 * a contract signer, or an EOA with an EIP-7702 delegation, could otherwise switch its past signatures off (H-2).
 * Operators whose stake sits in a Safe register a separate EOA signing key instead.
 *
 * - No key set: the operator's own address is the key.
 * - `rotate(new)`: the new key is accepted at once (the operator chose it, so it can only make more of its own
 *   evidence enforceable). The current key stays in force until `delay` has passed, and after that it is still
 *   accepted for another `delay` as the previous key, so evidence signed before a rotation stays reportable for at
 *   least as long as a departing operator's stake stays slashable. One rotation at a time.
 * - Retiring a key never makes evidence it signed before the rotation unreportable within that window; a key that
 *   leaks can be rotated out, and stops counting 2 x `delay` after the rotation request at the latest.
 */
library SigningKeys {
  struct Keys {
    /// @notice The key in force (0 = the operator's own address)
    address key;
    /// @notice A rotation in progress: accepted now, the key in force from `nextAt`
    address next;
    uint64 nextAt;
    /// @notice The key before the last completed rotation, still accepted until `prevUntil`
    address prev;
    uint64 prevUntil;
  }

  error RotationPending();
  error ZeroKey();

  /// @notice Current key, pending key, previous key and until when the previous key is accepted, as of now
  function keysOf(Keys storage _k, address _owner, uint64 _delay)
    internal
    view
    returns (address _cur, address _pending, address _prev, uint64 _prevUntil)
  {
    address _key = _k.key == address(0) ? _owner : _k.key;
    if (_k.next != address(0) && block.timestamp >= _k.nextAt) {
      return (_k.next, address(0), _key, _k.nextAt + _delay);
    }
    return (_key, _k.next, _k.prev, _k.prevUntil);
  }

  /// @notice Whether `_signer` may sign evidence for this operator right now
  function accepts(Keys storage _k, address _owner, uint64 _delay, address _signer) internal view returns (bool) {
    if (_signer == address(0)) return false;
    (address _cur, address _pending, address _prev, uint64 _prevUntil) = keysOf(_k, _owner, _delay);
    return _signer == _cur || _signer == _pending || (_signer == _prev && block.timestamp <= _prevUntil);
  }

  /// @notice Recovers an ECDSA signer (EOA keys only; a bad or malleable signature yields address(0))
  function recover(bytes32 _digest, bytes calldata _signature) internal pure returns (address _signer) {
    (_signer,,) = ECDSA.tryRecover(_digest, _signature);
  }

  /// @notice Sets the first key, before any evidence exists (register / first bond)
  function init(Keys storage _k, address _key) internal {
    delete _k.next;
    delete _k.nextAt;
    delete _k.prev;
    delete _k.prevUntil;
    _k.key = _key;
  }

  /// @notice Starts a rotation to `_new`, which is in force after `_delay`
  function rotate(Keys storage _k, address _owner, uint64 _delay, address _new) internal returns (uint64 _at) {
    if (_new == address(0)) revert ZeroKey();
    if (_k.next != address(0)) {
      if (block.timestamp < _k.nextAt) revert RotationPending();
      // settle the finished rotation; the older `prev` has already expired (its window ended by this `nextAt`)
      _k.prev = _k.key == address(0) ? _owner : _k.key;
      _k.prevUntil = _k.nextAt + _delay;
      _k.key = _k.next;
    }
    _at = uint64(block.timestamp) + _delay;
    _k.next = _new;
    _k.nextAt = _at;
  }
}
