// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {ZcHarvestToTreasury} from 'zipnet/ZcHarvestToTreasury.sol';
import {ZipPolls} from 'zipnet/ZipPolls.sol';

import {MockZC, ZipnetBase} from './ZipnetBase.sol';

/**
 * @notice M-7: ZC pays ETH to every holder, escrow contracts included, and only the holder can claim it. Before the fix
 *         the poll escrow had no claim path (and no receive), so its share was stranded forever. It has no owner for
 *         the yield, so it harvests it to the treasury.
 */
contract EscrowHarvestTest is ZipnetBase {
  address internal user = makeAddr('user');

  function _fund(address _to, uint256 _amount) internal {
    zc.mint(user, _amount);
    vm.prank(user);
    zc.approve(_to, _amount);
  }

  /// @dev Pays 1 ETH of rewards over every eligible holder and returns what `_holder` earned
  function _rewards(address _holder) internal returns (uint256 _earned) {
    vm.deal(address(this), 1 ether);
    zc.distributeRewards{value: 1 ether}();
    _earned = zc.pendingReward(_holder);
    assertGt(_earned, 0, 'the escrow earned ETH');
  }

  function _harvestsToTreasury(ZcHarvestToTreasury _c, address _treasury) internal {
    uint256 _earned = _rewards(address(_c));
    uint256 _before = _treasury.balance;
    vm.prank(makeAddr('anyone'));
    _c.harvest();
    assertEq(_treasury.balance - _before, _earned);
    assertEq(address(_c).balance, 0);
    vm.expectRevert(MockZC.NothingToClaim.selector);
    _c.harvest();
  }

  function test_m7_pollsHarvestToTreasury() public {
    ZipPolls _p = new ZipPolls(IPrivacyPool(address(pool)), semaphore);
    _fund(address(_p), 10 ether);
    vm.prank(user);
    _p.create(1, 'q', 2, 1 days, 0, 1 ether, 10);
    _harvestsToTreasury(_p, poolTreasury);
  }

  function test_m7_ethOnlyFromZc() public {
    ZipPolls _p = new ZipPolls(IPrivacyPool(address(pool)), semaphore);
    vm.deal(address(this), 1 ether);
    (bool _ok,) = address(_p).call{value: 1 ether}('');
    assertFalse(_ok);
  }
}
