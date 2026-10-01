// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from '@oz/proxy/ERC1967/ERC1967Proxy.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {Test} from 'forge-std/Test.sol';
import {PoseidonT2} from 'poseidon/PoseidonT2.sol';
import {PoseidonT3} from 'poseidon/PoseidonT3.sol';
import {PoseidonT4} from 'poseidon/PoseidonT4.sol';

import {Entrypoint} from 'contracts/Entrypoint.sol';
import {Constants} from 'contracts/lib/Constants.sol';
import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';
import {IVerifier} from 'interfaces/IVerifier.sol';

import {MockZC} from '../ZipnetBase.sol';

/**
 * @notice A model of the two Groth16 circuits for fuzzing: a proof verifies iff its exact public signals were attested
 *         by the prover, i.e. by someone who knows the note's secrets. It stands in for circuit soundness (nobody can
 *         prove a statement about a note without its nullifier and secret) so that every check the CONTRACTS make
 *         (processooor, context, roots, depths, nullifiers, depositor, commitment membership) runs for real.
 *         The public-signal layout is the real one (ProofLib), and PoolRealProofs.t.sol checks the model's signals
 *         against real proofs from the 0xbow circuits.
 */
contract ModelVerifier is IVerifier {
  address public immutable PROVER;
  mapping(bytes32 _statement => bool _proven) public proven;

  constructor(address _prover) {
    PROVER = _prover;
  }

  function attestWithdraw(uint256[8] memory _s) external {
    require(msg.sender == PROVER, 'only the prover');
    proven[keccak256(abi.encode(uint256(8), _s))] = true;
  }

  function attestRagequit(uint256[4] memory _s) external {
    require(msg.sender == PROVER, 'only the prover');
    proven[keccak256(abi.encode(uint256(4), _s))] = true;
  }

  function verifyProof(uint256[2] memory, uint256[2][2] memory, uint256[2] memory, uint256[8] memory _s)
    external
    view
    returns (bool)
  {
    return proven[keccak256(abi.encode(uint256(8), _s))];
  }

  function verifyProof(uint256[2] memory, uint256[2][2] memory, uint256[2] memory, uint256[4] memory _s)
    external
    view
    returns (bool)
  {
    return proven[keccak256(abi.encode(uint256(4), _s))];
  }
}

interface IHarvest {
  function harvest() external returns (uint256);
}

/**
 * @notice A TREASURY that can accept, revert, burn all gas, or re-enter the pool while receiving the harvest.
 * @dev `pool` is set after deployment (the pool takes the treasury in its constructor).
 */
contract TreasuryActor {
  enum Mode {
    Accept,
    Revert,
    BurnGas,
    ReenterHarvest, // re-enters harvest() and swallows the result
    ReenterWithFreshRewards, // makes new rewards appear, then re-enters harvest() (which then claims them)
    ReenterAndBubble // re-enters harvest() and lets its revert bubble up
  }

  Mode public mode;
  address public pool;
  MockZC public zc;
  uint256 public received;
  uint256 public spent; // ETH this contract sent away (ReenterWithFreshRewards)
  uint256 public reentries;
  uint256 public reentriesSucceeded;
  bool private _inside;

  function wire(address _pool, MockZC _zc) external {
    (pool, zc) = (_pool, _zc);
  }

  function setMode(Mode _m) external {
    mode = _m;
  }

  receive() external payable {
    received += msg.value;
    Mode _m = mode;
    if (_m == Mode.Accept) return;
    if (_m == Mode.Revert) revert('treasury says no');
    if (_m == Mode.BurnGas) {
      while (true) {}
    }
    if (_inside) return; // one level of re-entry is enough
    _inside = true;
    ++reentries;
    if (_m == Mode.ReenterHarvest) {
      try IHarvest(pool).harvest() {
        ++reentriesSucceeded;
      } catch {}
    } else if (_m == Mode.ReenterWithFreshRewards) {
      uint256 _fresh = msg.value / 2 + 1;
      if (address(this).balance >= _fresh && zc.eligibleSupply() != 0) {
        spent += _fresh;
        zc.distributeRewards{value: _fresh}();
      }
      try IHarvest(pool).harvest() {
        ++reentriesSucceeded;
      } catch {}
    } else {
      IHarvest(pool).harvest(); // bubbles NothingToClaim()
    }
    _inside = false;
  }
}

