// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TimelockController} from '@oz/governance/TimelockController.sol';
import {Script, console} from 'forge-std/Script.sol';

interface ISafeProxyFactory {
  function createProxyWithNonce(address _singleton, bytes memory _initializer, uint256 _saltNonce)
    external
    returns (address _proxy);
}

interface ISafe {
  function setup(
    address[] calldata _owners,
    uint256 _threshold,
    address _to,
    bytes calldata _data,
    address _fallbackHandler,
    address _paymentToken,
    uint256 _payment,
    address payable _paymentReceiver
  ) external;
  function getOwners() external view returns (address[] memory);
  function getThreshold() external view returns (uint256);
}

/**
 * @title Owners
 * @notice Creates what Deploy.s.sol needs as OWNER_SAFE, OWNER and TREASURY, in one run: two canonical Safe v1.4.1
 *         proxies (no modules, no guard) and an OpenZeppelin TimelockController run by the owner Safe.
 * @dev Env:
 *   SAFE_OWNERS        comma-separated signer addresses (required)
 *   SAFE_THRESHOLD     signatures needed (default 2; must be <= the number of owners)
 *   OWNER_MIN_DELAY    the timelock's delay in seconds (default 172800 = 48h, Deploy's minimum on chain 1)
 *   SAFE_SALT          salt nonce for the Safe proxies (default the block timestamp)
 *   DEPLOYMENT         names deployments/<DEPLOYMENT>-owners.json (default "owners")
 * Then run Deploy with OWNER, OWNER_SAFE and TREASURY from the log, and SAFE_MIN_THRESHOLD / SAFE_MIN_OWNERS set to the
 * threshold and owner count used here.
 */
contract Owners is Script {
  /// @notice Safe v1.4.1 canonical deployments (the same address on mainnet and Sepolia)
  address internal constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
  address internal constant SAFE_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
  address internal constant SAFE_FALLBACK = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;

  function run() external returns (address _ownerSafe, address _treasury, address _timelock) {
    address[] memory _owners = vm.envAddress('SAFE_OWNERS', ',');
    uint256 _threshold = vm.envOr('SAFE_THRESHOLD', uint256(2));
    uint256 _delay = vm.envOr('OWNER_MIN_DELAY', uint256(172_800));
    uint256 _salt = vm.envOr('SAFE_SALT', block.timestamp);
    require(_owners.length > 0 && _threshold > 0 && _threshold <= _owners.length, 'owners: bad SAFE_OWNERS / SAFE_THRESHOLD');
    require(SAFE_SINGLETON.code.length > 0 && SAFE_FACTORY.code.length > 0 && SAFE_FALLBACK.code.length > 0, 'owners: no canonical Safe v1.4.1 on this chain');

    vm.startBroadcast();
    _ownerSafe = _safe(_owners, _threshold, _salt);
    _treasury = _safe(_owners, _threshold, _salt + 1);
    address[] memory _run = new address[](1);
    _run[0] = _ownerSafe;
    // No admin: only the timelock itself (through the owner Safe and the delay) can change its roles
    _timelock = address(new TimelockController(_delay, _run, _run, address(0)));
    vm.stopBroadcast();

    for (uint256 _i; _i < 2; ++_i) {
      ISafe _s = ISafe(_i == 0 ? _ownerSafe : _treasury);
      require(_s.getThreshold() == _threshold && _s.getOwners().length == _owners.length, 'owners: Safe setup mismatch');
      require(address(uint160(uint256(vm.load(address(_s), bytes32(0))))) == SAFE_SINGLETON, 'owners: wrong singleton');
    }

    string memory _o = 'owners';
    vm.serializeAddress(_o, 'ownerSafe', _ownerSafe);
    vm.serializeAddress(_o, 'treasury', _treasury);
    vm.serializeAddress(_o, 'signers', _owners);
    vm.serializeUint(_o, 'threshold', _threshold);
    string memory _json = vm.serializeAddress(_o, 'timelock', _timelock);
    vm.writeJson(_json, string.concat('./deployments/', vm.envOr('DEPLOYMENT', string('owners')), '-owners.json'));

    console.log('OWNER_SAFE=%s', _ownerSafe);
    console.log('TREASURY=%s', _treasury);
    console.log('OWNER=%s', _timelock);
    console.log('SAFE_MIN_THRESHOLD=%s SAFE_MIN_OWNERS=%s', _threshold, _owners.length);
  }

  function _safe(address[] memory _owners, uint256 _threshold, uint256 _salt) internal returns (address) {
    bytes memory _init = abi.encodeCall(
      ISafe.setup, (_owners, _threshold, address(0), '', SAFE_FALLBACK, address(0), 0, payable(address(0)))
    );
    return ISafeProxyFactory(SAFE_FACTORY).createProxyWithNonce(SAFE_SINGLETON, _init, _salt);
  }
}
