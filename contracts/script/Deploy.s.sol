// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from '@oz/proxy/ERC1967/ERC1967Proxy.sol';
import {ERC20} from '@oz/token/ERC20/ERC20.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';
import {Semaphore} from '@semaphore-protocol/contracts/Semaphore.sol';
import {SemaphoreVerifier} from '@semaphore-protocol/contracts/base/SemaphoreVerifier.sol';
import {ISemaphore} from '@semaphore-protocol/contracts/interfaces/ISemaphore.sol';
import {ISemaphoreVerifier} from '@semaphore-protocol/contracts/interfaces/ISemaphoreVerifier.sol';
import {Script} from 'forge-std/Script.sol';
import {console} from 'forge-std/console.sol';

import {BatchRelayer} from 'contracts/BatchRelayer.sol';
import {Entrypoint} from 'contracts/Entrypoint.sol';
import {CommitmentVerifier} from 'contracts/verifiers/CommitmentVerifier.sol';
import {WithdrawalVerifier} from 'contracts/verifiers/WithdrawalVerifier.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {ZipAddressRegistry} from 'zipnet/ZipAddressRegistry.sol';
import {ZipBadges} from 'zipnet/ZipBadges.sol';
import {ZipBroadcaster} from 'zipnet/ZipBroadcaster.sol';
import {ZipCouriers} from 'zipnet/ZipCouriers.sol';
import {ZipDoorstep} from 'zipnet/ZipDoorstep.sol';
import {ZipMerchants} from 'zipnet/ZipMerchants.sol';
import {ZipPay} from 'zipnet/ZipPay.sol';
import {ZipPolls} from 'zipnet/ZipPolls.sol';
import {ZipPrivacyPool} from 'zipnet/ZipPrivacyPool.sol';
import {ZipRezip} from 'zipnet/ZipRezip.sol';
import {ZipSignal} from 'zipnet/ZipSignal.sol';
import {ZipLiquidityBands} from 'zipnet/ZipLiquidityBands.sol';

/// @notice Stand-in ZC for local runs; mainnet uses the sender.family token (never deployed on chain 1)
contract LocalZC is ERC20 {
  constructor(address _to) ERC20('zipcoin', 'ZC') {
    _mint(_to, 1_000_000_000 ether);
  }
}

/**
 * @notice Deploys the whole zipnet stack and writes deployments/<DEPLOYMENT>.json.
 *
 * Off chain 1 every variable is optional and unset means "deploy a fresh one" (what local runs want). On chain 1 the
 * script refuses (reverts with a "mainnet: ..." message) instead of falling back; see `validate` and docs/DEPLOY.md §3
 * for the full list. Env:
 *   ZC_ADDRESS                 token (mainnet: sender.family ZC 0x2CA7B61B23b15e75aC7AB60Dd6f627895d64a46E, required)
 *   WITHDRAWAL_VERIFIER        mainnet 0xbow: 0x022891F938Ae7fDC8Ab9Ead0FBf50aBA8C897D6d
 *   RAGEQUIT_VERIFIER          mainnet 0xbow: 0xa45ACa8604a73D80C551fAad6355A5c3A5565eC6
 *   ENTRYPOINT_IMPL            mainnet 0xbow: 0x15e355024de1CDc74ADdea7EBDf98418Ba5B1a2c
 *   ALLOW_FRESH_VERIFIERS      chain 1 only: 1 lets the three above be unset (deployed fresh) or differ from 0xbow's
 *   SEMAPHORE_ADDRESS          existing Semaphore v4 (mainnet: the canonical deployment, required)
 *   OWNER, POSTMAN, TREASURY   default to the broadcaster (local only; on chain 1 all three are required)
 *   OWNER_SAFE                 chain 1 (required): the 2-of-3 Safe behind OWNER. OWNER itself must be an OpenZeppelin
 *                              TimelockController with OWNER_SAFE as proposer and executor and no admin but itself, so
 *                              an Entrypoint upgrade or vetting-fee change waits out the delay and users can leave
 *                              first (R2-M3, core L-5)
 *   OWNER_MIN_DELAY            chain 1: the timelock's minimum delay must be at least this (default 172800 = 48h,
 *                              never below 1 day)
 *   SAFE_MIN_THRESHOLD, SAFE_MIN_OWNERS  chain 1: OWNER_SAFE and TREASURY must be Safes with at least this threshold
 *                              and owner count (default 2 and 3: the 2-of-3 decision), proxies of the canonical Safe
 *                              v1.3.0 / v1.4.1 singletons, with no module and no guard enabled
 *   SAFE_ALLOWED_MODULES       comma-separated modules (or a guard) those Safes may have anyway (default none)
 *   SAFE_SINGLETONS_EXTRA      comma-separated further Safe singletons to accept (e.g. a newer Safe release)
 *   DEPLOY_BATCH_RELAYER       deploy the upstream BatchRelayer for the wallet's combined-notes unzip (default true).
 *                              It is outside 0xbow's audits and anyone can take a balance it holds: nothing may send it
 *                              funds directly (pool review L-1)
 *   PRIVATE_KEY                deployer key (required)
 *   DEPLOYMENT                 output name, default "local" (chain 1: required, and not "local")
 *   BANDS_POSITION_MANAGER     Uniswap v4 PositionManager of ZC's pool (mainnet 0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e)
 *   BANDS_HOOK                 ZC's pool hook (mainnet 0xCb69D5aBe0589AF4c57b0dCCA292980D5E52C0c0). Both or neither:
 *                              with both, ZipLiquidityBands is deployed with TREASURY as its Safe. On chain 1 both are
 *                              checked against ZC's real pool (the token's factory `poolKeyFor`).
 *   BANDS_MAX_DAY_ZC           its immutable day-cap ceiling (default 10M ZC). The bands take ZC only, above the launch
 *                              range; any ETH reaching them (rewards, harvest) is passed on to the Safe.
 *   TAX_TREASURY               ZipPay's treasury share of the tax (immutable): "bands", "safe", or the bands / TREASURY
 *                              address. Unset = bands when deployed, else TREASURY (chain 1: required)
 *   HARVEST_TREASURY           the pool's harvested ETH (immutable), same values. Unset = TREASURY (chain 1: required)
 * Skipped contracts are left out of the deployment JSON.
 * Economics (defaults = plan; chain 1 needs each one set explicitly): MIN_DEPOSIT 1 ZC, MAX_RELAY_BPS 500,
 *   MIN_BURN 100 ZC, TAX_BPS 100, BURN_SHARE_BPS 5000, COURIER_SHARE_BPS 3000, MERCHANT_MIN_STAKE 1000 ZC,
 *   COURIER_MIN_STAKE 1000 ZC, PAYER_GROUP_MIN_BASE 1000 ZC (smallest ZipPay base that may join a merchant's payer
 *   group; chain 1 needs at least 10,000 ZC, since a join costs only its tax).
 *
 * The broadcaster initialises the Entrypoint as owner, registers the pool, then hands OWNER_ROLE to OWNER and
 * renounces its own, so no deployer key keeps power.
 *
 * The pool's address is predicted from the deployer's nonce (the bands contract records it as HARVEST_SOURCE).
 * Broadcast with `--slow` and send nothing else from the deployer meanwhile; the script asserts the prediction in the
 * simulation. On chain a nonce shift can no longer break anything (pool review L-2): the pool pays the bands contract's
 * real address, and since R2-M1 the bands contract accepts ETH from any sender, so a wrong HARVEST_SOURCE only
 * mislabels it. `--sig 'check()'` re-checks every role and wire after the broadcast (and warns on that label); run it
 * before announcing the addresses, and redeploy if it fails.
 */
