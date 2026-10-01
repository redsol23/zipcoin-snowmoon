// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from 'forge-std/Test.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';

import {Entrypoint} from 'contracts/Entrypoint.sol';

import {ZcHarvestToTreasury} from 'zipnet/ZcHarvestToTreasury.sol';
import {ZipLiquidityBands} from 'zipnet/ZipLiquidityBands.sol';
import {ZipPay} from 'zipnet/ZipPay.sol';
import {ZipPrivacyPool} from 'zipnet/ZipPrivacyPool.sol';

import {Deploy, LocalZC} from '../../script/Deploy.s.sol';
import {MockPermit2, MockPoolManager, MockPositionManager} from '../zipnet/BandsMocks.sol';
import {MockZC} from '../zipnet/ZipnetBase.sol';

/// @notice Runs the script's own guard and deploy code with a config passed in (no env, so tests can run in parallel)
contract DeployHarness is Deploy {
  function deployWith(Config memory _c) external returns (Stack memory) {
    me = address(this);
    _c.deployer = address(this);
    validate(_c, known());
    _deploy(_c);
    return s;
  }

  /// @dev The post-deploy check against the stack just deployed
  function checkDeployed(Roles memory _r) external {
    checkJson(_toJson(s), _r);
  }
}

/// @notice The Safe surface the guard reads (a proxy of the v1.4.1 singleton), and a receiver for payouts
contract FakeSafe {
  /// @dev slot 0, as in a Safe proxy
  address internal singleton = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
  uint256 public getThreshold;
  address[] internal _owners;
  address[] internal _modules;

  constructor(uint256 _threshold, uint256 _n) {
    getThreshold = _threshold;
    for (uint256 _i; _i < _n; ++_i) {
      _owners.push(address(uint160(0x5afe00 + _i)));
    }
  }

  function getOwners() external view returns (address[] memory) {
    return _owners;
  }

  function enableModule(address _m) external {
    _modules.push(_m);
  }

  function getModulesPaginated(address, uint256) external view returns (address[] memory, address) {
    return (_modules, address(0x1));
  }

  receive() external payable {}
}

/// @notice The OpenZeppelin TimelockController surface the guard reads
contract FakeTimelock {
  bytes32 public constant PROPOSER_ROLE = keccak256('PROPOSER_ROLE');
  bytes32 public constant EXECUTOR_ROLE = keccak256('EXECUTOR_ROLE');
  uint256 public getMinDelay;
  mapping(bytes32 => mapping(address => bool)) public hasRole;

  constructor(uint256 _delay, address _safe) {
    getMinDelay = _delay;
    hasRole[PROPOSER_ROLE][_safe] = true;
    hasRole[EXECUTOR_ROLE][_safe] = true;
    hasRole[bytes32(0)][address(this)] = true;
  }

  function set(bytes32 _role, address _who, bool _on) external {
    hasRole[_role][_who] = _on;
  }
}

/// @notice ZC's surface the guard reads beyond ERC-20
contract FakeZC {
  uint256 public totalSupply = 1_000_000_000 ether;
  bool public holderFeesEnabled = true;
  address public factory;
  address public market;

  constructor(address _factory, address _market) {
    (factory, market) = (_factory, _market);
  }

  function setSupply(uint256 _s) external {
    totalSupply = _s;
  }
}

contract FakeFactory {
  ZipLiquidityBands.PoolKey internal _key;
  int24 public startTick = 196_600;

  function setKey(ZipLiquidityBands.PoolKey memory _k) external {
    _key = _k;
  }

  function setStartTick(int24 _t) external {
    startTick = _t;
  }

  function poolKeyFor(address) external view returns (ZipLiquidityBands.PoolKey memory) {
    return _key;
  }

  function startTickOf(address) external view returns (int24) {
    return startTick;
  }
}

contract FakePosm {
  address public poolManager;
  address public permit2;

  constructor(address _pm, address _p2) {
    (poolManager, permit2) = (_pm, _p2);
  }
}

contract FakeSemaphore {
  address public verifier;

  constructor(address _v) {
    verifier = _v;
  }
}

contract Code {}

/**
 * @notice The mainnet guard: each bad chain-1 config reverts with its message; the good one passes. Mocks stand in for
 *         the mainnet contracts through the `Known` struct the script compares against.
 */
