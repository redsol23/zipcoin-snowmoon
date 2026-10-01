// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from 'forge-std/Test.sol';

import {PoolHandler} from './PoolHandler.sol';

/**
 * @notice INVARIANTS of ZipPrivacyPool under a mixed campaign (see PoolHandler for the actions).
 *
 * Default depth is kept moderate for small machines (runs = 64, depth = 50). Deeper:
 *   FOUNDRY_PROFILE=pooldeep forge test --match-path 'test/zipnet/pool/PoolInvariant.t.sol' --threads 2
 * (the pooldeep profile in foundry.toml: invariant runs = 1000, depth = 200; fuzz runs = 2000).
 *
 * forge-config: default.invariant.runs = 64
 * forge-config: default.invariant.depth = 50
 * forge-config: default.invariant.fail-on-revert = true
 * forge-config: pooldeep.invariant.runs = 1000
 * forge-config: pooldeep.invariant.depth = 200
 */
contract PoolInvariantTest is Test {
  PoolHandler internal h;

  function setUp() public {
    h = new PoolHandler();
    targetContract(address(h));
    bytes4[] memory _s = new bytes4[](19);
    _s[0] = PoolHandler.deposit.selector;
    _s[1] = PoolHandler.deposit.selector; // deposits twice as likely: the pool needs notes to be interesting
    _s[2] = PoolHandler.relay.selector;
    _s[3] = PoolHandler.withdraw.selector;
    _s[4] = PoolHandler.ragequit.selector;
    _s[5] = PoolHandler.donate.selector;
    _s[6] = PoolHandler.sendEth.selector;
    _s[7] = PoolHandler.accrue.selector;
    _s[8] = PoolHandler.forceEth.selector;
    _s[9] = PoolHandler.setTreasuryMode.selector;
    _s[10] = PoolHandler.harvest.selector;
    _s[11] = PoolHandler.updateAsp.selector;
    _s[12] = PoolHandler.windDown.selector;
    _s[13] = PoolHandler.attackFrontRun.selector;
    _s[14] = PoolHandler.attackStealDirect.selector;
    _s[15] = PoolHandler.attackStealRagequit.selector;
    _s[16] = PoolHandler.attackForge.selector;
    _s[17] = PoolHandler.attackReplay.selector;
    _s[18] = PoolHandler.attackRestricted.selector;
    targetSelector(FuzzSelector({addr: address(h), selectors: _s}));
  }

  /**
   * @notice All pool invariants, checked after every call. (One entry point instead of six: Foundry runs a separate
   *         campaign per invariant function, and these share one handler, so this is six times cheaper.)
   */
  function invariant_pool() public {
    _zcBacksEveryNote();
    _poolKeepsNoEth();
    _treasuryGetsExactlyTheClaims();
    _harvestNeverChangesPoolState();
    _onlyOwnersMoveNoteValue();
    _everyNoteCanRagequit();
  }

  /// @notice ZC backing: the pool holds at least every unspent note, and exactly that plus direct donations
  function _zcBacksEveryNote() internal view {
    uint256 _bal = h.zc_().balanceOf(address(h.zpool()));
    assertGe(_bal, h.ghostUnspent(), 'pool ZC below the unspent notes');
    assertEq(_bal, h.ghostUnspent() + h.ghostDonations(), 'pool ZC != unspent notes + donations');
  }

  /// @notice The pool never keeps ETH: the only ETH it can hold is ETH forced in since the last successful harvest,
  ///         and nobody but ZC can send it ETH
  function _poolKeepsNoEth() internal view {
    assertEq(address(h.zpool()).balance, h.ghostForcedSinceHarvest(), 'pool holds ETH it should not');
    assertFalse(h.ghostStrangerEthAccepted(), 'pool accepted ETH from someone other than ZC');
  }

  /// @notice TREASURY received exactly what the pool claimed from ZC, plus any forced ETH that a harvest swept
  function _treasuryGetsExactlyTheClaims() internal view {
    uint256 _swept = h.ghostForcedTotal() - address(h.zpool()).balance;
    assertEq(h.treasury().received(), h.claimedFromZc() + _swept, 'treasury != claims + swept ETH');
  }

  /// @notice harvest() never touched the root, nonce, labels, nullifiers, root history or raw storage
  function _harvestNeverChangesPoolState() internal view {
    assertFalse(h.ghostHarvestChangedState(), 'harvest changed pool state');
  }

  /// @notice No attacker ever succeeded, and attackers (who own no note) hold no ZC
  function _onlyOwnersMoveNoteValue() internal view {
    assertFalse(h.ghostAttackSucceeded(), 'an attack succeeded');
    for (uint256 _i; _i < 2; ++_i) {
      assertEq(h.zc_().balanceOf(h.attacker(_i)), 0, 'an attacker holds ZC');
    }
  }

  /// @notice Every unspent note can still be ragequit by its owner, whatever harvests or TREASURY did, and when all
  ///         have, the pool holds exactly the donations (cheap check, every call)
  function _everyNoteCanRagequit() internal {
    h.checkExits(false);
  }

  /// @notice The full exit check at the end of each run: every approved note can also be fully withdrawn
  function afterInvariant() public {
    h.checkExits(true);
    string[20] memory _k = [
      'deposit',
      'deposit.dead',
      'relay',
      'withdraw',
      'ragequit',
      'donate',
      'sendEth',
      'accrue',
      'forceEth',
      'treasuryMode',
      'harvest',
      'harvest.nothing',
      'harvest.refused',
      'asp',
      'attack.frontRun',
      'attack.stealDirect',
      'attack.stealRagequit',
      'attack.forge',
      'attack.replay',
      'attack.restricted'
    ];
    for (uint256 _i; _i < _k.length; ++_i) {
      emit log_named_uint(_k[_i], h.calls(bytes32(bytes(_k[_i]))));
    }
  }
}
