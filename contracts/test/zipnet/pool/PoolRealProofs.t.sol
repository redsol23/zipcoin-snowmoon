// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from '@oz/proxy/ERC1967/ERC1967Proxy.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {Vm} from 'forge-std/Vm.sol';
import {PoseidonT2} from 'poseidon/PoseidonT2.sol';

import {Entrypoint} from 'contracts/Entrypoint.sol';
import {Constants} from 'contracts/lib/Constants.sol';
import {PrivacyPoolComplex} from 'contracts/implementations/PrivacyPoolComplex.sol';
import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {CommitmentVerifier} from 'contracts/verifiers/CommitmentVerifier.sol';
import {WithdrawalVerifier} from 'contracts/verifiers/WithdrawalVerifier.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {ZipPrivacyPool} from 'zipnet/ZipPrivacyPool.sol';

import {MockZC, ZipnetBase} from '../ZipnetBase.sol';

/**
 * @notice Differential run with REAL Groth16 proofs (the 0xbow withdrawal and commitment circuits, via the same FFI
 *         prover the other suites use) and the production verifiers: upstream PrivacyPoolComplex and ZipPrivacyPool
 *         at the same address, a scripted deposit / relay / harvest / withdraw / ragequit / replay / stolen-ragequit
 *         sequence, identical results required at every step. Proofs are generated once (on the upstream run) and
 *         reused verbatim on the zip run, which is itself a check: a proof made against upstream verifies on ZipPrivacyPool.
 *
 *         It also grounds the fuzzing model (PoolModel.sol): the public signals the model predicts equal the ones the
 *         real circuits output.
 *
 *   forge test --match-path test/zipnet/pool/PoolRealProofs.t.sol   (needs node + packages/sdk dependencies)
 */
