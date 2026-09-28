// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from '@oz/proxy/ERC1967/ERC1967Proxy.sol';
import {ERC20} from '@oz/token/ERC20/ERC20.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {Test} from 'forge-std/Test.sol';
import {PoseidonT3} from 'poseidon/PoseidonT3.sol';
import {PoseidonT4} from 'poseidon/PoseidonT4.sol';
import {Semaphore} from '@semaphore-protocol/contracts/Semaphore.sol';
import {SemaphoreVerifier} from '@semaphore-protocol/contracts/base/SemaphoreVerifier.sol';
import {ISemaphore} from '@semaphore-protocol/contracts/interfaces/ISemaphore.sol';
import {ISemaphoreVerifier} from '@semaphore-protocol/contracts/interfaces/ISemaphoreVerifier.sol';

import {Entrypoint} from 'contracts/Entrypoint.sol';
import {PrivacyPoolComplex} from 'contracts/implementations/PrivacyPoolComplex.sol';
import {Constants} from 'contracts/lib/Constants.sol';
import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {CommitmentVerifier} from 'contracts/verifiers/CommitmentVerifier.sol';
import {WithdrawalVerifier} from 'contracts/verifiers/WithdrawalVerifier.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

contract MockZC is ERC20 {
  constructor() ERC20('zipcoin', 'ZC') {}

  function mint(address _to, uint256 _amount) external {
    _mint(_to, _amount);
  }
}

/**
 * @notice Local Privacy Pools stack with the production Groth16 verifiers and real proofs.
 * @dev Proofs come from packages/sdk/scripts/ffi-prove.ts (snarkjs + 0xbow ceremony artifacts). The test mirrors
 *      the pool's state tree and the ASP tree off-chain so it can hand the prover Merkle paths.
 */