contract DeployGuardTest is Test {
  DeployHarness internal d;
  Deploy.Known internal k;
  address internal deployer = makeAddr('deployer');
  address internal postman = makeAddr('postman');
  address internal hook = makeAddr('hook');
  FakeSafe internal ownerSafe;
  FakeSafe internal treasurySafe;
  FakeTimelock internal timelock;
  FakeFactory internal factory;
  FakeZC internal fzc;

  function setUp() public {
    d = new DeployHarness();
    address _pm = address(new Code());
    address _p2 = address(new Code());
    factory = new FakeFactory();
    fzc = new FakeZC(address(factory), _pm);
    factory.setKey(ZipLiquidityBands.PoolKey(address(0), address(fzc), 10_000, 200, hook));
    address _semVerifier = address(new Code());
    k = Deploy.Known({
      zc: address(fzc),
      withdrawalVerifier: address(new Code()),
      ragequitVerifier: address(new Code()),
      entrypointImpl: address(new Entrypoint()),
      semaphore: address(new FakeSemaphore(_semVerifier)),
      semaphoreVerifier: _semVerifier,
      factory: address(factory),
      poolManager: _pm,
      posm: address(new FakePosm(_pm, _p2)),
      permit2: _p2,
      hook: hook
    });
    ownerSafe = new FakeSafe(2, 3);
    treasurySafe = new FakeSafe(2, 3);
    timelock = new FakeTimelock(2 days, address(ownerSafe));
    vm.chainId(1);
  }

  /// @dev The launch config: every mainnet contract, 2-of-3 Safes, bands on, tax to bands, harvest to the Safe
  function _good() internal view returns (Deploy.Config memory _c) {
    _c.deployer = deployer;
    _c.zc = k.zc;
    _c.withdrawalVerifier = k.withdrawalVerifier;
    _c.ragequitVerifier = k.ragequitVerifier;
    _c.entrypointImpl = k.entrypointImpl;
    _c.semaphore = k.semaphore;
    _c.owner = address(timelock);
    _c.ownerSafe = address(ownerSafe);
    _c.ownerMinDelay = 2 days;
    _c.treasury = address(treasurySafe);
    _c.postman = postman;
    _c.postmanCapsAck = true;
    _c.safeMinThreshold = 2;
    _c.safeMinOwners = 3;
    _c.payerGroupMinBase = 10_000 ether;
    _c.bandsPosm = k.posm;
    _c.bandsHook = hook;
    _c.tax = Deploy.Dest.Bands;
    _c.harvest = Deploy.Dest.Safe;
    _c.deployment = 'mainnet';
  }

  function _fails(Deploy.Config memory _c, bytes memory _msg) internal {
    vm.expectRevert(_msg);
    d.validate(_c, k);
  }

  function test_good_passes() public view {
    d.validate(_good(), k);
  }

  // --- 1. ZC, verifiers, Entrypoint implementation, Semaphore -------------------------------------------------------

  function test_zcUnset_refuses() public {
    Deploy.Config memory _c = _good();
    _c.zc = address(0);
    _fails(_c, 'mainnet: ZC_ADDRESS must be set (the script never deploys a stand-in ZC on chain 1)');
  }

  function test_zcOtherAddress_refuses() public {
    Deploy.Config memory _c = _good();
    _c.zc = address(new LocalZC(address(this)));
    _fails(_c, bytes(string.concat('mainnet: ZC_ADDRESS is not ZC ', vm.toString(k.zc))));
  }

  function test_zcNoCode_refuses() public {
    k.zc = makeAddr('eoa');
    Deploy.Config memory _c = _good();
    _c.zc = k.zc;
    _fails(_c, 'mainnet: ZC_ADDRESS has no code');
  }

  function test_zcWrongSupply_refuses() public {
    fzc.setSupply(1e27 - 1);
    _fails(_good(), 'mainnet: ZC_ADDRESS totalSupply is not 1e27; not ZC');
  }

  function test_zcWithoutHolderFees_refuses() public {
    // A plain 1B ERC-20 (the local stand-in) has the right supply but no holderFeesEnabled()
    k.zc = address(new LocalZC(address(this)));
    Deploy.Config memory _c = _good();
    _c.zc = k.zc;
    _fails(_c, 'mainnet: ZC_ADDRESS does not answer holderFeesEnabled(); not ZC');
  }

  function test_verifiersUnset_refuse() public {
    Deploy.Config memory _c = _good();
    _c.withdrawalVerifier = address(0);
    _fails(_c, 'mainnet: WITHDRAWAL_VERIFIER must be set to the 0xbow production contract (ALLOW_FRESH_VERIFIERS=1 deploys a fresh one)');
    _c = _good();
    _c.ragequitVerifier = address(0);
    _fails(_c, 'mainnet: RAGEQUIT_VERIFIER must be set to the 0xbow production contract (ALLOW_FRESH_VERIFIERS=1 deploys a fresh one)');
    _c = _good();
    _c.entrypointImpl = address(0);
    _fails(_c, 'mainnet: ENTRYPOINT_IMPL must be set to the 0xbow production contract (ALLOW_FRESH_VERIFIERS=1 deploys a fresh one)');
  }

  function test_verifiersOther_refuse() public {
    Deploy.Config memory _c = _good();
    _c.withdrawalVerifier = address(new Code());
    _fails(_c, bytes(string.concat('mainnet: WITHDRAWAL_VERIFIER is not the 0xbow production contract ', vm.toString(k.withdrawalVerifier))));
    _c = _good();
    _c.ragequitVerifier = makeAddr('noCode');
    _fails(_c, 'mainnet: RAGEQUIT_VERIFIER has no code');
  }

  function test_allowFreshVerifiers_passes() public {
    Deploy.Config memory _c = _good();
    _c.withdrawalVerifier = address(0);
    _c.ragequitVerifier = address(new Code());
    _c.entrypointImpl = address(0);
    _c.allowFreshVerifiers = true;
    d.validate(_c, k);
  }

  function test_entrypointImplNotUups_refuses() public {
    Deploy.Config memory _c = _good();
    _c.entrypointImpl = address(new Code());
    _c.allowFreshVerifiers = true;
    _fails(_c, 'mainnet: ENTRYPOINT_IMPL is not a UUPS implementation');
  }

  function test_semaphore_refuses() public {
    Deploy.Config memory _c = _good();
    _c.semaphore = address(0);
    _fails(_c, 'mainnet: set SEMAPHORE_ADDRESS to the canonical Semaphore v4');
    _c.semaphore = address(new FakeSemaphore(k.semaphoreVerifier));
    _fails(_c, bytes(string.concat('mainnet: SEMAPHORE_ADDRESS is not the canonical Semaphore v4 ', vm.toString(k.semaphore))));
    k.semaphore = address(new FakeSemaphore(address(0xbad)));
    _c.semaphore = k.semaphore;
    _fails(_c, 'mainnet: SEMAPHORE_ADDRESS verifier() is not the canonical SemaphoreVerifier');
  }

  // --- 2. bands and the tax ---------------------------------------------------------------------------------------

  function test_taxUnset_refuses() public {
    Deploy.Config memory _c = _good();
    _c.tax = Deploy.Dest.Unset;
    _fails(_c, 'mainnet: TAX_TREASURY must be set explicitly: "bands" (the launch decision) or "safe"');
  }

  function test_taxBandsWithoutBandsConfig_refuses() public {
    Deploy.Config memory _c = _good();
    (_c.bandsPosm, _c.bandsHook) = (address(0), address(0));
    _fails(_c, 'TAX_TREASURY=bands needs BANDS_POSITION_MANAGER and BANDS_HOOK (the bands contract is not being deployed)');
  }

  function test_bandsHalfConfig_refuses() public {
    Deploy.Config memory _c = _good();
    _c.bandsHook = address(0);
    _fails(_c, 'BANDS_POSITION_MANAGER and BANDS_HOOK must be set together (both or neither)');
    _c = _good();
    _c.bandsPosm = address(0);
    _fails(_c, 'BANDS_POSITION_MANAGER and BANDS_HOOK must be set together (both or neither)');
  }

  function test_taxSafeWithoutBands_passes() public view {
    Deploy.Config memory _c = _good();
    (_c.bandsPosm, _c.bandsHook) = (address(0), address(0));
    _c.tax = Deploy.Dest.Safe;
    d.validate(_c, k);
  }

  function test_bandsPoolConfig_refuses() public {
    Deploy.Config memory _c = _good();
    _c.bandsPosm = address(new FakePosm(k.poolManager, k.permit2));
    _fails(_c, bytes(string.concat('mainnet: BANDS_POSITION_MANAGER is not the v4 PositionManager ', vm.toString(k.posm))));
    _c = _good();
    _c.bandsHook = makeAddr('otherHook');
    _fails(_c, bytes(string.concat('mainnet: BANDS_HOOK is not ZC launch hook ', vm.toString(hook))));

    k.posm = address(new FakePosm(makeAddr('otherPm'), k.permit2));
    _c = _good();
    _fails(_c, 'mainnet: BANDS_POSITION_MANAGER poolManager() is not the v4 PoolManager');
    k.posm = address(new FakePosm(k.poolManager, makeAddr('otherP2')));
    _c = _good();
    _fails(_c, 'mainnet: BANDS_POSITION_MANAGER permit2() is not Permit2');
  }

  function test_zcPoolMismatch_refuses() public {
    // ZC's market is not the PoolManager
    k.poolManager = makeAddr('otherPm');
    k.posm = address(new FakePosm(k.poolManager, k.permit2));
    _fails(_good(), 'mainnet: ZC market() is not the v4 PoolManager');
  }

  function test_zcFactoryMismatch_refuses() public {
    k.factory = address(new FakeFactory());
    _fails(_good(), 'mainnet: ZC factory() is not the launch factory');
  }

  function test_poolKeyMismatch_refuses() public {
    string memory _m = 'mainnet: ZC pool key (factory poolKeyFor) is not ETH/ZC, fee 10000, tickSpacing 200, BANDS_HOOK';
    factory.setKey(ZipLiquidityBands.PoolKey(address(0), address(fzc), 3000, 200, hook));
    _fails(_good(), bytes(_m));
    factory.setKey(ZipLiquidityBands.PoolKey(address(0), address(fzc), 10_000, 60, hook));
    _fails(_good(), bytes(_m));
    factory.setKey(ZipLiquidityBands.PoolKey(address(0), address(fzc), 10_000, 200, address(0)));
    _fails(_good(), bytes(_m));
  }

  function test_startTickMismatch_refuses() public {
    factory.setStartTick(195_800);
    _fails(_good(), 'mainnet: ZC start tick is not 196600 (the bands assume the launch range [127600, 196600])');
  }

  // --- 3. DEPLOYMENT, economics ------------------------------------------------------------

  function test_readConfig_chain1Defaults() public view {
    // No deploy env is set in the test process: chain 1 falls back to nothing
    Deploy.Config memory _c = d.readConfig(deployer);
    assertEq(_c.owner, address(0));
    assertEq(_c.treasury, address(0));
    assertEq(_c.postman, address(0));
    assertEq(_c.deployment, '');
    assertEq(_c.missing, 'MIN_DEPOSIT');
    assertEq(uint8(_c.tax), uint8(Deploy.Dest.Unset));
    assertEq(_c.ownerSafe, address(0));
    assertEq(_c.ownerMinDelay, 2 days, 'OWNER_MIN_DELAY defaults to 48h');
    assertTrue(_c.deployBatchRelayer);
  }

  function test_readConfig_localDefaults() public {
    vm.chainId(31_337);
    Deploy.Config memory _c = d.readConfig(deployer);
    assertEq(_c.owner, deployer);
    assertEq(_c.treasury, deployer);
    assertEq(_c.deployment, 'local');
  }

  function test_deployment_refuses() public {
    Deploy.Config memory _c = _good();
    _c.deployment = '';
    _fails(_c, 'mainnet: set DEPLOYMENT (e.g. mainnet); the output must not overwrite local.json');
    _c.deployment = 'local';
    _fails(_c, 'mainnet: set DEPLOYMENT (e.g. mainnet); the output must not overwrite local.json');
    // The services' DEPLOYMENT (a path) leaking into the forge command
    _c.deployment = '../../contracts/deployments/mainnet.json';
    _fails(_c, 'mainnet: DEPLOYMENT is a file name (e.g. mainnet), not a path: the services variable of that name is a path');
  }

  function test_missingEconomics_refuses() public {
    Deploy.Config memory _c = _good();
    _c.missing = 'TAX_BPS';
    _fails(_c, 'mainnet: set TAX_BPS explicitly (immutable economics have no silent default on chain 1)');
  }

  // --- 4. roles and Safes -----------------------------------------------------------------------------------------

  function test_rolesUnsetOrDeployer_refuse() public {
    Deploy.Config memory _c = _good();
    _c.owner = address(0);
    _fails(_c, 'mainnet: OWNER must be set');
    _c = _good();
    _c.treasury = deployer;
    _fails(_c, 'mainnet: TREASURY must not be the deployer');
    _c = _good();
    _c.postman = address(0);
    _fails(_c, 'mainnet: POSTMAN must be set');
  }

  function test_rolesNotDistinct_refuse() public {
    Deploy.Config memory _c = _good();
    _c.treasury = _c.ownerSafe;
    _fails(_c, 'mainnet: OWNER_SAFE and TREASURY must be different Safes');
    _c = _good();
    _c.owner = _c.ownerSafe;
    _fails(_c, 'mainnet: OWNER must be the timelock OWNER_SAFE proposes through, not a Safe');
    _c = _good();
    _c.postman = _c.treasury;
    _fails(_c, 'mainnet: POSTMAN must be its own hot key, not a Safe');
    _c = _good();
    _c.ownerSafe = address(0);
    _fails(_c, 'mainnet: OWNER_SAFE must be set');
  }

  // --- 4b. the Entrypoint OWNER is a timelock (R2-M3, core L-5) ------------------------------------------------------

  function test_ownerNotAContract_refuses() public {
    Deploy.Config memory _c = _good();
    _c.owner = makeAddr('eoaOwner');
    _fails(_c, 'mainnet: OWNER has no code; it must be an OpenZeppelin TimelockController that OWNER_SAFE proposes through');
  }

  function test_ownerNotATimelock_refuses() public {
    Deploy.Config memory _c = _good();
    _c.owner = address(new Code());
    _fails(_c, 'mainnet: OWNER does not answer getMinDelay(); it must be an OpenZeppelin TimelockController');
  }

  function test_ownerTimelockTooShort_refuses() public {
    Deploy.Config memory _c = _good();
    _c.owner = address(new FakeTimelock(1 days, address(ownerSafe)));
    _fails(_c, 'mainnet: the OWNER timelock delay is 86400s, below OWNER_MIN_DELAY 172800');
    _c = _good();
    _c.ownerMinDelay = 1 hours;
    _fails(_c, 'mainnet: OWNER_MIN_DELAY is below 1 day');
  }

  function test_ownerTimelockRoles_refuse() public {
    Deploy.Config memory _c = _good();
    _c.owner = address(new FakeTimelock(2 days, makeAddr('someoneElse')));
    _fails(_c, 'mainnet: OWNER_SAFE is not a proposer on the OWNER timelock');

    FakeTimelock _t = new FakeTimelock(2 days, address(ownerSafe));
    _t.set(_t.EXECUTOR_ROLE(), address(ownerSafe), false);
    _c.owner = address(_t);
    _fails(_c, 'mainnet: OWNER_SAFE cannot execute on the OWNER timelock');
    _t.set(_t.EXECUTOR_ROLE(), address(0), true); // open executor: anyone may execute after the delay
    d.validate(_c, k);

    _t.set(bytes32(0), address(ownerSafe), true);
    _fails(_c, 'mainnet: the OWNER timelock must have no admin but itself (deploy it with admin = address(0))');
  }

  function test_treasuryNotASafe_refuses() public {
    Deploy.Config memory _c = _good();
    _c.treasury = address(new Code());
    _fails(_c, 'mainnet: TREASURY does not answer getThreshold(); not a Safe');
  }

  function test_safeThresholdAndOwners_refuse() public {
    Deploy.Config memory _c = _good();
    _c.ownerSafe = address(new FakeSafe(1, 3));
    _c.owner = address(new FakeTimelock(2 days, _c.ownerSafe));
    _fails(_c, 'mainnet: OWNER_SAFE Safe threshold is 1, below SAFE_MIN_THRESHOLD 2');
    _c = _good();
    _c.treasury = address(new FakeSafe(2, 2));
    _fails(_c, 'mainnet: TREASURY Safe has 2 owners, below SAFE_MIN_OWNERS 3');
  }

  /// @notice core L-4: a Safe module (or guard) can move funds without the threshold
  function test_safeModuleOrGuard_refuses_unlessAllowed() public {
    Deploy.Config memory _c = _good();
    address _module = makeAddr('module');
    treasurySafe.enableModule(_module);
    _fails(
      _c,
      bytes(
        string.concat(
          'mainnet: TREASURY has module ',
          vm.toString(_module),
          ' enabled; a module bypasses the threshold (SAFE_ALLOWED_MODULES lists accepted ones)'
        )
      )
    );
    _c.safeAllowed = new address[](1);
    _c.safeAllowed[0] = _module;
    d.validate(_c, k);

    address _guard = makeAddr('guard');
    vm.store(address(ownerSafe), 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8, bytes32(uint256(uint160(_guard)))); // guard:allow (Safe guard slot)
    _fails(
      _c,
      bytes(string.concat('mainnet: OWNER_SAFE has guard ', vm.toString(_guard), ' set (SAFE_ALLOWED_MODULES lists accepted ones)'))
    );
  }

  function test_safeUnknownSingleton_refuses() public {
    Deploy.Config memory _c = _good();
    address _other = makeAddr('singleton');
    vm.store(address(treasurySafe), bytes32(0), bytes32(uint256(uint160(_other))));
    _fails(
      _c,
      bytes(
        string.concat(
          'mainnet: TREASURY is not a proxy of a known Safe singleton (got ', vm.toString(_other), '; SAFE_SINGLETONS_EXTRA adds one)'
        )
      )
    );
    _c.safeSingletonsExtra = new address[](1);
    _c.safeSingletonsExtra[0] = _other;
    d.validate(_c, k);
  }

  /// @notice core L-2: a payer-group join costs only the tax on PAYER_GROUP_MIN_BASE
  function test_payerGroupMinBase_floor() public {
    Deploy.Config memory _c = _good();
    _c.payerGroupMinBase = 1000 ether;
    _fails(_c, 'mainnet: PAYER_GROUP_MIN_BASE must be at least 10000 ZC (1e22 wei): a payer-group join costs only its tax');
    _c.payerGroupMinBase = 0;
    _fails(_c, 'mainnet: PAYER_GROUP_MIN_BASE must be at least 10000 ZC (1e22 wei): a payer-group join costs only its tax');
  }

  function test_safeOverride_passes() public {
    Deploy.Config memory _c = _good();
    _c.ownerSafe = address(new FakeSafe(3, 5));
    _c.owner = address(new FakeTimelock(2 days, _c.ownerSafe));
    _c.treasury = address(new FakeSafe(1, 2));
    _c.safeMinThreshold = 1;
    _c.safeMinOwners = 2;
    d.validate(_c, k);
    _c.safeMinOwners = 0;
    _fails(_c, 'mainnet: bad SAFE_MIN_THRESHOLD / SAFE_MIN_OWNERS');
  }

  function test_postmanCapsAck_refuses() public {
    Deploy.Config memory _c = _good();
    _c.postmanCapsAck = false;
    _fails(
      _c,
      'mainnet: set MAX_DEPOSIT_WEI and MAX_DEPOSITOR_DAILY_WEI in the postman env, then POSTMAN_CAPS_ACK=MAX_DEPOSIT_WEI,MAX_DEPOSITOR_DAILY_WEI'
    );
  }

  // --- 5. HARVEST_TREASURY ------------------------------------------------------------------------------------------

  function test_harvestUnset_refuses() public {
    Deploy.Config memory _c = _good();
    _c.harvest = Deploy.Dest.Unset;
    _fails(_c, 'mainnet: HARVEST_TREASURY must be set explicitly: "safe" (the launch default) or "bands"');
  }

  function test_harvestOtherAddress_refuses() public {
    Deploy.Config memory _c = _good();
    (_c.harvest, _c.harvestAddr) = (Deploy.Dest.Address, makeAddr('someone'));
    _fails(
      _c,
      bytes(
        string.concat(
          'HARVEST_TREASURY must be "bands", "safe", or the TREASURY Safe or bands contract address; got ',
          vm.toString(_c.harvestAddr)
        )
      )
    );
    // The deployer is no exception
    _c.harvestAddr = deployer;
    vm.expectRevert();
    d.validate(_c, k);
  }

  function test_harvestAddressOfSafeOrBands_passes() public view {
    Deploy.Config memory _c = _good();
    (_c.harvest, _c.harvestAddr) = (Deploy.Dest.Address, _c.treasury);
    d.validate(_c, k);
    (_c.harvest, _c.harvestAddr) = (Deploy.Dest.Address, d.predictBands(_c));
    d.validate(_c, k);
    (_c.tax, _c.taxAddr) = (Deploy.Dest.Address, d.predictBands(_c));
    d.validate(_c, k);
  }

  function test_harvestBandsWithoutBands_refuses() public {
    Deploy.Config memory _c = _good();
    (_c.bandsPosm, _c.bandsHook) = (address(0), address(0));
    _c.tax = Deploy.Dest.Safe;
    _c.harvest = Deploy.Dest.Bands;
    _fails(_c, 'HARVEST_TREASURY=bands needs BANDS_POSITION_MANAGER and BANDS_HOOK (the bands contract is not being deployed)');
  }

  function test_parseDest() public {
    (Deploy.Dest _d, address _a) = d.parseDest('');
    assertEq(uint8(_d), uint8(Deploy.Dest.Unset));
    (_d,) = d.parseDest('safe');
    assertEq(uint8(_d), uint8(Deploy.Dest.Safe));
    (_d,) = d.parseDest('bands');
    assertEq(uint8(_d), uint8(Deploy.Dest.Bands));
    (_d, _a) = d.parseDest('0x000000000000000000000000000000000000bEEF');
    assertEq(uint8(_d), uint8(Deploy.Dest.Address));
    assertEq(_a, address(0xbEEF));
    vm.expectRevert();
    d.parseDest('Bands');
  }
}