contract Deploy is Script {
  struct Stack {
    address zc;
    address entrypoint;
    address pool;
    uint256 scope;
    address semaphore;
    address broadcaster;
    address doorstep;
    address rezip;
    address addressRegistry;
    address merchants;
    address couriers;
    address pay;
    address badges;
    address signal;
    address polls;
    address batchRelayer;
    address bands;
    uint256 deployBlock;
  }

  /// @notice A payout destination as written in env: unset, "safe", "bands" or a literal address
  enum Dest {
    Unset,
    Safe,
    Bands,
    Address
  }

  /// @notice Everything the deploy decides from env, read once and validated before anything is broadcast
  struct Config {
    address deployer;
    address zc;
    address withdrawalVerifier;
    address ragequitVerifier;
    address entrypointImpl;
    address semaphore;
    bool allowFreshVerifiers;
    address owner;
    address treasury;
    address postman;
    bool postmanCapsAck;
    uint256 safeMinThreshold;
    uint256 safeMinOwners;
    /// @dev Chain 1: OWNER is an OpenZeppelin TimelockController, and OWNER_SAFE proposes and executes through it
    address ownerSafe;
    uint256 ownerMinDelay;
    /// @dev Safe modules (or a Safe guard) the guard accepts on OWNER_SAFE and TREASURY; default none
    address[] safeAllowed;
    /// @dev Safe singletons beyond the canonical v1.3.0 / v1.4.1 ones
    address[] safeSingletonsExtra;
    uint256 payerGroupMinBase;
    bool deployBatchRelayer;
    address bandsPosm;
    address bandsHook;
    Dest tax;
    address taxAddr;
    Dest harvest;
    address harvestAddr;
    string deployment;
    /// @dev The first immutable-economics variable left unset ('' = none); chain 1 needs every one explicit
    string missing;
  }

  /// @notice The mainnet contracts the chain-1 guard compares against (zero off chain 1)
  struct Known {
    address zc;
    address withdrawalVerifier;
    address ragequitVerifier;
    address entrypointImpl;
    address semaphore;
    address semaphoreVerifier;
    address factory;
    address poolManager;
    address posm;
    address permit2;
    address hook;
  }

  uint256 internal constant ZC_TOTAL_SUPPLY = 1_000_000_000 ether;
  /// @dev ERC-1967 implementation slot, what a UUPS implementation's proxiableUUID() returns
  bytes32 internal constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc; // guard:allow (ERC-1967 slot)
  /// @dev Safe's guard storage slot, keccak256("guard_manager.guard.address")
  bytes32 internal constant SAFE_GUARD_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8; // guard:allow (Safe guard slot)
  /// @dev Safe's module list starts and ends at this sentinel
  address internal constant SAFE_SENTINEL = address(0x1);
  /// @notice The Entrypoint OWNER timelock's default minimum delay, and the lowest OWNER_MIN_DELAY accepted
  uint256 internal constant OWNER_DELAY_DEFAULT = 2 days;
  uint256 internal constant OWNER_DELAY_FLOOR = 1 days;
  /// @notice Chain 1: the smallest PAYER_GROUP_MIN_BASE accepted (a payer-group join costs this base's tax)
  uint256 internal constant PAYER_GROUP_MIN_BASE_FLOOR = 10_000 ether;
  bytes32 internal constant OWNER_ROLE = keccak256('OWNER_ROLE');
  bytes32 internal constant ASP_POSTMAN = keccak256('ASP_POSTMAN');

  Stack internal s;
  address internal me;
  /// @dev ZipPay's resolved treasury (bands or the Safe)
  address internal taxTo;

  function run() external returns (Stack memory) {
    uint256 _key = vm.envUint('PRIVATE_KEY');
    me = vm.addr(_key);
    Config memory _c = readConfig(me);
    validate(_c, known());
    s.deployBlock = block.number;
    vm.startBroadcast(_key);
    _deploy(_c);
    vm.stopBroadcast();
    _write(s, _c.deployment);
    return s;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // config and the mainnet guard
  // ---------------------------------------------------------------------------------------------------------------

  /// @notice The mainnet constants on chain 1 (docs/DEPLOY.md §3, BandsFork.t.sol); all zero elsewhere
  function known() public view returns (Known memory _k) {
    if (block.chainid != 1) return _k;
    _k = Known({
      zc: 0x2CA7B61B23b15e75aC7AB60Dd6f627895d64a46E,
      withdrawalVerifier: 0x022891F938Ae7fDC8Ab9Ead0FBf50aBA8C897D6d,
      ragequitVerifier: 0xa45ACa8604a73D80C551fAad6355A5c3A5565eC6,
      entrypointImpl: 0x15e355024de1CDc74ADdea7EBDf98418Ba5B1a2c,
      semaphore: 0x8A1fd199516489B0Fb7153EB5f075cDAC83c693D,
      semaphoreVerifier: 0x4DeC9E3784EcC1eE002001BfE91deEf4A48931f8,
      factory: 0x8D37c2981bdF809567092fd458B6bf3e97ee860c,
      poolManager: 0x000000000004444c5dc75cB358380D2e3dE08A90,
      posm: 0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e,
      permit2: 0x000000000022D473030F116dDEE9F6B43aC78BA3,
      hook: 0xCb69D5aBe0589AF4c57b0dCCA292980D5E52C0c0
    });
  }

  /// @notice Reads the deploy config from env
  function readConfig(address _deployer) public view returns (Config memory _c) {
    bool _main = block.chainid == 1;
    _c.deployer = _deployer;
    _c.zc = vm.envOr('ZC_ADDRESS', address(0));
    _c.withdrawalVerifier = vm.envOr('WITHDRAWAL_VERIFIER', address(0));
    _c.ragequitVerifier = vm.envOr('RAGEQUIT_VERIFIER', address(0));
    _c.entrypointImpl = vm.envOr('ENTRYPOINT_IMPL', address(0));
    _c.semaphore = vm.envOr('SEMAPHORE_ADDRESS', address(0));
    _c.allowFreshVerifiers = vm.envOr('ALLOW_FRESH_VERIFIERS', false);
    _c.owner = vm.envOr('OWNER', _main ? address(0) : _deployer);
    _c.treasury = vm.envOr('TREASURY', _main ? address(0) : _deployer);
    _c.postman = vm.envOr('POSTMAN', _main ? address(0) : _deployer);
    _c.postmanCapsAck = keccak256(bytes(vm.envOr('POSTMAN_CAPS_ACK', string(''))))
      == keccak256('MAX_DEPOSIT_WEI,MAX_DEPOSITOR_DAILY_WEI');
    _c.safeMinThreshold = vm.envOr('SAFE_MIN_THRESHOLD', uint256(2));
    _c.safeMinOwners = vm.envOr('SAFE_MIN_OWNERS', uint256(3));
    _c.ownerSafe = vm.envOr('OWNER_SAFE', address(0));
    _c.ownerMinDelay = vm.envOr('OWNER_MIN_DELAY', uint256(OWNER_DELAY_DEFAULT));
    _c.safeAllowed = vm.envOr('SAFE_ALLOWED_MODULES', ',', new address[](0));
    _c.safeSingletonsExtra = vm.envOr('SAFE_SINGLETONS_EXTRA', ',', new address[](0));
    _c.payerGroupMinBase = vm.envOr('PAYER_GROUP_MIN_BASE', uint256(1000 ether));
    _c.deployBatchRelayer = vm.envOr('DEPLOY_BATCH_RELAYER', true);
    _c.bandsPosm = vm.envOr('BANDS_POSITION_MANAGER', address(0));
    _c.bandsHook = vm.envOr('BANDS_HOOK', address(0));
    (_c.tax, _c.taxAddr) = parseDest(vm.envOr('TAX_TREASURY', string('')));
    (_c.harvest, _c.harvestAddr) = parseDest(vm.envOr('HARVEST_TREASURY', string('')));
    _c.deployment = vm.envOr('DEPLOYMENT', _main ? string('') : string('local'));
    _c.missing = _firstUnset(_c);
  }

  /// @notice "safe" / "bands" / "" / an address; anything else reverts
  function parseDest(string memory _v) public pure returns (Dest, address) {
    bytes32 _h = keccak256(bytes(_v));
    if (bytes(_v).length == 0) return (Dest.Unset, address(0));
    if (_h == keccak256('safe')) return (Dest.Safe, address(0));
    if (_h == keccak256('bands')) return (Dest.Bands, address(0));
    return (Dest.Address, vm.parseAddress(_v));
  }

  /**
   * @notice Where a payout goes: the Safe (TREASURY) or the bands contract, nothing else. `_bands` is the bands
   *         contract's (predicted) address, zero when it is not deployed. An address must equal one of the two, so a
   *         hex bands address wires exactly like "bands" (the bands contract then accepts the pool's harvest).
   */
  function resolveDest(string memory _name, Dest _d, address _a, address _safe, address _bands, Dest _default)
    public
    pure
    returns (Dest)
  {
    if (_d == Dest.Unset) _d = _default;
    if (_d == Dest.Address) {
      if (_a == _safe) return Dest.Safe;
      require(
        _bands != address(0) && _a == _bands,
        string.concat(_name, ' must be "bands", "safe", or the TREASURY Safe or bands contract address; got ', vm.toString(_a))
      );
      return Dest.Bands;
    }
    require(
      _d != Dest.Bands || _bands != address(0),
      string.concat(_name, '=bands needs BANDS_POSITION_MANAGER and BANDS_HOOK (the bands contract is not being deployed)')
    );
    return _d;
  }

  /// @notice Where the bands contract will land: after LocalZC, the fresh verifiers / implementation and the proxy
  function predictBands(Config memory _c) public view returns (address) {
    if (_c.bandsPosm == address(0)) return address(0);
    uint256 _n = vm.getNonce(_c.deployer) + 1; // the Entrypoint proxy
    if (_c.zc == address(0)) ++_n;
    if (_c.withdrawalVerifier == address(0)) ++_n;
    if (_c.ragequitVerifier == address(0)) ++_n;
    if (_c.entrypointImpl == address(0)) ++_n;
    return vm.computeCreateAddress(_c.deployer, _n);
  }

  /**
   * @notice Refuses a bad config before anything is broadcast. Everywhere: the bands pool config is both-or-neither
   *         and both payout destinations resolve to the Safe or the bands contract. On chain 1, every fallback that
   *         would deploy a stand-in, pick a default or skip a decided contract refuses instead.
   */
  function validate(Config memory _c, Known memory _k) public view {
    require(
      (_c.bandsPosm == address(0)) == (_c.bandsHook == address(0)),
      'BANDS_POSITION_MANAGER and BANDS_HOOK must be set together (both or neither)'
    );
    address _bands = predictBands(_c);
    resolveDest('TAX_TREASURY', _c.tax, _c.taxAddr, _c.treasury, _bands, _bands != address(0) ? Dest.Bands : Dest.Safe);
    resolveDest('HARVEST_TREASURY', _c.harvest, _c.harvestAddr, _c.treasury, _bands, Dest.Safe);
    if (block.chainid != 1) return;
    _guardRoles(_c);
    _guardExisting(_c, _k);
    _guardPayouts(_c, _k);
    _guardScope(_c);
  }

  /**
   * @dev OWNER, OWNER_SAFE, TREASURY and POSTMAN set, distinct, not the deployer. OWNER is a TimelockController whose
   *      proposer and executor is OWNER_SAFE (R2-M3, core L-5: the Entrypoint OWNER can upgrade it and set the
   *      vetting fee, so users get OWNER_MIN_DELAY to exit first). OWNER_SAFE and TREASURY are 2-of-3 (or the
   *      override) Safes with no modules or guard beyond SAFE_ALLOWED_MODULES.
   */
  function _guardRoles(Config memory _c) internal view {
    address[4] memory _a = [_c.owner, _c.ownerSafe, _c.treasury, _c.postman];
    string[4] memory _n = ['OWNER', 'OWNER_SAFE', 'TREASURY', 'POSTMAN'];
    for (uint256 _i; _i < 4; ++_i) {
      require(_a[_i] != address(0), string.concat('mainnet: ', _n[_i], ' must be set'));
      require(_a[_i] != _c.deployer, string.concat('mainnet: ', _n[_i], ' must not be the deployer'));
    }
    require(_c.ownerSafe != _c.treasury, 'mainnet: OWNER_SAFE and TREASURY must be different Safes');
    require(
      _c.owner != _c.ownerSafe && _c.owner != _c.treasury,
      'mainnet: OWNER must be the timelock OWNER_SAFE proposes through, not a Safe'
    );
    require(
      _c.postman != _c.owner && _c.postman != _c.ownerSafe && _c.postman != _c.treasury,
      'mainnet: POSTMAN must be its own hot key, not a Safe'
    );
    require(_c.safeMinThreshold >= 1 && _c.safeMinOwners >= _c.safeMinThreshold, 'mainnet: bad SAFE_MIN_THRESHOLD / SAFE_MIN_OWNERS');
    _guardTimelock(_c);
    _guardSafe('OWNER_SAFE', _c.ownerSafe, _c);
    _guardSafe('TREASURY', _c.treasury, _c);
    require(
      _c.postmanCapsAck,
      'mainnet: set MAX_DEPOSIT_WEI and MAX_DEPOSITOR_DAILY_WEI in the postman env, then POSTMAN_CAPS_ACK=MAX_DEPOSIT_WEI,MAX_DEPOSITOR_DAILY_WEI'
    );
  }

  /// @dev OWNER looks like an OpenZeppelin TimelockController with delay >= OWNER_MIN_DELAY, run by OWNER_SAFE
  function _guardTimelock(Config memory _c) internal view {
    require(
      _c.owner.code.length > 0,
      'mainnet: OWNER has no code; it must be an OpenZeppelin TimelockController that OWNER_SAFE proposes through'
    );
    (bool _ok, bytes memory _r) = _c.owner.staticcall(abi.encodeWithSignature('getMinDelay()'));
    require(_ok && _r.length >= 32, 'mainnet: OWNER does not answer getMinDelay(); it must be an OpenZeppelin TimelockController');
    uint256 _delay = abi.decode(_r, (uint256));
    require(_c.ownerMinDelay >= OWNER_DELAY_FLOOR, 'mainnet: OWNER_MIN_DELAY is below 1 day');
    require(
      _delay >= _c.ownerMinDelay,
      string.concat('mainnet: the OWNER timelock delay is ', vm.toString(_delay), 's, below OWNER_MIN_DELAY ', vm.toString(_c.ownerMinDelay))
    );
    require(_timelockRole(_c.owner, 'PROPOSER_ROLE()', _c.ownerSafe), 'mainnet: OWNER_SAFE is not a proposer on the OWNER timelock');
    require(
      _timelockRole(_c.owner, 'EXECUTOR_ROLE()', _c.ownerSafe) || _timelockRole(_c.owner, 'EXECUTOR_ROLE()', address(0)),
      'mainnet: OWNER_SAFE cannot execute on the OWNER timelock'
    );
    require(
      !_hasRole(_c.owner, bytes32(0), _c.deployer) && !_hasRole(_c.owner, bytes32(0), _c.ownerSafe),
      'mainnet: the OWNER timelock must have no admin but itself (deploy it with admin = address(0))'
    );
  }

  function _timelockRole(address _timelock, string memory _roleSig, address _who) internal view returns (bool) {
    (bool _ok, bytes memory _r) = _timelock.staticcall(abi.encodeWithSignature(_roleSig));
    return _ok && _r.length >= 32 && _hasRole(_timelock, abi.decode(_r, (bytes32)), _who);
  }

  function _hasRole(address _target, bytes32 _role, address _who) internal view returns (bool) {
    (bool _ok, bytes memory _r) = _target.staticcall(abi.encodeWithSignature('hasRole(bytes32,address)', _role, _who));
    return _ok && _r.length >= 32 && abi.decode(_r, (bool));
  }

  /**
   * @dev A canonical Safe (its proxy's singleton, storage slot 0, is Safe v1.3.0 or v1.4.1, or listed in
   *      SAFE_SINGLETONS_EXTRA) with the threshold and owner count, and no module or guard that could act without the
   *      threshold (a module can move anything) unless listed in SAFE_ALLOWED_MODULES.
   */
  function _guardSafe(string memory _name, address _safe, Config memory _c) internal view {
    require(_safe.code.length > 0, string.concat('mainnet: ', _name, ' has no code; it must be a Safe'));
    (bool _ok, bytes memory _r) = _safe.staticcall(abi.encodeWithSignature('getThreshold()'));
    require(_ok && _r.length >= 32, string.concat('mainnet: ', _name, ' does not answer getThreshold(); not a Safe'));
    uint256 _threshold = abi.decode(_r, (uint256));
    (_ok, _r) = _safe.staticcall(abi.encodeWithSignature('getOwners()'));
    require(_ok && _r.length >= 64, string.concat('mainnet: ', _name, ' does not answer getOwners(); not a Safe'));
    uint256 _owners = abi.decode(_r, (address[])).length;
    require(
      _threshold >= _c.safeMinThreshold,
      string.concat('mainnet: ', _name, ' Safe threshold is ', vm.toString(_threshold), ', below SAFE_MIN_THRESHOLD ', vm.toString(_c.safeMinThreshold))
    );
    require(
      _owners >= _c.safeMinOwners,
      string.concat('mainnet: ', _name, ' Safe has ', vm.toString(_owners), ' owners, below SAFE_MIN_OWNERS ', vm.toString(_c.safeMinOwners))
    );
    address _singleton = address(uint160(uint256(vm.load(_safe, bytes32(0)))));
    require(
      _isSafeSingleton(_singleton) || _listed(_c.safeSingletonsExtra, _singleton),
      string.concat('mainnet: ', _name, ' is not a proxy of a known Safe singleton (got ', vm.toString(_singleton), '; SAFE_SINGLETONS_EXTRA adds one)')
    );
    (_ok, _r) = _safe.staticcall(abi.encodeWithSignature('getModulesPaginated(address,uint256)', SAFE_SENTINEL, uint256(20)));
    require(_ok && _r.length >= 64, string.concat('mainnet: ', _name, ' does not answer getModulesPaginated; not a Safe'));
    (address[] memory _modules,) = abi.decode(_r, (address[], address));
    for (uint256 _i; _i < _modules.length; ++_i) {
      require(
        _listed(_c.safeAllowed, _modules[_i]),
        string.concat('mainnet: ', _name, ' has module ', vm.toString(_modules[_i]), ' enabled; a module bypasses the threshold (SAFE_ALLOWED_MODULES lists accepted ones)')
      );
    }
    address _guard = address(uint160(uint256(vm.load(_safe, SAFE_GUARD_SLOT))));
    require(
      _guard == address(0) || _listed(_c.safeAllowed, _guard),
      string.concat('mainnet: ', _name, ' has guard ', vm.toString(_guard), ' set (SAFE_ALLOWED_MODULES lists accepted ones)')
    );
  }

  /// @dev Safe v1.3.0 (Safe, SafeL2) and v1.4.1 (Safe, SafeL2) singletons, the canonical deployments
  function _isSafeSingleton(address _a) internal pure returns (bool) {
    return _a == 0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552 || _a == 0x3E5c63644E683549055b9Be8653de26E0B4CD36E
      || _a == 0x41675C099F32341bf84BFc5382aF534df5C7461a || _a == 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
  }

  function _listed(address[] memory _list, address _a) internal pure returns (bool) {
    for (uint256 _i; _i < _list.length; ++_i) {
      if (_list[_i] == _a) return true;
    }
    return false;
  }

  /// @dev ZC, the 0xbow verifiers and Entrypoint implementation, and Semaphore: the real ones, never stand-ins
  function _guardExisting(Config memory _c, Known memory _k) internal view {
    require(_c.zc != address(0), 'mainnet: ZC_ADDRESS must be set (the script never deploys a stand-in ZC on chain 1)');
    require(_c.zc == _k.zc, string.concat('mainnet: ZC_ADDRESS is not ZC ', vm.toString(_k.zc)));
    require(_c.zc.code.length > 0, 'mainnet: ZC_ADDRESS has no code');
    (bool _ok, bytes memory _r) = _c.zc.staticcall(abi.encodeWithSignature('totalSupply()'));
    require(_ok && _r.length >= 32 && abi.decode(_r, (uint256)) == ZC_TOTAL_SUPPLY, 'mainnet: ZC_ADDRESS totalSupply is not 1e27; not ZC');
    (_ok, _r) = _c.zc.staticcall(abi.encodeWithSignature('holderFeesEnabled()'));
    require(_ok && _r.length >= 32, 'mainnet: ZC_ADDRESS does not answer holderFeesEnabled(); not ZC');

    _guardZeroBow('WITHDRAWAL_VERIFIER', _c.withdrawalVerifier, _k.withdrawalVerifier, _c.allowFreshVerifiers);
    _guardZeroBow('RAGEQUIT_VERIFIER', _c.ragequitVerifier, _k.ragequitVerifier, _c.allowFreshVerifiers);
    _guardZeroBow('ENTRYPOINT_IMPL', _c.entrypointImpl, _k.entrypointImpl, _c.allowFreshVerifiers);
    if (_c.entrypointImpl != address(0)) {
      (_ok, _r) = _c.entrypointImpl.staticcall(abi.encodeWithSignature('proxiableUUID()'));
      require(_ok && _r.length >= 32 && bytes32(_r) == IMPL_SLOT, 'mainnet: ENTRYPOINT_IMPL is not a UUPS implementation');
    }

    require(_c.semaphore != address(0), 'mainnet: set SEMAPHORE_ADDRESS to the canonical Semaphore v4');
    require(_c.semaphore == _k.semaphore, string.concat('mainnet: SEMAPHORE_ADDRESS is not the canonical Semaphore v4 ', vm.toString(_k.semaphore)));
    require(_c.semaphore.code.length > 0, 'SEMAPHORE_ADDRESS has no code on this chain');
    (_ok, _r) = _c.semaphore.staticcall(abi.encodeWithSignature('verifier()'));
    require(
      _ok && _r.length >= 32 && abi.decode(_r, (address)) == _k.semaphoreVerifier,
      'mainnet: SEMAPHORE_ADDRESS verifier() is not the canonical SemaphoreVerifier'
    );
  }

  /**
   * @dev The 0xbow production verifiers and Entrypoint implementation. Fresh copies compile from the same vendored
   *      sources and verification keys, but they are a new, unreviewed deployment instead of the instances the fork
   *      test, the audit and 0xbow's own pools use, so chain 1 takes them only with ALLOW_FRESH_VERIFIERS=1.
   */
  function _guardZeroBow(string memory _name, address _a, address _known, bool _allowFresh) internal view {
    if (_a == address(0)) {
      require(
        _allowFresh,
        string.concat('mainnet: ', _name, ' must be set to the 0xbow production contract (ALLOW_FRESH_VERIFIERS=1 deploys a fresh one)')
      );
      console.log('WARNING: ALLOW_FRESH_VERIFIERS: deploying a fresh', _name);
      return;
    }
    require(_a.code.length > 0, string.concat('mainnet: ', _name, ' has no code'));
    if (_a != _known) {
      require(_allowFresh, string.concat('mainnet: ', _name, ' is not the 0xbow production contract ', vm.toString(_known)));
      console.log('WARNING: ALLOW_FRESH_VERIFIERS: non-0xbow', _name, _a);
    }
  }

  /// @dev TAX_TREASURY and HARVEST_TREASURY explicit; the bands pool config is ZC's real v4 pool
  function _guardPayouts(Config memory _c, Known memory _k) internal view {
    require(_c.tax != Dest.Unset, 'mainnet: TAX_TREASURY must be set explicitly: "bands" (the launch decision) or "safe"');
    require(_c.harvest != Dest.Unset, 'mainnet: HARVEST_TREASURY must be set explicitly: "safe" (the launch default) or "bands"');
    if (_c.bandsPosm == address(0)) return;
    require(_c.bandsPosm == _k.posm, string.concat('mainnet: BANDS_POSITION_MANAGER is not the v4 PositionManager ', vm.toString(_k.posm)));
    require(_c.bandsHook == _k.hook, string.concat('mainnet: BANDS_HOOK is not ZC launch hook ', vm.toString(_k.hook)));
    require(_word(_c.bandsPosm, 'poolManager()') == _k.poolManager, 'mainnet: BANDS_POSITION_MANAGER poolManager() is not the v4 PoolManager');
    require(_word(_c.bandsPosm, 'permit2()') == _k.permit2, 'mainnet: BANDS_POSITION_MANAGER permit2() is not Permit2');
    require(_word(_c.zc, 'market()') == _k.poolManager, 'mainnet: ZC market() is not the v4 PoolManager');
    require(_word(_c.zc, 'factory()') == _k.factory, 'mainnet: ZC factory() is not the launch factory');
    (bool _ok, bytes memory _r) = _k.factory.staticcall(abi.encodeWithSignature('poolKeyFor(address)', _c.zc));
    require(_ok && _r.length >= 160, 'mainnet: factory poolKeyFor(ZC) failed');
    ZipLiquidityBands.PoolKey memory _key = abi.decode(_r, (ZipLiquidityBands.PoolKey));
    ZipLiquidityBands.PoolKey memory _want = ZipLiquidityBands.PoolKey(
      address(0), _c.zc, 10_000, 200, _c.bandsHook
    );
    require(
      keccak256(abi.encode(_key)) == keccak256(abi.encode(_want)),
      'mainnet: ZC pool key (factory poolKeyFor) is not ETH/ZC, fee 10000, tickSpacing 200, BANDS_HOOK'
    );
    (_ok, _r) = _k.factory.staticcall(abi.encodeWithSignature('startTickOf(address)', _c.zc));
    require(
      _ok && _r.length >= 32 && abi.decode(_r, (int24)) == 196_600,
      'mainnet: ZC start tick is not 196600 (the bands assume the launch range [127600, 196600])'
    );
  }

  /// @dev A real deployment name, economics explicit
  function _guardScope(Config memory _c) internal pure {
    require(
      bytes(_c.deployment).length > 0 && keccak256(bytes(_c.deployment)) != keccak256('local'),
      'mainnet: set DEPLOYMENT (e.g. mainnet); the output must not overwrite local.json'
    );
    bytes memory _name = bytes(_c.deployment);
    for (uint256 _i; _i < _name.length; ++_i) {
      require(
        _name[_i] != '/' && _name[_i] != '\\' && _name[_i] != '.',
        'mainnet: DEPLOYMENT is a file name (e.g. mainnet), not a path: the services variable of that name is a path'
      );
    }
    require(
      bytes(_c.missing).length == 0,
      string.concat('mainnet: set ', _c.missing, ' explicitly (immutable economics have no silent default on chain 1)')
    );
    // core L-2: a payer-group identity costs the tax on this base (a merchant paying itself gets the base back), so a
    // tiny base makes the groups free to fill
    require(
      _c.payerGroupMinBase >= PAYER_GROUP_MIN_BASE_FLOOR,
      'mainnet: PAYER_GROUP_MIN_BASE must be at least 10000 ZC (1e22 wei): a payer-group join costs only its tax'
    );
  }

  /// @dev The economics a chain-1 deploy must spell out, given what is being deployed
  function _firstUnset(Config memory _c) internal view returns (string memory) {
    string[9] memory _always = [
      'MIN_DEPOSIT',
      'MAX_RELAY_BPS',
      'MIN_BURN',
      'TAX_BPS',
      'BURN_SHARE_BPS',
      'COURIER_SHARE_BPS',
      'MERCHANT_MIN_STAKE',
      'COURIER_MIN_STAKE',
      'PAYER_GROUP_MIN_BASE'
    ];
    for (uint256 _i; _i < _always.length; ++_i) {
      if (!vm.envExists(_always[_i])) return _always[_i];
    }
    if (_c.bandsPosm != address(0) && !vm.envExists('BANDS_MAX_DAY_ZC')) return 'BANDS_MAX_DAY_ZC';
    return '';
  }

  function _word(address _target, string memory _sig) internal view returns (address) {
    (bool _ok, bytes memory _r) = _target.staticcall(abi.encodeWithSignature(_sig));
    if (!_ok || _r.length < 32) return address(0);
    return abi.decode(_r, (address));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // deploy
  // ---------------------------------------------------------------------------------------------------------------

  function _deploy(Config memory _c) internal {
    _core(_c);
    _features(_c);
    _handOver(_c.owner);
  }

  function _core(Config memory _c) internal {
    s.zc = _c.zc;
    if (s.zc == address(0)) {
      require(block.chainid != 1, 'mainnet: ZC_ADDRESS must be set');
      s.zc = address(new LocalZC(me));
    }
    bool _fresh = block.chainid != 1 || _c.allowFreshVerifiers;
    address _wv = _c.withdrawalVerifier;
    address _rv = _c.ragequitVerifier;
    address _impl = _c.entrypointImpl;
    require(_fresh || (_wv != address(0) && _rv != address(0) && _impl != address(0)), 'mainnet: no fresh verifiers');
    if (_wv == address(0)) _wv = address(new WithdrawalVerifier());
    if (_rv == address(0)) _rv = address(new CommitmentVerifier());
    if (_impl == address(0)) _impl = address(new Entrypoint());

    Entrypoint _ep =
      Entrypoint(payable(address(new ERC1967Proxy(_impl, abi.encodeCall(Entrypoint.initialize, (me, _c.postman))))));
    _bandsAndPool(_c, address(_ep), _wv, _rv);
    _ep.registerPool(
      IERC20(s.zc), IPrivacyPool(s.pool), vm.envOr('MIN_DEPOSIT', uint256(1 ether)), 0, vm.envOr('MAX_RELAY_BPS', uint256(500))
    );
    s.entrypoint = address(_ep);
    s.scope = ZipPrivacyPool(payable(s.pool)).SCOPE();

    // Mainnet uses the canonical Semaphore v4; locally a fresh one
    s.semaphore = _c.semaphore;
    if (s.semaphore == address(0)) {
      require(block.chainid != 1, 'mainnet: set SEMAPHORE_ADDRESS to the canonical Semaphore v4');
      s.semaphore = address(new Semaphore(ISemaphoreVerifier(address(new SemaphoreVerifier()))));
    }
    require(s.semaphore.code.length > 0, 'SEMAPHORE_ADDRESS has no code on this chain');
  }

  /**
   * @dev The bands contract comes first so it can name the pool as its harvest source; the pool then pays
   *      HARVEST_TREASURY (the Safe or the bands contract). Both addresses come from the deployer's nonce and are
   *      asserted, as is the harvest wiring: the pool pays the bands contract exactly when the bands contract accepts it.
   */
  function _bandsAndPool(Config memory _c, address _ep, address _wv, address _rv) internal {
    bool _withBands = _c.bandsPosm != address(0);
    uint256 _n = vm.getNonce(me);
    address _bandsAt = _withBands ? vm.computeCreateAddress(me, _n) : address(0);
    address _poolAt = vm.computeCreateAddress(me, _withBands ? _n + 1 : _n);
    bool _harvestToBands =
      resolveDest('HARVEST_TREASURY', _c.harvest, _c.harvestAddr, _c.treasury, _bandsAt, Dest.Safe) == Dest.Bands;
    if (_withBands) {
      _deployBands(_c, _harvestToBands ? _poolAt : address(0));
      require(s.bands == _bandsAt, 'bands contract is not at the predicted address (deployer nonce moved; use --slow)');
    }
    // Upstream PrivacyPoolComplex plus harvest(): the pool's ZC holder rewards (ETH) go to HARVEST_TREASURY
    ZipPrivacyPool _pool = new ZipPrivacyPool(_ep, _wv, _rv, s.zc, payable(_harvestToBands ? s.bands : _c.treasury));
    require(
      address(_pool) == _poolAt,
      'pool is not at the predicted address the bands contract expects (deployer nonce moved; use --slow)'
    );
    if (s.bands != address(0)) {
      require(
        (_pool.TREASURY() == s.bands) == (ZipLiquidityBands(payable(s.bands)).HARVEST_SOURCE() == address(_pool)),
        'harvest wiring: the pool pays the bands contract only if the bands contract accepts the pool'
      );
    }
    s.pool = address(_pool);
  }

  function _features(Config memory _c) internal {
    IPrivacyPool _p = IPrivacyPool(s.pool);
    ISemaphore _sem = ISemaphore(s.semaphore);
    uint256 _minBurn = vm.envOr('MIN_BURN', uint256(100 ether));
    s.broadcaster = address(new ZipBroadcaster(_p, _minBurn));
    s.doorstep = address(new ZipDoorstep(_p, _minBurn));
    s.rezip = address(new ZipRezip(_p));
    s.addressRegistry = address(new ZipAddressRegistry());
    s.merchants = address(new ZipMerchants(IERC20(s.zc), vm.envOr('MERCHANT_MIN_STAKE', uint256(1000 ether))));
    s.couriers = address(new ZipCouriers(_p, vm.envOr('COURIER_MIN_STAKE', uint256(1000 ether))));
    Dest _tax = resolveDest(
      'TAX_TREASURY', _c.tax, _c.taxAddr, _c.treasury, s.bands, s.bands != address(0) ? Dest.Bands : Dest.Safe
    );
    taxTo = _tax == Dest.Bands ? s.bands : _c.treasury;
    s.pay = address(
      new ZipPay(
        _p,
        ZipMerchants(payable(s.merchants)),
        vm.envOr('TAX_BPS', uint256(100)),
        vm.envOr('BURN_SHARE_BPS', uint256(5000)),
        vm.envOr('COURIER_SHARE_BPS', uint256(3000)),
        s.couriers,
        taxTo,
        _sem,
        vm.envOr('PAYER_GROUP_MIN_BASE', uint256(1000 ether))
      )
    );
    uint256[] memory _tiers = new uint256[](4);
    _tiers[0] = 3000 ether; //         100 ZC x  30 days
    _tiers[1] = 30_000 ether; //     1,000 ZC x  30 days
    _tiers[2] = 365_000 ether; //    1,000 ZC x 365 days
    _tiers[3] = 3_650_000 ether; // 10,000 ZC x 365 days
    s.badges = address(new ZipBadges(_p, _sem, _tiers));
    s.signal = address(new ZipSignal(_sem));
    s.polls = address(new ZipPolls(_p, _sem));
    // Upstream BatchRelayer: one person's several notes unzipped to one recipient in one transaction (the wallet's
    // "combine notes" unzip). Pool review L-1: it is outside 0xbow's audits and anyone can take a balance it holds, so
    // nothing may ever send it funds directly; it only receives a withdrawal and pays it out in the same transaction.
    // DEPLOY_BATCH_RELAYER=false leaves it out (the wallet then unzips one note at a time).
    if (_c.deployBatchRelayer) s.batchRelayer = address(new BatchRelayer(vm.envOr('MAX_RELAY_BPS', uint256(500))));
  }

  /**
   * @dev ZipLiquidityBands: the tax share (ZC) as one-sided liquidity ABOVE ZC's launch range only, every output to
   *      TREASURY (the Safe). ETH reaching it (with HARVEST_TREASURY=bands, the pool's harvest) is never put into
   *      liquidity; it is passed on to the Safe. Deployed only when the pool config is given. Caps and weights start
   *      at the launch values (U1 only; 1M ZC per call, 2M ZC per day, 24h apart); the Safe adjusts them within the
   *      ceiling. `_harvestSource` is the privacy pool deployed next when its harvest pays the bands contract, else zero.
   */
  function _deployBands(Config memory _c, address _harvestSource) internal {
    s.bands = address(
      new ZipLiquidityBands(
        _c.treasury,
        s.zc,
        _c.bandsPosm,
        _c.bandsHook,
        _harvestSource,
        uint128(vm.envOr('BANDS_MAX_DAY_ZC', uint256(10_000_000 ether))),
        ZipLiquidityBands.Caps({perCallZc: 1_000_000 ether, dayZc: 2_000_000 ether, minZc: 10_000 ether, minInterval: 1 days}),
        [uint16(10_000), 0, 0]
      )
    );
  }

  function _handOver(address _owner) internal {
    if (_owner == me) return;
    bytes32 _ownerRole = keccak256('OWNER_ROLE');
    Entrypoint(payable(s.entrypoint)).grantRole(_ownerRole, _owner);
    Entrypoint(payable(s.entrypoint)).renounceRole(_ownerRole, me);
  }

  function _write(Stack memory _s, string memory _name) internal {
    string memory _file = string.concat('./deployments/', _name, '.json');
    vm.writeJson(_toJson(_s), _file);
    console.log('wrote', _file);
  }

  /// @dev The deployment JSON (what `_write` saves and `checkJson` reads)
  function _toJson(Stack memory _s) internal returns (string memory _json) {
    string memory _o = 'zipnet';
    vm.serializeUint(_o, 'chainId', block.chainid);
    vm.serializeUint(_o, 'deployBlock', _s.deployBlock);
    vm.serializeAddress(_o, 'zc', _s.zc);
    vm.serializeAddress(_o, 'entrypoint', _s.entrypoint);
    vm.serializeAddress(_o, 'pool', _s.pool);
    vm.serializeString(_o, 'scope', vm.toString(_s.scope));
    vm.serializeAddress(_o, 'semaphore', _s.semaphore);
    vm.serializeAddress(_o, 'broadcaster', _s.broadcaster);
    vm.serializeAddress(_o, 'doorstep', _s.doorstep);
    vm.serializeAddress(_o, 'rezip', _s.rezip);
    vm.serializeAddress(_o, 'addressRegistry', _s.addressRegistry);
    vm.serializeAddress(_o, 'merchants', _s.merchants);
    vm.serializeAddress(_o, 'couriers', _s.couriers);
    vm.serializeAddress(_o, 'pay', _s.pay);
    vm.serializeAddress(_o, 'badges', _s.badges);
    vm.serializeAddress(_o, 'signal', _s.signal);
    vm.serializeAddress(_o, 'polls', _s.polls);
    if (_s.batchRelayer != address(0)) vm.serializeAddress(_o, 'batchRelayer', _s.batchRelayer);
    // Contracts left out are left out of the file too
    if (_s.bands != address(0)) vm.serializeAddress(_o, 'bands', _s.bands);
    _json = vm.serializeAddress(_o, 'polls', _s.polls);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // after the broadcast
  // ---------------------------------------------------------------------------------------------------------------

  /// @notice Who should hold what, for `checkJson` (zero = don't check that one)
  struct Roles {
    address owner;
    address postman;
    /// @dev the TREASURY Safe
    address safe;
    address deployer;
    uint256 ownerMinDelay;
    uint256 minDeposit;
    uint256 maxRelayBps;
  }

  /**
   * @notice Re-checks a broadcast deployment on chain (see `checkJson`). Run after broadcasting, with the deploy's
   *         OWNER, POSTMAN and TREASURY in env (required on chain 1) and DEPLOYER or PRIVATE_KEY for the deployer:
   *         forge script script/Deploy.s.sol:Deploy --sig 'check()' --rpc-url $ETHEREUM_MAINNET_RPC
   *         It only simulates (it sends 1 wei from the pool and the poll escrow in the simulation to prove its harvest
   *         lands).
   */
  function check() external {
    Roles memory _r;
    _r.owner = vm.envOr('OWNER', address(0));
    _r.postman = vm.envOr('POSTMAN', address(0));
    _r.safe = vm.envOr('TREASURY', address(0));
    _r.deployer = vm.envOr('DEPLOYER', address(0));
    if (_r.deployer == address(0) && vm.envExists('PRIVATE_KEY')) _r.deployer = vm.addr(vm.envUint('PRIVATE_KEY'));
    _r.ownerMinDelay = vm.envOr('OWNER_MIN_DELAY', OWNER_DELAY_DEFAULT);
    _r.minDeposit = vm.envOr('MIN_DEPOSIT', uint256(1 ether));
    _r.maxRelayBps = vm.envOr('MAX_RELAY_BPS', uint256(500));
    if (block.chainid == 1) {
      require(
        _r.owner != address(0) && _r.postman != address(0) && _r.safe != address(0),
        'check: set OWNER, POSTMAN and TREASURY (as for the deploy) so the roles can be checked'
      );
    }
    checkJson(vm.readFile(string.concat('./deployments/', vm.envOr('DEPLOYMENT', string('local')), '.json')), _r);
  }

  /**
   * @notice Every recorded address has code; the Entrypoint's ZC pool is the recorded pool, with vetting fee 0 and the
   *         configured minimum and relay fee; OWNER holds OWNER_ROLE and the deployer holds none; POSTMAN holds
   *         ASP_POSTMAN; on chain 1 OWNER is a timelock with at least OWNER_MIN_DELAY; every note-spending contract
   *         uses the recorded pool; ZipPay pays the recorded couriers and merchants; the pool harvest and the tax go to the bands contract or the Safe (both to the Safe
   *         when there are no bands); and every harvest destination accepts ETH from the contract that harvests to it.
   */
  function checkJson(string memory _json, Roles memory _r) public {
    string[14] memory _keys = [
      '.zc', '.entrypoint', '.pool', '.semaphore', '.broadcaster', '.doorstep', '.rezip', '.addressRegistry', '.merchants',
      '.couriers', '.pay', '.badges', '.signal', '.polls'
    ];
    for (uint256 _i; _i < _keys.length; ++_i) {
      require(vm.parseJsonAddress(_json, _keys[_i]).code.length > 0, string.concat('check: no code at ', _keys[_i]));
    }
    string[2] memory _optional = ['.batchRelayer', '.bands'];
    for (uint256 _i; _i < _optional.length; ++_i) {
      if (vm.keyExistsJson(_json, _optional[_i])) {
        require(_at(_json, _optional[_i]).code.length > 0, string.concat('check: no code at ', _optional[_i]));
      }
    }
    address _pool = _at(_json, '.pool');
    _checkEntrypoint(_json, _r);
    _checkWiring(_json, _pool);
    (address _harvestTo, address _taxTo) = _checkPayouts(_json, _pool, _r);
    if (vm.keyExistsJson(_json, '.batchRelayer')) {
      address _br = _at(_json, '.batchRelayer');
      // Pool review L-1: anyone can take what it holds, so it must never hold anything
      if (_br.balance != 0 || IERC20(_at(_json, '.zc')).balanceOf(_br) != 0) {
        console.log('WARNING: the BatchRelayer holds a balance; anyone can take it');
      }
    }
    console.log('check ok: pool', _pool, 'harvest ->', _harvestTo);
  }

  function _at(string memory _json, string memory _key) internal pure returns (address) {
    return vm.parseJsonAddress(_json, _key);
  }

  /// @dev The ZC pool's config, the pool's own wiring, and the roles
  function _checkEntrypoint(string memory _json, Roles memory _r) internal view {
    address _ep = _at(_json, '.entrypoint');
    address _zc = _at(_json, '.zc');
    ZipPrivacyPool _pool = ZipPrivacyPool(payable(_at(_json, '.pool')));
    (bool _ok, bytes memory _ret) = _ep.staticcall(abi.encodeWithSignature('assetConfig(address)', _zc));
    require(_ok && _ret.length >= 128, 'check: the Entrypoint has no ZC config');
    (address _p, uint256 _min, uint256 _fee, uint256 _maxRelay) = abi.decode(_ret, (address, uint256, uint256, uint256));
    require(_p == address(_pool), 'check: the Entrypoint ZC pool is not the recorded pool');
    require(_fee == 0, 'check: the Entrypoint vetting fee is not 0 (contract re-zips revert and deferred payouts park)');
    require(_min == _r.minDeposit, 'check: the Entrypoint minimum deposit is not MIN_DEPOSIT');
    require(_maxRelay == _r.maxRelayBps, 'check: the Entrypoint max relay fee is not MAX_RELAY_BPS');
    require(address(_pool.ENTRYPOINT()) == _ep, 'check: the pool answers to another Entrypoint');
    require(_pool.ASSET() == _zc, 'check: the pool asset is not ZC');
    require(_pool.SCOPE() == vm.parseUint(vm.parseJsonString(_json, '.scope')), 'check: the pool scope is not the recorded scope');
    if (_r.owner != address(0)) {
      require(_hasRole(_ep, OWNER_ROLE, _r.owner), 'check: OWNER does not hold the Entrypoint OWNER_ROLE');
      if (_r.deployer != address(0) && _r.deployer != _r.owner) {
        require(!_hasRole(_ep, OWNER_ROLE, _r.deployer), 'check: the deployer still holds the Entrypoint OWNER_ROLE');
      }
    }
    if (_r.postman != address(0)) {
      require(_hasRole(_ep, ASP_POSTMAN, _r.postman), 'check: POSTMAN does not hold the Entrypoint ASP_POSTMAN role');
    }
    if (block.chainid == 1) {
      (_ok, _ret) = _r.owner.staticcall(abi.encodeWithSignature('getMinDelay()'));
      require(
        _ok && _ret.length >= 32 && abi.decode(_ret, (uint256)) >= _r.ownerMinDelay,
        'check: OWNER is not a timelock with at least OWNER_MIN_DELAY'
      );
    }
  }

  /// @dev Every note-spending contract uses the recorded pool; ZipPay is wired up
  function _checkWiring(string memory _json, address _pool) internal view {
    string[7] memory _spenders = ['.broadcaster', '.doorstep', '.rezip', '.couriers', '.pay', '.badges', '.polls'];
    for (uint256 _i; _i < _spenders.length; ++_i) {
      require(_word(_at(_json, _spenders[_i]), 'POOL()') == _pool, string.concat('check: ', _spenders[_i], ' uses another pool'));
    }
    _checkPay(ZipPay(_at(_json, '.pay')), _json);
  }

  function _checkPay(ZipPay _pay, string memory _json) internal view {
    require(_pay.COURIER_POOL() == _at(_json, '.couriers'), 'check: ZipPay pays another courier pool');
    require(address(_pay.MERCHANTS()) == _at(_json, '.merchants'), 'check: ZipPay lists another merchant registry');
    if (block.chainid == 1) {
      require(_pay.MIN_JOIN_BASE() >= PAYER_GROUP_MIN_BASE_FLOOR, 'check: ZipPay MIN_JOIN_BASE is below the floor');
    }
  }

  /**
   * @dev Where the pool harvest and the tax go (the bands contract or the Safe; both the Safe without bands), and that
   *      every harvest lands: the pool's and the poll escrow's (both pay the pool's TREASURY, R2-M1 / pool review M-1).
   */
  function _checkPayouts(string memory _json, address _pool, Roles memory _r)
    internal
    returns (address _harvestTo, address _taxTo)
  {
    _harvestTo = ZipPrivacyPool(payable(_pool)).TREASURY();
    _taxTo = ZipPay(_at(_json, '.pay')).TREASURY();
    if (vm.keyExistsJson(_json, '.bands')) {
      ZipLiquidityBands _b = ZipLiquidityBands(payable(_at(_json, '.bands')));
      require(_harvestTo == address(_b) || _harvestTo == _b.SAFE(), 'check: the pool harvest pays neither bands nor the Safe');
      require(_taxTo == address(_b) || _taxTo == _b.SAFE(), 'check: ZipPay pays neither bands nor the Safe');
      if (_r.safe != address(0)) require(_b.SAFE() == _r.safe, 'check: the bands contract pays another Safe than TREASURY');
      // Owner decision: the treasury bands add liquidity ABOVE the launch range only, never below it
      for (uint8 _i; _i < _b.BANDS(); ++_i) {
        (, int24 _hi) = _b.bandTicks(_i);
        require(_hi <= _b.LAUNCH_LOWER(), 'check: a bands range is not above the launch range');
      }
      // Pool review L-2: HARVEST_SOURCE comes from a nonce prediction. Since R2-M1 the bands contract takes ETH from
      // anyone, so a wrong prediction only mislabels it and can no longer brick the harvest.
      if ((_harvestTo == address(_b)) != (_b.HARVEST_SOURCE() == _pool)) {
        console.log('WARNING: bands HARVEST_SOURCE does not name the pool (informational only; the harvest still lands)');
      }
    } else if (_r.safe != address(0)) {
      require(_harvestTo == _r.safe, 'check: with no bands contract the pool harvest must pay the TREASURY Safe');
      require(_taxTo == _r.safe, 'check: with no bands contract ZipPay must pay the TREASURY Safe');
    }
    require(_acceptsEth(_harvestTo, _pool), 'check: the pool harvest destination refuses ETH from the pool');
    require(
      _acceptsEth(_harvestTo, _at(_json, '.polls')),
      'check: the harvest destination refuses ETH from .polls (its harvest() would revert)'
    );
  }

  /// @dev Simulation only: whether `_to` accepts 1 wei sent by `_from`
  function _acceptsEth(address _to, address _from) internal returns (bool _ok) {
    vm.deal(_from, _from.balance + 1);
    vm.prank(_from);
    (_ok,) = _to.call{value: 1}('');
  }
}
