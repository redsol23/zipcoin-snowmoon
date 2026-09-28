// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20, SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {ISemaphore} from '@semaphore-protocol/contracts/interfaces/ISemaphore.sol';
import {ISemaphoreGroups} from '@semaphore-protocol/contracts/interfaces/ISemaphoreGroups.sol';

import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {ZipMerchants} from './ZipMerchants.sol';
import {ZipProcessooor} from './ZipProcessooor.sol';

/**
 * @title ZipPay
 * @notice Pay a merchant from a zipped note with sales tax taken in the same proof.
 *
 * Snowmoon ch. 6 - "Payment succeeded. Base 10.5 zc, Tax 1.1 zc, Total 11.6 zc ... Only Gladias and the restaurant
 * knew that a 10.5 zipcoin order had been made. The sales tax was sent to the government in real time,
 * automatically."
 *
 * The payer is anonymous: the chain sees a note being spent, never whose. The order details travel in `receipt`,
 * encrypted to buyer and merchant. The merchant can take payment to its payout address or straight back into the
 * pool as a new note (`payeePrecommitment`), so its revenue stays zipped too.
 *
 * A payer may also drop a Semaphore identity into the merchant's payer group (Snowmoon ch. 19: the Beautiful Plants
 * courtyard reaching "all their guests from the past half year"). The group can then be reached with ZipBroadcaster or
 * polled, and members can prove "I ate here" without saying who they are.
 *
 * Tax is split in real time: part burned, part to the courier reward pool that keeps the network private, the rest to
 * the treasury. Rates and recipients are fixed at deployment.
 * @dev The amount spent is a public signal of the withdrawal proof, so totals are visible; who paid is not. No owner.
 */
