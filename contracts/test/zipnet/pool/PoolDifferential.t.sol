// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {Vm} from 'forge-std/Vm.sol';

import {PrivacyPoolComplex} from 'contracts/implementations/PrivacyPoolComplex.sol';
import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {ZipPrivacyPool} from 'zipnet/ZipPrivacyPool.sol';

import {PoolModel} from './PoolModel.sol';

/// @notice Upstream with one silent change (a bumped nonce at construction), to prove the harness notices a divergence
contract ShiftedPool is PrivacyPoolComplex {
  constructor(address _e, address _w, address _r, address _a) PrivacyPoolComplex(_e, _w, _r, _a) {
    nonce = 7;
  }
}

/**
 * @notice DIFFERENTIAL test: upstream 0xbow PrivacyPoolComplex vs ZipPrivacyPool.
 *
 * Both run in the same EVM "universe" twice: the test snapshots the state, deploys upstream, runs a sequence of
 * operations recording an observation after every step, reverts to the snapshot, deploys ZipPrivacyPool at the SAME
 * address (same deployer nonce, so the same SCOPE, labels, commitments, contexts and roots), replays the same sequence,
 * and requires every observation to match:
 *   - the call's success and its return / revert data,
 *   - every event emitted (emitter, topics, data),
 *   - the pool's state: root, size, depth, root index, the whole 64-root history, nonce, dead, raw storage slots 0-9,
 *     every depositor label and every nullifier the sequence touched, and the ZC balances of the pool, the Entrypoint
 *     and every actor, plus the pool's ETH.
 * The only exception is harvest(): upstream has none, so on that step the upstream run does nothing and the zip run
 * calls harvest(), and only the pool state is compared (harvest's events and TREASURY's ETH are the permitted diff).
 *
 * Sequences are fuzzed. Each step is one of: deposit (sometimes below the minimum, sometimes a reused precommitment),
 * relayed withdraw (sometimes over the max relay fee), direct withdraw, ragequit (sometimes by a non-depositor), ASP
 * root update (sometimes dropping a label), replay of a spent proof, front-run with a changed recipient, prove-now/
 * submit-later (stale state or ASP root), reward accrual, harvest, ZC donation, direct ETH send, wind-down.
 */
