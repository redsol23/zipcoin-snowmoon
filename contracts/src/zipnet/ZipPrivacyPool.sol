// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {PrivacyPoolComplex} from 'contracts/implementations/PrivacyPoolComplex.sol';

import {IZcRewards} from './ZcRewardsHarvester.sol';

/**
 * @title ZipPrivacyPool
 * @notice The upstream 0xbow PrivacyPoolComplex, unchanged, plus a way to collect the ETH that the ZC token pays the
 *         pool as a ZC holder. That ETH belongs to no depositor; it goes to TREASURY.
 *
 * REVIEW NOTES. This is the entire difference from upstream:
 *   1. an immutable TREASURY, set in the constructor, with no other constructor changes;
 *   2. `receive()`, which accepts ETH only from the pool's ASSET (the ZC token), from its claim();
 *   3. `harvest()`, which anyone may call. It calls ASSET.claim() and forwards this contract's whole ETH balance to
 *      TREASURY.
 * The pool never holds ETH otherwise: PrivacyPoolComplex is ERC20-only and its `_pull` rejects msg.value. No storage
 * is added (TREASURY is immutable), and no upstream function is overridden. Neither addition reads or writes pool
 * state: the trees, nullifiers, deposits, labels and ZC balances are untouched. ZC's claim() pays ETH and does not
 * move ZC, so every note stays fully backed. Reentrancy has nothing to exploit, because harvest keeps no state and a
 * reentrant harvest only finds nothing to claim.
 */
contract ZipPrivacyPool is PrivacyPoolComplex {
  /// @notice Receives the pool's ETH holder rewards
  address payable public immutable TREASURY;

  event Harvested(uint256 claimed, uint256 forwarded);

  error OnlyAsset();
  error ZeroTreasury();
  error TreasuryTransferFailed();

  constructor(
    address _entrypoint,
    address _withdrawalVerifier,
    address _ragequitVerifier,
    address _asset,
    address payable _treasury
  ) PrivacyPoolComplex(_entrypoint, _withdrawalVerifier, _ragequitVerifier, _asset) {
    if (_treasury == address(0)) revert ZeroTreasury();
    TREASURY = _treasury;
  }

  /// @notice ETH arrives only from the ZC token's claim()
  receive() external payable {
    if (msg.sender != ASSET) revert OnlyAsset();
  }

  /**
   * @notice Claims the pool's ETH rewards from ZC and sends them to TREASURY. Anyone may call it.
   * @dev Reverts with ZC's NothingToClaim() when there is nothing to claim.
   */
  function harvest() external returns (uint256 _claimed) {
    _claimed = IZcRewards(ASSET).claim();
    uint256 _amount = address(this).balance;
    (bool _ok,) = TREASURY.call{value: _amount}('');
    if (!_ok) revert TreasuryTransferFailed();
    emit Harvested(_claimed, _amount);
  }
}
