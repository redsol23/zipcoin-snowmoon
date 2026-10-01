// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {Vm} from 'forge-std/Vm.sol';

import {PrivacyPoolComplex} from 'contracts/implementations/PrivacyPoolComplex.sol';
import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {ZipPrivacyPool} from 'zipnet/ZipPrivacyPool.sol';

import {PoolModel} from './PoolModel.sol';

/**
 * @notice STORAGE LAYOUT snapshot. ZipPrivacyPool must keep upstream PrivacyPoolComplex's layout exactly and add no
 *         slot of its own (TREASURY is immutable). Two independent checks, so a change that shifts storage fails CI:
 *
 *   1. The expected layout is hard-coded below (from `forge inspect <C> storageLayout`, upstream at
 *      privacy-pools-core d494b63) and verified BEHAVIOURALLY on both contracts with vm.load after real state changes:
 *      every slot, including the mapping bases and the LeanIMT struct members, holds what the getters report.
 *
 *        slot 0  nonce               uint256
 *        slot 1  dead                bool (offset 0)
 *        slot 2  roots               mapping(uint256 => uint256)
 *        slot 3  currentRootIndex    uint32 (offset 0)
 *        slot 4  _merkleTree.size    uint256      (LeanIMTData, slots 4-7)
 *        slot 5  _merkleTree.depth   uint256
 *        slot 6  _merkleTree.sideNodes  mapping(uint256 => uint256)
 *        slot 7  _merkleTree.leaves     mapping(uint256 => uint256)   (leaf => index + 1)
 *        slot 8  nullifierHashes     mapping(uint256 => bool)
 *        slot 9  depositors          mapping(uint256 => address)
 *
 *   2. `forge inspect` via FFI for both contracts, compared entry by entry (label, slot, offset, type), plus the same
 *      entry count. Skipped with a log line when FFI can't run forge (e.g. forge not on PATH).
 */
