// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20, SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {EIP712} from '@oz/utils/cryptography/EIP712.sol';

import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {SigningKeys} from './SigningKeys.sol';
import {ZcRewardsHarvester} from './ZcRewardsHarvester.sol';

/**
 * @title ZipCouriers
 * @notice The courier network: staked nodes that sit between users and the chain, relaying proofs, holding them for a
 *         random delay, adding cover traffic and serving pool state. The decentralized layer "in the middle between
 *         users and a chain, that is not itself a chain" from *The cryptographic world computer*, and the paid
 *         rebroadcasters of Snowmoon ch. 15.
 *
 * - Staking: couriers bond ZC and publish an endpoint. Leaving takes UNBOND_DELAY so misbehaviour can still be reported.
 * - Rewards: the courier share of ZipPay sales tax is sent here; `sync` spreads whatever arrived over the stake.
 * - Accountability: a courier that accepts a job signs a Receipt promising to deliver that exact job before
 *   `deadline`. The receipt binds the job itself: `jobHash = jobHashOf(target, callData)`, the call the courier would
 *   make (for a relay, `Entrypoint.relay(withdrawal, proof, scope)`; for a processooor, its entry point with the
 *   withdrawal and proof), so the processooor, the withdrawal data, the amount, the scope and the nullifier are all
 *   fixed. After the deadline, anyone holding the receipt and the call can `report`: the report MAKES THE DELIVERY
 *   itself, and slashes SLASH_BPS of the stake (half to the reporter, half burned) only if that delivery succeeds and
 *   spends the receipt's nullifier. So a user who made its own job fail (poisoning a precommitment, ragequitting
 *   the second note of a batch, delisting the merchant it pays) can't slash: a job that can't be delivered now
 *   reverts `NotSlashable`, and one that can is delivered, so the user gets its action either way (H-1).
 *   One nullifier can only be slashed for once: the delivery spends it. Reports are commit-reveal (`commitReport`,
 *   then `report` a block later) and the bounty goes to the committed reporter, so a report copied from the mempool
 *   pays the copier nothing.
 *   Receipts are plain ECDSA signatures (never ERC-1271), so neither a contract nor an EOA with an EIP-7702
 *   delegation can void its own receipts (H-2). A courier whose bond sits in a Safe signs with a separate EOA key
 *   (`bondWithKey`, `rotateSigningKey`); a retired key stays valid for UNBOND_DELAY after its successor is in force.
 * - ETH rewards: bonded ZC earns ZC's ETH holder rewards, which go to the couriers pro rata by bond over time
 *   (ZcRewardsHarvester). Unlike the ZC tax share, ETH follows the ZC itself: a bond earns from `bond` until it leaves
 *   at `unbond` (unbonding stake is still held and still slashable), and a slash stops the slashed part at once.
 * @dev Receipts carry only the note's nullifier hash and the job's hash, never who asked. No owner.
 */
