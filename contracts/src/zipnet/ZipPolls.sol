// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20, SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';
import {ISemaphore} from '@semaphore-protocol/contracts/interfaces/ISemaphore.sol';

import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {SemaphoreNullifiers} from './SemaphoreNullifiers.sol';
import {ZipEscrowHarvest} from './ZcHarvestToTreasury.sol';
import {ZipProcessooor} from './ZipProcessooor.sol';

/**
 * @title ZipPolls
 * @notice Pay zipcoins to ask a group a question, in public, with answers everyone can count (Snowmoon ch. 27: "The more
 *         zipcoins you burn, the more people it polls"; the point is common knowledge of the result).
 *
 * The creator burns `burn` (the priority signal) and escrows `rewardPerVote × maxVotes` (the breadth: how many members
 * get paid to answer). Each member of the group votes once per poll with a Semaphore proof whose message binds the
 * option and the address paid for answering, so couriers can submit votes without being able to redirect rewards.
 * Unused escrow is burned at close rather than refunded, so an anonymous creator stays anonymous.
 * A vote with `rewardTo = address(0)` takes no reward: nothing names an address next to the answer, and the reward it
 * would have had is burned at once (A-4).
 * @dev `groupId` is any Semaphore group: a badge tier, a merchant's payers. No owner.
 */
contract ZipPolls is ZipEscrowHarvest, SemaphoreNullifiers {
  using SafeERC20 for IERC20;

  struct Poll {
    uint256 groupId;
    uint64 endsAt;
    uint8 optionCount;
    bool closed;
    uint256 rewardPerVote;
    uint256 maxVotes;
    uint256 votes;
    string question;
  }

  struct Creation {
    uint256 groupId;
    string question;
    uint8 optionCount;
    uint64 duration;
    uint256 burn;
    uint256 rewardPerVote;
    uint256 maxVotes;
    Courier courier;
  }

  uint256 public constant MAX_QUESTION_BYTES = 1024;
  uint8 public constant MAX_OPTIONS = 16;

  ISemaphore public immutable SEMAPHORE;

  uint256 public pollCount;
  mapping(uint256 => Poll) public polls;
  mapping(uint256 pollId => mapping(uint8 option => uint256)) public tally;

  event PollCreated(
    uint256 indexed pollId,
    uint256 indexed groupId,
    address indexed creator,
    uint256 burned,
    uint256 rewardPerVote,
    uint256 maxVotes,
    uint64 endsAt,
    uint8 optionCount,
    string question
  );
  event Voted(uint256 indexed pollId, uint8 option, uint256 nullifier, address rewardTo, uint256 reward);
  event PollClosed(uint256 indexed pollId, uint256 votes, uint256 burnedEscrow);

  error BadPoll();
  error WrongTotal();
  error BadOption();
  error BadScope();
  error BadMessage();
  error Ended();
  error NotEnded();

  constructor(IPrivacyPool _pool, ISemaphore _semaphore) ZipProcessooor(_pool) {
    SEMAPHORE = _semaphore;
  }

  function scopeOf(uint256 _pollId) public view returns (uint256) {
    return uint256(keccak256(abi.encode('zipnet.poll', address(this), block.chainid, _pollId)));
  }

  function messageOf(uint8 _option, address _rewardTo) public pure returns (uint256) {
    return uint256(keccak256(abi.encode(_option, _rewardTo)));
  }

  /// @notice Ask anonymously, paying from a zipped note (value = burn + escrow + courier fee)
  function createAnon(IPrivacyPool.Withdrawal calldata _withdrawal, ProofLib.WithdrawProof calldata _proof)
    external
    returns (uint256)
  {
    Creation memory _c = abi.decode(_withdrawal.data, (Creation));
    (, uint256 _net) = _spend(_withdrawal, _proof, _c.courier);
    if (_net != _c.burn + _c.rewardPerVote * _c.maxVotes) revert WrongTotal();
    return _create(address(0), _c);
  }

  function create(
    uint256 _groupId,
    string calldata _question,
    uint8 _optionCount,
    uint64 _duration,
    uint256 _burn,
    uint256 _rewardPerVote,
    uint256 _maxVotes
  ) external returns (uint256) {
    ZC.safeTransferFrom(msg.sender, address(this), _burn + _rewardPerVote * _maxVotes);
    return _create(
      msg.sender,
      Creation(_groupId, _question, _optionCount, _duration, _burn, _rewardPerVote, _maxVotes, Courier(address(0), 0))
    );
  }

  function vote(uint256 _pollId, uint8 _option, address _rewardTo, ISemaphore.SemaphoreProof calldata _proof) external {
    Poll storage _p = polls[_pollId];
    if (_p.endsAt == 0) revert BadPoll();
    if (block.timestamp >= _p.endsAt) revert Ended();
    if (_option >= _p.optionCount) revert BadOption();
    if (_proof.scope != scopeOf(_pollId)) revert BadScope();
    if (_proof.message != messageOf(_option, _rewardTo)) revert BadMessage();

    _consumeProof(SEMAPHORE, _p.groupId, _proof);
    tally[_pollId][_option] += 1;
    uint256 _reward;
    if (_p.votes < _p.maxVotes) {
      _reward = _p.rewardPerVote;
      if (_reward != 0) ZC.safeTransfer(_rewardTo == address(0) ? BURN : _rewardTo, _reward);
      if (_rewardTo == address(0)) _reward = 0;
    }
    _p.votes += 1;
    emit Voted(_pollId, _option, _proof.nullifier, _rewardTo, _reward);
  }

  function close(uint256 _pollId) external {
    Poll storage _p = polls[_pollId];
    if (_p.endsAt == 0 || _p.closed) revert BadPoll();
    if (block.timestamp < _p.endsAt) revert NotEnded();
    _p.closed = true;
    uint256 _paid = _p.votes < _p.maxVotes ? _p.votes : _p.maxVotes;
    uint256 _left = (_p.maxVotes - _paid) * _p.rewardPerVote;
    if (_left != 0) ZC.safeTransfer(BURN, _left);
    emit PollClosed(_pollId, _p.votes, _left);
  }

  function _create(address _creator, Creation memory _c) internal returns (uint256 _id) {
    if (
      _c.optionCount < 2 || _c.optionCount > MAX_OPTIONS || _c.duration == 0
        || bytes(_c.question).length > MAX_QUESTION_BYTES
    ) revert BadPoll();
    if (_c.burn != 0) ZC.safeTransfer(BURN, _c.burn);
    _id = ++pollCount;
    uint64 _endsAt = uint64(block.timestamp) + _c.duration;
    polls[_id] = Poll(_c.groupId, _endsAt, _c.optionCount, false, _c.rewardPerVote, _c.maxVotes, 0, _c.question);
    emit PollCreated(
      _id, _c.groupId, _creator, _c.burn, _c.rewardPerVote, _c.maxVotes, _endsAt, _c.optionCount, _c.question
    );
  }
}