contract PoolRealProofsTest is ZipnetBase {
  using ProofLib for ProofLib.WithdrawProof;
  using ProofLib for ProofLib.RagequitProof;

  uint256 internal constant STEPS = 11;

  struct Cache {
    bool filled;
    ProofLib.WithdrawProof relayA;
    ProofLib.WithdrawProof directB;
    ProofLib.RagequitProof exitA2;
    ProofLib.RagequitProof exitB2;
    uint256 aspRoot;
  }

  struct Obs {
    bool ok;
    bytes32 ret;
    bytes32 logs;
    bytes32 state;
  }

  address internal alice = makeAddr('alice');
  address internal bob = makeAddr('bob');
  address internal carol = makeAddr('carol');
  address internal relayer = makeAddr('relayer');
  address internal withdrawalVerifier;
  address internal ragequitVerifier;
  bool internal zipRun;
  uint256 internal nextSecret;

  function setUp() public override {
    zc = new MockZC();
    address _impl = address(new Entrypoint());
    entrypoint =
      Entrypoint(payable(address(new ERC1967Proxy(_impl, abi.encodeCall(Entrypoint.initialize, (owner, postman))))));
    withdrawalVerifier = address(new WithdrawalVerifier());
    ragequitVerifier = address(new CommitmentVerifier());
  }

  function test_realProofs_upstreamAndZipAgreeStepByStep() public {
    Cache memory _cache;
    uint256 _snap = vm.snapshotState();
    Obs[] memory _a = _run(false, _cache);
    vm.revertToState(_snap);
    Obs[] memory _b = _run(true, _cache);
    for (uint256 _i; _i < STEPS; ++_i) {
      string memory _at = string.concat('step ', vm.toString(_i));
      assertEq(_a[_i].state, _b[_i].state, string.concat(_at, ': state'));
      if (_i == 5) continue; // harvest
      assertEq(_a[_i].ok, _b[_i].ok, string.concat(_at, ': success'));
      assertEq(_a[_i].ret, _b[_i].ret, string.concat(_at, ': return data'));
      assertEq(_a[_i].logs, _b[_i].logs, string.concat(_at, ': events'));
    }
    bool[STEPS] memory _okWant = [true, true, true, true, true, true, true, true, false, false, true];
    for (uint256 _i; _i < STEPS; ++_i) {
      assertEq(_b[_i].ok, _okWant[_i], string.concat('outcome of step ', vm.toString(_i)));
    }
  }

  // ------------------------------------------------------------------------------------------------------------

  function _run(bool _zip, Cache memory _c) internal returns (Obs[] memory _o) {
    zipRun = _zip;
    if (_zip) {
      pool = new ZipPrivacyPool(address(entrypoint), withdrawalVerifier, ragequitVerifier, address(zc), poolTreasury);
    } else {
      pool = ZipPrivacyPool(
        payable(address(new PrivacyPoolComplex(address(entrypoint), withdrawalVerifier, ragequitVerifier, address(zc))))
      );
    }
    vm.prank(owner);
    entrypoint.registerPool(IERC20(address(zc)), IPrivacyPool(address(pool)), 1 ether, 0, 500);
    scope = pool.SCOPE();
    delete stateLeaves;
    delete aspLeaves;

    _o = new Obs[](STEPS);
    Note memory _nA;
    Note memory _nB;
    Note memory _a2;
    Note memory _b2;

    // 0, 1: deposits
    vm.recordLogs();
    _nA = _depositNote(alice, 100 ether);
    _o[0] = _observe(true, '');
    vm.recordLogs();
    _nB = _depositNote(bob, 50 ether);
    _o[1] = _observe(true, '');

    // 2: the ASP approves both labels (a real LeanIMT root, as the circuit needs)
    vm.recordLogs();
    aspLeaves.push(_nA.label);
    aspLeaves.push(_nB.label);
    if (!_c.filled) _c.aspRoot = _root(aspLeaves);
    vm.prank(postman);
    entrypoint.updateRoot(_c.aspRoot, 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi');
    _o[2] = _observe(true, '');

    // 3: relayed withdraw of 40 from alice's note to carol, 1% to the relayer
    IPrivacyPool.Withdrawal memory _w = IPrivacyPool.Withdrawal(
      address(entrypoint),
      abi.encode(IEntrypoint.RelayData({recipient: carol, feeRecipient: relayer, relayFeeBPS: 100}))
    );
    (_c.relayA, _a2) = _proveCached(_c.filled, _c.relayA, _nA, 40 ether, _w);
    if (!_c.filled) _checkModelSignals(_c.relayA, _nA, _a2, 40 ether, _w);
    vm.recordLogs();
    vm.prank(relayer);
    (bool _ok, bytes memory _ret) = address(entrypoint).call(abi.encodeCall(entrypoint.relay, (_w, _c.relayA, scope)));
    stateLeaves.push(_c.relayA.newCommitmentHash());
    _o[3] = _observe(_ok, _ret);

    // 4: ZC pays ETH rewards; 5: harvest (zip only)
    vm.recordLogs();
    vm.deal(address(this), 1 ether);
    zc.distributeRewards{value: 1 ether}();
    _o[4] = _observe(true, '');
    vm.recordLogs();
    if (_zip) {
      uint256 _pending = zc.pendingReward(address(pool));
      assertGt(_pending, 0);
      assertEq(pool.harvest(), _pending);
      assertEq(poolTreasury.balance, _pending, 'TREASURY got the claim');
    }
    _o[5] = _observe(true, '');

    // 6: bob withdraws 10 directly (he is the processooor)
    IPrivacyPool.Withdrawal memory _d = IPrivacyPool.Withdrawal(bob, '');
    (_c.directB, _b2) = _proveCached(_c.filled, _c.directB, _nB, 10 ether, _d);
    vm.recordLogs();
    vm.prank(bob);
    (_ok, _ret) = address(pool).call(abi.encodeCall(pool.withdraw, (_d, _c.directB)));
    stateLeaves.push(_c.directB.newCommitmentHash());
    _o[6] = _observe(_ok, _ret);

    // 7: alice ragequits her 60 change
    if (!_c.filled) {
      _c.exitA2 = _exit(_a2);
      assertEq(_c.exitA2.commitmentHash(), _commitment(_a2), 'model: ragequit commitment');
      assertEq(_c.exitA2.nullifierHash(), PoseidonT2.hash([_a2.nullifier]), 'model: ragequit nullifier hash');
      assertEq(_c.exitA2.value(), 60 ether, 'model: ragequit value');
      assertEq(_c.exitA2.label(), _nA.label, 'model: ragequit label');
    }
    vm.recordLogs();
    vm.prank(alice);
    (_ok, _ret) = address(pool).call(abi.encodeCall(pool.ragequit, (_c.exitA2)));
    _o[7] = _observe(_ok, _ret);

    // 8: the relay proof replayed
    vm.recordLogs();
    vm.prank(relayer);
    (_ok, _ret) = address(entrypoint).call(abi.encodeCall(entrypoint.relay, (_w, _c.relayA, scope)));
    _o[8] = _observe(_ok, _ret);

    // 9: carol submits bob's ragequit proof; 10: bob does
    if (!_c.filled) _c.exitB2 = _exit(_b2);
    vm.recordLogs();
    vm.prank(carol);
    (_ok, _ret) = address(pool).call(abi.encodeCall(pool.ragequit, (_c.exitB2)));
    _o[9] = _observe(_ok, _ret);
    vm.recordLogs();
    vm.prank(bob);
    (_ok, _ret) = address(pool).call(abi.encodeCall(pool.ragequit, (_c.exitB2)));
    _o[10] = _observe(_ok, _ret);

    assertEq(zc.balanceOf(carol), 39.6 ether);
    assertEq(zc.balanceOf(bob), 50 ether);
    assertEq(zc.balanceOf(alice), 60 ether);
    assertEq(zc.balanceOf(address(pool)), 0, 'everyone is out');
    _c.filled = true;
  }

  function _depositNote(address _who, uint256 _value) internal returns (Note memory _n) {
    uint256 _nullifier = uint256(keccak256(abi.encode('real-n', ++nextSecret))) % Constants.SNARK_SCALAR_FIELD;
    uint256 _secret = uint256(keccak256(abi.encode('real-s', nextSecret))) % Constants.SNARK_SCALAR_FIELD;
    zc.mint(_who, _value);
    vm.startPrank(_who);
    zc.approve(address(entrypoint), _value);
    uint256 _cm = entrypoint.deposit(IERC20(address(zc)), _value, _precommitment(_nullifier, _secret));
    vm.stopPrank();
    uint256 _label = uint256(keccak256(abi.encodePacked(scope, pool.nonce()))) % Constants.SNARK_SCALAR_FIELD;
    _n = Note(_value, _label, _nullifier, _secret);
    assertEq(_commitment(_n), _cm, 'commitment mirror');
    stateLeaves.push(_cm);
  }

  function _proveCached(
    bool _filled,
    ProofLib.WithdrawProof memory _cached,
    Note memory _n,
    uint256 _amount,
    IPrivacyPool.Withdrawal memory _w
  ) internal returns (ProofLib.WithdrawProof memory _p, Note memory _change) {
    if (!_filled) return _prove(_n, _amount, _w);
    // Re-derive the change note exactly as _prove does (same salt sequence on both runs)
    (uint256 _nn, uint256 _ns) = _secrets();
    _change = Note(_n.value - _amount, _n.label, _nn, _ns);
    _p = _cached;
    assertEq(_p.newCommitmentHash(), _commitment(_change), 'cached proof matches the replayed change note');
  }

  function _exit(Note memory _n) internal returns (ProofLib.RagequitProof memory) {
    string[] memory _a = new string[](5);
    _a[0] = 'exit';
    _a[1] = vm.toString(_n.value);
    _a[2] = vm.toString(_n.label);
    _a[3] = vm.toString(_n.nullifier);
    _a[4] = vm.toString(_n.secret);
    return abi.decode(_ffi(_a), (ProofLib.RagequitProof));
  }

  /// @dev The real circuit's public signals equal what PoolModel's prover would attest
  function _checkModelSignals(
    ProofLib.WithdrawProof memory _p,
    Note memory _n,
    Note memory _change,
    uint256 _amount,
    IPrivacyPool.Withdrawal memory _w
  ) internal view {
    assertEq(_p.newCommitmentHash(), _commitment(_change), 'model: new commitment');
    assertEq(_p.existingNullifierHash(), PoseidonT2.hash([_n.nullifier]), 'model: nullifier hash = Poseidon(nullifier)');
    assertEq(_p.withdrawnValue(), _amount, 'model: withdrawn value');
    assertEq(_p.stateRoot(), pool.currentRoot(), 'model: state root = the pool root');
    assertEq(_p.stateTreeDepth(), pool.currentTreeDepth(), 'model: state depth');
    assertEq(_p.ASPRoot(), entrypoint.latestRoot(), 'model: ASP root = latest');
    assertEq(_p.context(), _context(_w), 'model: context');
  }

  function _observe(bool _ok, bytes memory _ret) internal returns (Obs memory _o) {
    _o.ok = _ok;
    _o.ret = keccak256(_ret);
    Vm.Log[] memory _logs = vm.getRecordedLogs();
    for (uint256 _i; _i < _logs.length; ++_i) {
      _o.logs = keccak256(abi.encode(_o.logs, _logs[_i].emitter, _logs[_i].topics, _logs[_i].data));
    }
    _o.state = keccak256(
      abi.encode(
        pool.currentRoot(),
        pool.currentTreeSize(),
        pool.currentTreeDepth(),
        pool.currentRootIndex(),
        pool.nonce(),
        zc.balanceOf(address(pool)),
        zc.balanceOf(alice),
        zc.balanceOf(bob),
        zc.balanceOf(carol),
        zc.balanceOf(relayer),
        address(pool).balance
      )
    );
    for (uint256 _s; _s < 10; ++_s) {
      _o.state = keccak256(abi.encode(_o.state, vm.load(address(pool), bytes32(_s))));
    }
  }
}