/**
 * @notice The script's real deploy code on a local chain with mock bands plumbing: the pool's harvest() pays each
 *         allowed HARVEST_TREASURY setting, and ZipPay pays the TAX_TREASURY destination.
 */
contract DeployHarvestTest is Test {
  int24 internal constant SPOT_TICK = 165_930;
  uint160 internal constant SPOT_SQRT = 317_562_884_112_765_502_424_763_899_389_167;

  DeployHarness internal d;
  MockZC internal zc;
  MockPositionManager internal posm;
  FakeSafe internal safe;
  address internal hook = makeAddr('hook');
  address internal owner = makeAddr('owner');
  address internal postman = makeAddr('postman');

  function setUp() public {
    d = new DeployHarness();
    zc = new MockZC();
    MockPoolManager _pm = new MockPoolManager();
    posm = new MockPositionManager(_pm, new MockPermit2(), address(zc), hook);
    ZipLiquidityBands.PoolKey memory _key = ZipLiquidityBands.PoolKey(address(0), address(zc), 10_000, 200, hook);
    _pm.init(address(posm), keccak256(abi.encode(keccak256(abi.encode(_key)), uint256(6))));
    _pm.setPrice(SPOT_SQRT, SPOT_TICK);
    safe = new FakeSafe(2, 3);
  }

  function _config(Deploy.Dest _hDest, address _harvestAddr) internal view returns (Deploy.Config memory _c) {
    _c.zc = address(zc);
    _c.owner = owner;
    _c.treasury = address(safe);
    _c.postman = postman;
    _c.bandsPosm = address(posm);
    _c.bandsHook = hook;
    _c.tax = Deploy.Dest.Bands;
    (_c.harvest, _c.harvestAddr) = (_hDest, _harvestAddr);
    _c.deployment = 'test';
  }

  /// @dev Deploys, gives the pool ZC holder rewards, harvests, and returns who got the ETH
  function _harvest(Deploy.Config memory _c) internal returns (Deploy.Stack memory _s, address _to) {
    _s = d.deployWith(_c);
    zc.mint(_s.pool, 1000 ether);
    zc.distributeRewards{value: 1 ether}();
    _to = ZipPrivacyPool(payable(_s.pool)).TREASURY();
    uint256 _before = _to.balance;
    assertEq(ZipPrivacyPool(payable(_s.pool)).harvest(), 1 ether);
    assertEq(_to.balance - _before, 1 ether, 'the harvest reached its treasury');
    // Both sides of the wiring agree
    bool _toBands = _to == _s.bands;
    assertEq(ZipLiquidityBands(payable(_s.bands)).HARVEST_SOURCE() == _s.pool, _toBands);
    // The tax goes to bands
    assertEq(ZipPay(_s.pay).TREASURY(), _s.bands);
    // R2-M1 / pool review M-1: the poll escrow harvests to the same destination, and it takes the ETH
    zc.mint(_s.polls, 1000 ether);
    zc.distributeRewards{value: 1 ether}();
    uint256 _earned = zc.pendingReward(_s.polls);
    _before = _to.balance;
    ZcHarvestToTreasury(payable(_s.polls)).harvest();
    assertEq(_to.balance - _before, _earned, 'the escrow harvest reached the treasury');
    // And the post-deploy check passes on it
    d.checkDeployed(Deploy.Roles(owner, postman, address(safe), address(d), 2 days, 1 ether, 500));
  }

  function test_harvest_safe() public {
    (Deploy.Stack memory _s, address _to) = _harvest(_config(Deploy.Dest.Safe, address(0)));
    assertEq(_to, address(safe));
    assertEq(ZipLiquidityBands(payable(_s.bands)).HARVEST_SOURCE(), address(0));
  }

  function test_harvest_unsetIsSafeLocally() public {
    (, address _to) = _harvest(_config(Deploy.Dest.Unset, address(0)));
    assertEq(_to, address(safe));
  }

  function test_harvest_bands() public {
    (Deploy.Stack memory _s, address _to) = _harvest(_config(Deploy.Dest.Bands, address(0)));
    assertEq(_to, _s.bands);
  }

  function test_harvest_safeAddress() public {
    (, address _to) = _harvest(_config(Deploy.Dest.Address, address(safe)));
    assertEq(_to, address(safe));
  }

  /// @dev The audit's case: a hex bands address used to leave HARVEST_SOURCE at zero, so harvest() reverted forever
  function test_harvest_bandsAddress() public {
    Deploy.Config memory _c = _config(Deploy.Dest.Unset, address(0));
    _c.deployer = address(d);
    address _bandsAt = d.predictBands(_c);
    (_c.harvest, _c.harvestAddr) = (Deploy.Dest.Address, _bandsAt);
    (Deploy.Stack memory _s, address _to) = _harvest(_c);
    assertEq(_s.bands, _bandsAt);
    assertEq(_to, _bandsAt);
  }

  function test_harvest_otherAddress_refuses() public {
    Deploy.Config memory _c = _config(Deploy.Dest.Address, makeAddr('elsewhere'));
    vm.expectRevert(
      bytes(
        string.concat(
          'HARVEST_TREASURY must be "bands", "safe", or the TREASURY Safe or bands contract address; got ',
          vm.toString(makeAddr('elsewhere'))
        )
      )
    );
    d.deployWith(_c);
  }

  /// @notice core L-4: check() catches a wrong role, a vetting fee and a harvest that can't land
  function test_check_catchesMiswiring() public {
    Deploy.Config memory _c = _config(Deploy.Dest.Bands, address(0));
    Deploy.Stack memory _s = d.deployWith(_c);
    Deploy.Roles memory _r = Deploy.Roles(owner, postman, address(safe), address(d), 2 days, 1 ether, 500);
    d.checkDeployed(_r);

    Deploy.Roles memory _bad = Deploy.Roles(makeAddr('notOwner'), postman, address(safe), address(d), 2 days, 1 ether, 500);
    vm.expectRevert(bytes('check: OWNER does not hold the Entrypoint OWNER_ROLE'));
    d.checkDeployed(_bad);
    _bad = Deploy.Roles(owner, makeAddr('notPostman'), address(safe), address(d), 2 days, 1 ether, 500);
    vm.expectRevert(bytes('check: POSTMAN does not hold the Entrypoint ASP_POSTMAN role'));
    d.checkDeployed(_bad);
    _bad = Deploy.Roles(owner, postman, makeAddr('otherSafe'), address(d), 2 days, 1 ether, 500);
    vm.expectRevert(bytes('check: the bands contract pays another Safe than TREASURY'));
    d.checkDeployed(_bad);

    vm.prank(owner);
    Entrypoint(payable(_s.entrypoint)).updatePoolConfiguration(IERC20(_s.zc), 1 ether, 1, 500);
    vm.expectRevert(bytes('check: the Entrypoint vetting fee is not 0 (contract re-zips revert and deferred payouts park)'));
    d.checkDeployed(_r);
  }

  /// @notice pool review L-1: the BatchRelayer is deployed only when asked (the wallet's combined-notes unzip)
  function test_batchRelayer_flag() public {
    Deploy.Config memory _c = _config(Deploy.Dest.Safe, address(0));
    assertEq(d.deployWith(_c).batchRelayer, address(0));
    DeployHarness _d2 = new DeployHarness();
    _c.deployBatchRelayer = true;
    assertTrue(_d2.deployWith(_c).batchRelayer.code.length > 0);
  }

  function test_noBands_taxAndHarvestToSafe() public {
    Deploy.Config memory _c = _config(Deploy.Dest.Unset, address(0));
    (_c.bandsPosm, _c.bandsHook, _c.tax) = (address(0), address(0), Deploy.Dest.Unset);
    Deploy.Stack memory _s = d.deployWith(_c);
    assertEq(_s.bands, address(0));
    assertEq(ZipPrivacyPool(payable(_s.pool)).TREASURY(), address(safe));
    assertEq(ZipPay(_s.pay).TREASURY(), address(safe));
  }
}