contract PoolStorageLayoutTest is PoolModel {
  function setUp() public {
    _deployStack();
  }

  function test_layout_behavioural_upstream() public {
    pool = IPrivacyPool(
      address(new PrivacyPoolComplex(address(entrypoint), address(verifier), address(verifier), address(zc)))
    );
    _exercise();
  }

  function test_layout_behavioural_zip() public {
    pool = IPrivacyPool(
      address(
        new ZipPrivacyPool(
          address(entrypoint), address(verifier), address(verifier), address(zc), payable(makeAddr('t'))
        )
      )
    );
    _exercise();
    // and harvest leaves every slot as it was
    bytes32[10] memory _before;
    for (uint256 _s; _s < 10; ++_s) {
      _before[_s] = vm.load(address(pool), bytes32(_s));
    }
    vm.deal(address(this), 1 ether);
    zc.distributeRewards{value: 1 ether}();
    ZipPrivacyPool(payable(address(pool))).harvest();
    for (uint256 _s; _s < 10; ++_s) {
      assertEq(vm.load(address(pool), bytes32(_s)), _before[_s], 'harvest wrote storage');
    }
  }

  function _slot(uint256 _key, uint256 _base) internal pure returns (bytes32) {
    return keccak256(abi.encode(_key, _base));
  }

  function _exercise() internal {
    _register(1 ether, 0, 500);
    vm.prank(postman);
    entrypoint.updateRoot(1, CID);

    address _alice = makeAddr('alice');
    uint256[] memory _leaves = new uint256[](3);
    for (uint256 _k; _k < 2; ++_k) {
      (uint256 _n, uint256 _s) = _secrets();
      zc.mint(_alice, 10 ether);
      vm.startPrank(_alice);
      zc.approve(address(entrypoint), 10 ether);
      uint256 _c = entrypoint.deposit(IERC20(address(zc)), 10 ether, _precommitment(_n, _s));
      vm.stopPrank();
      _recordDeposit(_alice, 10 ether, _n, _s, _c);
      _leaves[_k] = _c;
    }
    _postAsp(0);
    IPrivacyPool.Withdrawal memory _w = IPrivacyPool.Withdrawal(_alice, '');
    (ProofLib.WithdrawProof memory _p, Note memory _change) = _proveWithdraw(0, 4 ether, _w);
    vm.prank(_alice);
    pool.withdraw(_w, _p);
    _recordSpend(0, _change);
    _leaves[2] = _change.commitment;
    vm.prank(epOwner);
    entrypoint.windDownPool(pool);

    address _p0 = address(pool);
    assertEq(uint256(vm.load(_p0, bytes32(uint256(0)))), pool.nonce(), 'slot 0: nonce');
    assertEq(pool.nonce(), 2);
    assertEq(uint256(vm.load(_p0, bytes32(uint256(1)))), 1, 'slot 1: dead (only this bool in the slot)');
    uint256 _idx = pool.currentRootIndex();
    assertEq(_idx, 3);
    assertEq(
      uint256(vm.load(_p0, bytes32(uint256(3)))), _idx, 'slot 3: currentRootIndex (only this uint32 in the slot)'
    );
    for (uint256 _i = 1; _i <= 3; ++_i) {
      assertEq(uint256(vm.load(_p0, _slot(_i, 2))), pool.roots(_i), 'slot 2: roots mapping');
    }
    assertEq(uint256(vm.load(_p0, _slot(_idx, 2))), pool.currentRoot(), 'slot 2: latest root');
    assertEq(uint256(vm.load(_p0, bytes32(uint256(4)))), 3, 'slot 4: tree size');
    assertEq(uint256(vm.load(_p0, bytes32(uint256(4)))), pool.currentTreeSize());
    assertEq(uint256(vm.load(_p0, bytes32(uint256(5)))), pool.currentTreeDepth(), 'slot 5: tree depth');
    assertEq(uint256(vm.load(_p0, _slot(0, 6))), _leaves[2], 'slot 6: sideNodes[0] is the last even leaf');
    for (uint256 _i; _i < 3; ++_i) {
      assertEq(uint256(vm.load(_p0, _slot(_leaves[_i], 7))), _i + 1, 'slot 7: leaves mapping (index + 1)');
    }
    uint256 _nh = _nullifierHash(notes[0].nullifier);
    assertTrue(pool.nullifierHashes(_nh));
    assertEq(uint256(vm.load(_p0, _slot(_nh, 8))), 1, 'slot 8: nullifierHashes');
    for (uint256 _i; _i < labels.length; ++_i) {
      assertEq(address(uint160(uint256(vm.load(_p0, _slot(labels[_i], 9))))), _alice, 'slot 9: depositors');
    }
    for (uint256 _s = 10; _s < 16; ++_s) {
      assertEq(vm.load(_p0, bytes32(_s)), bytes32(0), 'nothing beyond slot 9');
    }
  }

  // ------------------------------------------------------------------------------------------------------------

  function _inspect(string memory _contract) internal returns (bool _ok, string memory _json) {
    string[] memory _cmd = new string[](5);
    _cmd[0] = 'forge';
    _cmd[1] = 'inspect';
    _cmd[2] = _contract;
    _cmd[3] = 'storageLayout';
    _cmd[4] = '--json';
    try vm.tryFfi(_cmd) returns (Vm.FfiResult memory _r) {
      if (_r.exitCode != 0 || _r.stdout.length == 0) return (false, '');
      return (true, string(_r.stdout));
    } catch {
      return (false, '');
    }
  }

  function test_layout_forgeInspect_zipEqualsUpstream() public {
    (bool _okU, string memory _up) = _inspect('PrivacyPoolComplex');
    (bool _okZ, string memory _zip) = _inspect('ZipPrivacyPool');
    if (!_okU || !_okZ) {
      emit log('forge inspect unavailable through FFI; the behavioural layout tests still apply');
      vm.skip(true);
    }
    uint256 _n;
    while (vm.keyExistsJson(_up, string.concat('.storage[', vm.toString(_n), ']'))) ++_n;
    assertEq(_n, 7, 'upstream has 7 storage variables');
    assertFalse(
      vm.keyExistsJson(_zip, string.concat('.storage[', vm.toString(_n), ']')), 'ZipPrivacyPool added storage'
    );
    string[7] memory _labels =
      ['nonce', 'dead', 'roots', 'currentRootIndex', '_merkleTree', 'nullifierHashes', 'depositors'];
    string[7] memory _slots = ['0', '1', '2', '3', '4', '8', '9'];
    for (uint256 _i; _i < _n; ++_i) {
      string memory _k = string.concat('.storage[', vm.toString(_i), ']');
      string[4] memory _f = ['.label', '.slot', '.type', '.offset'];
      for (uint256 _j; _j < 3; ++_j) {
        // Type strings embed compiler-internal AST ids (e.g. `t_struct(LeanIMTData)2911_storage`) that shift whenever
        // unrelated code changes; compare them with those ids removed so only real layout differences fail
        assertEq(
          _stripAstIds(vm.parseJsonString(_zip, string.concat(_k, _f[_j]))),
          _stripAstIds(vm.parseJsonString(_up, string.concat(_k, _f[_j]))),
          string.concat('storage entry ', vm.toString(_i), _f[_j])
        );
      }
      assertEq(
        vm.parseJsonUint(_zip, string.concat(_k, '.offset')),
        vm.parseJsonUint(_up, string.concat(_k, '.offset')),
        'offset'
      );
      assertEq(vm.parseJsonString(_zip, string.concat(_k, '.label')), _labels[_i], 'snapshot label');
      assertEq(vm.parseJsonString(_zip, string.concat(_k, '.slot')), _slots[_i], 'snapshot slot');
    }
  }

  /// @dev Drops the digits that directly follow a ')' (solc's AST id in storage type strings), keeping everything else
  function _stripAstIds(string memory _s) internal pure returns (string memory) {
    bytes memory _in = bytes(_s);
    bytes memory _out = new bytes(_in.length);
    uint256 _n;
    bool _afterParen;
    for (uint256 _i; _i < _in.length; ++_i) {
      bytes1 _c = _in[_i];
      bool _digit = _c >= '0' && _c <= '9';
      if (_afterParen && _digit) continue;
      _afterParen = _c == ')';
      _out[_n++] = _c;
    }
    assembly {
      mstore(_out, _n)
    }
    return string(_out);
  }
}