/**
 * @notice Shared model: notes with their secrets, the honest prover, and the local Entrypoint + MockZC stack.
 */
abstract contract PoolModel is Test {
  uint256 internal constant FIELD = Constants.SNARK_SCALAR_FIELD;
  uint256 internal constant ASP_DEPTH = 8;
  string internal constant CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

  struct Note {
    address owner;
    uint256 value;
    uint256 label;
    uint256 nullifier;
    uint256 secret;
    uint256 commitment;
    bool spent;
  }

  address internal epOwner = makeAddr('epOwner');
  address internal postman = makeAddr('postman');

  MockZC internal zc;
  Entrypoint internal entrypoint;
  ModelVerifier internal verifier;
  IPrivacyPool internal pool;

  Note[] internal notes;
  uint256[] internal labels;
  mapping(uint256 _label => bool) internal aspApproved;
  uint256 internal aspVersion;
  uint256 private _salt;

  function _deployStack() internal {
    zc = new MockZC();
    address _impl = address(new Entrypoint());
    entrypoint =
      Entrypoint(payable(address(new ERC1967Proxy(_impl, abi.encodeCall(Entrypoint.initialize, (epOwner, postman))))));
    verifier = new ModelVerifier(address(this));
  }

  function _register(uint256 _minDeposit, uint256 _vettingBps, uint256 _maxRelayBps) internal {
    vm.prank(epOwner);
    entrypoint.registerPool(IERC20(address(zc)), pool, _minDeposit, _vettingBps, _maxRelayBps);
  }

  // ------------------------------------------------------------------------------------------------------------
  // hashing, exactly as the circuits do it
  // ------------------------------------------------------------------------------------------------------------

  function _nullifierHash(uint256 _nullifier) internal pure returns (uint256) {
    return PoseidonT2.hash([_nullifier]);
  }

  function _precommitment(uint256 _nullifier, uint256 _secret) internal pure returns (uint256) {
    return PoseidonT3.hash([_nullifier, _secret]);
  }

  function _commit(uint256 _value, uint256 _label, uint256 _nullifier, uint256 _secret)
    internal
    pure
    returns (uint256)
  {
    return PoseidonT4.hash([_value, _label, _precommitment(_nullifier, _secret)]);
  }

  function _secrets() internal returns (uint256 _nullifier, uint256 _secret) {
    _nullifier = uint256(keccak256(abi.encode('model-n', ++_salt))) % FIELD;
    _secret = uint256(keccak256(abi.encode('model-s', _salt))) % FIELD;
  }

  function _labelAt(uint256 _nonce) internal view returns (uint256) {
    return uint256(keccak256(abi.encodePacked(pool.SCOPE(), _nonce))) % FIELD;
  }

  function _context(IPrivacyPool.Withdrawal memory _w) internal view returns (uint256) {
    return uint256(keccak256(abi.encode(_w, pool.SCOPE()))) % FIELD;
  }

  // ------------------------------------------------------------------------------------------------------------
  // ASP (the postman)
  // ------------------------------------------------------------------------------------------------------------

  /// @dev Posts a fresh ASP root approving every label except `_drop` (0 drops none). The model root is a hash of the
  ///      approved set and a version (it never needs to be a real Merkle root: the model verifier binds it).
  function _postAsp(uint256 _drop) internal {
    for (uint256 _i; _i < labels.length; ++_i) {
      aspApproved[labels[_i]] = labels[_i] != _drop;
    }
    uint256 _root = uint256(keccak256(abi.encode('asp', ++aspVersion, _drop))) % FIELD;
    if (_root == 0) _root = 1;
    vm.prank(postman);
    entrypoint.updateRoot(_root, CID);
  }

  // ------------------------------------------------------------------------------------------------------------
  // the honest prover: it only proves statements the circuits would accept for a note whose secrets it knows
  // ------------------------------------------------------------------------------------------------------------

  function _dummyProofPoints()
    internal
    pure
    returns (uint256[2] memory _a, uint256[2][2] memory _b, uint256[2] memory _c)
  {
    _a = [uint256(1), 2];
    _b = [[uint256(3), 4], [uint256(5), 6]];
    _c = [uint256(7), 8];
  }

  /**
   * @dev Proves spending `_amount` of note `_i` into withdrawal `_w` against the pool's current root and the latest
   *      ASP root. Circuit preconditions (the caller ensures them): the note is in the tree, its label is approved,
   *      `_amount <= value`. A spent note can still be proven (the circuit doesn't know), so double spends reach the
   *      contract.
   */
  function _proveWithdraw(uint256 _i, uint256 _amount, IPrivacyPool.Withdrawal memory _w)
    internal
    returns (ProofLib.WithdrawProof memory _p, Note memory _change)
  {
    Note memory _n = notes[_i];
    require(_amount <= _n.value, 'model: overdraw');
    require(aspApproved[_n.label], 'model: label not approved');
    (uint256 _nn, uint256 _ns) = _secrets();
    _change =
      Note(_n.owner, _n.value - _amount, _n.label, _nn, _ns, _commit(_n.value - _amount, _n.label, _nn, _ns), false);
    uint256[8] memory _s = [
      _change.commitment,
      _nullifierHash(_n.nullifier),
      _amount,
      IPrivacyPool(address(pool)).currentRoot(),
      IPrivacyPool(address(pool)).currentTreeDepth(),
      entrypoint.latestRoot(),
      ASP_DEPTH,
      _context(_w)
    ];
    verifier.attestWithdraw(_s);
    (uint256[2] memory _a, uint256[2][2] memory _b, uint256[2] memory _c) = _dummyProofPoints();
    _p = ProofLib.WithdrawProof(_a, _b, _c, _s);
  }

  function _proveRagequit(uint256 _i) internal returns (ProofLib.RagequitProof memory _p) {
    Note memory _n = notes[_i];
    uint256[4] memory _s = [_n.commitment, _nullifierHash(_n.nullifier), _n.value, _n.label];
    verifier.attestRagequit(_s);
    (uint256[2] memory _a, uint256[2][2] memory _b, uint256[2] memory _c) = _dummyProofPoints();
    _p = ProofLib.RagequitProof(_a, _b, _c, _s);
  }

  function _relayData(address _recipient, address _feeRecipient, uint256 _bps)
    internal
    view
    returns (IPrivacyPool.Withdrawal memory)
  {
    return IPrivacyPool.Withdrawal(
      address(entrypoint),
      abi.encode(IEntrypoint.RelayData({recipient: _recipient, feeRecipient: _feeRecipient, relayFeeBPS: _bps}))
    );
  }

  /// @dev Keeps the note book in step with a successful spend
  function _recordSpend(uint256 _i, Note memory _change) internal {
    notes[_i].spent = true;
    notes.push(_change);
  }

  /// @dev Records a successful deposit; returns the note index
  function _recordDeposit(address _owner, uint256 _value, uint256 _nullifier, uint256 _secret, uint256 _commitment)
    internal
    returns (uint256)
  {
    uint256 _label = _labelAt(pool.nonce());
    require(_commit(_value, _label, _nullifier, _secret) == _commitment, 'model: commitment mirror');
    labels.push(_label);
    notes.push(Note(_owner, _value, _label, _nullifier, _secret, _commitment, false));
    return notes.length - 1;
  }

  /// @dev ETH arriving without a call, as SELFDESTRUCT or a block reward would deliver it (receive() never runs)
  function _forceEth(address _to, uint256 _eth) internal {
    vm.deal(_to, _to.balance + _eth);
  }

  function _net(uint256 _value) internal view returns (uint256) {
    (,, uint256 _vetting,) = entrypoint.assetConfig(IERC20(address(zc)));
    return _value - (_value * _vetting) / 10_000;
  }
}
