// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20, SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {EIP712} from '@oz/utils/cryptography/EIP712.sol';
import {SignatureChecker} from '@oz/utils/cryptography/SignatureChecker.sol';

import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

/**
 * @title ZipCouriers
 * @notice The courier network: staked nodes that sit between users and the chain, relaying proofs, holding them for a
 *         random delay, adding cover traffic and serving pool state. The decentralized layer "in the middle between
 *         users and a chain, that is not itself a chain" from *The cryptographic world computer*, and the paid
 *         rebroadcasters of Snowmoon ch. 15.
 *
 * - Staking: couriers bond ZC and publish an endpoint. Leaving takes UNBOND_DELAY so misbehaviour can still be reported.
 * - Rewards: the courier share of ZipPay sales tax is sent here; `sync` spreads whatever arrived over the stake.
 * - Accountability: a courier that accepts a job signs a Receipt promising to submit a proof before `deadline`. If the
 *   deadline passes, the note is still unspent and the proof would still have been valid (same ASP root, state root
 *   still in the pool's history), anyone holding the receipt can slash SLASH_BPS of the stake: half to the reporter,
 *   half burned. Couriers simulate a proof before signing, so a user cannot trap one with a bad proof.
 * @dev Receipts carry only the note's nullifier hash and roots, never who asked. No owner.
 */
contract ZipCouriers is EIP712 {
  using SafeERC20 for IERC20;

  struct Courier {
    uint256 stake;
    uint64 unbondAt;
    string endpoint;
  }

  struct Receipt {
    address courier;
    uint256 nullifierHash;
    uint256 aspRoot;
    uint256 stateRoot;
    uint64 deadline;
  }

  bytes32 public constant RECEIPT_TYPEHASH =
    keccak256('Receipt(address courier,uint256 nullifierHash,uint256 aspRoot,uint256 stateRoot,uint64 deadline)');
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
  /// @dev Stake of unbonding couriers still sits here; tracked so it is never mistaken for new rewards
  uint256 private _unbondingStake;

  event Bonded(address indexed courier, uint256 stake, string endpoint);
  event EndpointSet(address indexed courier, string endpoint);
  event UnbondRequested(address indexed courier, uint64 unbondAt);
  event Unbonded(address indexed courier, uint256 stake);
  event RewardsSynced(uint256 amount, uint256 accRewardPerStake);
  event Claimed(address indexed courier, uint256 amount);
  event Slashed(address indexed courier, address indexed reporter, uint256 nullifierHash, uint256 amount);

  error StakeTooSmall();
  error Unbonding();
  error NotBonded();
  error TooEarly();
  error NotSlashable();
  error BadSignature();
  error AlreadyReported();

  constructor(IPrivacyPool _pool, uint256 _minStake) EIP712('zipnet couriers', '1') {
    POOL = _pool;
    ZC = IERC20(_pool.ASSET());
    ENTRYPOINT = IEntrypoint(address(_pool.ENTRYPOINT()));
    MIN_STAKE = _minStake;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // staking
  // ---------------------------------------------------------------------------------------------------------------

  /// @notice Join, or add stake and update the endpoint
  function bond(uint256 _amount, string calldata _endpoint) external {
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

  /// @notice Books any ZC that arrived since the last sync (e.g. the courier share of sales tax) as rewards
  function sync() public {
    if (totalStaked == 0) return;
    uint256 _held = ZC.balanceOf(address(this));
    uint256 _bonded = _bondedIncludingUnbonding();
    uint256 _new = _held - _bonded - rewardReserve;
    if (_new == 0) return;
    rewardReserve += _new;
    accRewardPerStake += (_new * ACC) / totalStaked;
    emit RewardsSynced(_new, accRewardPerStake);
  }

  function pending(address _courier) public view returns (uint256) {
    Courier storage _c = couriers[_courier];
    if (_c.unbondAt != 0) return owed[_courier];
    return owed[_courier] + (_c.stake * accRewardPerStake) / ACC - _debt[_courier];
  }

  function claim() external returns (uint256 _amount) {
    sync();
    _settle(msg.sender);
    _amount = owed[msg.sender];
    owed[msg.sender] = 0;
    rewardReserve -= _amount;
    ZC.safeTransfer(msg.sender, _amount);
    emit Claimed(msg.sender, _amount);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // accountability
  // ---------------------------------------------------------------------------------------------------------------

  function receiptDigest(Receipt calldata _r) public view returns (bytes32) {
    return _hashTypedDataV4(
      keccak256(abi.encode(RECEIPT_TYPEHASH, _r.courier, _r.nullifierHash, _r.aspRoot, _r.stateRoot, _r.deadline))
    );
  }

  /// @notice A courier that promised to deliver and did not, while delivery was still possible, loses SLASH_BPS
  function report(Receipt calldata _r, bytes calldata _signature) external {
    bytes32 _digest = receiptDigest(_r);
    if (reported[_digest]) revert AlreadyReported();
    if (!SignatureChecker.isValidSignatureNow(_r.courier, _digest, _signature)) revert BadSignature();
    if (
      block.timestamp <= _r.deadline || POOL.nullifierHashes(_r.nullifierHash)
        || ENTRYPOINT.latestRoot() != _r.aspRoot || !_isKnownStateRoot(_r.stateRoot)
    ) revert NotSlashable();
    reported[_digest] = true;

    Courier storage _c = couriers[_r.courier];
    sync();
    _settle(_r.courier);
    uint256 _amount = (_c.stake * SLASH_BPS) / 10_000;
    _c.stake -= _amount;
    if (_c.unbondAt == 0) totalStaked -= _amount;
    else _unbondingStake -= _amount;
    _rebase(_r.courier);

    uint256 _bounty = _amount / 2;
    ZC.safeTransfer(msg.sender, _bounty);
    ZC.safeTransfer(BURN, _amount - _bounty);
    emit Slashed(_r.courier, msg.sender, _r.nullifierHash, _amount);
  }

  function _isKnownStateRoot(uint256 _root) internal view returns (bool) {
    if (_root == 0) return false;
    for (uint256 _i; _i < 64; ++_i) {
      if (POOL.roots(_i) == _root) return true;
    }
    return false;
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
    owed[_courier] += (_c.stake * accRewardPerStake) / ACC - _debt[_courier];
    _debt[_courier] = (_c.stake * accRewardPerStake) / ACC;
  }

  function _rebase(address _courier) internal {
    _debt[_courier] = (couriers[_courier].stake * accRewardPerStake) / ACC;
  }
}