/**
 * @notice The launch config against real mainnet state: the guard passes with the real ZC, 0xbow contracts,
 *         Semaphore and ZC's v4 pool (2-of-3 Safes are stood in by FakeSafe), then the script deploys the stack.
 *         Skipped when ETHEREUM_MAINNET_RPC is unset.
 */
contract DeployMainnetForkTest is Test {
  DeployHarness internal d;
  bool internal forked;

  function setUp() public {
    string memory _rpc = vm.envOr('ETHEREUM_MAINNET_RPC', string(''));
    if (bytes(_rpc).length == 0) return;
    vm.createSelectFork(_rpc);
    forked = true;
    d = new DeployHarness();
  }

  function test_fork_launchConfig() public {
    if (!forked) vm.skip(true);
    Deploy.Known memory _k = d.known();
    Deploy.Config memory _c;
    _c.deployer = address(d);
    _c.zc = _k.zc;
    _c.withdrawalVerifier = _k.withdrawalVerifier;
    _c.ragequitVerifier = _k.ragequitVerifier;
    _c.entrypointImpl = _k.entrypointImpl;
    _c.semaphore = _k.semaphore;
    _c.ownerSafe = address(new FakeSafe(2, 3));
    _c.owner = address(new FakeTimelock(2 days, _c.ownerSafe));
    _c.ownerMinDelay = 2 days;
    _c.payerGroupMinBase = 10_000 ether;
    _c.treasury = address(new FakeSafe(2, 3));
    _c.postman = makeAddr('postman');
    _c.postmanCapsAck = true;
    _c.safeMinThreshold = 2;
    _c.safeMinOwners = 3;
    _c.bandsPosm = _k.posm;
    _c.bandsHook = _k.hook;
    _c.tax = Deploy.Dest.Bands;
    _c.harvest = Deploy.Dest.Safe;
    _c.deployment = 'mainnet';
    d.validate(_c, _k);

    Deploy.Stack memory _s = d.deployWith(_c);
    assertEq(ZipPay(_s.pay).TREASURY(), _s.bands);
    assertEq(ZipPrivacyPool(payable(_s.pool)).TREASURY(), _c.treasury);
    assertEq(ZipLiquidityBands(payable(_s.bands)).SAFE(), _c.treasury);
    assertTrue(Entrypoint(payable(_s.entrypoint)).hasRole(keccak256('OWNER_ROLE'), _c.owner));
    assertFalse(Entrypoint(payable(_s.entrypoint)).hasRole(keccak256('OWNER_ROLE'), address(d)));
  }
}
