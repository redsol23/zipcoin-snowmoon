// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IZcRewards} from './ZcRewardsHarvester.sol';
import {ZipProcessooor} from './ZipProcessooor.sol';

/// @notice The treasury ZipPrivacyPool forwards its own harvest to
interface ITreasuryPool {
  function TREASURY() external view returns (address payable);
}

/**
 * @title ZcHarvestToTreasury
 * @notice For contracts that escrow ZC with no natural owner for its ETH yield (poll escrow). The ZC token pays ETH
 *         to every holder, these contracts included, and only the holder can claim it; without this the ETH would be
 *         stranded while still diluting every other holder (M-7). `harvest()` claims it and forwards all of it to the treasury, exactly as ZipPrivacyPool does
 *         for the pool's own balance.
 * @dev Holds no state: a reentrant harvest only finds nothing to claim. ETH is accepted only from the ZC token.
 */
abstract contract ZcHarvestToTreasury {
  event Harvested(uint256 claimed, uint256 forwarded);

  error OnlyZc();
  error TreasuryTransferFailed();

  /// @dev The ZC token (the only sender of ETH)
  function _harvestToken() internal view virtual returns (address);

  /// @dev Where harvested ETH goes
  function _harvestTreasury() internal view virtual returns (address payable);

  /// @notice ETH arrives only from the ZC token's claim()
  receive() external payable {
    if (msg.sender != _harvestToken()) revert OnlyZc();
  }

  /**
   * @notice Claims this contract's ETH rewards from ZC and sends them to the treasury. Anyone may call it.
   * @dev Reverts with ZC's NothingToClaim() when there is nothing to claim.
   */
  function harvest() external returns (uint256 _claimed) {
    _claimed = IZcRewards(_harvestToken()).claim();
    uint256 _amount = address(this).balance;
    (bool _ok,) = _harvestTreasury().call{value: _amount}('');
    if (!_ok) revert TreasuryTransferFailed();
    emit Harvested(_claimed, _amount);
  }
}

/**
 * @title ZipEscrowHarvest
 * @notice A note-spending contract that escrows ZC: its ETH yield goes to the same TREASURY as the privacy pool's
 *         (read from the pool, so no extra constructor argument or deploy wiring).
 */
abstract contract ZipEscrowHarvest is ZipProcessooor, ZcHarvestToTreasury {
  function _harvestToken() internal view override returns (address) {
    return address(ZC);
  }

  function _harvestTreasury() internal view override returns (address payable) {
    return ITreasuryPool(address(POOL)).TREASURY();
  }
}
