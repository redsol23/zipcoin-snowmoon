// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20, SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';

import {Constants} from 'contracts/lib/Constants.sol';
import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

/**
 * @title DeferredPayout
 * @notice "Pay into the pool later, under a precommitment chosen earlier, and never get stuck doing it."
 *
 * A contract that escrows ZC and later re-zips it to a precommitment the owner chose days or months before (badge
 * returns) cannot let that deposit decide whether the funds ever leave. The deposit
 * can fail for reasons the owner does not control:
 * - someone deposits first under the same public precommitment (PrecommitmentAlreadyUsed, 1 ZC grief);
 * - the amount is below the pool's minimum (e.g. the Entrypoint owner raised it);
 * - the pool was removed (PoolNotFound) or wound down (PoolIsDead);
 * - the Entrypoint OWNER set a vetting fee (R2-M3). The deposit would succeed, but the fee (up to 99.99%) would go to
 *   the OWNER, and anyone can trigger these payouts, so it parks instead and the owner redirects it once the fee is
 *   back to 0 or releases it to an address.
 *
 * `payOrPark` tries the deposit and, if it fails, parks the amount under the payout's id instead of reverting. The
 * owning contract then lets the payout's rightful owner (authorised however that contract authorised the payout in the
 * first place) do one of:
 * - `redirect`: deposit the parked amount under a NEW precommitment;
 * - `release`: send the parked amount to a plain address (the exit when the pool is gone or dead).
 *
 * A deposit that succeeded is still only half the story: the note's depositor is the escrowing contract, so upstream
 * `PrivacyPool.ragequit` (the public exit for notes the ASP never approves) only works when that contract calls it
 * (M-12). `payOrPark` records the note's pool and label, and `ragequit` lets the owning contract ragequit that exact
 * note (or any change note sharing its label) and forward the value to an address the owner chose.
 *
 * What the library does NOT do is authorise: every `redirect` / `release` / `ragequit` must be gated by the caller.
 * Bind the new precommitment or recipient into the owner's authorisation (a Semaphore message, an EIP-712 field), and
 * use `nonceOf` / `useNonce` so an authorisation cannot be replayed if the same id is ever parked twice.
 *
 * Known nuisance, accepted (R2-L5): contracts check `usedPrecommitments` when a payout is created (ZipBadges `_lock`),
 * and ZipPay and ZipRezip deposit in the same transaction.
 * A mempool watcher can deposit 1 ZC under the pending transaction's precommitment first, and that transaction then
 * reverts (PrecommitmentUsed / PrecommitmentAlreadyUsed). No funds move or freeze: the attacker's 1 ZC becomes a note
 * the victim can spend, which makes the grief self-limiting. The wallet retries with a fresh precommitment (for
 * lockAnon that also means a new withdrawal proof). Sending through a private relay avoids it.
 *
 * @dev A payout that anyone may trigger (e.g. an expired badge unlock) could be forced to park by calling with just
 *      enough gas for the Entrypoint call to run out of gas. `payOrPark` refuses to park when the failed call left
 *      less than 1/8 of the gas it started with, so such a call reverts and can be retried with more gas. A payout
 *      that parks is still fully recoverable, so the worst a successful grief can do is cost the owner one call.
 */
