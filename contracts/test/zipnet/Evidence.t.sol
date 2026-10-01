// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {PoseidonT2} from 'poseidon/PoseidonT2.sol';

import {BatchRelayer} from 'contracts/BatchRelayer.sol';
import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IBatchRelayer} from 'interfaces/IBatchRelayer.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {SigningKeys} from 'zipnet/SigningKeys.sol';
import {ZipCouriers} from 'zipnet/ZipCouriers.sol';
import {ZipMerchants} from 'zipnet/ZipMerchants.sol';
import {ZipProcessooor} from 'zipnet/ZipProcessooor.sol';
import {ZipRezip} from 'zipnet/ZipRezip.sol';

import {ZipnetBase} from './ZipnetBase.sol';

/// @dev Stands in for a contract (a Safe) holding a stake; its signatures are never accepted as evidence
contract StakeHolder {
  function run(address _to, bytes calldata _data) external {
    (bool _ok, bytes memory _ret) = _to.call(_data);
    if (!_ok) {
      assembly {
        revert(add(_ret, 32), mload(_ret))
      }
    }
  }
}

/**
 * Review 2 regressions for the evidence the network slashes on: merchant invoices and courier receipts.
 * H-2: ECDSA-only verification (EIP-7702 / ERC-1271 self-voiding) and the separate signing key with delayed rotation.
 */