contract ZipPay is ZipProcessooor {
  using SafeERC20 for IERC20;

  struct Payment {
    uint256 merchantId;
    uint256 base;
    bytes32 orderId;
    uint256 payeePrecommitment;
    uint256 identityCommitment;
    bytes receipt;
    Courier courier;
  }

  uint256 public constant MAX_RECEIPT_BYTES = 512;
  uint256 public constant MAX_TAX_BPS = 1000;

  ZipMerchants public immutable MERCHANTS;
  IEntrypoint public immutable ENTRYPOINT;
  uint256 public immutable TAX_BPS;
  uint256 public immutable BURN_SHARE_BPS;
  uint256 public immutable COURIER_SHARE_BPS;
  address public immutable COURIER_POOL;
  address public immutable TREASURY;
  ISemaphore public immutable SEMAPHORE;

  /// @notice Semaphore group of each merchant's payers, created on first use (0 = none yet)
  mapping(uint256 merchantId => uint256 groupId) public payerGroup;
  mapping(uint256 merchantId => bool) public hasPayerGroup;

  /**
   * @param payer The paying wallet for `pay`, address(0) when paid from a zipped note
   * @param identityCommitment Semaphore identity the payer chose to add to this merchant's payer group, or 0
   */
  event Paid(
    uint256 indexed merchantId,
    bytes32 indexed orderId,
    address indexed payer,
    uint256 nullifierHash,
    uint256 base,
    uint256 tax,
    uint256 fee,
    uint256 identityCommitment,
    bytes receipt
  );
  event TaxSplit(uint256 burned, uint256 toCouriers, uint256 toTreasury);
  event PayerGroupCreated(uint256 indexed merchantId, uint256 groupId);

  error NotListed();
  error WrongTotal();
  error TooLong();
  error BadShares();

  constructor(
    IPrivacyPool _pool,
    ZipMerchants _merchants,
    uint256 _taxBPS,
    uint256 _burnShareBPS,
    uint256 _courierShareBPS,
    address _courierPool,
    address _treasury,
    ISemaphore _semaphore
  ) ZipProcessooor(_pool) {
    if (_taxBPS > MAX_TAX_BPS || _burnShareBPS + _courierShareBPS > 10_000) revert BadShares();
    MERCHANTS = _merchants;
    ENTRYPOINT = IEntrypoint(address(_pool.ENTRYPOINT()));
    TAX_BPS = _taxBPS;
    BURN_SHARE_BPS = _burnShareBPS;
    COURIER_SHARE_BPS = _courierShareBPS;
    COURIER_POOL = _courierPool;
    TREASURY = _treasury;
    SEMAPHORE = _semaphore;
  }

  function taxOn(uint256 _base) public view returns (uint256) {
    return (_base * TAX_BPS) / 10_000;
  }

  /// @notice Pay from a zipped note. The note must spend exactly base + tax + courier fee.
  function payAnon(IPrivacyPool.Withdrawal calldata _withdrawal, ProofLib.WithdrawProof calldata _proof) external {
    Payment memory _p = abi.decode(_withdrawal.data, (Payment));
    _check(_p);
    (, uint256 _net) = _spend(_withdrawal, _proof, _p.courier);
    uint256 _tax = taxOn(_p.base);
    if (_net != _p.base + _tax) revert WrongTotal();
    _settle(_p, _tax);
    emit Paid(
      _p.merchantId, _p.orderId, address(0), _nullifierHash(_proof), _p.base, _tax, _p.courier.fee, _p.identityCommitment, _p.receipt
    );
  }

  /// @notice Pay from a wallet (public payer, same tax)
  function pay(
    uint256 _merchantId,
    uint256 _base,
    bytes32 _orderId,
    uint256 _payeePrecommitment,
    uint256 _identityCommitment,
    bytes calldata _receipt
  ) external {
    Payment memory _p =
      Payment(_merchantId, _base, _orderId, _payeePrecommitment, _identityCommitment, _receipt, Courier(address(0), 0));
    _check(_p);
    uint256 _tax = taxOn(_base);
    ZC.safeTransferFrom(msg.sender, address(this), _base + _tax);
    _settle(_p, _tax);
    emit Paid(_merchantId, _orderId, msg.sender, 0, _base, _tax, 0, _identityCommitment, _receipt);
  }

  function _check(Payment memory _p) internal view {
    if (!MERCHANTS.isListed(_p.merchantId)) revert NotListed();
    if (_p.receipt.length > MAX_RECEIPT_BYTES) revert TooLong();
  }

  function _settle(Payment memory _p, uint256 _tax) internal {
    if (_p.payeePrecommitment != 0) {
      ZC.forceApprove(address(ENTRYPOINT), _p.base);
      ENTRYPOINT.deposit(ZC, _p.base, _p.payeePrecommitment);
    } else {
      ZC.safeTransfer(MERCHANTS.payoutOf(_p.merchantId), _p.base);
    }

    uint256 _burned = (_tax * BURN_SHARE_BPS) / 10_000;
    uint256 _toCouriers = (_tax * COURIER_SHARE_BPS) / 10_000;
    uint256 _toTreasury = _tax - _burned - _toCouriers;
    if (_burned != 0) ZC.safeTransfer(BURN, _burned);
    if (_toCouriers != 0) ZC.safeTransfer(COURIER_POOL, _toCouriers);
    if (_toTreasury != 0) ZC.safeTransfer(TREASURY, _toTreasury);
    emit TaxSplit(_burned, _toCouriers, _toTreasury);

    if (_p.identityCommitment != 0) _joinPayers(_p.merchantId, _p.identityCommitment);
  }

  /// @dev Repeat customers are already members; a repeat join is skipped rather than reverting the payment
  function _joinPayers(uint256 _merchantId, uint256 _identityCommitment) internal {
    uint256 _group;
    if (hasPayerGroup[_merchantId]) {
      _group = payerGroup[_merchantId];
      if (ISemaphoreGroups(address(SEMAPHORE)).hasMember(_group, _identityCommitment)) return;
    } else {
      _group = SEMAPHORE.createGroup(address(this));
      payerGroup[_merchantId] = _group;
      hasPayerGroup[_merchantId] = true;
      emit PayerGroupCreated(_merchantId, _group);
    }
    SEMAPHORE.addMember(_group, _identityCommitment);
  }
}
