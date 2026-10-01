// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from '@oz/token/ERC20/ERC20.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {PoseidonT2} from 'poseidon/PoseidonT2.sol';

import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {ZcRewardsHarvester} from 'zipnet/ZcRewardsHarvester.sol';
import {ZipBadges} from 'zipnet/ZipBadges.sol';
import {ZipCouriers} from 'zipnet/ZipCouriers.sol';
import {ZipMerchants} from 'zipnet/ZipMerchants.sol';
import {ZipPrivacyPool} from 'zipnet/ZipPrivacyPool.sol';

import {MockZC, ZipnetBase} from './ZipnetBase.sol';

/// @dev A merchant that tries to re-enter while being paid its ETH
contract Reenterer {
  ZipMerchants internal immutable M;
  MockZC internal immutable Z;
  bool public claimBlocked;
  bool public harvestBlocked;
  bool public stakeBlocked;
  bool public exitBlocked;
  uint256 public id;
  uint256 public received;

  constructor(ZipMerchants _m, MockZC _z) {
    M = _m;
    Z = _z;
  }

  function register(uint256 _stake) external {
    Z.approve(address(M), type(uint256).max);
    id = M.register(address(this), _stake, 'reenter');
  }

  function requestExit() external {
    M.requestExit(id);
  }

  function claim() external {
    M.claimEth();
  }

  receive() external payable {
    received += msg.value;
    try M.claimEth() {} catch {
      claimBlocked = true;
    }
    try M.harvest() {} catch {
      harvestBlocked = true;
    }
    try M.register(address(this), 1000 ether, 'again') {} catch {
      stakeBlocked = true;
    }
    try M.exit(id) {} catch {
      exitBlocked = true;
    }
  }
}

/// @dev ERC20 without the reward interface (like the local stand-in token)
contract PlainZC is ERC20 {
  constructor() ERC20('plain', 'P') {}

  function mint(address _to, uint256 _amount) external {
    _mint(_to, _amount);
  }
}