contract EvidenceTest is ZipnetBase {
  ZipCouriers internal couriers;
  ZipMerchants internal merchants;
  address internal courier;
  uint256 internal courierKey;
  address internal inspector = makeAddr('inspector');

  /// @dev The EIP-7702 delegation designator an EOA carries after one type-4 transaction (0xef0100 || delegate)
  bytes internal designator = abi.encodePacked(hex'ef0100', address(0xBEEF));
  bytes internal constant ANY_CALL = hex'01';

  function setUp() public virtual override {
    super.setUp();
    couriers = new ZipCouriers(IPrivacyPool(address(pool)), 1000 ether);
    merchants = new ZipMerchants(IERC20(address(zc)), 1000 ether);
    (courier, courierKey) = makeAddrAndKey('courier');
    zc.mint(courier, 10_000 ether);
    vm.startPrank(courier);
    zc.approve(address(couriers), 10_000 ether);
    couriers.bond(10_000 ether, 'https://c.example');
    vm.stopPrank();
  }

  // --------------------------------------------------------------------------------------------------------------
  // helpers
  // --------------------------------------------------------------------------------------------------------------

  function _sig(uint256 _key, bytes32 _digest) internal pure returns (bytes memory) {
    (uint8 _v, bytes32 _r, bytes32 _s) = vm.sign(_key, _digest);
    return abi.encodePacked(_r, _s, _v);
  }

  function _register(address _who) internal returns (uint256 _id) {
    zc.mint(_who, 1000 ether);
    vm.startPrank(_who);
    zc.approve(address(merchants), 1000 ether);
    _id = merchants.register(_who, 1000 ether, '');
    vm.stopPrank();
  }

  function _untaxed(uint256 _id, bytes32 _order) internal view returns (ZipMerchants.Invoice memory) {
    return ZipMerchants.Invoice(_id, 50 ether, _order, ZipMerchants.Route.UNTAXED, uint64(block.timestamp + 1 days));
  }

  function _commitInvoice(address _by, ZipMerchants.Invoice memory _inv) internal {
    vm.prank(_by);
    merchants.commitReport(merchants.reportCommitment(merchants.invoiceDigest(_inv), _by, 0));
    vm.roll(block.number + 1);
  }

  // --------------------------------------------------------------------------------------------------------------
  // H-2: EIP-7702 delegated signers can no longer void their evidence
  // --------------------------------------------------------------------------------------------------------------

  function test_h2_delegatedMerchantEoa_stillSlashed() public {
    (address _m, uint256 _mKey) = makeAddrAndKey('merchant');
    uint256 _id = _register(_m);
    ZipMerchants.Invoice memory _inv = _untaxed(_id, 'order-1');
    bytes memory _s = _sig(_mKey, merchants.invoiceDigest(_inv));
    _commitInvoice(inspector, _inv);

    vm.etch(_m, designator); // one type-4 transaction later
    assertGt(_m.code.length, 0);
    vm.prank(inspector);
    merchants.report(_inv, _s, 0);
    assertEq(zc.balanceOf(inspector), 500 ether, 'the ECDSA signature still slashes');
  }

  function test_h2_delegatedCourierEoa_signatureStillAccepted() public {
    ZipCouriers.Receipt memory _r = _anyReceipt(courier);
    bytes memory _s = _sig(courierKey, couriers.receiptDigest(_r));
    vm.prank(inspector);
    couriers.commitReport(couriers.reportCommitment(couriers.receiptDigest(_r), inspector, 0));
    vm.roll(block.number + 1);
    vm.etch(courier, designator);
    vm.prank(inspector);
    vm.expectRevert(ZipCouriers.NotSlashable.selector); // past the signature check: its conditions are what decide
    couriers.report(_r, _s, 0, address(entrypoint), ANY_CALL);
  }

  function test_h2_contractSignatureIsNeverEvidence() public {
    // A contract signer has no ECDSA key: a signature blob it would "approve" under ERC-1271 is just bad
    StakeHolder _safe = new StakeHolder();
    uint256 _id = _register(address(_safe));
    ZipMerchants.Invoice memory _inv = _untaxed(_id, 'order-2');
    _commitInvoice(inspector, _inv);
    vm.prank(inspector);
    vm.expectRevert(ZipMerchants.BadSignature.selector);
    merchants.report(_inv, hex'1234', 0);
  }

  // --------------------------------------------------------------------------------------------------------------
  // H-2: separate signing keys
  // --------------------------------------------------------------------------------------------------------------

  function test_h2_safeMerchantWithSigningKey_isEnforceable() public {
    StakeHolder _safe = new StakeHolder();
    (address _key, uint256 _pk) = makeAddrAndKey('shop-key');
    zc.mint(address(_safe), 1000 ether);
    _safe.run(address(zc), abi.encodeCall(IERC20.approve, (address(merchants), 1000 ether)));
    _safe.run(
      address(merchants), abi.encodeCall(ZipMerchants.registerWithKey, (address(_safe), 1000 ether, 'shop', _key))
    );
    uint256 _id = merchants.merchantCount();
    (address _cur,,,) = merchants.signingKeysOf(_id);
    assertEq(_cur, _key);

    ZipMerchants.Invoice memory _inv = _untaxed(_id, 'order-3');
    bytes memory _s = _sig(_pk, merchants.invoiceDigest(_inv));
    _commitInvoice(inspector, _inv);
    vm.etch(_key, designator); // the key delegating doesn't help either
    vm.prank(inspector);
    merchants.report(_inv, _s, 0);
    assertEq(zc.balanceOf(inspector), 500 ether);
  }

  function test_h2_merchantRotation_oldKeyValidForTheWindow_newKeyAtOnce() public {
    (address _m, uint256 _mKey) = makeAddrAndKey('rotating');
    (address _k2, uint256 _pk2) = makeAddrAndKey('rotating-2');
    uint256 _id = _register(_m);
    uint256 _t0 = block.timestamp;

    ZipMerchants.Invoice memory _old = _untaxed(_id, 'before');
    bytes memory _oldSig = _sig(_mKey, merchants.invoiceDigest(_old));

    vm.prank(_m);
    merchants.rotateSigningKey(_id, _k2);
    vm.prank(_m);
    vm.expectRevert(SigningKeys.RotationPending.selector);
    merchants.rotateSigningKey(_id, makeAddr('third'));
    vm.prank(makeAddr('stranger'));
    vm.expectRevert(ZipMerchants.NotMerchant.selector);
    merchants.rotateSigningKey(_id, makeAddr('third'));

    // In force after EXIT_DELAY; the old key is still accepted for another EXIT_DELAY, then no more
    vm.warp(_t0 + 14 days);
    (address _cur, address _pending, address _prev, uint64 _until) = merchants.signingKeysOf(_id);
    assertEq(_cur, _k2);
    assertEq(_pending, address(0));
    assertEq(_prev, _m);
    assertEq(_until, _t0 + 28 days);

    // Old evidence, reported inside the window, slashes
    ZipMerchants.Invoice memory _new = _untaxed(_id, 'after');
    bytes memory _newSig = _sig(_pk2, merchants.invoiceDigest(_new));
    uint256 _snap = vm.snapshotState();
    _commitInvoice(inspector, _old);
    vm.prank(inspector);
    merchants.report(_old, _oldSig, 0);
    vm.revertToState(_snap);

    // After the window only the new key counts
    vm.warp(_t0 + 28 days + 1);
    _commitInvoice(inspector, _old);
    vm.prank(inspector);
    vm.expectRevert(ZipMerchants.BadSignature.selector);
    merchants.report(_old, _oldSig, 0);
    _commitInvoice(inspector, _new);
    vm.prank(inspector);
    merchants.report(_new, _newSig, 0);
    assertEq(zc.balanceOf(inspector), 500 ether);
  }

  function test_h2_courierSigningKey_bondWithKey_andRotation() public {
    (address _c, uint256 _cKey) = makeAddrAndKey('safe-courier');
    (address _key, uint256 _pk) = makeAddrAndKey('courier-key');
    zc.mint(_c, 2000 ether);
    vm.startPrank(_c);
    zc.approve(address(couriers), 2000 ether);
    couriers.bondWithKey(1000 ether, 'https://s.example', _key);
    vm.expectRevert(ZipCouriers.AlreadyBonded.selector);
    couriers.bondWithKey(1000 ether, 'https://s.example', _key);
    vm.stopPrank();

    ZipCouriers.Receipt memory _r = _anyReceipt(_c);
    bytes32 _d = couriers.receiptDigest(_r);
    vm.prank(inspector);
    couriers.commitReport(couriers.reportCommitment(_d, inspector, 0));
    vm.roll(block.number + 1);

    // The courier address itself is not the key: only `_key` signs
    vm.prank(inspector);
    vm.expectRevert(ZipCouriers.BadSignature.selector);
    couriers.report(_r, _sig(_cKey, _d), 0, address(entrypoint), ANY_CALL);
    vm.prank(inspector);
    vm.expectRevert(ZipCouriers.NotSlashable.selector);
    couriers.report(_r, _sig(_pk, _d), 0, address(entrypoint), ANY_CALL);

    // Rotation: the new key at once, the old one until two UNBOND_DELAYs from the request
    (address _k2, uint256 _pk2) = makeAddrAndKey('courier-key-2');
    uint256 _t0 = block.timestamp;
    vm.prank(_c);
    couriers.rotateSigningKey(_k2);
    vm.prank(inspector);
    vm.expectRevert(ZipCouriers.NotSlashable.selector);
    couriers.report(_r, _sig(_pk2, _d), 0, address(entrypoint), ANY_CALL);
    vm.warp(_t0 + 28 days);
    vm.prank(inspector);
    vm.expectRevert(ZipCouriers.NotSlashable.selector);
    couriers.report(_r, _sig(_pk, _d), 0, address(entrypoint), ANY_CALL);
    vm.warp(_t0 + 28 days + 1);
    vm.prank(inspector);
    vm.expectRevert(ZipCouriers.BadSignature.selector);
    couriers.report(_r, _sig(_pk, _d), 0, address(entrypoint), ANY_CALL);
  }

  /// @dev A receipt whose conditions are not met (its deadline is far away): report gets past the signature, then stops
  function _anyReceipt(address _c) internal view virtual returns (ZipCouriers.Receipt memory) {
    return
      ZipCouriers.Receipt(_c, 1, couriers.jobHashOf(address(entrypoint), ANY_CALL), uint64(block.timestamp + 365 days));
  }

  // --------------------------------------------------------------------------------------------------------------
  // H-1: a receipt binds the job, and a report delivers it; a user can't make its own job fail and then slash
  // --------------------------------------------------------------------------------------------------------------

  address internal attacker = makeAddr('attacker');

  function _receiptFor(uint256 _nullifierHash, address _target, bytes memory _call)
    internal
    view
    returns (ZipCouriers.Receipt memory _r, bytes memory _s)
  {
    _r = ZipCouriers.Receipt(
      courier, _nullifierHash, couriers.jobHashOf(_target, _call), uint64(block.timestamp + 1 hours)
    );
    _s = _sig(courierKey, couriers.receiptDigest(_r));
  }

  function _commitReceipt(address _by, ZipCouriers.Receipt memory _r) internal {
    vm.prank(_by);
    couriers.commitReport(couriers.reportCommitment(couriers.receiptDigest(_r), _by, 0));
  }

  function _relayCall(Note memory _n, address _to)
    internal
    returns (bytes memory _call, IPrivacyPool.Withdrawal memory _w, ProofLib.WithdrawProof memory _p)
  {
    _w = IPrivacyPool.Withdrawal(
      address(entrypoint), abi.encode(IEntrypoint.RelayData({recipient: _to, feeRecipient: courier, relayFeeBPS: 0}))
    );
    (_p,) = _prove(_n, _n.value, _w);
    _call = abi.encodeCall(entrypoint.relay, (_w, _p, scope));
  }

  function _stakeOf(address _c) internal view returns (uint256 _stake) {
    (_stake,,) = couriers.couriers(_c);
  }

  struct RezipJob {
    ZipRezip rezip;
    uint256 pre;
    IPrivacyPool.Withdrawal w;
    ProofLib.WithdrawProof p;
    bytes call;
    ZipCouriers.Receipt r;
    bytes s;
  }

  /// @dev A held rezip of all of `_owner`'s new 10 ZC note, with the courier's signed receipt for exactly that call
  function _rezipJob(address _owner) internal returns (RezipJob memory _j) {
    _j.rezip = new ZipRezip(IPrivacyPool(address(pool)));
    Note memory _n = _zip(_owner, 10 ether);
    (uint256 _rn, uint256 _rs) = _secrets();
    _j.pre = _precommitment(_rn, _rs);
    ZipRezip.Send memory _send = ZipRezip.Send(_j.pre, hex'', ZipProcessooor.Courier(courier, 1 ether));
    _j.w = IPrivacyPool.Withdrawal(address(_j.rezip), abi.encode(_send));
    (_j.p,) = _prove(_n, 10 ether, _j.w);
    _j.call = abi.encodeCall(ZipRezip.rezip, (_j.w, _j.p));
    // The courier simulates (passes) and signs a receipt for exactly this job
    uint256 _snap = vm.snapshotState();
    _j.rezip.rezip(_j.w, _j.p);
    vm.revertToState(_snap);
    (_j.r, _j.s) = _receiptFor(_j.p.pubSignals[1], address(_j.rezip), _j.call);
  }

  /// The review's PoC (test_poc_ffi_rezipPoisonedAfterReceipt_slashesHonestCourier), now a regression test
  function test_h1_poc_rezipPoisonedAfterReceipt_isNotSlashable() public {
    RezipJob memory _j = _rezipJob(attacker);

    // The attacker poisons its own precommitment, so every delivery reverts
    zc.mint(attacker, 1 ether);
    vm.startPrank(attacker);
    zc.approve(address(entrypoint), 1 ether);
    entrypoint.deposit(IERC20(address(zc)), 1 ether, _j.pre);
    vm.stopPrank();
    _commitReceipt(attacker, _j.r);
    vm.prank(courier);
    vm.expectRevert(IEntrypoint.PrecommitmentAlreadyUsed.selector);
    _j.rezip.rezip(_j.w, _j.p);

    vm.roll(block.number + 1);
    vm.warp(block.timestamp + 1 hours + 1);
    vm.prank(attacker);
    vm.expectRevert(ZipCouriers.NotSlashable.selector); // the report tries the delivery; it can't succeed
    couriers.report(_j.r, _j.s, 0, address(_j.rezip), _j.call);
    assertEq(_stakeOf(courier), 10_000 ether, 'the honest courier keeps its stake');
    assertEq(zc.balanceOf(attacker), 0);
  }

  /// A missed rezip that can still be delivered: the report delivers it (the user gets its note) and slashes
  function test_h1_missedRezip_reportDeliversAndSlashes() public {
    RezipJob memory _j = _rezipJob(makeAddr('user'));
    _commitReceipt(inspector, _j.r);
    vm.roll(block.number + 1);
    vm.warp(block.timestamp + 1 hours + 1);
    uint256 _poolBefore = zc.balanceOf(address(pool));
    vm.prank(inspector);
    couriers.report(_j.r, _j.s, 0, address(_j.rezip), _j.call);
    assertEq(zc.balanceOf(inspector), 500 ether);
    assertEq(_stakeOf(courier), 9000 ether);
    assertTrue(pool.nullifierHashes(_j.p.pubSignals[1]), 'delivered');
    assertEq(zc.balanceOf(address(pool)), _poolBefore - 1 ether, 'the rezipped 9 ZC went back into the pool');
  }

  /// One note, many receipts (a proof per state root, a different job each): only one slash, and only one delivery
  function test_h1_oneSlashPerNullifier() public {
    Note memory _n = _zip(makeAddr('user'), 10 ether);
    (bytes memory _c1,,) = _relayCall(_n, makeAddr('dest-1'));
    _zip(makeAddr('other'), 10 ether); // a new state root and ASP root; the first proof goes stale
    (bytes memory _c2,,) = _relayCall(_n, makeAddr('dest-2'));
    uint256 _nh = PoseidonT2.hash([_n.nullifier]);
    (ZipCouriers.Receipt memory _r1, bytes memory _s1) = _receiptFor(_nh, address(entrypoint), _c1);
    (ZipCouriers.Receipt memory _r2, bytes memory _s2) = _receiptFor(_nh, address(entrypoint), _c2);
    _commitReceipt(inspector, _r1);
    _commitReceipt(inspector, _r2);
    vm.roll(block.number + 1);
    vm.warp(block.timestamp + 1 hours + 1);

    vm.startPrank(inspector);
    vm.expectRevert(ZipCouriers.NotSlashable.selector); // stale proof: not deliverable now
    couriers.report(_r1, _s1, 0, address(entrypoint), _c1);
    couriers.report(_r2, _s2, 0, address(entrypoint), _c2);
    vm.expectRevert(ZipCouriers.NotSlashable.selector); // the note is spent now
    couriers.report(_r1, _s1, 0, address(entrypoint), _c1);
    vm.stopPrank();
    assertEq(_stakeOf(courier), 9000 ether);
    assertEq(zc.balanceOf(makeAddr('dest-2')), 10 ether);
  }

  /// Batch: the user spends the second note elsewhere after the receipt. The batch can't be delivered: no slash
  function test_h1_batchWithSecondNoteSpent_isNotSlashable() public {
    BatchRelayer _batch = new BatchRelayer(500);
    Note memory _a = _zip(attacker, 70 ether);
    Note memory _b = _zip(attacker, 50 ether);
    IPrivacyPool.Withdrawal memory _w = IPrivacyPool.Withdrawal(
      address(_batch),
      abi.encode(
        IBatchRelayer.BatchRelayData({
          recipient: attacker, feeRecipient: courier, relayFeeBPS: 100, batchSize: 2, totalValue: 120 ether
        })
      )
    );
    ProofLib.WithdrawProof[] memory _proofs = new ProofLib.WithdrawProof[](2);
    (_proofs[0],) = _prove(_a, 70 ether, _w);
    (_proofs[1],) = _prove(_b, 50 ether, _w);
    bytes memory _call = abi.encodeCall(_batch.batchRelay, (IPrivacyPool(address(pool)), _w, _proofs));
    (ZipCouriers.Receipt memory _r, bytes memory _s) = _receiptFor(_proofs[0].pubSignals[1], address(_batch), _call);

    // note 2 goes elsewhere
    (, IPrivacyPool.Withdrawal memory _w2, ProofLib.WithdrawProof memory _p2) = _relayCall(_b, attacker);
    entrypoint.relay(_w2, _p2, scope);

    _commitReceipt(attacker, _r);
    vm.roll(block.number + 1);
    vm.warp(block.timestamp + 1 hours + 1);
    vm.prank(attacker);
    vm.expectRevert(ZipCouriers.NotSlashable.selector);
    couriers.report(_r, _s, 0, address(_batch), _call);
    assertEq(_stakeOf(courier), 10_000 ether);
  }

  /// A receipt can never make this contract call the ZC token (it could move the stakes) or itself
  function test_h1_forbiddenTargets() public {
    bytes memory _steal = abi.encodeCall(IERC20.transfer, (attacker, 10_000 ether));
    (ZipCouriers.Receipt memory _r, bytes memory _s) = _receiptFor(1, address(zc), _steal);
    _commitReceipt(attacker, _r);
    bytes memory _self = abi.encodeCall(ZipCouriers.claim, ());
    (ZipCouriers.Receipt memory _r2, bytes memory _s2) = _receiptFor(1, address(couriers), _self);
    _commitReceipt(attacker, _r2);
    vm.roll(block.number + 1);
    vm.warp(block.timestamp + 1 hours + 1);
    vm.startPrank(attacker);
    vm.expectRevert(ZipCouriers.WrongJob.selector);
    couriers.report(_r, _s, 0, address(zc), _steal);
    vm.expectRevert(ZipCouriers.WrongJob.selector);
    couriers.report(_r2, _s2, 0, address(couriers), _self);
    vm.stopPrank();
  }

  // --------------------------------------------------------------------------------------------------------------
  // L-1: the offender can't take its own bounty
  // --------------------------------------------------------------------------------------------------------------

  /// The review's PoC (test_poc_merchantPreCommitsSelfReport_takesTheBounty), now a regression test
  function test_l1_poc_merchantPreCommittedSelfReport_isRefused_inspectorIsPaid() public {
    (address _m, uint256 _mKey) = makeAddrAndKey('merchant2');
    uint256 _id = _register(_m);
    ZipMerchants.Invoice memory _inv = _untaxed(_id, 'order-2');
    bytes32 _d = merchants.invoiceDigest(_inv);
    bytes memory _s = _sig(_mKey, _d);

    vm.prank(_m); // at signing time, a cheap insurance commit
    merchants.commitReport(merchants.reportCommitment(_d, _m, bytes32('x')));
    vm.roll(block.number + 100);
    // Pointing a field it controls at the inspector doesn't block the inspector
    vm.prank(_m);
    merchants.update(_id, inspector, '');
    _commitInvoice(inspector, _inv);

    vm.prank(_m); // tries to front-run the inspector's reveal
    vm.expectRevert(ZipMerchants.SelfReport.selector);
    merchants.report(_inv, _s, bytes32('x'));

    vm.prank(inspector);
    merchants.report(_inv, _s, 0);
    assertEq(zc.balanceOf(inspector), 500 ether, 'the inspector gets the bounty');
    assertEq(zc.balanceOf(_m), 0);
  }

  function test_l1_signingKeyCantReportItsOwnInvoice() public {
    StakeHolder _safe = new StakeHolder();
    (address _key, uint256 _pk) = makeAddrAndKey('shop-key-2');
    zc.mint(address(_safe), 1000 ether);
    _safe.run(address(zc), abi.encodeCall(IERC20.approve, (address(merchants), 1000 ether)));
    _safe.run(address(merchants), abi.encodeCall(ZipMerchants.registerWithKey, (address(_safe), 1000 ether, '', _key)));
    ZipMerchants.Invoice memory _inv = _untaxed(merchants.merchantCount(), 'order-4');
    bytes memory _s = _sig(_pk, merchants.invoiceDigest(_inv));
    _commitInvoice(_key, _inv);
    vm.prank(_key);
    vm.expectRevert(ZipMerchants.SelfReport.selector);
    merchants.report(_inv, _s, 0);
  }

  function test_l1_courierCantReportItsOwnReceipt() public {
    ZipCouriers.Receipt memory _r = _anyReceipt(courier);
    bytes32 _d = couriers.receiptDigest(_r);
    vm.prank(courier);
    couriers.commitReport(couriers.reportCommitment(_d, courier, 0));
    vm.roll(block.number + 1);
    vm.prank(courier);
    vm.expectRevert(ZipCouriers.SelfReport.selector);
    couriers.report(_r, _sig(courierKey, _d), 0, address(entrypoint), ANY_CALL);
  }
}
