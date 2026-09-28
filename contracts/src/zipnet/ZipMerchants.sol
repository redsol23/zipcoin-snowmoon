// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20, SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {EIP712} from '@oz/utils/cryptography/EIP712.sol';
import {SignatureChecker} from '@oz/utils/cryptography/SignatureChecker.sol';

/**
 * @title ZipMerchants
 * @notice Merchants who take zipcoin with sales tax, and the random inspection that keeps them honest.
 *
 * Snowmoon ch. 6: tax is "enforced not by auditing spreadsheets, but by random inspection - people coming to order,
 * and verifying that a tax-paying transaction type was used any time that the restaurant requested payment."
 *
 * Merchants stake ZC to be listed and sign every invoice (EIP-712). An invoice names its route: TAXED means "pay
 * through ZipPay", anything else is the merchant asking to be paid around the tax. Anyone can play customer, and a
 * signed untaxed invoice is all the evidence needed: the stake is slashed, half to the inspector, half burned, and the
 * merchant is delisted. Leaving takes an exit delay so a merchant cannot outrun a report.
 * @dev No owner.
 */
contract ZipMerchants is EIP712 {
  using SafeERC20 for IERC20;

  enum Route {
    TAXED,
    UNTAXED
  }

  struct Merchant {
    address signer;
    address payout;
    uint256 stake;
    uint64 exitAt;
    bool slashed;
    string metadataURI;
  }

  struct Invoice {
    uint256 merchantId;
    uint256 amount;
    bytes32 orderId;
    Route route;
    uint64 expiry;
  }

  bytes32 public constant INVOICE_TYPEHASH =
    keccak256('Invoice(uint256 merchantId,uint256 amount,bytes32 orderId,uint8 route,uint64 expiry)');
  address public constant BURN = 0x000000000000000000000000000000000000dEaD;
  uint64 public constant EXIT_DELAY = 14 days;

  IERC20 public immutable ZC;
  uint256 public immutable MIN_STAKE;

  uint256 public merchantCount;
  mapping(uint256 => Merchant) public merchants;

  event Registered(uint256 indexed merchantId, address indexed signer, address payout, uint256 stake, string metadataURI);
  event Updated(uint256 indexed merchantId, address payout, string metadataURI);
  event ExitRequested(uint256 indexed merchantId, uint64 exitAt);
  event Exited(uint256 indexed merchantId, uint256 stake);
  event Slashed(uint256 indexed merchantId, address indexed inspector, bytes32 orderId, uint256 bounty, uint256 burned);

  error StakeTooSmall();
  error NotMerchant();
  error NotListed();
  error ExitPending();
  error TooEarly();
  error NotEvidence();
  error BadSignature();

  constructor(IERC20 _zc, uint256 _minStake) EIP712('zipnet merchants', '1') {
    ZC = _zc;
    MIN_STAKE = _minStake;
  }

  function register(address _payout, uint256 _stake, string calldata _metadataURI) external returns (uint256 _id) {
    if (_stake < MIN_STAKE) revert StakeTooSmall();
    ZC.safeTransferFrom(msg.sender, address(this), _stake);
    _id = ++merchantCount;
    merchants[_id] = Merchant(msg.sender, _payout, _stake, 0, false, _metadataURI);
    emit Registered(_id, msg.sender, _payout, _stake, _metadataURI);
  }

  function update(uint256 _id, address _payout, string calldata _metadataURI) external {
    Merchant storage _m = _own(_id);
    _m.payout = _payout;
    _m.metadataURI = _metadataURI;
    emit Updated(_id, _payout, _metadataURI);
  }

  function requestExit(uint256 _id) external {
    Merchant storage _m = _own(_id);
    if (_m.exitAt != 0) revert ExitPending();
    _m.exitAt = uint64(block.timestamp) + EXIT_DELAY;
    emit ExitRequested(_id, _m.exitAt);
  }

  function exit(uint256 _id) external {
    Merchant storage _m = _own(_id);
    if (_m.exitAt == 0 || block.timestamp < _m.exitAt) revert TooEarly();
    uint256 _stake = _m.stake;
    _m.stake = 0;
    ZC.safeTransfer(_m.signer, _stake);
    emit Exited(_id, _stake);
  }

  /// @notice Inspection: a signed invoice asking to be paid around the tax slashes the merchant
  function report(Invoice calldata _invoice, bytes calldata _signature) external {
    if (_invoice.route == Route.TAXED) revert NotEvidence();
    Merchant storage _m = merchants[_invoice.merchantId];
    if (_m.stake == 0 || _m.slashed) revert NotListed();
    if (!SignatureChecker.isValidSignatureNow(_m.signer, invoiceDigest(_invoice), _signature)) revert BadSignature();

    uint256 _stake = _m.stake;
    _m.stake = 0;
    _m.slashed = true;
    uint256 _bounty = _stake / 2;
    ZC.safeTransfer(msg.sender, _bounty);
    ZC.safeTransfer(BURN, _stake - _bounty);
    emit Slashed(_invoice.merchantId, msg.sender, _invoice.orderId, _bounty, _stake - _bounty);
  }

  /// @notice Listed merchants can be paid through ZipPay
  function isListed(uint256 _id) public view returns (bool) {
    Merchant storage _m = merchants[_id];
    return _m.stake != 0 && !_m.slashed && _m.exitAt == 0;
  }

  function payoutOf(uint256 _id) external view returns (address) {
    if (!isListed(_id)) revert NotListed();
    return merchants[_id].payout;
  }

  function invoiceDigest(Invoice calldata _i) public view returns (bytes32) {
    return _hashTypedDataV4(
      keccak256(abi.encode(INVOICE_TYPEHASH, _i.merchantId, _i.amount, _i.orderId, uint8(_i.route), _i.expiry))
    );
  }

  function _own(uint256 _id) internal view returns (Merchant storage _m) {
    _m = merchants[_id];
    if (_m.signer != msg.sender) revert NotMerchant();
    if (_m.slashed) revert NotListed();
  }
}
