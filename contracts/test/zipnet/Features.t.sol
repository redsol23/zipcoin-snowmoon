// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Semaphore} from '@semaphore-protocol/contracts/Semaphore.sol';
import {Vm} from 'forge-std/Vm.sol';

import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {ZipBroadcaster} from 'zipnet/ZipBroadcaster.sol';
import {ZipDoorstep} from 'zipnet/ZipDoorstep.sol';
import {ZipMerchants} from 'zipnet/ZipMerchants.sol';
import {ZipPay} from 'zipnet/ZipPay.sol';
import {ZipProcessooor} from 'zipnet/ZipProcessooor.sol';
import {ZipRezip} from 'zipnet/ZipRezip.sol';

import {ZipnetBase} from './ZipnetBase.sol';

contract FeaturesTest is ZipnetBase {
  ZipBroadcaster internal broadcaster;
  ZipDoorstep internal doorstep;
  ZipRezip internal rezip;
  ZipMerchants internal merchants;
  ZipPay internal zipPay;

  address internal courier = makeAddr('courier');
  address internal courierPool = makeAddr('courierPool');
  address internal treasury = makeAddr('treasury');

  function setUp() public override {
    super.setUp();
    broadcaster = new ZipBroadcaster(IPrivacyPool(address(pool)), 10 ether);
    doorstep = new ZipDoorstep(IPrivacyPool(address(pool)), 10 ether);
    rezip = new ZipRezip(IPrivacyPool(address(pool)));
    merchants = new ZipMerchants(zc, 1000 ether);
    // 1% tax: 50% burned, 30% couriers, 20% treasury
    zipPay =
      new ZipPay(IPrivacyPool(address(pool)), merchants, 100, 5000, 3000, courierPool, treasury, semaphore, 10 ether);
  }

  function _courier(uint256 _fee) internal view returns (ZipProcessooor.Courier memory) {
    return ZipProcessooor.Courier(courier, _fee);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // burn to speak
  // ---------------------------------------------------------------------------------------------------------------

  function test_speakAnon_burnsAndPaysCourier() public {
    Note memory _n = _zip(makeAddr('alice'), 500 ether);
    ZipBroadcaster.Speech memory _s = ZipBroadcaster.Speech(
      'courtyard', 7, 'someone who ate at Beautiful Plants, 18, successful', 'Zei', 'ipfs://bundle', _courier(2 ether)
    );
    IPrivacyPool.Withdrawal memory _w = IPrivacyPool.Withdrawal(address(broadcaster), abi.encode(_s));
    (ProofLib.WithdrawProof memory _p,) = _prove(_n, 400 ether, _w);

    vm.prank(courier);
    broadcaster.speakAnon(_w, _p);

    assertEq(zc.balanceOf(BURN), 398 ether);
    assertEq(zc.balanceOf(courier), 2 ether);
  }

  function test_speakAnon_courierCannotRewriteMessage() public {
    Note memory _n = _zip(makeAddr('alice'), 500 ether);
    ZipBroadcaster.Speech memory _s = ZipBroadcaster.Speech('', 0, 'the real message', '', '', _courier(1 ether));
    IPrivacyPool.Withdrawal memory _w = IPrivacyPool.Withdrawal(address(broadcaster), abi.encode(_s));
    (ProofLib.WithdrawProof memory _p,) = _prove(_n, 100 ether, _w);

    _s.message = 'a forged message';
    _s.courier.fee = 90 ether;
    _w.data = abi.encode(_s);
    vm.expectRevert(IPrivacyPool.ContextMismatch.selector);
    broadcaster.speakAnon(_w, _p);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // doorstep
  // ---------------------------------------------------------------------------------------------------------------

  function test_knockAnon_burnsAndGifts() public {
    Note memory _n = _zip(makeAddr('mov'), 200 ether);
    address _door = makeAddr('telroy');
    ZipDoorstep.Knock memory _k = ZipDoorstep.Knock(_door, 50 ether, 'we need to talk about the Order', _courier(1 ether));
    IPrivacyPool.Withdrawal memory _w = IPrivacyPool.Withdrawal(address(doorstep), abi.encode(_k));
    (ProofLib.WithdrawProof memory _p,) = _prove(_n, 151 ether, _w);

    doorstep.knockAnon(_w, _p);

    assertEq(zc.balanceOf(_door), 50 ether);
    assertEq(zc.balanceOf(BURN), 100 ether);
    assertEq(zc.balanceOf(courier), 1 ether);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // private send
  // ---------------------------------------------------------------------------------------------------------------

  function test_rezip_recipientCanSpendTheNewNote() public {
    Note memory _n = _zip(makeAddr('seila'), 300 ether);

    // The recipient's secrets would come from a zip link or be encrypted to their zip address
    (uint256 _rn, uint256 _rs) = _secrets();
    ZipRezip.Send memory _send = ZipRezip.Send(_precommitment(_rn, _rs), hex'c1f3e7', _courier(1 ether));
    IPrivacyPool.Withdrawal memory _w = IPrivacyPool.Withdrawal(address(rezip), abi.encode(_send));
    (ProofLib.WithdrawProof memory _p,) = _prove(_n, 121 ether, _w);

    vm.recordLogs();
    rezip.rezip(_w, _p);
    _spent(_p);
    (uint256 _label, uint256 _value) = _rezippedEvent();

    Note memory _received = Note(_value, _label, _rn, _rs);
    assertEq(_value, 120 ether);
    _track(_received);
    _approve(_label);

    // Febric and Hreda, in Greater Plum Harbor, unzip their allowance through a courier
    address _kid = makeAddr('febric');
    IPrivacyPool.Withdrawal memory _w2 = IPrivacyPool.Withdrawal(
      address(entrypoint), abi.encode(IEntrypoint.RelayData({recipient: _kid, feeRecipient: courier, relayFeeBPS: 0}))
    );
    (ProofLib.WithdrawProof memory _p2,) = _prove(_received, 120 ether, _w2);
    entrypoint.relay(_w2, _p2, scope);

    assertEq(zc.balanceOf(_kid), 120 ether);
  }

  function _rezippedEvent() internal returns (uint256 _label, uint256 _value) {
    Vm.Log[] memory _logs = vm.getRecordedLogs();
    for (uint256 _i; _i < _logs.length; ++_i) {
      if (_logs[_i].topics[0] == ZipRezip.Rezipped.selector) {
        (_label, _value,,) = abi.decode(_logs[_i].data, (uint256, uint256, uint256, bytes));
        return (_label, _value);
      }
    }
    revert('no Rezipped');
  }

  // ---------------------------------------------------------------------------------------------------------------
  // pay with sales tax
  // ---------------------------------------------------------------------------------------------------------------

  function _listMerchant(address _signer, address _payout) internal returns (uint256 _id) {
    zc.mint(_signer, 1000 ether);
    vm.startPrank(_signer);
    zc.approve(address(merchants), 1000 ether);
    _id = merchants.register(_payout, 1000 ether, 'ipfs://beautiful-plants');
    vm.stopPrank();
  }

  function test_payAnon_splitsTaxInRealTime() public {
    address _restaurant = makeAddr('restaurant');
    uint256 _id = _listMerchant(_restaurant, _restaurant);
    Note memory _n = _zip(makeAddr('gladias'), 2773 ether);

    // Base 1000, tax 10 (1%), courier 1
    ZipPay.Payment memory _pay =
      ZipPay.Payment(_id, 1000 ether, keccak256('table 4'), 0, 0, hex'5eca1ed0', _courier(1 ether));
    IPrivacyPool.Withdrawal memory _w = IPrivacyPool.Withdrawal(address(zipPay), abi.encode(_pay));
    (ProofLib.WithdrawProof memory _p,) = _prove(_n, 1011 ether, _w);

    zipPay.payAnon(_w, _p);

    assertEq(zc.balanceOf(_restaurant), 1000 ether);
    assertEq(zc.balanceOf(BURN), 5 ether);
    assertEq(zc.balanceOf(courierPool), 3 ether);
    assertEq(zc.balanceOf(treasury), 2 ether);
    assertEq(zc.balanceOf(courier), 1 ether);
  }

  function test_payAnon_revertsWhenTaxIsShort() public {
    uint256 _id = _listMerchant(makeAddr('restaurant'), makeAddr('restaurant'));
    Note memory _n = _zip(makeAddr('gladias'), 2000 ether);
    ZipPay.Payment memory _pay = ZipPay.Payment(_id, 1000 ether, bytes32(0), 0, 0, '', _courier(0));
    IPrivacyPool.Withdrawal memory _w = IPrivacyPool.Withdrawal(address(zipPay), abi.encode(_pay));
    (ProofLib.WithdrawProof memory _p,) = _prove(_n, 1000 ether, _w);

    vm.expectRevert(ZipPay.WrongTotal.selector);
    zipPay.payAnon(_w, _p);
  }

  function test_pay_merchantRevenueStaysZipped() public {
    uint256 _id = _listMerchant(makeAddr('restaurant'), makeAddr('restaurant'));
    (uint256 _mn, uint256 _ms) = _secrets();
    address _buyer = makeAddr('buyer');
    zc.mint(_buyer, 101 ether);
    vm.startPrank(_buyer);
    zc.approve(address(zipPay), 101 ether);
    zipPay.pay(_id, 100 ether, bytes32(0), _precommitment(_mn, _ms), 0, '');
    vm.stopPrank();

    assertEq(zc.balanceOf(makeAddr('restaurant')), 0);
    assertEq(zc.balanceOf(address(pool)), 100 ether);
  }

  // M-2 PoC, inverted: a zero-base (or tiny) payment can't add identities to a merchant's payer group
  function test_m2_payerGroupNeedsARealPurchase() public {
    uint256 _id = _listMerchant(makeAddr('restaurant'), makeAddr('restaurant'));
    address _attacker = makeAddr('attacker'); // holds no ZC
    vm.startPrank(_attacker);
    vm.expectRevert(ZipPay.BaseTooSmallToJoin.selector);
    zipPay.pay(_id, 0, bytes32(uint256(1)), 0, 1001, '');
    vm.stopPrank();
    assertFalse(zipPay.hasPayerGroup(_id));

    address _buyer = makeAddr('buyer');
    zc.mint(_buyer, 20 ether);
    vm.startPrank(_buyer);
    zc.approve(address(zipPay), 20 ether);
    vm.expectRevert(ZipPay.BaseTooSmallToJoin.selector);
    zipPay.pay(_id, 9 ether, bytes32(0), 0, 1002, ''); // below MIN_JOIN_BASE (10)
    zipPay.pay(_id, 1 ether, bytes32(0), 0, 0, ''); // a small purchase without joining is fine
    zipPay.pay(_id, 10 ether, bytes32(0), 0, 1003, '');
    vm.stopPrank();
    assertTrue(Semaphore(address(semaphore)).hasMember(zipPay.payerGroup(_id), 1003));
    assertEq(Semaphore(address(semaphore)).getMerkleTreeSize(zipPay.payerGroup(_id)), 1);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // random inspection
  // ---------------------------------------------------------------------------------------------------------------

  function test_inspection_untaxedInvoiceSlashes() public {
    (address _signer, uint256 _key) = makeAddrAndKey('shady');
    uint256 _id = _listMerchant(_signer, _signer);
    ZipMerchants.Invoice memory _inv =
      ZipMerchants.Invoice(_id, 50 ether, keccak256('cash price'), ZipMerchants.Route.UNTAXED, uint64(block.timestamp + 1 hours));
    (uint8 _v, bytes32 _r, bytes32 _s) = vm.sign(_key, merchants.invoiceDigest(_inv));

    address _inspector = makeAddr('inspector');
    bytes memory _sig = abi.encodePacked(_r, _s, _v);
    bytes32 _salt = keccak256('inspector salt');

    // the report must be committed a block earlier
    vm.prank(_inspector);
    vm.expectRevert(ZipMerchants.NotCommitted.selector);
    merchants.report(_inv, _sig, _salt);
    vm.prank(_inspector);
    merchants.commitReport(merchants.reportCommitment(merchants.invoiceDigest(_inv), _inspector, _salt));
    vm.prank(_inspector);
    vm.expectRevert(ZipMerchants.NotCommitted.selector);
    merchants.report(_inv, _sig, _salt); // same block
    vm.roll(block.number + 1);

    // M-8: a mempool watcher (or the merchant itself) copying the reveal has no commitment of its own
    vm.prank(makeAddr('copier'));
    vm.expectRevert(ZipMerchants.NotCommitted.selector);
    merchants.report(_inv, _sig, _salt);
    vm.prank(_signer);
    vm.expectRevert(ZipMerchants.NotCommitted.selector);
    merchants.report(_inv, _sig, _salt);

    vm.prank(_inspector);
    merchants.report(_inv, _sig, _salt);

    assertEq(zc.balanceOf(_inspector), 500 ether);
    assertEq(zc.balanceOf(BURN), 500 ether);
    assertFalse(merchants.isListed(_id));
  }

  function test_inspection_taxedInvoiceIsNotEvidence() public {
    (address _signer, uint256 _key) = makeAddrAndKey('honest');
    uint256 _id = _listMerchant(_signer, _signer);
    ZipMerchants.Invoice memory _inv =
      ZipMerchants.Invoice(_id, 50 ether, bytes32(0), ZipMerchants.Route.TAXED, uint64(block.timestamp + 1 hours));
    (uint8 _v, bytes32 _r, bytes32 _s) = vm.sign(_key, merchants.invoiceDigest(_inv));

    vm.expectRevert(ZipMerchants.NotEvidence.selector);
    merchants.report(_inv, abi.encodePacked(_r, _s, _v), 0);
  }

  function test_merchantExitWaitsForInspectionWindow() public {
    address _m = makeAddr('leaving');
    uint256 _id = _listMerchant(_m, _m);
    vm.startPrank(_m);
    merchants.requestExit(_id);
    vm.expectRevert(ZipMerchants.TooEarly.selector);
    merchants.exit(_id);
    vm.warp(block.timestamp + 14 days);
    merchants.exit(_id);
    vm.stopPrank();
    assertEq(zc.balanceOf(_m), 1000 ether);
  }
}