contract PoolDifferentialTest is PoolModel {
  uint256 internal constant STEPS = 24;
  uint256 internal constant OPS = 16;

  enum Kind {
    Upstream,
    Zip,
    Shifted
  }

  struct Obs {
    uint256 op;
    bool ok;
    bytes4 err;
    bytes32 ret;
    bytes32 logs;
    bytes32 state;
    uint256 root;
    uint256 nonce;
    uint256 poolZc;
  }

  address payable internal treasury = payable(makeAddr('diffTreasury'));
  address internal relayer = makeAddr('relayer');
  address internal funder = makeAddr('funder');
  address[4] internal actors;

  Kind internal kind;
  uint256 internal lastPrecommitment;
  // the last successful relay (for replays) and a proof held back for later
  IPrivacyPool.Withdrawal internal lastW;
  ProofLib.WithdrawProof internal lastP;
  bool internal hasLast;
  IPrivacyPool.Withdrawal internal heldW;
  ProofLib.WithdrawProof internal heldP;
  uint256 internal heldNote;
  Note internal heldChange;
  bool internal hasHeld;

  function setUp() public {
    actors = [makeAddr('alice'), makeAddr('bob'), makeAddr('carol'), makeAddr('dave')];
    _deployStack();
  }

  // ------------------------------------------------------------------------------------------------------------
  // the tests
  // ------------------------------------------------------------------------------------------------------------

  /// forge-config: default.fuzz.runs = 128
  /// forge-config: pooldeep.fuzz.runs = 2000
  function testFuzz_differential_randomSequences(uint256[STEPS] memory _ops) public {
    _compare(_ops);
  }

  /// @notice Every op kind in a fixed, meaningful order, so coverage never depends on the fuzzer's luck
  function test_differential_everyOpKind() public {
    uint256[STEPS] memory _ops;
    uint256[STEPS] memory _kinds =
      [uint256(0), 0, 1, 5, 2, 3, 6, 7, 10, 11, 8, 0, 5, 9, 4, 12, 13, 11, 10, 11, 14, 2, 3, 0];
    for (uint256 _i; _i < STEPS; ++_i) {
      _ops[_i] = (uint256(keccak256(abi.encode('fixed', _i))) << 8) | _kinds[_i];
    }
    _ops[20] = (_ops[20] & ~uint256(0xff00)) | 14; // wind-down fires (its gate reads bits 8-9)
    Obs[] memory _b = _compare(_ops);
    // The outcome of every step is pinned, so this test keeps exercising what it claims to
    bytes4[STEPS] memory _want = [
      bytes4(0), // deposit
      bytes4(keccak256('PrecommitmentAlreadyUsed()')), // deposit reusing a precommitment
      0, // deposit
      0xffffffff, // ASP root update (no call result)
      0, // relayed withdraw
      0, // direct withdraw
      bytes4(keccak256('NullifierAlreadySpent()')), // replay of the spent relay proof
      bytes4(keccak256('ContextMismatch()')), // front-run with a changed recipient
      0, // rewards accrue
      0, // harvest (zip)
      0xffffffff, // prove now, submit later
      0, // deposit
      0xffffffff, // ASP root update
      bytes4(keccak256('IncorrectASPRoot()')), // the held proof is stale now
      bytes4(keccak256('NullifierAlreadySpent()')), // ragequit of a spent note
      0, // ZC donation
      bytes4(keccak256('OnlyAsset()')), // direct ETH (upstream refuses too, with empty revert data)
      bytes4(keccak256('NothingToClaim()')), // harvest with nothing to claim
      0, // rewards accrue
      0, // harvest
      0, // wind-down
      0, // relayed withdraw after wind-down
      0, // direct withdraw after wind-down
      bytes4(keccak256('PoolIsDead()')) // deposit after wind-down
    ];
    for (uint256 _i; _i < STEPS; ++_i) {
      string memory _at = string.concat('step ', vm.toString(_i));
      if (_want[_i] == 0) assertTrue(_b[_i].ok, _at);
      else if (_want[_i] != 0xffffffff) assertEq(_b[_i].err, _want[_i], _at);
    }
  }

  /// @notice The harness has teeth: a pool that differs from upstream in one storage write fails the comparison
  function test_differential_detectsADivergence() public {
    uint256[STEPS] memory _ops;
    for (uint256 _i; _i < STEPS; ++_i) {
      _ops[_i] = (uint256(keccak256(abi.encode('teeth', _i))) << 8) | (_i < 3 ? 0 : 12);
    }
    vm.expectRevert();
    this.compareKinds(Kind.Upstream, Kind.Shifted, _ops);
    this.compareKinds(Kind.Upstream, Kind.Zip, _ops); // and the real pool passes the same sequence
  }

  // ------------------------------------------------------------------------------------------------------------
  // the harness
  // ------------------------------------------------------------------------------------------------------------

  function compareKinds(Kind _x, Kind _y, uint256[STEPS] memory _ops) external {
    _compareKinds(_x, _y, _ops);
  }

  function _compare(uint256[STEPS] memory _ops) internal returns (Obs[] memory) {
    return _compareKinds(Kind.Upstream, Kind.Zip, _ops);
  }

  function _compareKinds(Kind _x, Kind _y, uint256[STEPS] memory _ops) internal returns (Obs[] memory) {
    uint256 _snap = vm.snapshotState();
    Obs[] memory _a = _run(_x, _ops);
    vm.revertToState(_snap);
    Obs[] memory _b = _run(_y, _ops);

    for (uint256 _i; _i < STEPS; ++_i) {
      string memory _at = string.concat('step ', vm.toString(_i), ' op ', vm.toString(_a[_i].op));
      assertEq(_a[_i].op, _b[_i].op, _at);
      assertEq(_a[_i].root, _b[_i].root, string.concat(_at, ': root'));
      assertEq(_a[_i].nonce, _b[_i].nonce, string.concat(_at, ': nonce'));
      assertEq(_a[_i].poolZc, _b[_i].poolZc, string.concat(_at, ': pool ZC'));
      assertEq(_a[_i].state, _b[_i].state, string.concat(_at, ': state digest'));
      if (_a[_i].op == 11) continue; // harvest: state only
      assertEq(_a[_i].ok, _b[_i].ok, string.concat(_at, ': success'));
      if (_a[_i].op == 13) continue; // direct ETH: both refuse, with different revert data
      assertEq(_a[_i].ret, _b[_i].ret, string.concat(_at, ': return/revert data'));
      assertEq(_a[_i].logs, _b[_i].logs, string.concat(_at, ': events'));
    }
    return _b;
  }

  function _run(Kind _k, uint256[STEPS] memory _ops) internal returns (Obs[] memory _o) {
    kind = _k;
    if (_k == Kind.Upstream) {
      pool = IPrivacyPool(
        address(new PrivacyPoolComplex(address(entrypoint), address(verifier), address(verifier), address(zc)))
      );
    } else if (_k == Kind.Shifted) {
      pool =
        IPrivacyPool(address(new ShiftedPool(address(entrypoint), address(verifier), address(verifier), address(zc))));
    } else {
      pool = IPrivacyPool(
        address(new ZipPrivacyPool(address(entrypoint), address(verifier), address(verifier), address(zc), treasury))
      );
    }
    _register(1 ether, 100, 500);
    vm.prank(postman);
    entrypoint.updateRoot(1, CID);

    _o = new Obs[](STEPS);
    for (uint256 _i; _i < STEPS; ++_i) {
      _o[_i] = _step(_ops[_i]);
    }
  }

  function _step(uint256 _op) internal returns (Obs memory _obs) {
    uint256 _kind = _op % OPS;
    uint256 _r = _op >> 8;
    vm.recordLogs();
    bool _ok;
    bytes memory _ret;
    if (_kind <= 1 || (_kind == 14 && _r % 4 != 0)) (_ok, _ret) = _deposit(_r);
    else if (_kind == 2) (_ok, _ret) = _relay(_r, false);
    else if (_kind == 3) (_ok, _ret) = _directWithdraw(_r);
    else if (_kind == 4) (_ok, _ret) = _ragequit(_r);
    else if (_kind == 5) _postAsp(_r % 3 == 0 && labels.length != 0 ? labels[(_r >> 8) % labels.length] : 0);
    else if (_kind == 6) (_ok, _ret) = _replay();
    else if (_kind == 7) (_ok, _ret) = _frontRun(_r);
    else if (_kind == 8) _hold(_r);
    else if (_kind == 9) (_ok, _ret) = _submitHeld();
    else if (_kind == 10) (_ok, _ret) = _accrue(_r);
    else if (_kind == 11) (_ok, _ret) = _harvest();
    else if (_kind == 12) (_ok, _ret) = _donate(_r);
    else if (_kind == 13) (_ok, _ret) = _sendEth(_r);
    else if (_kind == 14) (_ok, _ret) = _windDown();
    else (_ok, _ret) = _relay(_r, true); // 15: relay with an arbitrary (maybe excessive) fee

    _obs.op = _kind == 14 && _r % 4 != 0 ? 0 : _kind;
    _obs.ok = _ok;
    _obs.ret = keccak256(_ret);
    _obs.err = bytes4(_ret);
    _obs.logs = _logsDigest(vm.getRecordedLogs());
    _obs.state = _stateDigest();
    _obs.root = pool.currentRoot();
    _obs.nonce = pool.nonce();
    _obs.poolZc = zc.balanceOf(address(pool));
  }

  // ------------------------------------------------------------------------------------------------------------
  // operations (identical on both pools, except harvest)
  // ------------------------------------------------------------------------------------------------------------

  function _deposit(uint256 _r) internal returns (bool _ok, bytes memory _ret) {
    address _who = actors[_r % 4];
    uint256 _value = _bound(_r >> 8, 0.5 ether, 1_000_000 ether); // below the 1 ZC minimum sometimes
    (uint256 _nullifier, uint256 _secret) = _secrets();
    uint256 _pre =
      (_r >> 120) % 8 == 0 && lastPrecommitment != 0 ? lastPrecommitment : _precommitment(_nullifier, _secret);
    zc.mint(_who, _value);
    vm.prank(_who);
    zc.approve(address(entrypoint), _value);
    vm.prank(_who);
    (_ok, _ret) =
      address(entrypoint).call(abi.encodeWithSignature('deposit(address,uint256,uint256)', zc, _value, _pre));
    if (_ok) {
      lastPrecommitment = _pre;
      _recordDeposit(_who, _net(_value), _nullifier, _secret, abi.decode(_ret, (uint256)));
    }
  }

  /// @dev Picks a note whose label is approved and that has value. One pick in four may be a spent note (a double
  ///      spend, which must fail); otherwise only unspent notes.
  function _pick(uint256 _r) internal view returns (bool _found, uint256 _i) {
    uint256 _n = notes.length;
    bool _anySpent = (_r >> 200) % 4 == 0;
    for (uint256 _k; _k < _n; ++_k) {
      _i = (_r % _n + _k) % _n;
      if (aspApproved[notes[_i].label] && notes[_i].value != 0 && (_anySpent || !notes[_i].spent)) return (true, _i);
    }
  }

  function _relay(uint256 _r, bool _anyFee) internal returns (bool _ok, bytes memory _ret) {
    (bool _found, uint256 _i) = _pick(_r);
    if (!_found) return (false, 'skip');
    uint256 _amount = _bound(_r >> 16, 1, notes[_i].value);
    uint256 _fee = _anyFee ? (_r >> 100) % 700 : (_r >> 100) % 501;
    IPrivacyPool.Withdrawal memory _w = _relayData(actors[(_r >> 110) % 4], relayer, _fee);
    (ProofLib.WithdrawProof memory _p, Note memory _change) = _proveWithdraw(_i, _amount, _w);
    vm.prank(relayer);
    (_ok, _ret) = address(entrypoint).call(abi.encodeCall(entrypoint.relay, (_w, _p, pool.SCOPE())));
    if (_ok) {
      _recordSpend(_i, _change);
      (lastW, lastP, hasLast) = (_w, _p, true);
    }
  }

  function _directWithdraw(uint256 _r) internal returns (bool _ok, bytes memory _ret) {
    (bool _found, uint256 _i) = _pick(_r);
    if (!_found) return (false, 'skip');
    uint256 _amount = _bound(_r >> 16, 0, notes[_i].value);
    address _owner = notes[_i].owner;
    IPrivacyPool.Withdrawal memory _w = IPrivacyPool.Withdrawal(_owner, abi.encode(_r));
    (ProofLib.WithdrawProof memory _p, Note memory _change) = _proveWithdraw(_i, _amount, _w);
    vm.prank(_owner);
    (_ok, _ret) = address(pool).call(abi.encodeCall(pool.withdraw, (_w, _p)));
    if (_ok) _recordSpend(_i, _change);
  }

  function _ragequit(uint256 _r) internal returns (bool _ok, bytes memory _ret) {
    if (notes.length == 0) return (false, 'skip');
    uint256 _i = _r % notes.length;
    ProofLib.RagequitProof memory _p = _proveRagequit(_i);
    address _caller = (_r >> 60) % 4 == 0 ? actors[(_r >> 70) % 4] : notes[_i].owner; // sometimes a stranger
    vm.prank(_caller);
    (_ok, _ret) = address(pool).call(abi.encodeCall(pool.ragequit, (_p)));
    if (_ok) notes[_i].spent = true;
  }

  function _replay() internal returns (bool _ok, bytes memory _ret) {
    if (!hasLast) return (false, 'skip');
    vm.prank(relayer);
    (_ok, _ret) = address(entrypoint).call(abi.encodeCall(entrypoint.relay, (lastW, lastP, pool.SCOPE())));
  }

  /// @dev A valid proof submitted with a different recipient (a mempool thief): the context no longer matches
  function _frontRun(uint256 _r) internal returns (bool _ok, bytes memory _ret) {
    (bool _found, uint256 _i) = _pick(_r);
    if (!_found) return (false, 'skip');
    IPrivacyPool.Withdrawal memory _w = _relayData(notes[_i].owner, relayer, 100);
    (ProofLib.WithdrawProof memory _p,) = _proveWithdraw(_i, _bound(_r >> 16, 1, notes[_i].value), _w);
    IPrivacyPool.Withdrawal memory _stolen = _relayData(makeAddr('thief'), makeAddr('thief'), 100);
    vm.prank(makeAddr('thief'));
    (_ok, _ret) = address(entrypoint).call(abi.encodeCall(entrypoint.relay, (_stolen, _p, pool.SCOPE())));
  }

  function _hold(uint256 _r) internal {
    (bool _found, uint256 _i) = _pick(_r);
    if (!_found) return;
    IPrivacyPool.Withdrawal memory _w = _relayData(actors[(_r >> 110) % 4], relayer, 50);
    (ProofLib.WithdrawProof memory _p, Note memory _change) =
      _proveWithdraw(_i, _bound(_r >> 16, 1, notes[_i].value), _w);
    (heldW, heldP, heldNote, hasHeld) = (_w, _p, _i, true);
    heldChange = _change;
  }

  function _submitHeld() internal returns (bool _ok, bytes memory _ret) {
    if (!hasHeld) return (false, 'skip');
    hasHeld = false;
    vm.prank(relayer);
    (_ok, _ret) = address(entrypoint).call(abi.encodeCall(entrypoint.relay, (heldW, heldP, pool.SCOPE())));
    if (_ok) _recordSpend(heldNote, heldChange);
  }

  function _accrue(uint256 _r) internal returns (bool _ok, bytes memory _ret) {
    uint256 _eth = _bound(_r, 1, 100 ether);
    vm.deal(funder, _eth);
    vm.prank(funder);
    (_ok, _ret) = address(zc).call{value: _eth}(abi.encodeCall(zc.distributeRewards, ()));
  }

  function _harvest() internal returns (bool _ok, bytes memory _ret) {
    if (kind != Kind.Zip) return (false, '');
    uint256 _pending = zc.pendingReward(address(pool));
    uint256 _before = treasury.balance;
    (_ok, _ret) = address(pool).call(abi.encodeCall(ZipPrivacyPool.harvest, ()));
    if (_pending == 0) {
      assertFalse(_ok, 'harvest with nothing to claim');
      assertEq(bytes4(_ret), bytes4(keccak256('NothingToClaim()')));
    } else {
      assertTrue(_ok, 'harvest');
      assertEq(abi.decode(_ret, (uint256)), _pending, 'harvest returns the claim');
      assertEq(treasury.balance - _before, _pending, 'TREASURY got exactly the claim');
      assertEq(address(pool).balance, 0, 'pool keeps no ETH');
    }
  }

  function _donate(uint256 _r) internal returns (bool _ok, bytes memory _ret) {
    address _who = actors[_r % 4];
    uint256 _value = _bound(_r >> 8, 1, 1000 ether);
    zc.mint(_who, _value);
    vm.prank(_who);
    (_ok, _ret) = address(zc).call(abi.encodeCall(IERC20.transfer, (address(pool), _value)));
  }

  function _sendEth(uint256 _r) internal returns (bool _ok, bytes memory _ret) {
    address _who = actors[_r % 4];
    vm.deal(_who, 1 ether);
    vm.prank(_who);
    (_ok, _ret) = address(pool).call{value: 1 ether}('');
    assertFalse(_ok, 'pool accepted ETH from a stranger');
    vm.deal(_who, 0);
  }

  function _windDown() internal returns (bool _ok, bytes memory _ret) {
    vm.prank(epOwner);
    (_ok, _ret) = address(entrypoint).call(abi.encodeCall(entrypoint.windDownPool, (pool)));
  }

  // ------------------------------------------------------------------------------------------------------------
  // observations
  // ------------------------------------------------------------------------------------------------------------

  function _logsDigest(Vm.Log[] memory _logs) internal pure returns (bytes32 _h) {
    for (uint256 _i; _i < _logs.length; ++_i) {
      _h = keccak256(abi.encode(_h, _logs[_i].emitter, _logs[_i].topics, _logs[_i].data));
    }
  }

  function _stateDigest() internal view returns (bytes32 _h) {
    IPrivacyPool _p = pool;
    _h = keccak256(
      abi.encode(
        _p.currentRoot(),
        _p.currentTreeSize(),
        _p.currentTreeDepth(),
        _p.currentRootIndex(),
        _p.nonce(),
        _p.dead(),
        zc.balanceOf(address(_p)),
        zc.balanceOf(address(entrypoint)),
        zc.balanceOf(relayer),
        address(_p).balance,
        entrypoint.latestRoot()
      )
    );
    for (uint256 _s; _s < 10; ++_s) {
      _h = keccak256(abi.encode(_h, vm.load(address(_p), bytes32(_s))));
    }
    for (uint256 _i; _i < 64; ++_i) {
      _h = keccak256(abi.encode(_h, _p.roots(_i)));
    }
    for (uint256 _i; _i < labels.length; ++_i) {
      _h = keccak256(abi.encode(_h, _p.depositors(labels[_i])));
    }
    for (uint256 _i; _i < notes.length; ++_i) {
      _h = keccak256(abi.encode(_h, _p.nullifierHashes(_nullifierHash(notes[_i].nullifier))));
    }
    for (uint256 _i; _i < 4; ++_i) {
      _h = keccak256(abi.encode(_h, zc.balanceOf(actors[_i]), actors[_i].balance));
    }
  }
}
