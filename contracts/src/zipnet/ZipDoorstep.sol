// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20, SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';

import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {ZipProcessooor} from './ZipProcessooor.sol';

/**
 * @title ZipDoorstep
 * @notice Burn zipcoins at someone's door (Snowmoon ch. 20: "50 zipcoins have just been burned 🔥" on the watch of
 *         whoever is inside). Optionally leave a gift. Couriers watch `Knocked` and notify the door's owner.
 * @dev The gift can never dwarf the burn (burn >= 10% of gift), so a knock stays a costly signal rather than a
 *      disguised transfer. No owner.
 */
contract ZipDoorstep is ZipProcessooor {
  using SafeERC20 for IERC20;

  struct Knock {
    address door;
    uint256 gift;
    string message;
    Courier courier;
  }

  uint256 public constant MAX_MESSAGE_BYTES = 280;
  uint256 public constant MIN_BURN_OF_GIFT_BPS = 1000;

  uint256 public immutable MIN_BURN;

  event Knocked(
    address indexed door, address indexed knocker, uint256 nullifierHash, uint256 burned, uint256 gift, uint256 fee, string message
  );

  error NoDoor();
  error TooLong();
  error BurnTooSmall();

  constructor(IPrivacyPool _pool, uint256 _minBurn) ZipProcessooor(_pool) {
    MIN_BURN = _minBurn;
  }

  /// @notice Knock from a zipped note: the door learns that someone serious burned, not who
  function knockAnon(IPrivacyPool.Withdrawal calldata _withdrawal, ProofLib.WithdrawProof calldata _proof) external {
    Knock memory _k = abi.decode(_withdrawal.data, (Knock));
    _validate(_k.door, _k.message);
    (, uint256 _net) = _spend(_withdrawal, _proof, _k.courier);
    if (_net < _k.gift) revert BurnTooSmall();
    uint256 _burned = _net - _k.gift;
    _checkBurn(_burned, _k.gift);

    ZC.safeTransfer(BURN, _burned);
    if (_k.gift != 0) ZC.safeTransfer(_k.door, _k.gift);
    emit Knocked(_k.door, address(0), _nullifierHash(_proof), _burned, _k.gift, _k.courier.fee, _k.message);
  }

  /// @notice Knock from your wallet
  function knock(address _door, uint256 _burn, uint256 _gift, string calldata _message) external {
    _validate(_door, _message);
    _checkBurn(_burn, _gift);
    ZC.safeTransferFrom(msg.sender, BURN, _burn);
    if (_gift != 0) ZC.safeTransferFrom(msg.sender, _door, _gift);
    emit Knocked(_door, msg.sender, 0, _burn, _gift, 0, _message);
  }

  function _validate(address _door, string memory _message) internal pure {
    if (_door == address(0)) revert NoDoor();
    if (bytes(_message).length > MAX_MESSAGE_BYTES) revert TooLong();
  }

  function _checkBurn(uint256 _burn, uint256 _gift) internal view {
    if (_burn < MIN_BURN || _burn * 10_000 < _gift * MIN_BURN_OF_GIFT_BPS) revert BurnTooSmall();
  }
}
