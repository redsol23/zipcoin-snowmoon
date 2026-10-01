// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20, SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {EIP712} from '@oz/utils/cryptography/EIP712.sol';
import {SigningKeys} from './SigningKeys.sol';
import {ZcRewardsHarvester} from './ZcRewardsHarvester.sol';

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
 * merchant is delisted. Leaving takes an exit delay so a merchant cannot outrun a report. Reports are commit-reveal
 * (`commitReport`, then `report` a block later) so a report copied from the mempool doesn't pay the copier.
 *
 * Invoices are plain ECDSA signatures (never ERC-1271), so neither a contract signer nor an EOA with an EIP-7702
 * delegation can switch its past invoices off (H-2). A merchant whose stake is held by a Safe signs with a separate EOA
 * signing key (`registerWithKey`), rotated with `rotateSigningKey`: the old key stays valid for evidence for EXIT_DELAY
 * after the new one is in force (see SigningKeys).
 *
 * ETH rewards: staked ZC earns ZC's ETH holder rewards, which go to the merchants pro rata by stake over time
 * (ZcRewardsHarvester), per signer across all of a signer's listings. Stake earns from `register` until `exit`, or
 * until a slash, which stops it at once.
 * @dev No owner.
 */
contract ZipMerchants is EIP712, ZcRewardsHarvester {
  using SafeERC20 for IERC20;
  using SigningKeys for SigningKeys.Keys;

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
  /// @notice report commitment => block it was committed in (see `commitReport`)
  mapping(bytes32 => uint256) public reportCommittedAt;
  /// @dev merchant id => the EOA key its invoices are signed with (0 = the signer address itself)
  mapping(uint256 => SigningKeys.Keys) private _keys;

  event Registered(
    uint256 indexed merchantId, address indexed signer, address payout, uint256 stake, string metadataURI
  );
  event Updated(uint256 indexed merchantId, address payout, string metadataURI);
  event ExitRequested(uint256 indexed merchantId, uint64 exitAt);
  event Exited(uint256 indexed merchantId, uint256 stake);
  event Slashed(uint256 indexed merchantId, address indexed inspector, bytes32 orderId, uint256 bounty, uint256 burned);
  event ReportCommitted(bytes32 indexed commitment, address indexed inspector);
  event SigningKeyRotated(uint256 indexed merchantId, address indexed key, uint64 inForceAt);

  error StakeTooSmall();
  error NotMerchant();
  error NotListed();
  error ExitPending();
  error TooEarly();
  error NotEvidence();
  error BadSignature();
  error NotCommitted();
  error SelfReport();

  constructor(IERC20 _zc, uint256 _minStake) EIP712('zipnet merchants', '1') ZcRewardsHarvester(address(_zc)) {
    ZC = _zc;
    MIN_STAKE = _minStake;
  }

  /// @dev No treasury here, and without listed merchants this contract holds no stake (only donations), so ETH earned
  ///      while nobody is earning is booked to the merchants at the first harvest after some exist (R2-L4)
  function _unearnedEthTo() internal pure override returns (address payable) {
    return payable(address(0));
  }

  /// @notice List a merchant whose invoices are signed by `msg.sender` itself (an EOA)
  function register(address _payout, uint256 _stake, string calldata _metadataURI) external returns (uint256 _id) {
    _id = _register(_payout, _stake, _metadataURI);
  }

  /// @notice List a merchant whose invoices are signed by a separate EOA `_signingKey` (e.g. the stake sits in a Safe)
  function registerWithKey(address _payout, uint256 _stake, string calldata _metadataURI, address _signingKey)
    external
    returns (uint256 _id)
  {
    if (_signingKey == address(0)) revert SigningKeys.ZeroKey();
    _id = _register(_payout, _stake, _metadataURI);
    _keys[_id].init(_signingKey);
    emit SigningKeyRotated(_id, _signingKey, uint64(block.timestamp));
  }

  /**
   * @notice Start signing invoices with `_key`. It is accepted at once; the current key stays in force for EXIT_DELAY
   *         and is accepted for evidence for another EXIT_DELAY after that, so rotating can't void a recent invoice.
   */
  function rotateSigningKey(uint256 _id, address _key) external {
    _own(_id);
    emit SigningKeyRotated(_id, _key, _keys[_id].rotate(merchants[_id].signer, EXIT_DELAY, _key));
  }

  /// @notice The keys that sign for a merchant now: in force, pending (also accepted), previous (accepted until)
  function signingKeysOf(uint256 _id)
    external
    view
    returns (address _key, address _pending, address _prev, uint64 _prevUntil)
  {
    return _keys[_id].keysOf(merchants[_id].signer, EXIT_DELAY);
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
    _subEthStake(_m.signer, _stake);
    ZC.safeTransfer(_m.signer, _stake);
    emit Exited(_id, _stake);
  }

  /// @notice The commitment an inspector publishes first: it hides the invoice and binds the bounty to `_inspector`
  function reportCommitment(bytes32 _digest, address _inspector, bytes32 _salt) public pure returns (bytes32) {
    return keccak256(abi.encode(_digest, _inspector, _salt));
  }

  /// @notice Inspection step 1: commit to `reportCommitment(invoiceDigest(invoice), msg.sender, salt)`
  function commitReport(bytes32 _commitment) external {
    if (reportCommittedAt[_commitment] == 0) reportCommittedAt[_commitment] = block.number;
    emit ReportCommitted(_commitment, msg.sender);
  }

  /**
   * @notice Inspection step 2, at least one block after the commitment: a signed invoice asking to be paid around the
   *         tax slashes the merchant. The bounty goes to the committed inspector, so copying this call from the
   *         mempool gains nothing without an older commitment. The merchant can't take the bounty itself (L-1): its
   *         staker address and the key that signed the invoice can't report it.
   * @dev Residual (L-1): a merchant can still pre-commit a self-report from a fresh, unlinked address when it signs
   *      an untaxed invoice, and reveal first once an inspector commits, getting half its stake back. The contract
   *      can't tell a fresh address from an honest inspector. It is bounded: the whole stake is still slashed and the
   *      merchant delisted; the commit event shows neither the merchant nor the invoice, so racing every inspector
   *      means guessing which merchant each commitment is about; and inspectors should reveal through a private relay
   *      in the block right after their commitment.
   */
  function report(Invoice calldata _invoice, bytes calldata _signature, bytes32 _salt) external {
    if (_invoice.route == Route.TAXED) revert NotEvidence();
    uint256 _at = reportCommittedAt[reportCommitment(invoiceDigest(_invoice), msg.sender, _salt)];
    if (_at == 0 || _at >= block.number) revert NotCommitted();
    Merchant storage _m = merchants[_invoice.merchantId];
    if (_m.stake == 0 || _m.slashed) revert NotListed();
    // ECDSA only (H-2): a delegated (EIP-7702) or contract signer must not be able to void its own evidence
    address _by = SigningKeys.recover(invoiceDigest(_invoice), _signature);
    if (!_keys[_invoice.merchantId].accepts(_m.signer, EXIT_DELAY, _by)) revert BadSignature();
    // L-1: the offender can't report itself. Only fixed identities count (the staker and the key that signed this
    // invoice): excluding a field the merchant can still change (payout, a new key) would let it block an inspector
    // by pointing that field at the inspector's address.
    if (msg.sender == _m.signer || msg.sender == _by) revert SelfReport();

    uint256 _stake = _m.stake;
    _m.stake = 0;
    _m.slashed = true;
    _subEthStake(_m.signer, _stake);
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

  function _register(address _payout, uint256 _stake, string calldata _metadataURI) internal returns (uint256 _id) {
    if (_stake < MIN_STAKE) revert StakeTooSmall();
    ZC.safeTransferFrom(msg.sender, address(this), _stake);
    _id = ++merchantCount;
    merchants[_id] = Merchant(msg.sender, _payout, _stake, 0, false, _metadataURI);
    _addEthStake(msg.sender, _stake);
    emit Registered(_id, msg.sender, _payout, _stake, _metadataURI);
  }

  function _own(uint256 _id) internal view returns (Merchant storage _m) {
    _m = merchants[_id];
    if (_m.signer != msg.sender) revert NotMerchant();
    if (_m.slashed) revert NotListed();
  }
}
