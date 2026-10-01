// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';

import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IPrivacyPool, IPrivacyPoolComplex} from 'interfaces/IPrivacyPool.sol';

import {ZipPrivacyPool} from 'zipnet/ZipPrivacyPool.sol';

import {PoolModel, TreasuryActor} from './PoolModel.sol';

/**
 * @notice harvest() and receive() against every kind of TREASURY: accepting, reverting, gas-burning and three
 *         re-entrant ones. The question for each: what does harvest do, and is the pool still fully usable after?
 */
contract PoolHarvestTest is PoolModel {
  ZipPrivacyPool internal zpool;
  TreasuryActor internal treasury;
  address internal alice = makeAddr('alice');
  address internal bob = makeAddr('bob');
  address internal relayer = makeAddr('relayer');
  address internal keeper = makeAddr('keeper');

  function setUp() public {
    _deployStack();
    treasury = new TreasuryActor();
    zpool = new ZipPrivacyPool(
      address(entrypoint), address(verifier), address(verifier), address(zc), payable(address(treasury))
    );
    pool = IPrivacyPool(address(zpool));
    treasury.wire(address(zpool), zc);
    _register(1 ether, 0, 500);
    vm.prank(postman);
    entrypoint.updateRoot(1, CID);
  }

  function _deposit(address _who, uint256 _value) internal returns (uint256 _i) {
    (uint256 _n, uint256 _s) = _secrets();
    zc.mint(_who, _value);
    vm.startPrank(_who);
    zc.approve(address(entrypoint), _value);
    uint256 _c = entrypoint.deposit(IERC20(address(zc)), _value, _precommitment(_n, _s));
    vm.stopPrank();
    _i = _recordDeposit(_who, _value, _n, _s, _c);
    _postAsp(0);
  }

  function _accrue(uint256 _eth) internal {
    vm.deal(address(this), _eth);
    zc.distributeRewards{value: _eth}();
  }

  function _harvest() internal returns (bool _ok, bytes memory _ret) {
    vm.prank(keeper);
    (_ok, _ret) = address(zpool).call{gas: 5_000_000}(abi.encodeCall(ZipPrivacyPool.harvest, ()));
  }

  /// @dev A full user round trip: deposit, relayed partial withdraw, direct withdraw, ragequit of the rest
  function _poolStillWorks() internal {
    uint256 _i = _deposit(bob, 100 ether);
    IPrivacyPool.Withdrawal memory _w = _relayData(bob, relayer, 100);
    (ProofLib.WithdrawProof memory _p, Note memory _change) = _proveWithdraw(_i, 40 ether, _w);
    uint256 _bob = zc.balanceOf(bob);
    vm.prank(relayer);
    entrypoint.relay(_w, _p, pool.SCOPE());
    _recordSpend(_i, _change);
    assertEq(zc.balanceOf(bob) - _bob, 39.6 ether, 'relayed');

    uint256 _j = notes.length - 1;
    IPrivacyPool.Withdrawal memory _d = IPrivacyPool.Withdrawal(bob, '');
    (_p, _change) = _proveWithdraw(_j, 10 ether, _d);
    vm.prank(bob);
    pool.withdraw(_d, _p);
    _recordSpend(_j, _change);

    ProofLib.RagequitProof memory _r = _proveRagequit(notes.length - 1);
    vm.prank(bob);
    pool.ragequit(_r);
    assertEq(zc.balanceOf(bob) - _bob, 39.6 ether + 10 ether + 50 ether, 'bob out in full');
  }

  function _digest() internal view returns (bytes32 _h) {
    _h = keccak256(abi.encode(pool.currentRoot(), pool.currentTreeSize(), pool.nonce(), pool.currentRootIndex()));
    for (uint256 _s; _s < 10; ++_s) {
      _h = keccak256(abi.encode(_h, vm.load(address(pool), bytes32(_s))));
    }
  }

  // ------------------------------------------------------------------------------------------------------------

  function test_accept_treasuryGetsExactlyTheClaim_andPoolStateIsUntouched() public {
    _deposit(alice, 1000 ether);
    _accrue(3 ether);
    uint256 _pending = zc.pendingReward(address(zpool));
    assertEq(_pending, 3 ether, 'the pool is the only eligible holder');
    bytes32 _before = _digest();
    uint256 _zc = zc.balanceOf(address(zpool));

    vm.expectEmit(address(zpool));
    emit ZipPrivacyPool.Harvested(_pending, _pending);
    vm.prank(keeper);
    assertEq(zpool.harvest(), _pending);

    assertEq(treasury.received(), _pending);
    assertEq(address(zpool).balance, 0);
    assertEq(keeper.balance, 0, 'the caller gets nothing');
    assertEq(_digest(), _before, 'pool state changed');
    assertEq(zc.balanceOf(address(zpool)), _zc, 'ZC moved');
    _poolStillWorks();
  }

  function test_nothingToClaim_reverts() public {
    _deposit(alice, 1000 ether);
    vm.expectRevert(bytes4(keccak256('NothingToClaim()')));
    zpool.harvest();
  }

  function test_revertingTreasury_harvestReverts_rewardsStayClaimable_poolUnaffected() public {
    _deposit(alice, 1000 ether);
    _accrue(2 ether);
    uint256 _pending = zc.pendingReward(address(zpool));
    treasury.setMode(TreasuryActor.Mode.Revert);

    (bool _ok, bytes memory _ret) = _harvest();
    assertFalse(_ok);
    assertEq(bytes4(_ret), ZipPrivacyPool.TreasuryTransferFailed.selector);
    assertEq(zc.pendingReward(address(zpool)), _pending, 'the whole harvest rolled back');
    assertEq(address(zpool).balance, 0);

    _poolStillWorks(); // deposits, relays, withdrawals and ragequits don't depend on harvest

    // Once TREASURY accepts again, everything that accrued meanwhile is harvested in one go
    _accrue(1 ether);
    treasury.setMode(TreasuryActor.Mode.Accept);
    uint256 _all = zc.pendingReward(address(zpool));
    assertGt(_all, _pending);
    (_ok,) = _harvest();
    assertTrue(_ok);
    assertEq(treasury.received(), _all, 'received the accumulated claim');
  }

  function test_gasBurningTreasury_harvestRevertsCleanly_poolUnaffected() public {
    _deposit(alice, 1000 ether);
    _accrue(1 ether);
    treasury.setMode(TreasuryActor.Mode.BurnGas);
    (bool _ok, bytes memory _ret) = _harvest();
    assertFalse(_ok);
    assertEq(bytes4(_ret), ZipPrivacyPool.TreasuryTransferFailed.selector, 'the 1/64 gas left is enough to revert');
    _poolStillWorks();
  }

  function test_reentrantTreasury_nestedHarvestFindsNothing() public {
    _deposit(alice, 1000 ether);
    _accrue(1 ether);
    uint256 _pending = zc.pendingReward(address(zpool));
    treasury.setMode(TreasuryActor.Mode.ReenterHarvest);
    (bool _ok,) = _harvest();
    assertTrue(_ok);
    assertEq(treasury.reentries(), 1);
    assertEq(treasury.reentriesSucceeded(), 0, 'the nested harvest had nothing to claim');
    assertEq(treasury.received(), _pending);
    assertEq(address(zpool).balance, 0);
    _poolStillWorks();
  }

  /// @dev The treasury pays new rewards into ZC mid-harvest and re-enters: the nested harvest claims them and pays
  ///      the treasury again. Nothing is double-counted and the pool ends with no ETH.
  function test_reentrantTreasury_withFreshRewards_everyClaimReachesTheTreasury() public {
    _deposit(alice, 1000 ether);
    _accrue(4 ether);
    uint256 _first = zc.pendingReward(address(zpool));
    treasury.setMode(TreasuryActor.Mode.ReenterWithFreshRewards);
    (bool _ok,) = _harvest();
    assertTrue(_ok);
    assertEq(treasury.reentriesSucceeded(), 1, 'the nested harvest claimed the fresh rewards');
    uint256 _fresh = treasury.spent();
    assertApproxEqAbs(treasury.received(), _first + _fresh, 2, 'both claims reached the treasury');
    assertEq(address(zpool).balance, 0);
    assertEq(address(zc).balance, 4 ether + _fresh - treasury.received(), 'ZC paid out exactly what TREASURY got');
    _poolStillWorks();
  }

  function test_reentrantTreasury_bubblingRevert_blocksOnlyHarvest() public {
    _deposit(alice, 1000 ether);
    _accrue(1 ether);
    treasury.setMode(TreasuryActor.Mode.ReenterAndBubble);
    (bool _ok, bytes memory _ret) = _harvest();
    assertFalse(_ok);
    assertEq(bytes4(_ret), ZipPrivacyPool.TreasuryTransferFailed.selector);
    _poolStillWorks();
  }

  /// @dev SELFDESTRUCT can force ETH in. harvest() sweeps it along with the next claim; with nothing to claim it
  ///      stays (harvest reverts NothingToClaim first). No pool accounting reads the pool's ETH balance.
  function test_forcedEth_waitsForTheNextClaim_thenIsSwept() public {
    _deposit(alice, 1000 ether);
    _forceEth(address(zpool), 0.5 ether);
    assertEq(address(zpool).balance, 0.5 ether);
    vm.expectRevert(bytes4(keccak256('NothingToClaim()')));
    zpool.harvest();
    _poolStillWorks();

    _accrue(1 ether);
    uint256 _pending = zc.pendingReward(address(zpool));
    zpool.harvest();
    assertEq(treasury.received(), _pending + 0.5 ether);
    assertEq(address(zpool).balance, 0);
  }

  function test_receive_onlyTheAsset() public {
    address[3] memory _who = [alice, address(entrypoint), address(treasury)];
    for (uint256 _i; _i < 3; ++_i) {
      vm.deal(_who[_i], 1 ether);
      vm.prank(_who[_i]);
      (bool _ok, bytes memory _ret) = address(zpool).call{value: 1 ether}('');
      assertFalse(_ok);
      assertEq(bytes4(_ret), ZipPrivacyPool.OnlyAsset.selector);
    }
    // The token itself may pay the pool (that is how claim() delivers); the next harvest forwards it
    vm.deal(address(zc), 1 ether);
    vm.prank(address(zc));
    (bool _sent,) = address(zpool).call{value: 1 ether}('');
    assertTrue(_sent);
  }

  function test_depositsCannotCarryEth() public {
    // Upstream's _pull rejects msg.value; the Entrypoint never forwards ETH to an ERC20 pool anyway
    vm.deal(address(entrypoint), 1 ether);
    vm.prank(address(entrypoint));
    vm.expectRevert(IPrivacyPoolComplex.NativeAssetNotAccepted.selector);
    zpool.deposit{value: 1 ether}(alice, 1 ether, 42);
  }

  function test_constructor_rejectsZeroTreasury() public {
    vm.expectRevert(ZipPrivacyPool.ZeroTreasury.selector);
    new ZipPrivacyPool(address(entrypoint), address(verifier), address(verifier), address(zc), payable(address(0)));
  }
}
