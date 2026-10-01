// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';

import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {ZipPrivacyPool} from 'zipnet/ZipPrivacyPool.sol';

import {MockZC} from '../ZipnetBase.sol';
import {PoolModel, TreasuryActor} from './PoolModel.sol';

/**
 * @notice Invariant handler for ZipPrivacyPool. Honest actors deposit, withdraw (relayed and direct), ragequit,
 *         donate ZC and try to send ETH; anyone harvests; ZC distributes ETH rewards; ETH is forced in by
 *         SELFDESTRUCT (simulated); the postman updates (and sometimes narrows) the ASP set; the TREASURY switches between
 *         accepting, reverting, burning gas and re-entering. Attackers (who never own a note) front-run, replay,
 *         forge, steal ragequits and call restricted functions.
 * @dev Every expected outcome is asserted in place (the campaign runs with fail_on_revert, so a failed assertion or an
 *      unexpected revert fails it). Ghost variables feed the global invariants in PoolInvariant.t.sol.
 */
contract PoolHandler is PoolModel {
  uint256 internal constant HARVEST_GAS = 5_000_000;

  ZipPrivacyPool public zpool;
  TreasuryActor public treasury;

  address[5] internal actors;
  address[2] internal attackers;
  address internal funder = makeAddr('rewardFunder');

  // ---- ghosts ----
  uint256 public ghostUnspent; // sum of the values of all unspent notes
  uint256 public ghostDonations; // ZC sent straight to the pool
  uint256 public ghostZcEthIn; // ETH handed to ZC as rewards by the funder
  uint256 public ghostForcedTotal; // ETH forced into the pool
  uint256 public ghostForcedSinceHarvest; // forced ETH not yet swept by a harvest
  bool public ghostHarvestChangedState;
  bool public ghostStrangerEthAccepted;
  bool public ghostAttackSucceeded;
  uint256 public lastPending;

  // the last successful relay, for replays
  IPrivacyPool.Withdrawal internal lastW;
  ProofLib.WithdrawProof internal lastP;
  bool internal hasLast;

  mapping(bytes32 => uint256) public calls;

  constructor() {
    actors = [makeAddr('a0'), makeAddr('a1'), makeAddr('a2'), makeAddr('a3'), makeAddr('a4')];
    attackers = [makeAddr('mallory'), makeAddr('trudy')];
    _deployStack();
    treasury = new TreasuryActor();
    zpool = new ZipPrivacyPool(
      address(entrypoint), address(verifier), address(verifier), address(zc), payable(address(treasury))
    );
    pool = IPrivacyPool(address(zpool));
    treasury.wire(address(zpool), zc);
    _register(1 ether, 100, 500);
    vm.prank(postman);
    entrypoint.updateRoot(1, CID);
  }

  function _count(bytes32 _what) internal {
    ++calls[_what];
  }

  function zc_() external view returns (MockZC) {
    return zc;
  }

  function noteCount() external view returns (uint256) {
    return notes.length;
  }

  function attacker(uint256 _i) external view returns (address) {
    return attackers[_i];
  }

  /// @dev An unspent note; with `_approvedOnly`, one whose label the ASP currently approves and that holds value
  function _unspent(uint256 _seed, bool _approvedOnly) internal view returns (bool _found, uint256 _i) {
    uint256 _n = notes.length;
    for (uint256 _k; _k < _n; ++_k) {
      _i = (_seed % _n + _k) % _n;
      Note storage _note = notes[_i];
      if (_note.spent) continue;
      if (_approvedOnly && (!aspApproved[_note.label] || _note.value == 0)) continue;
      return (true, _i);
    }
  }

  // ============================================================================================================
  // honest users
  // ============================================================================================================

  function deposit(uint256 _actor, uint256 _value) external {
    address _who = actors[_actor % 5];
    _value = _bound(_value, 1 ether, 10_000_000 ether);
    (uint256 _nullifier, uint256 _secret) = _secrets();
    zc.mint(_who, _value);
    vm.startPrank(_who);
    zc.approve(address(entrypoint), _value);
    (bool _ok, bytes memory _ret) = address(entrypoint)
      .call(
        abi.encodeWithSignature('deposit(address,uint256,uint256)', zc, _value, _precommitment(_nullifier, _secret))
      );
    vm.stopPrank();
    if (pool.dead()) {
      assertFalse(_ok, 'deposit into a dead pool');
      vm.prank(_who);
      zc.transfer(address(0xdead), _value); // keep actors' balances tidy
      _count('deposit.dead');
      return;
    }
    assertTrue(_ok, 'deposit reverted');
    uint256 _net = _net(_value);
    uint256 _i = _recordDeposit(_who, _net, _nullifier, _secret, abi.decode(_ret, (uint256)));
    ghostUnspent += _net;
    assertEq(pool.depositors(notes[_i].label), _who, 'depositor recorded');
    _postAsp(0); // the ASP approves the new label (dropping none)
    _count('deposit');
  }

  function relay(uint256 _seed, uint256 _amount, uint256 _feeBps, uint256 _to, uint256 _by) external {
    (bool _found, uint256 _i) = _unspent(_seed, true);
    if (!_found) return;
    _amount = _bound(_amount, 1, notes[_i].value);
    _feeBps = _bound(_feeBps, 0, 500);
    address _recipient = _to % 3 == 0 ? makeAddr(string.concat('fresh', vm.toString(_to % 1000))) : actors[_to % 5];
    address _relayer = actors[_by % 5];
    IPrivacyPool.Withdrawal memory _w = _relayData(_recipient, _relayer, _feeBps);
    (ProofLib.WithdrawProof memory _p, Note memory _change) = _proveWithdraw(_i, _amount, _w);
    _submitRelay(_i, _amount, _feeBps, _w, _p, _change, _relayer);
    _count('relay');
  }

  function _submitRelay(
    uint256 _i,
    uint256 _amount,
    uint256 _feeBps,
    IPrivacyPool.Withdrawal memory _w,
    ProofLib.WithdrawProof memory _p,
    Note memory _change,
    address _relayer
  ) internal {
    address _recipient = abi.decode(_w.data, (address));
    uint256 _fee = _amount - (_amount - (_amount * _feeBps) / 10_000);
    uint256 _rBefore = zc.balanceOf(_recipient);
    uint256 _fBefore = zc.balanceOf(_relayer);
    uint256 _poolBefore = zc.balanceOf(address(pool));
    vm.prank(_relayer);
    entrypoint.relay(_w, _p, pool.SCOPE()); // must succeed: it is the note owner's valid proof
    if (_recipient == _relayer) {
      assertEq(zc.balanceOf(_recipient) - _rBefore, _amount, 'recipient+relayer');
    } else {
      assertEq(zc.balanceOf(_recipient) - _rBefore, _amount - _fee, 'recipient got amount less fee');
      assertEq(zc.balanceOf(_relayer) - _fBefore, _fee, 'relayer got the fee');
    }
    assertEq(_poolBefore - zc.balanceOf(address(pool)), _amount, 'pool paid exactly the amount');
    _recordSpend(_i, _change);
    ghostUnspent -= _amount;
    (lastW, lastP, hasLast) = (_w, _p, true);
  }

  function withdraw(uint256 _seed, uint256 _amount) external {
    (bool _found, uint256 _i) = _unspent(_seed, true);
    if (!_found) return;
    _amount = _bound(_amount, 0, notes[_i].value);
    address _owner = notes[_i].owner;
    IPrivacyPool.Withdrawal memory _w = IPrivacyPool.Withdrawal(_owner, abi.encode(_seed));
    (ProofLib.WithdrawProof memory _p, Note memory _change) = _proveWithdraw(_i, _amount, _w);
    uint256 _before = zc.balanceOf(_owner);
    vm.prank(_owner);
    pool.withdraw(_w, _p);
    assertEq(zc.balanceOf(_owner) - _before, _amount, 'owner got the amount');
    _recordSpend(_i, _change);
    ghostUnspent -= _amount;
    _count('withdraw');
  }

  function ragequit(uint256 _seed) external {
    (bool _found, uint256 _i) = _unspent(_seed, false);
    if (!_found) return;
    Note memory _n = notes[_i];
    ProofLib.RagequitProof memory _p = _proveRagequit(_i);
    uint256 _before = zc.balanceOf(_n.owner);
    vm.prank(_n.owner);
    pool.ragequit(_p);
    assertEq(zc.balanceOf(_n.owner) - _before, _n.value, 'ragequit paid the note');
    notes[_i].spent = true;
    ghostUnspent -= _n.value;
    _count('ragequit');
  }

  function donate(uint256 _actor, uint256 _value) external {
    address _who = actors[_actor % 5];
    _value = _bound(_value, 1, 100_000 ether);
    zc.mint(_who, _value);
    vm.prank(_who);
    zc.transfer(address(pool), _value);
    ghostDonations += _value;
    _count('donate');
  }

  function sendEth(uint256 _actor, uint256 _value) external {
    address _who = _actor % 4 == 0 ? attackers[_actor % 2] : actors[_actor % 5];
    _value = _bound(_value, 1, 10 ether);
    vm.deal(_who, _who.balance + _value);
    vm.prank(_who);
    (bool _ok, bytes memory _ret) = address(pool).call{value: _value}('');
    if (_ok) ghostStrangerEthAccepted = true;
    assertEq(bytes4(_ret), ZipPrivacyPool.OnlyAsset.selector, 'direct ETH refused with OnlyAsset');
    vm.deal(_who, _who.balance - _value);
    _count('sendEth');
  }

  // ============================================================================================================
  // rewards, harvest, treasury
  // ============================================================================================================

  function accrue(uint256 _eth) external {
    if (zc.eligibleSupply() == 0) return;
    _eth = _bound(_eth, 1, 50 ether);
    vm.deal(funder, _eth);
    vm.prank(funder);
    zc.distributeRewards{value: _eth}();
    ghostZcEthIn += _eth;
    _count('accrue');
  }

  function forceEth(uint256 _eth) external {
    _eth = _bound(_eth, 1, 1 ether);
    _forceEth(address(pool), _eth);
    ghostForcedTotal += _eth;
    ghostForcedSinceHarvest += _eth;
    _count('forceEth');
  }

  function setTreasuryMode(uint256 _mode) external {
    treasury.setMode(TreasuryActor.Mode(_mode % 6));
    _count('treasuryMode');
  }

  function harvest(uint256 _caller) external {
    address _who = _caller % 3 == 0 ? attackers[_caller % 2] : actors[_caller % 5];
    bytes32 _stateBefore = poolDigest();
    uint256 _zcBefore = zc.balanceOf(address(pool));
    uint256 _pending = zc.pendingReward(address(pool));
    uint256 _poolEth = address(pool).balance;
    uint256 _tBefore = treasury.received();
    uint256 _whoZc = zc.balanceOf(_who);
    uint256 _whoEth = _who.balance;
    TreasuryActor.Mode _mode = treasury.mode();
    lastPending = _pending;

    vm.prank(_who);
    (bool _ok, bytes memory _ret) = address(zpool).call{gas: HARVEST_GAS}(abi.encodeCall(ZipPrivacyPool.harvest, ()));

    if (_pending == 0) {
      assertFalse(_ok, 'harvest with nothing to claim');
      assertEq(bytes4(_ret), bytes4(keccak256('NothingToClaim()')), 'NothingToClaim');
      _count('harvest.nothing');
    } else if (
      _mode == TreasuryActor.Mode.Revert || _mode == TreasuryActor.Mode.BurnGas
        || _mode == TreasuryActor.Mode.ReenterAndBubble
    ) {
      assertFalse(_ok, 'harvest into a refusing treasury');
      assertEq(bytes4(_ret), ZipPrivacyPool.TreasuryTransferFailed.selector, 'TreasuryTransferFailed');
      assertEq(zc.pendingReward(address(pool)), _pending, 'the claim rolled back: rewards stay claimable');
      _count('harvest.refused');
    } else {
      assertTrue(_ok, 'harvest failed');
      assertEq(abi.decode(_ret, (uint256)), _pending, 'returns what was claimed');
      assertEq(address(pool).balance, 0, 'pool holds ETH after a harvest');
      assertGe(treasury.received() - _tBefore, _pending + _poolEth, 'treasury got at least the claim and the stray ETH');
      if (_mode == TreasuryActor.Mode.Accept || _mode == TreasuryActor.Mode.ReenterHarvest) {
        assertEq(treasury.received() - _tBefore, _pending + _poolEth, 'treasury got exactly the claim + stray ETH');
      }
      ghostForcedSinceHarvest = 0;
      _count('harvest');
    }
    if (poolDigest() != _stateBefore) ghostHarvestChangedState = true;
    assertEq(zc.balanceOf(address(pool)), _zcBefore, 'harvest moved ZC');
    assertEq(zc.balanceOf(_who), _whoZc, 'the harvester gained ZC');
    assertEq(_who.balance, _whoEth, 'the harvester gained ETH');
  }

  // ============================================================================================================
  // ASP and owner
  // ============================================================================================================

  function updateAsp(uint256 _seed) external {
    uint256 _drop = _seed % 4 == 0 && labels.length != 0 ? labels[(_seed >> 8) % labels.length] : 0;
    _postAsp(_drop);
    _count('asp');
  }

  function windDown(uint256 _seed) external {
    if (_seed % 25 != 0 || pool.dead()) return;
    vm.prank(epOwner);
    entrypoint.windDownPool(pool);
    _count('windDown');
  }

  // ============================================================================================================
  // attackers: none of these may succeed
  // ============================================================================================================

  function _fail(bool _ok) internal {
    if (_ok) ghostAttackSucceeded = true;
    assertFalse(_ok, 'an attack succeeded');
  }

  /// @dev The owner's relay proof, resubmitted by an attacker with the attacker as recipient. Then the owner's
  ///      original still goes through: the failed front-run burned nothing.
  function attackFrontRun(uint256 _seed, uint256 _amount, uint256 _who) external {
    (bool _found, uint256 _i) = _unspent(_seed, true);
    if (!_found) return;
    address _mallory = attackers[_who % 2];
    _amount = _bound(_amount, 1, notes[_i].value);
    address _relayer = actors[_seed % 5];
    IPrivacyPool.Withdrawal memory _w = _relayData(notes[_i].owner, _relayer, 100);
    (ProofLib.WithdrawProof memory _p, Note memory _change) = _proveWithdraw(_i, _amount, _w);

    IPrivacyPool.Withdrawal memory _stolen = _relayData(_mallory, _mallory, 100);
    vm.prank(_mallory);
    (bool _ok, bytes memory _ret) =
      address(entrypoint).call(abi.encodeCall(entrypoint.relay, (_stolen, _p, pool.SCOPE())));
    _fail(_ok);
    assertEq(bytes4(_ret), IPrivacyPool.ContextMismatch.selector, 'ContextMismatch');

    _submitRelay(_i, _amount, 100, _w, _p, _change, _relayer);
    _count('attack.frontRun');
  }

  /// @dev The owner's direct-withdraw proof, called by an attacker as-is (wrong processooor) and re-targeted
  function attackStealDirect(uint256 _seed, uint256 _who) external {
    (bool _found, uint256 _i) = _unspent(_seed, true);
    if (!_found) return;
    address _mallory = attackers[_who % 2];
    IPrivacyPool.Withdrawal memory _w = IPrivacyPool.Withdrawal(notes[_i].owner, '');
    (ProofLib.WithdrawProof memory _p,) = _proveWithdraw(_i, notes[_i].value, _w);
    vm.prank(_mallory);
    (bool _ok, bytes memory _ret) = address(pool).call(abi.encodeCall(pool.withdraw, (_w, _p)));
    _fail(_ok);
    assertEq(bytes4(_ret), IPrivacyPool.InvalidProcessooor.selector, 'InvalidProcessooor');
    IPrivacyPool.Withdrawal memory _mine = IPrivacyPool.Withdrawal(_mallory, '');
    vm.prank(_mallory);
    (_ok, _ret) = address(pool).call(abi.encodeCall(pool.withdraw, (_mine, _p)));
    _fail(_ok);
    assertEq(bytes4(_ret), IPrivacyPool.ContextMismatch.selector, 'ContextMismatch');
    _count('attack.stealDirect');
  }

  /// @dev The owner's ragequit proof (e.g. seen in the mempool), submitted by an attacker
  function attackStealRagequit(uint256 _seed, uint256 _who) external {
    (bool _found, uint256 _i) = _unspent(_seed, false);
    if (!_found) return;
    address _mallory = attackers[_who % 2];
    ProofLib.RagequitProof memory _p = _proveRagequit(_i);
    vm.prank(_mallory);
    (bool _ok, bytes memory _ret) = address(pool).call(abi.encodeCall(pool.ragequit, (_p)));
    _fail(_ok);
    assertEq(bytes4(_ret), IPrivacyPool.OnlyOriginalDepositor.selector, 'OnlyOriginalDepositor');
    _count('attack.stealRagequit');
  }

  /// @dev A made-up statement about someone's note: its real nullifier, an attacker-chosen amount and change note
  function attackForge(uint256 _seed, uint256 _amount, uint256 _who) external {
    (bool _found, uint256 _i) = _unspent(_seed, false);
    if (!_found) return;
    address _mallory = attackers[_who % 2];
    IPrivacyPool.Withdrawal memory _w = _relayData(_mallory, _mallory, 0);
    uint256[8] memory _s = [
      uint256(keccak256(abi.encode('forged', _seed))) % FIELD,
      _nullifierHash(notes[_i].nullifier),
      _bound(_amount, 1, notes[_i].value + 1),
      pool.currentRoot(),
      pool.currentTreeDepth(),
      entrypoint.latestRoot(),
      ASP_DEPTH,
      _context(_w)
    ];
    (uint256[2] memory _a, uint256[2][2] memory _b, uint256[2] memory _c) = _dummyProofPoints();
    ProofLib.WithdrawProof memory _p = ProofLib.WithdrawProof(_a, _b, _c, _s);
    vm.prank(_mallory);
    (bool _ok, bytes memory _ret) = address(entrypoint).call(abi.encodeCall(entrypoint.relay, (_w, _p, pool.SCOPE())));
    _fail(_ok);
    assertEq(bytes4(_ret), IPrivacyPool.InvalidProof.selector, 'InvalidProof');
    _count('attack.forge');
  }

  function attackReplay(uint256 _who) external {
    if (!hasLast) return;
    vm.prank(attackers[_who % 2]);
    (bool _ok,) = address(entrypoint).call(abi.encodeCall(entrypoint.relay, (lastW, lastP, pool.SCOPE())));
    _fail(_ok);
    _count('attack.replay');
  }

  function attackRestricted(uint256 _who, uint256 _what) external {
    address _mallory = attackers[_who % 2];
    bool _ok;
    vm.startPrank(_mallory);
    uint256 _k = _what % 4;
    if (_k == 0) (_ok,) = address(pool).call(abi.encodeCall(pool.deposit, (_mallory, 1 ether, 123)));
    else if (_k == 1) (_ok,) = address(pool).call(abi.encodeCall(pool.windDown, ()));
    else if (_k == 2) (_ok,) = address(entrypoint).call(abi.encodeCall(entrypoint.windDownPool, (pool)));
    else (_ok,) = address(entrypoint).call(abi.encodeCall(entrypoint.updateRoot, (_what | 1, CID)));
    vm.stopPrank();
    _fail(_ok);
    _count('attack.restricted');
  }

  // ============================================================================================================
  // views for the invariants
  // ============================================================================================================

  /// @notice Everything the pool keeps: tree, root history, nonce, dead, raw slots, every label and nullifier
  function poolDigest() public view returns (bytes32 _h) {
    _h = keccak256(
      abi.encode(
        pool.currentRoot(),
        pool.currentTreeSize(),
        pool.currentTreeDepth(),
        pool.currentRootIndex(),
        pool.nonce(),
        pool.dead()
      )
    );
    for (uint256 _s; _s < 10; ++_s) {
      _h = keccak256(abi.encode(_h, vm.load(address(pool), bytes32(_s))));
    }
    for (uint256 _i; _i < 64; ++_i) {
      _h = keccak256(abi.encode(_h, pool.roots(_i)));
    }
    for (uint256 _i; _i < labels.length; ++_i) {
      _h = keccak256(abi.encode(_h, pool.depositors(labels[_i])));
    }
    for (uint256 _i; _i < notes.length; ++_i) {
      _h = keccak256(abi.encode(_h, pool.nullifierHashes(_nullifierHash(notes[_i].nullifier))));
    }
  }

  /// @notice ETH that has left ZC as claims (only the pool ever claims in this campaign)
  function claimedFromZc() public view returns (uint256) {
    return ghostZcEthIn + treasury.spent() - address(zc).balance;
  }

  /**
   * @notice On a snapshot: every unspent note can be ragequit by its owner (and, when `_withdrawToo`, fully withdrawn
   *         when its label is approved). After all ragequits the pool holds exactly the donations. State is restored.
   */
  function checkExits(bool _withdrawToo) external {
    uint256 _snap = vm.snapshotState();
    uint256 _n = notes.length;
    if (_withdrawToo) {
      for (uint256 _i; _i < _n; ++_i) {
        Note memory _note = notes[_i];
        if (_note.spent || !aspApproved[_note.label]) continue;
        IPrivacyPool.Withdrawal memory _w = IPrivacyPool.Withdrawal(_note.owner, '');
        (ProofLib.WithdrawProof memory _p,) = _proveWithdraw(_i, _note.value, _w);
        uint256 _before = zc.balanceOf(_note.owner);
        vm.prank(_note.owner);
        pool.withdraw(_w, _p);
        assertEq(zc.balanceOf(_note.owner) - _before, _note.value, 'full withdraw of a note');
      }
      vm.revertToState(_snap);
      _snap = vm.snapshotState();
    }
    for (uint256 _i; _i < _n; ++_i) {
      Note memory _note = notes[_i];
      if (_note.spent) continue;
      ProofLib.RagequitProof memory _p = _proveRagequit(_i);
      vm.prank(_note.owner);
      pool.ragequit(_p);
    }
    assertEq(zc.balanceOf(address(pool)), ghostDonations, 'after every exit the pool holds exactly the donations');
    vm.revertToState(_snap);
  }
}
