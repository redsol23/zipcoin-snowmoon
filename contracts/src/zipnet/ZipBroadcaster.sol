// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20, SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';

import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {ZipProcessooor} from './ZipProcessooor.sol';

/**
 * @title ZipBroadcaster
 * @notice Burn zipcoins to be heard (Snowmoon ch. 19: "An anonymous person burned four hundred zipcoins to send this
 *         message"). The burn is the signal: readers and their AI filters rank and admit messages by it.
 * @dev A message can be aimed at a group (`groupId`, see ZipGroups: badge tiers, a merchant's past payers, poll
 *      respondents) and carry an off-chain payload (`payload`, e.g. an IPFS CID of an encrypted bundle) when 280 bytes
 *      are not enough. `groupId == 0` is the public feed. No owner.
 */
contract ZipBroadcaster is ZipProcessooor {
  using SafeERC20 for IERC20;

  struct Speech {
    bytes32 topic;
    uint256 groupId;
    string message;
    string target;
    string payload;
    Courier courier;
  }

  uint256 public constant MAX_MESSAGE_BYTES = 280;
  uint256 public constant MAX_TARGET_BYTES = 120;
  uint256 public constant MAX_PAYLOAD_BYTES = 128;

  uint256 public immutable MIN_BURN;

  /**
   * @param speaker The burning wallet, or address(0) when spoken from a zipped note
   * @param nullifierHash The spent note's nullifier for anonymous speech, 0 otherwise
   */
  event Spoken(
    address indexed speaker,
    bytes32 indexed topic,
    uint256 indexed groupId,
    uint256 nullifierHash,
    uint256 burned,
    uint256 fee,
    string message,
    string target,
    string payload
  );

  error EmptyMessage();
  error TooLong();
  error BurnTooSmall();

  constructor(IPrivacyPool _pool, uint256 _minBurn) ZipProcessooor(_pool) {
    MIN_BURN = _minBurn;
  }

  /// @notice Burn from a zipped note and speak without revealing who you are
  function speakAnon(IPrivacyPool.Withdrawal calldata _withdrawal, ProofLib.WithdrawProof calldata _proof) external {
    Speech memory _s = abi.decode(_withdrawal.data, (Speech));
    _validate(_s);
    (, uint256 _burned) = _spend(_withdrawal, _proof, _s.courier);
    if (_burned < MIN_BURN) revert BurnTooSmall();
    ZC.safeTransfer(BURN, _burned);
    emit Spoken(
      address(0), _s.topic, _s.groupId, _nullifierHash(_proof), _burned, _s.courier.fee, _s.message, _s.target, _s.payload
    );
  }

  /// @notice Burn from your wallet and speak publicly
  function speak(
    uint256 _amount,
    bytes32 _topic,
    uint256 _groupId,
    string calldata _message,
    string calldata _target,
    string calldata _payload
  ) external {
    _validate(Speech(_topic, _groupId, _message, _target, _payload, Courier(address(0), 0)));
    if (_amount < MIN_BURN) revert BurnTooSmall();
    ZC.safeTransferFrom(msg.sender, BURN, _amount);
    emit Spoken(msg.sender, _topic, _groupId, 0, _amount, 0, _message, _target, _payload);
  }

  function _validate(Speech memory _s) internal pure {
    if (bytes(_s.message).length == 0) revert EmptyMessage();
    if (
      bytes(_s.message).length > MAX_MESSAGE_BYTES || bytes(_s.target).length > MAX_TARGET_BYTES
        || bytes(_s.payload).length > MAX_PAYLOAD_BYTES
    ) revert TooLong();
  }
}