contract RewardsTest is ZipnetBase {
  ZipMerchants internal merchants;
  ZipCouriers internal couriers;
  ZipBadges internal badges;

  address internal alice = makeAddr('alice');
  address internal bob = makeAddr('bob');
  address internal carol = makeAddr('carol');
  address internal mov;
  uint256 internal movKey;
  address internal zven = makeAddr('zven');

  function setUp() public override {
    super.setUp();
    merchants = new ZipMerchants(zc, 100 ether);
    couriers = new ZipCouriers(IPrivacyPool(address(pool)), 100 ether);
    uint256[] memory _t = new uint256[](1);
    _t[0] = 1 ether;
    badges = new ZipBadges(IPrivacyPool(address(pool)), semaphore, _t);
    (mov, movKey) = makeAddrAndKey('mov');
  }

  // --------------------------------------------------------------------------------------------------------------
  // helpers
  // --------------------------------------------------------------------------------------------------------------

  /// @dev Pays `_wei` of ETH rewards to ZC holders. Tests keep all eligible ZC inside the contract under test.
  function _rewards(uint256 _wei) internal {
    vm.deal(address(this), _wei);
    zc.distributeRewards{value: _wei}();
  }

  function _register(address _who, uint256 _stake) internal returns (uint256 _id) {
    zc.mint(_who, _stake);
    vm.startPrank(_who);
    zc.approve(address(merchants), _stake);
    _id = merchants.register(_who, _stake, 'shop');
    vm.stopPrank();
  }

  function _exit(address _who, uint256 _id) internal {
    vm.prank(_who);
    merchants.requestExit(_id);
    vm.warp(block.timestamp + 14 days);
    vm.prank(_who);
    merchants.exit(_id);
  }

  function _bond(address _who, uint256 _amount) internal {
    zc.mint(_who, _amount);
    vm.startPrank(_who);
    zc.approve(address(couriers), _amount);
    couriers.bond(_amount, 'https://courier.example');
    vm.stopPrank();
  }

  function _lock(address _who, uint256 _value, uint256 _identity) internal {
    zc.mint(_who, _value);
    vm.startPrank(_who);
    zc.approve(address(badges), _value);
    badges.lock(_value, _identity, 30 days, uint256(keccak256(abi.encode(_identity))) % 1e70);
    vm.stopPrank();
  }

  function _claim(ZcRewardsHarvester _c, address _who) internal returns (uint256 _got) {
    uint256 _before = _who.balance;
    vm.prank(_who);
    _c.claimEth();
    _got = _who.balance - _before;
  }

  // --------------------------------------------------------------------------------------------------------------
  // privacy pool -> treasury
  // --------------------------------------------------------------------------------------------------------------

  function test_pool_harvestSendsEthToTreasury_accountingUntouched() public {
    _zip(alice, 100 ether);
    uint256 _root = pool.currentRoot();
    uint256 _size = pool.currentTreeSize();
    uint256 _nonce = pool.nonce();
    assertEq(zc.balanceOf(alice), 0);

    _rewards(1 ether);
    assertEq(zc.pendingReward(address(pool)), 1 ether);

    vm.prank(carol); // anyone
    assertEq(pool.harvest(), 1 ether);
    assertEq(poolTreasury.balance, 1 ether);
    assertEq(address(pool).balance, 0);
    assertEq(zc.pendingReward(address(pool)), 0);

    // ZC and every piece of pool state are unchanged
    assertEq(zc.balanceOf(address(pool)), 100 ether);
    assertEq(pool.currentRoot(), _root);
    assertEq(pool.currentTreeSize(), _size);
    assertEq(pool.nonce(), _nonce);

    // and the pool still takes deposits
    _zip(bob, 5 ether);
    assertEq(zc.balanceOf(address(pool)), 105 ether);
  }

  function test_pool_harvestWithNothingToClaimReverts() public {
    zc.mint(address(pool), 10 ether);
    vm.expectRevert(MockZC.NothingToClaim.selector);
    pool.harvest();
  }

  function test_pool_receiveOnlyFromZc() public {
    vm.deal(alice, 1 ether);
    vm.prank(alice);
    (bool _ok,) = address(pool).call{value: 1 ether}('');
    assertFalse(_ok);
  }

  function test_pool_rejectsZeroTreasury() public {
    vm.expectRevert(ZipPrivacyPool.ZeroTreasury.selector);
    new ZipPrivacyPool(address(entrypoint), address(1), address(1), address(zc), payable(address(0)));
  }

  // --------------------------------------------------------------------------------------------------------------
  // stakers: pro rata over time
  // --------------------------------------------------------------------------------------------------------------

  function test_merchants_proRataAcrossJoinsAndExits() public {
    uint256 _a = _register(alice, 1000 ether);
    _rewards(1 ether); // alice alone
    assertEq(merchants.pendingEth(alice), 1 ether); // the view includes ETH not yet harvested

    // bob joins; ETH that accrued before he joined stays alice's even though nobody harvested
    _register(bob, 3000 ether);
    assertEq(merchants.pendingEth(alice), 1 ether);
    assertEq(merchants.pendingEth(bob), 0);

    _rewards(4 ether); // 1:3
    merchants.harvest();
    assertEq(merchants.pendingEth(alice), 2 ether);
    assertEq(merchants.pendingEth(bob), 3 ether);

    // alice leaves; she keeps what she earned and earns nothing more
    _exit(alice, _a);
    zc.excludeFromRewards(alice); // her ZC is back in her wallet; keep all eligible ZC in the contract
    _rewards(3 ether);
    merchants.harvest();
    assertEq(merchants.pendingEth(alice), 2 ether);
    assertEq(merchants.pendingEth(bob), 6 ether);

    assertEq(_claim(merchants, alice), 2 ether);
    assertEq(_claim(merchants, bob), 6 ether);
    assertEq(merchants.pendingEth(alice), 0);
    assertEq(merchants.pendingEth(bob), 0);
    assertEq(address(merchants).balance, 0);

    // claiming again pays nothing
    assertEq(_claim(merchants, bob), 0);
  }

  function test_merchants_claimHarvestsFirst() public {
    _register(alice, 1000 ether);
    _rewards(1 ether);
    assertEq(_claim(merchants, alice), 1 ether);
  }

  function test_merchants_slashedStakeStopsEarning() public {
    (address _shady, uint256 _key) = makeAddrAndKey('shady');
    uint256 _id = _register(_shady, 1000 ether);
    _register(bob, 1000 ether);
    _rewards(2 ether);

    ZipMerchants.Invoice memory _inv = ZipMerchants.Invoice(
      _id, 50 ether, keccak256('cash price'), ZipMerchants.Route.UNTAXED, uint64(block.timestamp + 1 hours)
    );
    (uint8 _v, bytes32 _r, bytes32 _s) = vm.sign(_key, merchants.invoiceDigest(_inv));
    merchants.commitReport(merchants.reportCommitment(merchants.invoiceDigest(_inv), address(this), 0));
    vm.roll(block.number + 1);
    merchants.report(_inv, abi.encodePacked(_r, _s, _v), 0);
    assertEq(merchants.ethStakeOf(_shady), 0);
    assertEq(merchants.totalEthStake(), 1000 ether);

    // what was earned before the slash is kept; the inspector's 500 ZC now earns at the token, not here
    _rewards(1.5 ether); // eligible: merchants 1000 + inspector 500
    merchants.harvest();
    assertEq(merchants.pendingEth(_shady), 1 ether);
    assertEq(merchants.pendingEth(bob), 2 ether);
    assertEq(_claim(merchants, _shady), 1 ether);
  }

  function test_couriers_proRata_unbondingStillEarns_unbondStops() public {
    _bond(mov, 3000 ether);
    _bond(zven, 1000 ether);
    _rewards(4 ether);
    couriers.harvest();
    assertEq(couriers.pendingEth(mov), 3 ether);
    assertEq(couriers.pendingEth(zven), 1 ether);

    vm.prank(zven);
    couriers.requestUnbond(); // still held and slashable, so its ZC still earns ETH
    _rewards(4 ether);
    couriers.harvest();
    assertEq(couriers.pendingEth(zven), 2 ether);

    vm.warp(block.timestamp + 14 days);
    vm.prank(zven);
    couriers.unbond();
    zc.excludeFromRewards(zven); // keep all eligible ZC in the courier contract
    _rewards(3 ether);
    couriers.harvest();
    assertEq(couriers.pendingEth(mov), 9 ether);
    assertEq(couriers.pendingEth(zven), 2 ether);
    assertEq(_claim(couriers, zven), 2 ether);
    assertEq(_claim(couriers, mov), 9 ether);
  }

  function test_couriers_slashStopsTheSlashedPart() public {
    _bond(mov, 3000 ether);
    _bond(zven, 1000 ether);
    _rewards(4 ether);

    Note memory _n = _zip(alice, 10 ether); // the pool now holds 10 ZC too
    zc.excludeFromRewards(address(pool));
    address _dest = makeAddr('dest');
    zc.excludeFromRewards(_dest); // the report delivers the job: the 10 ZC leave the (excluded) pool for `_dest`
    IPrivacyPool.Withdrawal memory _w = IPrivacyPool.Withdrawal(
      address(entrypoint), abi.encode(IEntrypoint.RelayData({recipient: _dest, feeRecipient: mov, relayFeeBPS: 0}))
    );
    (ProofLib.WithdrawProof memory _p,) = _prove(_n, 10 ether, _w);
    bytes memory _call = abi.encodeCall(entrypoint.relay, (_w, _p, scope));
    ZipCouriers.Receipt memory _r = ZipCouriers.Receipt(
      mov,
      PoseidonT2.hash([_n.nullifier]),
      couriers.jobHashOf(address(entrypoint), _call),
      uint64(block.timestamp + 1 hours)
    );
    (uint8 _v, bytes32 _rr, bytes32 _s) = vm.sign(movKey, couriers.receiptDigest(_r));
    vm.warp(block.timestamp + 2 hours);
    address _reporter = makeAddr('reporter');
    vm.prank(_reporter);
    couriers.commitReport(couriers.reportCommitment(couriers.receiptDigest(_r), _reporter, 0));
    vm.roll(block.number + 1);
    vm.prank(_reporter);
    couriers.report(_r, abi.encodePacked(_rr, _s, _v), 0, address(entrypoint), _call);
    assertEq(couriers.ethStakeOf(mov), 2700 ether);
    assertEq(couriers.pendingEth(mov), 3 ether); // earned before the slash, harvested by the slash

    zc.excludeFromRewards(_reporter);
    _rewards(3.7 ether); // eligible: couriers 3700
    couriers.harvest();
    assertEq(couriers.pendingEth(mov), 5.7 ether);
    assertEq(couriers.pendingEth(zven), 2 ether);
  }

  function test_badges_lockersEarn_claimEthFor_unlockStops() public {
    _lock(alice, 1000 ether, 11);
    _lock(bob, 3000 ether, 22);
    assertEq(badges.lockRewardTo(1), alice);
    _rewards(4 ether);
    badges.harvest();
    assertEq(badges.pendingEth(alice), 1 ether);
    assertEq(badges.pendingEth(bob), 3 ether);

    // anyone can pay alice out, to alice
    vm.prank(carol);
    badges.claimEthFor(alice);
    assertEq(alice.balance, 1 ether);
    assertEq(carol.balance, 0);

    // alice unlocks: her lock returns to the pool and stops earning here
    vm.warp(block.timestamp + 30 days);
    uint256[][] memory _sib = new uint256[][](1);
    _sib[0] = new uint256[](1);
    _sib[0][0] = 22;
    badges.unlock(1, _sib);
    assertEq(badges.ethStakeOf(alice), 0);
    zc.excludeFromRewards(address(pool));
    _rewards(2 ether);
    badges.harvest();
    assertEq(badges.pendingEth(alice), 0);
    assertApproxEqAbs(badges.pendingEth(bob), 5 ether, 2); // 3000-wei-share rounding
  }

  // --------------------------------------------------------------------------------------------------------------
  // safety
  // --------------------------------------------------------------------------------------------------------------

  function test_reentrancyDuringPayoutIsBlocked() public {
    Reenterer _x = new Reenterer(merchants, zc);
    zc.mint(address(_x), 2000 ether); // 1000 to stake, 1000 for the re-entrant register
    _x.register(1000 ether);
    zc.excludeFromRewards(address(_x));
    _x.requestExit(); // so exit() would succeed if it were not blocked
    vm.warp(block.timestamp + 14 days);
    _register(bob, 1000 ether);
    _rewards(2 ether);
    merchants.harvest();

    _x.claim();
    assertEq(_x.received(), 1 ether); // paid once
    assertTrue(_x.claimBlocked());
    assertTrue(_x.harvestBlocked());
    assertTrue(_x.stakeBlocked());
    assertTrue(_x.exitBlocked());
    assertEq(merchants.pendingEth(address(_x)), 0);
    assertEq(merchants.pendingEth(bob), 1 ether);
    assertEq(address(merchants).balance, 1 ether);
  }

  function test_receiveRejectsAnyoneButZc() public {
    vm.deal(alice, 4 ether);
    vm.startPrank(alice);
    (bool _ok,) = address(merchants).call{value: 1 ether}('');
    assertFalse(_ok);
    (_ok,) = address(couriers).call{value: 1 ether}('');
    assertFalse(_ok);
    (_ok,) = address(badges).call{value: 1 ether}('');
    assertFalse(_ok);
    vm.stopPrank();
    vm.expectRevert(ZcRewardsHarvester.OnlyZc.selector);
    vm.prank(alice);
    payable(address(merchants)).transfer(1 ether);
  }

  function test_harvestWithNothingToClaim_revertsButStakingDoesNot() public {
    vm.expectRevert(MockZC.NothingToClaim.selector);
    merchants.harvest();
    _register(alice, 1000 ether); // stake changes skip an empty claim
    vm.expectRevert(MockZC.NothingToClaim.selector);
    merchants.harvest();
    assertEq(_claim(merchants, alice), 0);
  }

  function test_tokenWithoutRewardsNeverBlocksStaking() public {
    PlainZC _p = new PlainZC();
    ZipMerchants _m = new ZipMerchants(IERC20(address(_p)), 1 ether);
    _p.mint(alice, 10 ether);
    vm.startPrank(alice);
    _p.approve(address(_m), 10 ether);
    uint256 _id = _m.register(alice, 10 ether, 'x');
    _m.requestExit(_id);
    vm.warp(block.timestamp + 14 days);
    _m.exit(_id);
    assertEq(_m.claimEth(), 0);
    vm.stopPrank();
    assertEq(_p.balanceOf(alice), 10 ether);
  }

  function testFuzz_roundingNeverOverpays(uint96[4] memory _stakes, uint64[3] memory _wei) public {
    address[4] memory _who = [alice, bob, carol, zven];
    uint256 _distributed;
    for (uint256 _i; _i < 4; ++_i) {
      uint256 _s = bound(uint256(_stakes[_i]), 100 ether, 1e27);
      _register(_who[_i], _s + _i); // odd amounts
      uint256 _w = bound(uint256(_wei[_i % 3]), 1, 1e20);
      _rewards(_w);
      _distributed += _w;
    }
    if (zc.pendingReward(address(merchants)) != 0) merchants.harvest();
    uint256 _paid;
    for (uint256 _i; _i < 4; ++_i) {
      uint256 _pending = merchants.pendingEth(_who[_i]);
      uint256 _got = _claim(merchants, _who[_i]);
      assertEq(_got, _pending);
      _paid += _got;
    }
    // what is left is rounding dust only (a few wei per settlement)
    assertLe(address(merchants).balance, 16);
    assertLe(_paid, _distributed);
    assertGe(_paid + 32, _distributed); // with the token's own rounding, at most a few wei go unpaid
    assertEq(merchants.totalEthStake(), zc.balanceOf(address(merchants)));
  }
}