abstract contract ZipnetBase is Test {
  using ProofLib for ProofLib.WithdrawProof;

  struct Note {
    uint256 value;
    uint256 label;
    uint256 nullifier;
    uint256 secret;
  }

  address internal constant BURN = 0x000000000000000000000000000000000000dEaD;

  address internal owner = makeAddr('owner');
  address internal postman = makeAddr('postman');

  MockZC internal zc;
  Entrypoint internal entrypoint;
  PrivacyPoolComplex internal pool;
  uint256 internal scope;
  ISemaphore internal semaphore;

  uint256[] internal stateLeaves;
  uint256[] internal aspLeaves;
  uint256 private _salt;

  function setUp() public virtual {
    zc = new MockZC();
    address _impl = address(new Entrypoint());
    entrypoint = Entrypoint(
      payable(address(new ERC1967Proxy(_impl, abi.encodeCall(Entrypoint.initialize, (owner, postman)))))
    );
    pool = new PrivacyPoolComplex(
      address(entrypoint), address(new WithdrawalVerifier()), address(new CommitmentVerifier()), address(zc)
    );
    vm.prank(owner);
    entrypoint.registerPool(IERC20(address(zc)), IPrivacyPool(address(pool)), 1 ether, 0, 500);
    scope = pool.SCOPE();
    semaphore = ISemaphore(address(new Semaphore(ISemaphoreVerifier(address(new SemaphoreVerifier())))));
  }

  // --------------------------------------------------------------------------------------------------------------
  // notes
  // --------------------------------------------------------------------------------------------------------------

  function _secrets() internal returns (uint256 _nullifier, uint256 _secret) {
    _nullifier = uint256(keccak256(abi.encode('n', ++_salt))) % Constants.SNARK_SCALAR_FIELD;
    _secret = uint256(keccak256(abi.encode('s', _salt))) % Constants.SNARK_SCALAR_FIELD;
  }

  function _precommitment(uint256 _nullifier, uint256 _secret) internal pure returns (uint256) {
    return PoseidonT3.hash([_nullifier, _secret]);
  }

  function _commitment(Note memory _n) internal pure returns (uint256) {
    return PoseidonT4.hash([_n.value, _n.label, _precommitment(_n.nullifier, _n.secret)]);
  }

  /// @dev Deposits `_value` ZC from `_who` and approves the label in the ASP set.
  function _zip(address _who, uint256 _value) internal returns (Note memory _n) {
    (uint256 _nullifier, uint256 _secret) = _secrets();
    zc.mint(_who, _value);
    vm.startPrank(_who);
    zc.approve(address(entrypoint), _value);
    uint256 _c = entrypoint.deposit(IERC20(address(zc)), _value, _precommitment(_nullifier, _secret));
    vm.stopPrank();

    uint256 _label = uint256(keccak256(abi.encodePacked(scope, pool.nonce()))) % Constants.SNARK_SCALAR_FIELD;
    _n = Note(_value, _label, _nullifier, _secret);
    assertEq(_commitment(_n), _c, 'commitment mirror');
    stateLeaves.push(_c);
    _approve(_label);
  }

  /// @dev Records a deposit made by a contract (e.g. a rezip) whose secrets the test already knows.
  function _track(Note memory _n) internal {
    stateLeaves.push(_commitment(_n));
  }

  function _approve(uint256 _label) internal {
    aspLeaves.push(_label);
    vm.prank(postman);
    entrypoint.updateRoot(_root(aspLeaves), 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi');
  }

  // --------------------------------------------------------------------------------------------------------------
  // proofs
  // --------------------------------------------------------------------------------------------------------------

  function _ffi(string[] memory _args) internal returns (bytes memory) {
    string[] memory _cmd = new string[](_args.length + 3);
    _cmd[0] = 'node';
    _cmd[1] = '../packages/sdk/node_modules/tsx/dist/cli.mjs';
    _cmd[2] = '../packages/sdk/scripts/ffi-prove.ts';
    for (uint256 _i; _i < _args.length; ++_i) _cmd[_i + 3] = _args[_i];
    return vm.ffi(_cmd);
  }

  function _root(uint256[] memory _leaves) internal returns (uint256) {
    string[] memory _a = new string[](2);
    _a[0] = 'root';
    _a[1] = vm.toString(abi.encode(_leaves));
    return abi.decode(_ffi(_a), (uint256));
  }

  function _context(IPrivacyPool.Withdrawal memory _w) internal view returns (uint256) {
    return uint256(keccak256(abi.encode(_w, scope))) % Constants.SNARK_SCALAR_FIELD;
  }

  /**
   * @notice Proves spending `_amount` of `_n` into `_w`. Returns the proof and the change note left in the pool.
   * @dev The change note's commitment is appended to the mirrored state tree only once the caller submits.
   */
  function _prove(
    Note memory _n,
    uint256 _amount,
    IPrivacyPool.Withdrawal memory _w
  ) internal returns (ProofLib.WithdrawProof memory _proof, Note memory _change) {
    (uint256 _nn, uint256 _ns) = _secrets();
    _change = Note(_n.value - _amount, _n.label, _nn, _ns);

    string[] memory _a = new string[](11);
    _a[0] = 'spend';
    _a[1] = vm.toString(_n.value);
    _a[2] = vm.toString(_n.label);
    _a[3] = vm.toString(_n.nullifier);
    _a[4] = vm.toString(_n.secret);
    _a[5] = vm.toString(_nn);
    _a[6] = vm.toString(_ns);
    _a[7] = vm.toString(_amount);
    _a[8] = vm.toString(_context(_w));
    _a[9] = vm.toString(abi.encode(stateLeaves));
    _a[10] = vm.toString(abi.encode(aspLeaves));
    _proof = abi.decode(_ffi(_a), (ProofLib.WithdrawProof));
    assertEq(_proof.newCommitmentHash(), _commitment(_change), 'change mirror');
  }

  /// @dev Call after a successful spend so later proofs see the change note.
  function _spent(ProofLib.WithdrawProof memory _proof) internal {
    stateLeaves.push(_proof.newCommitmentHash());
  }

  // --------------------------------------------------------------------------------------------------------------
  // semaphore
  // --------------------------------------------------------------------------------------------------------------

  /// @dev Identity commitment of a Semaphore identity derived from `_secret`
  function _identity(string memory _secret) internal returns (uint256) {
    string[] memory _a = new string[](2);
    _a[0] = 'identity';
    _a[1] = _secret;
    return abi.decode(_ffi(_a), (uint256));
  }

  /// @dev Semaphore proof of membership in the group whose leaves (in insertion order, 0 for removed) are `_members`
  function _semProof(string memory _secret, uint256[] memory _members, uint256 _message, uint256 _scope)
    internal
    returns (ISemaphore.SemaphoreProof memory)
  {
    string[] memory _a = new string[](5);
    _a[0] = 'semaphore';
    _a[1] = _secret;
    _a[2] = vm.toString(abi.encode(_members));
    _a[3] = vm.toString(_message);
    _a[4] = vm.toString(_scope);
    return abi.decode(_ffi(_a), (ISemaphore.SemaphoreProof));
  }
}
