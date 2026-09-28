// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20, SafeERC20} from '@oz/token/ERC20/utils/SafeERC20.sol';

import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

/**
 * @title ZipProcessooor
 * @notice Base for every contract that spends a zipped note. The contract is the withdrawal `processooor`; the
 *         action's parameters travel in `withdrawal.data`, which the proof binds through its `context` signal, so a
 *         courier submitting the proof cannot change recipients, amounts, messages or its own fee.
 * @dev Every action pays its courier the same way: an explicit `fee` in ZC to `feeRecipient`, taken out of the
 *      withdrawn value. Holds nothing between calls.
 */
abstract contract ZipProcessooor {
  using SafeERC20 for IERC20;
  using ProofLib for ProofLib.WithdrawProof;

  /// @notice The courier's cut, sealed into the proof with the rest of the action
  struct Courier {
    address feeRecipient;
    uint256 fee;
  }

  address public constant BURN = 0x000000000000000000000000000000000000dEaD;

  IPrivacyPool public immutable POOL;
  IERC20 public immutable ZC;

  error InvalidProcessooor();
  error FeeTooHigh();
  error ValueMismatch();

  constructor(IPrivacyPool _pool) {
    POOL = _pool;
    ZC = IERC20(_pool.ASSET());
  }

  /**
   * @notice Spends a note into this contract and pays the courier
   * @return _value The withdrawn value
   * @return _net What is left for the action after the courier fee
   */
  function _spend(
    IPrivacyPool.Withdrawal calldata _withdrawal,
    ProofLib.WithdrawProof calldata _proof,
    Courier memory _courier
  ) internal returns (uint256 _value, uint256 _net) {
    if (_withdrawal.processooor != address(this)) revert InvalidProcessooor();
    _value = _proof.withdrawnValue();
    if (_courier.fee > _value) revert FeeTooHigh();

    POOL.withdraw(_withdrawal, _proof);

    _net = _value - _courier.fee;
    if (_courier.fee != 0) ZC.safeTransfer(_courier.feeRecipient, _courier.fee);
  }

  function _nullifierHash(ProofLib.WithdrawProof calldata _proof) internal pure returns (uint256) {
    return _proof.existingNullifierHash();
  }
}