contract ZipCouriers is EIP712, ZcRewardsHarvester {
  using SafeERC20 for IERC20;
  using SigningKeys for SigningKeys.Keys;

  struct Courier {
    uint256 stake;
    uint64 unbondAt;
    string endpoint;
  }

  /// @notice A courier's promise to deliver one job: `jobHash = jobHashOf(target, callData)`, spending `nullifierHash`
  struct Receipt {
    address courier;
    uint256 nullifierHash;
    bytes32 jobHash;
    uint64 deadline;
  }

  bytes32 public constant RECEIPT_TYPEHASH =
    keccak256('Receipt(address courier,uint256 nullifierHash,bytes32 jobHash,uint64 deadline)');
  address public constant BURN = 0x000000000000000000000000000000000000dEaD;
  uint64 public constant UNBOND_DELAY = 14 days;
  uint256 public constant SLASH_BPS = 1000;
  uint256 private constant ACC = 1e36;

  IERC20 public immutable ZC;
  IPrivacyPool public immutable POOL;
  IEntrypoint public immutable ENTRYPOINT;
  uint256 public immutable MIN_STAKE;

  mapping(address => Courier) public couriers;
  uint256 public totalStaked;
  /// @notice Rewards booked but not yet claimed
  uint256 public rewardReserve;
  uint256 public accRewardPerStake;
  mapping(address => uint256) private _debt;
  mapping(address => uint256) public owed;
  mapping(bytes32 => bool) public reported;
  /// @notice report commitment => block it was committed in (see `commitReport`)
  mapping(bytes32 => uint256) public reportCommittedAt;
  /// @dev Stake of unbonding couriers still sits here; tracked so it is never mistaken for new rewards
  uint256 private _unbondingStake;
  /// @dev courier => the EOA key its receipts are signed with (0 = the courier address itself)
  mapping(address => SigningKeys.Keys) private _keys;
  /// @dev Set while a report makes its delivery: no report may run inside another's delivery
  bool private transient _delivering;

  event Bonded(address indexed courier, uint256 stake, string endpoint);
  event EndpointSet(address indexed courier, string endpoint);
  event UnbondRequested(address indexed courier, uint64 unbondAt);
  event Unbonded(address indexed courier, uint256 stake);
  event RewardsSynced(uint256 amount, uint256 accRewardPerStake);
  event Claimed(address indexed courier, uint256 amount);
  event Slashed(address indexed courier, address indexed reporter, uint256 nullifierHash, uint256 amount);
  event UnearnedBurned(uint256 amount);
  event ReportCommitted(bytes32 indexed commitment, address indexed reporter);
  event SigningKeyRotated(address indexed courier, address indexed key, uint64 inForceAt);

  error StakeTooSmall();
  error Unbonding();
  error NotBonded();
  error AlreadyBonded();
  error TooEarly();
  error NotSlashable();
  error BadSignature();
  error AlreadyReported();
  error NotCommitted();
  error SelfReport();
  error WrongJob();

  constructor(IPrivacyPool _pool, uint256 _minStake) EIP712('zipnet couriers', '1') ZcRewardsHarvester(_pool.ASSET()) {
    POOL = _pool;
    ZC = IERC20(_pool.ASSET());
    ENTRYPOINT = IEntrypoint(address(_pool.ENTRYPOINT()));
    MIN_STAKE = _minStake;
  }

  /// @dev ETH earned while no courier is earning (e.g. only unbonding stake) goes to the pool's TREASURY (R2-L4)
  function _unearnedEthTo() internal view override returns (address payable) {
    return _poolTreasury(address(POOL));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // staking
  // ---------------------------------------------------------------------------------------------------------------

  /// @notice Join, or add stake and update the endpoint. Receipts are signed by the courier address (an EOA).
  function bond(uint256 _amount, string calldata _endpoint) external {
    _bond(_amount, _endpoint);
  }

  /// @notice Join with receipts signed by a separate EOA `_signingKey` (e.g. the bond is held by a Safe)
  function bondWithKey(uint256 _amount, string calldata _endpoint, address _signingKey) external {
    if (couriers[msg.sender].stake != 0) revert AlreadyBonded(); // use rotateSigningKey
    if (_signingKey == address(0)) revert SigningKeys.ZeroKey();
    _bond(_amount, _endpoint);
    _keys[msg.sender].init(_signingKey);
    emit SigningKeyRotated(msg.sender, _signingKey, uint64(block.timestamp));
  }

  /**
   * @notice Start signing receipts with `_key`. It is accepted at once; the current key stays in force for
   *         UNBOND_DELAY and is accepted for evidence for another UNBOND_DELAY after that.
   */
  function rotateSigningKey(address _key) external {
    if (couriers[msg.sender].stake == 0) revert NotBonded();
    emit SigningKeyRotated(msg.sender, _key, _keys[msg.sender].rotate(msg.sender, UNBOND_DELAY, _key));
  }

  /// @notice The keys that sign for a courier now: in force, pending (also accepted), previous (accepted until)
  function signingKeysOf(address _courier)
    external
    view
    returns (address _key, address _pending, address _prev, uint64 _prevUntil)
  {
    return _keys[_courier].keysOf(_courier, UNBOND_DELAY);
  }

  function _bond(uint256 _amount, string calldata _endpoint) internal {
    Courier storage _c = couriers[msg.sender];
    if (_c.unbondAt != 0) revert Unbonding();
    if (_c.stake + _amount < MIN_STAKE) revert StakeTooSmall();
    sync();
    _settle(msg.sender);
    ZC.safeTransferFrom(msg.sender, address(this), _amount);
    _c.stake += _amount;
    _c.endpoint = _endpoint;
    totalStaked += _amount;
    _rebase(msg.sender);
    _addEthStake(msg.sender, _amount);
    emit Bonded(msg.sender, _c.stake, _endpoint);
  }

  function setEndpoint(string calldata _endpoint) external {
    if (couriers[msg.sender].stake == 0) revert NotBonded();
    couriers[msg.sender].endpoint = _endpoint;
    emit EndpointSet(msg.sender, _endpoint);
  }

  /// @notice Stop earning now; the stake stays slashable until UNBOND_DELAY has passed
  function requestUnbond() external {
    Courier storage _c = couriers[msg.sender];
    if (_c.stake == 0) revert NotBonded();
    if (_c.unbondAt != 0) revert Unbonding();
    sync();
    _settle(msg.sender);
    totalStaked -= _c.stake;
    _unbondingStake += _c.stake;
    _c.unbondAt = uint64(block.timestamp) + UNBOND_DELAY;
    emit UnbondRequested(msg.sender, _c.unbondAt);
  }

  function unbond() external {
    Courier storage _c = couriers[msg.sender];
    if (_c.unbondAt == 0 || block.timestamp < _c.unbondAt) revert TooEarly();
    uint256 _stake = _c.stake;
    _unbondingStake -= _stake;
    delete couriers[msg.sender];
    // Rewards stopped at requestUnbond and what was earned stays in `owed`; the debt must go with the stake, or the
    // next _settle computes 0 - _debt and every claim and re-bond reverts (M-1)
    delete _debt[msg.sender];
    delete _keys[msg.sender];
    _subEthStake(msg.sender, _stake);
    ZC.safeTransfer(msg.sender, _stake);
    emit Unbonded(msg.sender, _stake);
  }

  function isActive(address _courier) public view returns (bool) {
    Courier storage _c = couriers[_courier];
    return _c.stake >= MIN_STAKE && _c.unbondAt == 0;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // rewards
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * @notice Books any ZC that arrived since the last sync (e.g. the courier share of sales tax) as rewards. ZC that
   *         arrives while nobody is bonded (earning) has nobody to go to and is burned, so the next courier to bond
   *         can't collect it all.
   */
  function sync() public {
    uint256 _held = ZC.balanceOf(address(this));
    uint256 _bonded = _bondedIncludingUnbonding();
    uint256 _new = _held - _bonded - rewardReserve;
    if (_new == 0) return;
    if (totalStaked == 0) {
      ZC.safeTransfer(BURN, _new);
      emit UnearnedBurned(_new);
      return;
    }
    rewardReserve += _new;
    accRewardPerStake += (_new * ACC) / totalStaked;
    emit RewardsSynced(_new, accRewardPerStake);
  }

  function pending(address _courier) public view returns (uint256) {
    Courier storage _c = couriers[_courier];
    if (_c.unbondAt != 0 || _c.stake == 0) return owed[_courier];
    return owed[_courier] + (_c.stake * accRewardPerStake) / ACC - _debt[_courier];
  }

  function claim() external returns (uint256 _amount) {
    sync();
    _settle(msg.sender);
    _amount = owed[msg.sender];
    owed[msg.sender] = 0;
    // per-account flooring can book a few wei more than the reserve holds; never let that revert the last claim
    if (_amount > rewardReserve) _amount = rewardReserve;
    rewardReserve -= _amount;
    ZC.safeTransfer(msg.sender, _amount);
    emit Claimed(msg.sender, _amount);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // accountability
  // ---------------------------------------------------------------------------------------------------------------

  function receiptDigest(Receipt calldata _r) public view returns (bytes32) {
    return
      _hashTypedDataV4(keccak256(abi.encode(RECEIPT_TYPEHASH, _r.courier, _r.nullifierHash, _r.jobHash, _r.deadline)));
  }

  /// @notice The job a receipt promises: the contract the courier calls and the exact calldata
  function jobHashOf(address _target, bytes calldata _callData) public pure returns (bytes32) {
    return keccak256(abi.encode(_target, keccak256(_callData)));
  }

  /// @notice The commitment a reporter publishes first: it hides the receipt and binds the bounty to `_reporter`
  function reportCommitment(bytes32 _digest, address _reporter, bytes32 _salt) public pure returns (bytes32) {
    return keccak256(abi.encode(_digest, _reporter, _salt));
  }

  /// @notice Step 1 of a report: commit to `reportCommitment(receiptDigest(r), msg.sender, salt)`
  function commitReport(bytes32 _commitment) external {
    if (reportCommittedAt[_commitment] == 0) reportCommittedAt[_commitment] = block.number;
    emit ReportCommitted(_commitment, msg.sender);
  }

  /**
   * @notice Step 2, at least one block after the commitment and after the receipt's deadline: deliver the job the
   *         courier promised and did not deliver, and slash the courier SLASH_BPS for it. The delivery is made here,
   *         with `_target` and `_callData` (which must hash to the receipt's `jobHash`); if it reverts, or doesn't
   *         spend the receipt's nullifier, the job wasn't deliverable now and nothing is slashed (`NotSlashable`).
   *         The bounty goes to the committed reporter, so copying this calldata from the mempool gains nothing, and
   *         never to the courier or its receipt key (L-1).
   * @dev Residual (L-1): a courier could pre-commit a report of its own receipt from an unlinked address and reveal
   *      first. It gains little: a report delivers the job (so the courier could just have delivered it), and the
   *      slash still takes SLASH_BPS of which it recovers half at most.
   */
  function report(
    Receipt calldata _r,
    bytes calldata _signature,
    bytes32 _salt,
    address _target,
    bytes calldata _callData
  ) external {
    if (_delivering) revert NotSlashable();
    bytes32 _digest = _checkReceipt(_r, _signature, _salt);
    if (jobHashOf(_target, _callData) != _r.jobHash) revert WrongJob();
    if (block.timestamp <= _r.deadline || POOL.nullifierHashes(_r.nullifierHash)) revert NotSlashable();
    // Never a call that could move this contract's own ZC (it approves nobody), nor one into itself
    if (_target == address(ZC) || _target == address(this) || _target.code.length == 0) revert WrongJob();
    reported[_digest] = true;

    // The delivery (H-1): only a job that can still be delivered now proves the courier could have
    _delivering = true;
    (bool _ok,) = _target.call(_callData);
    _delivering = false;
    if (!_ok || !POOL.nullifierHashes(_r.nullifierHash)) revert NotSlashable();

    _slash(_r.courier, _r.nullifierHash);
  }

  /// @dev A receipt this reporter committed to a block ago, not yet reported, signed by one of the courier's keys
  function _checkReceipt(Receipt calldata _r, bytes calldata _signature, bytes32 _salt)
    internal
    view
    returns (bytes32 _digest)
  {
    _digest = receiptDigest(_r);
    if (reported[_digest]) revert AlreadyReported();
    uint256 _at = reportCommittedAt[reportCommitment(_digest, msg.sender, _salt)];
    if (_at == 0 || _at >= block.number) revert NotCommitted();
    // ECDSA only (H-2): a delegated (EIP-7702) or contract signer must not be able to void its own receipts
    address _by = SigningKeys.recover(_digest, _signature);
    if (!_keys[_r.courier].accepts(_r.courier, UNBOND_DELAY, _by)) revert BadSignature();
    // L-1: the offender can't report itself (the courier, or the key that signed this receipt)
    if (msg.sender == _r.courier || msg.sender == _by) revert SelfReport();
  }

  function _slash(address _courier, uint256 _nullifierHash) internal {
    Courier storage _c = couriers[_courier];
    sync();
    _settle(_courier);
    uint256 _amount = (_c.stake * SLASH_BPS) / 10_000;
    _c.stake -= _amount;
    if (_c.unbondAt == 0) totalStaked -= _amount;
    else _unbondingStake -= _amount;
    _rebase(_courier);
    _subEthStake(_courier, _amount);

    uint256 _bounty = _amount / 2;
    ZC.safeTransfer(msg.sender, _bounty);
    ZC.safeTransfer(BURN, _amount - _bounty);
    emit Slashed(_courier, msg.sender, _nullifierHash, _amount);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------------------------------------------

  function _bondedIncludingUnbonding() internal view returns (uint256) {
    return totalStaked + _unbondingStake;
  }

  function _settle(address _courier) internal {
    Courier storage _c = couriers[_courier];
    if (_c.unbondAt != 0) return;
    if (_c.stake == 0) {
      _debt[_courier] = 0;
      return;
    }
    owed[_courier] += (_c.stake * accRewardPerStake) / ACC - _debt[_courier];
    _debt[_courier] = (_c.stake * accRewardPerStake) / ACC;
  }

  function _rebase(address _courier) internal {
    _debt[_courier] = (couriers[_courier].stake * accRewardPerStake) / ACC;
  }
}