library DeferredPayout {
  using SafeERC20 for IERC20;
  using ProofLib for ProofLib.RagequitProof;

  struct Book {
    /// @notice id => ZC parked after a failed deposit, waiting for redirect or release
    mapping(uint256 id => uint256) parked;
    /// @notice id => the pool the payout's note went into (0 = not deposited)
    mapping(uint256 id => address) poolOf;
    /// @notice id => the label of the payout's note (every note derived from it shares it)
    mapping(uint256 id => uint256) labelOf;
    /// @notice id => how many owner authorisations have been used (for replay protection)
    mapping(uint256 id => uint256) nonce;
    /// @notice Sum of `parked`
    uint256 totalParked;
  }

  event PayoutDeposited(uint256 indexed id, uint256 amount, uint256 precommitment, uint256 commitment, uint256 label);
  event PayoutParked(uint256 indexed id, uint256 amount, uint256 precommitment, bytes reason);
  event PayoutReleased(uint256 indexed id, address to, uint256 amount);
  event PayoutRagequit(uint256 indexed id, address to, uint256 amount);

  /// @notice The largest Entrypoint vetting fee a contract-made deposit accepts: none. Our deployment registers the
  ///         pool with a fee of 0, and every wei of a fee would go to the Entrypoint OWNER, not to anyone the payout
  ///         belongs to (R2-M3).
  uint256 internal constant MAX_VETTING_FEE_BPS = 0;

  error NothingParked();
  error NotThisPayout();
  error LowGas();
  error ZeroRecipient();
  error VettingFeeCharged(uint256 feeBps);

  /**
   * @notice Deposits `_amount` of `_asset` under `_precommitment`; if the deposit fails for any reason, parks it
   * @return _deposited Whether the deposit went through
   * @return _commitment The new note's commitment (0 when parked)
   */
  function payOrPark(
    Book storage _b,
    IEntrypoint _entrypoint,
    IERC20 _asset,
    uint256 _id,
    uint256 _amount,
    uint256 _precommitment
  ) internal returns (bool _deposited, uint256 _commitment) {
    if (_amount == 0) return (true, 0);
    (IPrivacyPool _pool, uint256 _min, uint256 _fee,) = _entrypoint.assetConfig(_asset);
    if (address(_pool) == address(0) || _amount < _min) {
      _park(_b, _id, _amount, _precommitment, '');
      return (false, 0);
    }
    // R2-M3: the Entrypoint keeps a vetting fee of every deposit for its OWNER. Our deployment sets it to 0; if it is
    // ever raised, a deposit would silently hand that share to the OWNER, so the payout parks for its owner instead
    if (_fee > MAX_VETTING_FEE_BPS) {
      _park(_b, _id, _amount, _precommitment, abi.encodeWithSelector(VettingFeeCharged.selector, _fee));
      return (false, 0);
    }
    _asset.forceApprove(address(_entrypoint), _amount);
    uint256 _gas = gasleft();
    try _entrypoint.deposit(_asset, _amount, _precommitment) returns (uint256 _c) {
      _record(_b, _id, _pool, _amount, _precommitment, _c);
      return (true, _c);
    } catch (bytes memory _reason) {
      if (gasleft() < _gas / 8) revert LowGas();
      _asset.forceApprove(address(_entrypoint), 0);
      _park(_b, _id, _amount, _precommitment, _reason);
      return (false, 0);
    }
  }

  /**
   * @notice Deposits a parked payout under a new precommitment. Reverts (leaving it parked) if that deposit fails.
   * @dev Caller authorises the payout's owner and binds `_precommitment` into that authorisation
   */
  function redirect(Book storage _b, IEntrypoint _entrypoint, IERC20 _asset, uint256 _id, uint256 _precommitment)
    internal
    returns (uint256 _commitment)
  {
    uint256 _amount = _take(_b, _id);
    IPrivacyPool _pool;
    (_commitment, _pool) = _deposit(_entrypoint, _asset, _amount, _precommitment);
    _record(_b, _id, _pool, _amount, _precommitment, _commitment);
  }

  /**
   * @notice A contract-made deposit that can never pay the Entrypoint's vetting fee: reverts VettingFeeCharged when
   *         the fee is above MAX_VETTING_FEE_BPS (R2-M3), so a user's funds never silently shrink. For deposits made
   *         in the user's own transaction (ZipPay, ZipRezip): the user retries or takes the funds to an
   *         address instead.
   * @return _commitment The new note's commitment
   * @return _label The new note's label, read from the pool the Entrypoint deposited into
   */
  function depositFeeFree(IEntrypoint _entrypoint, IERC20 _asset, uint256 _amount, uint256 _precommitment)
    internal
    returns (uint256 _commitment, uint256 _label)
  {
    IPrivacyPool _pool;
    (_commitment, _pool) = _deposit(_entrypoint, _asset, _amount, _precommitment);
    _label = labelNow(_pool);
  }

  /// @notice The label of the note the pool created last: keccak(SCOPE, nonce), as upstream numbers them
  function labelNow(IPrivacyPool _pool) internal view returns (uint256) {
    return uint256(keccak256(abi.encodePacked(_pool.SCOPE(), _pool.nonce()))) % Constants.SNARK_SCALAR_FIELD;
  }

  function _deposit(IEntrypoint _entrypoint, IERC20 _asset, uint256 _amount, uint256 _precommitment)
    private
    returns (uint256 _commitment, IPrivacyPool _pool)
  {
    uint256 _fee;
    (_pool,, _fee,) = _entrypoint.assetConfig(_asset);
    if (_fee > MAX_VETTING_FEE_BPS) revert VettingFeeCharged(_fee);
    _asset.forceApprove(address(_entrypoint), _amount);
    _commitment = _entrypoint.deposit(_asset, _amount, _precommitment);
  }

  /**
   * @notice Sends a parked payout to a plain address
   * @dev Caller authorises the payout's owner and binds `_to` into that authorisation
   */
  function release(Book storage _b, IERC20 _asset, uint256 _id, address _to) internal returns (uint256 _amount) {
    if (_to == address(0)) revert ZeroRecipient();
    _amount = _take(_b, _id);
    _asset.safeTransfer(_to, _amount);
    emit PayoutReleased(_id, _to, _amount);
  }

  /**
   * @notice Ragequits the payout's note (or a change note with the same label) and forwards its value to `_to`.
   *         The note's depositor is this contract, so nobody else can ragequit it; `_proof` shows knowledge of the
   *         note's secrets, and the caller's own authorisation binds `_to`.
   */
  function ragequit(Book storage _b, IERC20 _asset, uint256 _id, ProofLib.RagequitProof memory _proof, address _to)
    internal
    returns (uint256 _amount)
  {
    if (_to == address(0)) revert ZeroRecipient();
    address _pool = _b.poolOf[_id];
    if (_pool == address(0) || _proof.label() != _b.labelOf[_id]) revert NotThisPayout();
    uint256 _before = _asset.balanceOf(address(this));
    IPrivacyPool(_pool).ragequit(_proof);
    _amount = _asset.balanceOf(address(this)) - _before;
    _asset.safeTransfer(_to, _amount);
    emit PayoutRagequit(_id, _to, _amount);
  }

  /// @notice The nonce the next owner authorisation for `_id` must carry
  function nonceOf(Book storage _b, uint256 _id) internal view returns (uint256) {
    return _b.nonce[_id];
  }

  /// @notice Consumes the current nonce of `_id` (call after checking an authorisation that carried it)
  function useNonce(Book storage _b, uint256 _id) internal returns (uint256 _n) {
    _n = _b.nonce[_id]++;
  }

  function _park(Book storage _b, uint256 _id, uint256 _amount, uint256 _precommitment, bytes memory _reason) private {
    _b.parked[_id] += _amount;
    _b.totalParked += _amount;
    emit PayoutParked(_id, _amount, _precommitment, _reason);
  }

  function _take(Book storage _b, uint256 _id) private returns (uint256 _amount) {
    _amount = _b.parked[_id];
    if (_amount == 0) revert NothingParked();
    _b.parked[_id] = 0;
    _b.totalParked -= _amount;
  }

  /// @dev The pool numbers labels keccak(SCOPE, nonce) in deposit order; read it right after our own deposit
  function _record(
    Book storage _b,
    uint256 _id,
    IPrivacyPool _pool,
    uint256 _amount,
    uint256 _precommitment,
    uint256 _commitment
  ) private {
    uint256 _label = labelNow(_pool);
    _b.poolOf[_id] = address(_pool);
    _b.labelOf[_id] = _label;
    emit PayoutDeposited(_id, _amount, _precommitment, _commitment, _label);
  }
}
