// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20, SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';

import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {ZipProcessooor} from './ZipProcessooor.sol';
import {DeferredPayout} from './lib/DeferredPayout.sol';

/**
 * @title ZipRezip
 * @notice Private send: spend a note and re-deposit the value under the recipient's precommitment, so the coins never
 *         leave the pool and the anonymity set only grows.
 * @dev Two ways to address the recipient, both handled off-chain by the SDK:
 *      - zip link: the precommitment comes from random secrets carried in a URL; whoever opens it can unzip.
 *      - zip address: the secrets are encrypted to the recipient's key in ZipAddressRegistry and posted in
 *        `ciphertext`; the recipient's client scans `Rezipped` and tries to decrypt (stealth-address style).
 *      This contract is the depositor of record for rezipped notes; the ASP approves them because their value comes
 *      from already-approved notes. No owner.
 *
 *      Trust assumption (M-12, pool review L-3): since this contract is the depositor, only it could ragequit a
 *      rezipped note, and it has no ragequit path: the recipient is anonymous and nothing on chain could authorise one
 *      for them. A rezipped note therefore leaves the pool only through an ASP-approved withdrawal. If the ASP (the
 *      POSTMAN key) or the Entrypoint OWNER censors it, it is frozen. Senders who can't accept that send to an address.
 *
 *      A deposit never pays the Entrypoint's vetting fee: if the OWNER ever sets one, rezips revert rather than hand
 *      the OWNER a share of the value (R2-M3).
 */
contract ZipRezip is ZipProcessooor {
  using SafeERC20 for IERC20;

  struct Send {
    uint256 precommitment;
    bytes ciphertext;
    Courier courier;
  }

  uint256 public constant MAX_CIPHERTEXT_BYTES = 256;

  IEntrypoint public immutable ENTRYPOINT;
  uint256 public immutable SCOPE;

  /**
   * @param sender The wallet for `zipTo`, address(0) when sent from a zipped note
   * @param commitment The new note's commitment
   * @param label The new note's label (needed by the recipient to spend it)
   */
  event Rezipped(
    address indexed sender, uint256 indexed commitment, uint256 label, uint256 value, uint256 fee, bytes ciphertext
  );

  error TooLong();

  constructor(IPrivacyPool _pool) ZipProcessooor(_pool) {
    ENTRYPOINT = IEntrypoint(address(_pool.ENTRYPOINT()));
    SCOPE = _pool.SCOPE();
  }

  /// @notice Send from a zipped note to a precommitment, entirely inside the pool
  function rezip(IPrivacyPool.Withdrawal calldata _withdrawal, ProofLib.WithdrawProof calldata _proof) external {
    Send memory _s = abi.decode(_withdrawal.data, (Send));
    if (_s.ciphertext.length > MAX_CIPHERTEXT_BYTES) revert TooLong();
    (, uint256 _net) = _spend(_withdrawal, _proof, _s.courier);
    _deposit(address(0), _net, _s.courier.fee, _s.precommitment, _s.ciphertext);
  }

  /// @notice Send from a wallet straight into someone's zip: the sender is public, the recipient is not
  function zipTo(uint256 _value, uint256 _precommitment, bytes calldata _ciphertext) external {
    if (_ciphertext.length > MAX_CIPHERTEXT_BYTES) revert TooLong();
    ZC.safeTransferFrom(msg.sender, address(this), _value);
    _deposit(msg.sender, _value, 0, _precommitment, _ciphertext);
  }

  function _deposit(address _sender, uint256 _value, uint256 _fee, uint256 _precommitment, bytes memory _ciphertext)
    internal
  {
    // Reverts VettingFeeCharged if the Entrypoint would keep a fee (R2-M3), so the note always holds the full value.
    // The label comes from the pool the Entrypoint actually deposited into (I-6), not the construction-time one.
    (uint256 _commitment, uint256 _label) = DeferredPayout.depositFeeFree(ENTRYPOINT, ZC, _value, _precommitment);
    emit Rezipped(_sender, _commitment, _label, _value, _fee, _ciphertext);
  }
}
