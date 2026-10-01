// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from '@oz/proxy/ERC1967/ERC1967Proxy.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';

import {Entrypoint} from 'contracts/Entrypoint.sol';
import {Constants} from 'contracts/lib/Constants.sol';
import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {ZipLiquidityBands} from 'zipnet/ZipLiquidityBands.sol';
import {ZipPrivacyPool} from 'zipnet/ZipPrivacyPool.sol';

import {ForkSwapper} from './ForkSwapper.sol';
import {MockZC, ZipnetBase} from '../ZipnetBase.sol';

interface IRealZc {
  function market() external view returns (address);
  function rewardSource() external view returns (address);
  function holderFeesEnabled() external view returns (bool);
  function rewardExcluded(address) external view returns (bool);
  function pendingReward(address) external view returns (uint256);
  function notifyReward(uint256) external payable;
  function guardActive() external view returns (bool);
  function guardEndsAtBlock() external view returns (uint256);
  function MAX_HOLD() external view returns (uint256);
}

/// @notice The launch liquidity locker (ZC's rewardSource): collect() is permissionless and books the creator share
///         of the LP fees to holders through ZC.notifyReward
interface ILaunchLocker {
  function collect(uint256 tokenId) external returns (uint256 tokenAmount, uint256 ethAmount);
}

interface ISendItFactoryKeys {
  function poolKeyFor(address token) external view returns (ZipLiquidityBands.PoolKey memory);
}

interface ISafeProxyFactory {
  function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
    external
    returns (address proxy);
}

interface ISafe {
  function setup(
    address[] calldata owners,
    uint256 threshold,
    address to,
    bytes calldata data,
    address fallbackHandler,
    address paymentToken,
    uint256 payment,
    address payable paymentReceiver
  ) external;
  function getOwners() external view returns (address[] memory);
}

/**
 * @notice ZipPrivacyPool on a MAINNET FORK with the REAL ZC token (LaunchToken behind its proxy), the 0xbow production
 *         verifiers and Entrypoint implementation, a real Safe (v1.4.1) as TREASURY, and real swaps through ZC's
 *         Uniswap v4 pool to generate holder rewards. Real Groth16 proofs throughout (FFI prover).
 *
 *   ETHEREUM_MAINNET_RPC=<url> forge test --match-path test/zipnet/pool/PoolFork.t.sol -vv
 *
 * Skipped when ETHEREUM_MAINNET_RPC is unset. ZC is funded with real transfers out of the PoolManager (the market),
 * not `deal`: `deal` writes the balance slot directly and would bypass ZC's reward bookkeeping (a holder's reward debt
 * and the eligible supply), which is exactly what this test is about.
 */
contract PoolForkTest is ZipnetBase {
  address internal constant ZC = 0x2CA7B61B23b15e75aC7AB60Dd6f627895d64a46E;
  address internal constant WITHDRAWAL_VERIFIER = 0x022891F938Ae7fDC8Ab9Ead0FBf50aBA8C897D6d;
  address internal constant RAGEQUIT_VERIFIER = 0xa45ACa8604a73D80C551fAad6355A5c3A5565eC6;
  address internal constant ENTRYPOINT_IMPL = 0x15e355024de1CDc74ADdea7EBDf98418Ba5B1a2c;
  address internal constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
  address internal constant SENDIT_FACTORY = 0x8D37c2981bdF809567092fd458B6bf3e97ee860c;
  address internal constant SAFE_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
  address internal constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
  address internal constant SAFE_FALLBACK = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
  uint256 internal constant LOCKED_TOKEN_ID = 418_643; // ZC's locked launch position (see BandsFork.t.sol)

  struct Gas {
    uint256 deposit;
    uint256 relay;
    uint256 withdraw;
    uint256 ragequit;
  }

  bool internal forked;
  address internal safe;
  ZipPrivacyPool internal realPool;
  ZipPrivacyPool internal mockPool;
  MockZC internal mockZc;
  uint256 internal strayEth;

  // fresh, code-free addresses (some common makeAddr labels have code on mainnet)
  address internal alice = makeAddr('zip-pool-fork-alice');
  address internal bob = makeAddr('zip-pool-fork-bob');
  address internal carol = makeAddr('zip-pool-fork-carol');
  address internal relayer = makeAddr('zip-pool-fork-relayer');
  address internal swapperEoa = makeAddr('zip-pool-fork-trader');

  function setUp() public override {
    string memory _rpc = vm.envOr('ETHEREUM_MAINNET_RPC', string(''));
    if (bytes(_rpc).length == 0) return;
    vm.createSelectFork(_rpc);
    forked = true;
    for (uint256 _i; _i < 4; ++_i) {
      address _c = [ZC, WITHDRAWAL_VERIFIER, ENTRYPOINT_IMPL, POOL_MANAGER][_i];
      assertGt(_c.code.length, 0, 'mainnet contract missing');
    }
    address[5] memory _fresh = [alice, bob, carol, relayer, swapperEoa];
    for (uint256 _i; _i < 5; ++_i) {
      assertEq(_fresh[_i].code.length, 0, 'test address has code on mainnet');
    }

    safe = _deploySafe();
    entrypoint = Entrypoint(
      payable(address(new ERC1967Proxy(ENTRYPOINT_IMPL, abi.encodeCall(Entrypoint.initialize, (owner, postman)))))
    );
    realPool = new ZipPrivacyPool(address(entrypoint), WITHDRAWAL_VERIFIER, RAGEQUIT_VERIFIER, ZC, payable(safe));
    strayEth = address(realPool).balance; // the address may hold mainnet dust; harvest must sweep it too
    mockZc = new MockZC();
    mockPool =
      new ZipPrivacyPool(address(entrypoint), WITHDRAWAL_VERIFIER, RAGEQUIT_VERIFIER, address(mockZc), payable(safe));
    vm.startPrank(owner);
    entrypoint.registerPool(IERC20(ZC), IPrivacyPool(address(realPool)), 1 ether, 0, 500);
    entrypoint.registerPool(IERC20(address(mockZc)), IPrivacyPool(address(mockPool)), 1 ether, 0, 500);
    vm.stopPrank();
  }

  modifier onFork() {
    if (!forked) vm.skip(true);
    _;
  }

  /// @dev A real Safe v1.4.1 proxy (1-of-1), or a plain contract that accepts ETH if the Safe factory is missing
  function _deploySafe() internal returns (address _safe) {
    if (SAFE_FACTORY.code.length == 0 || SAFE_SINGLETON.code.length == 0) {
      emit log('Safe factory not found on this fork; using an ETH-accepting stand-in');
      return address(new ForkSwapper(POOL_MANAGER)); // has an open receive()
    }
    address[] memory _owners = new address[](1);
    _owners[0] = makeAddr('zip-pool-fork-signer');
    bytes memory _init =
      abi.encodeCall(ISafe.setup, (_owners, 1, address(0), '', SAFE_FALLBACK, address(0), 0, payable(address(0))));
    _safe =
      ISafeProxyFactory(SAFE_FACTORY).createProxyWithNonce(SAFE_SINGLETON, _init, uint256(keccak256('zip-pool-fork')));
    assertEq(ISafe(_safe).getOwners()[0], _owners[0], 'Safe is set up');
  }

  // ------------------------------------------------------------------------------------------------------------
  // helpers, parameterised by pool (the real-ZC pool or the MockZC twin)
  // ------------------------------------------------------------------------------------------------------------

  function _use(ZipPrivacyPool _p) internal {
    pool = _p;
    scope = _p.SCOPE();
    zc = MockZC(_p.ASSET()); // only the ERC-20 surface is used through this handle for the real token
    delete stateLeaves;
    delete aspLeaves;
  }

  function _fund(address _to, uint256 _value) internal {
    if (address(zc) == ZC) {
      uint256 _before = IERC20(ZC).balanceOf(_to);
      vm.prank(IRealZc(ZC).market());
      IERC20(ZC).transfer(_to, _value);
      assertEq(IERC20(ZC).balanceOf(_to) - _before, _value, 'ZC transfer delivered a different amount');
    } else {
      zc.mint(_to, _value);
    }
  }

  function _cool() internal {
    address[6] memory _a =
      [address(pool), address(entrypoint), ENTRYPOINT_IMPL, address(zc), WITHDRAWAL_VERIFIER, RAGEQUIT_VERIFIER];
    for (uint256 _i; _i < _a.length; ++_i) {
      (bool _ok,) = address(vm).call(abi.encodeWithSignature('cool(address)', _a[_i]));
      _ok;
    }
  }

  function _depositFork(address _who, uint256 _value) internal returns (Note memory _n, uint256 _gas) {
    _fund(_who, _value);
    (uint256 _nullifier, uint256 _secret) = _secrets();
    uint256 _pre = _precommitment(_nullifier, _secret); // (Poseidon is an external library call: before the prank)
    uint256 _poolBefore = zc.balanceOf(address(pool));
    vm.prank(_who);
    zc.approve(address(entrypoint), _value);
    _cool();
    vm.prank(_who);
    uint256 _g = gasleft();
    uint256 _c = entrypoint.deposit(IERC20(address(zc)), _value, _pre);
    _gas = _g - gasleft();
    assertEq(zc.balanceOf(address(pool)) - _poolBefore, _value, 'pool received less than the note records');
    assertEq(zc.balanceOf(address(entrypoint)), 0, 'ZC stuck in the Entrypoint');
    uint256 _label = uint256(keccak256(abi.encodePacked(scope, pool.nonce()))) % Constants.SNARK_SCALAR_FIELD;
    _n = Note(_value, _label, _nullifier, _secret);
    assertEq(_commitment(_n), _c, 'commitment mirror');
    stateLeaves.push(_c);
  }

  function _approveLabels(Note memory _a, Note memory _b) internal {
    aspLeaves.push(_a.label);
    aspLeaves.push(_b.label);
    vm.prank(postman);
    entrypoint.updateRoot(_root(aspLeaves), 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi');
  }

  function _relayFork(Note memory _n, uint256 _amount, address _to)
    internal
    returns (Note memory _change, uint256 _gas)
  {
    IPrivacyPool.Withdrawal memory _w = IPrivacyPool.Withdrawal(
      address(entrypoint), abi.encode(IEntrypoint.RelayData({recipient: _to, feeRecipient: relayer, relayFeeBPS: 100}))
    );
    ProofLib.WithdrawProof memory _p;
    (_p, _change) = _prove(_n, _amount, _w);
    uint256 _toBefore = zc.balanceOf(_to);
    uint256 _relayerBefore = zc.balanceOf(relayer);
    uint256 _poolBefore = zc.balanceOf(address(pool));
    _cool();
    vm.prank(relayer);
    uint256 _g = gasleft();
    entrypoint.relay(_w, _p, scope);
    _gas = _g - gasleft();
    _spent(_p);
    uint256 _fee = _amount / 100;
    assertEq(zc.balanceOf(_to) - _toBefore, _amount - _fee, 'recipient');
    assertEq(zc.balanceOf(relayer) - _relayerBefore, _fee, 'relayer');
    assertEq(_poolBefore - zc.balanceOf(address(pool)), _amount, 'pool paid exactly the amount');
    assertEq(zc.balanceOf(address(entrypoint)), 0, 'ZC stuck in the Entrypoint');
  }

  function _withdrawFork(Note memory _n, uint256 _amount, address _owner)
    internal
    returns (Note memory _change, uint256 _gas)
  {
    IPrivacyPool.Withdrawal memory _w = IPrivacyPool.Withdrawal(_owner, '');
    ProofLib.WithdrawProof memory _p;
    (_p, _change) = _prove(_n, _amount, _w);
    uint256 _before = zc.balanceOf(_owner);
    _cool();
    vm.prank(_owner);
    uint256 _g = gasleft();
    pool.withdraw(_w, _p);
    _gas = _g - gasleft();
    _spent(_p);
    assertEq(zc.balanceOf(_owner) - _before, _amount, 'direct withdraw');
  }

  function _ragequitFork(Note memory _n, address _owner) internal returns (uint256 _gas) {
    string[] memory _a = new string[](5);
    _a[0] = 'exit';
    _a[1] = vm.toString(_n.value);
    _a[2] = vm.toString(_n.label);
    _a[3] = vm.toString(_n.nullifier);
    _a[4] = vm.toString(_n.secret);
    ProofLib.RagequitProof memory _p = abi.decode(_ffi(_a), (ProofLib.RagequitProof));
    uint256 _before = zc.balanceOf(_owner);
    _cool();
    vm.prank(_owner);
    uint256 _g = gasleft();
    pool.ragequit(_p);
    _gas = _g - gasleft();
    assertEq(zc.balanceOf(_owner) - _before, _n.value, 'ragequit');
  }

  function _digest() internal view returns (bytes32 _h) {
    _h = keccak256(
      abi.encode(pool.currentRoot(), pool.currentTreeSize(), pool.nonce(), pool.currentRootIndex(), pool.dead())
    );
    for (uint256 _s; _s < 10; ++_s) {
      _h = keccak256(abi.encode(_h, vm.load(address(pool), bytes32(_s))));
    }
  }

  function _key() internal view returns (ZipLiquidityBands.PoolKey memory) {
    return ISendItFactoryKeys(SENDIT_FACTORY).poolKeyFor(ZC);
  }

  /// @dev Trades through the real pool and reports where the fees went
  function _rewardsFromTrading() internal returns (uint256 _fromSwaps) {
    IRealZc _z = IRealZc(ZC);
    uint256 _p0 = _z.pendingReward(address(realPool));
    address _src = _z.rewardSource();
    address _hook = _key().hooks;
    uint256[3] memory _eth0 = [_src.balance, ZC.balance, _hook.balance];
    _trade(5 ether);
    emit log_named_decimal_uint(
      'pool rewards accrued in the swaps themselves', _z.pendingReward(address(realPool)) - _p0, 18
    );
    emit log_named_decimal_int('  ETH delta at rewardSource', int256(_src.balance) - int256(_eth0[0]), 18);
    emit log_named_decimal_int('  ETH delta at ZC', int256(ZC.balance) - int256(_eth0[1]), 18);
    emit log_named_decimal_int('  ETH delta at the hook', int256(_hook.balance) - int256(_eth0[2]), 18);
    (, uint256 _eth) = ILaunchLocker(_src).collect(LOCKED_TOKEN_ID);
    emit log_named_decimal_uint('locker.collect(): ETH fees collected', _eth, 18);
    _fromSwaps = _z.pendingReward(address(realPool)) - _p0;
    emit log_named_decimal_uint('pool rewards accrued from a 5 ETH round trip, after collect', _fromSwaps, 18);
  }

  /// @dev Round-trip trades through ZC's real v4 pool (buy with ETH, sell the ZC back): the launch hook's fees
  function _trade(uint256 _eth) internal {
    ZipLiquidityBands.PoolKey memory _k = _key();
    ForkSwapper _sw = new ForkSwapper(POOL_MANAGER);
    vm.deal(swapperEoa, _eth);
    uint256 _zcBefore = IERC20(ZC).balanceOf(swapperEoa);
    vm.prank(swapperEoa);
    _sw.swap{value: _eth}(_k, true, _eth); // ETH (currency0) -> ZC
    uint256 _bought = IERC20(ZC).balanceOf(swapperEoa) - _zcBefore;
    emit log_named_decimal_uint('trade: ZC bought', _bought, 18);
    vm.prank(swapperEoa);
    IERC20(ZC).transfer(address(_sw), _bought);
    vm.prank(address(_sw));
    try _sw.swap(_k, false, _bought) {
      emit log_named_decimal_uint('trade: ETH back from the sell', address(_sw).balance, 18);
    } catch (bytes memory _err) {
      emit log_named_bytes('trade: the sell reverted', _err);
    }
  }

  // ------------------------------------------------------------------------------------------------------------

  function test_fork_realZc_fullLifecycle_withRealRewardsHarvestedToASafe() public onFork {
    IRealZc _z = IRealZc(ZC);
    _use(realPool);
    emit log_named_string('ZC holder fees enabled', _z.holderFeesEnabled() ? 'yes' : 'no');
    assertFalse(_z.rewardExcluded(address(realPool)), 'the pool is excluded from ZC rewards');

    (Note memory _a,) = _depositFork(alice, 10_000 ether);
    (Note memory _b,) = _depositFork(bob, 5000 ether);
    _approveLabels(_a, _b);

    // Real rewards from real trading: a round trip pays LP fees to ZC's locked launch position (nothing reaches holders
    // in the swap itself); the locker's permissionless collect() then routes the holders' share into ZC.notifyReward.
    uint256 _fromFees = _rewardsFromTrading();
    assertGt(_fromFees, 0, 'real swap fees reached the pool as holder rewards');
    uint256 _pending = _z.pendingReward(address(realPool));
    emit log_named_decimal_uint('pool rewards pending before harvest', _pending, 18);
    assertGt(_pending, 0, 'pool accrues ZC holder rewards');

    bytes32 _before = _digest();
    uint256 _zcBefore = IERC20(ZC).balanceOf(address(realPool));
    uint256 _safeBefore = safe.balance;
    address _keeper = makeAddr('zip-pool-fork-keeper');
    vm.prank(_keeper);
    uint256 _g = gasleft();
    uint256 _claimed = realPool.harvest();
    emit log_named_uint('gas: harvest (real ZC, to a Safe)', _g - gasleft());
    assertEq(_claimed, _pending, 'harvest returns the claim');
    assertEq(safe.balance - _safeBefore, _pending + strayEth, 'the Safe received the claim (+ any stray ETH)');
    assertEq(address(realPool).balance, 0, 'pool keeps no ETH');
    assertEq(_z.pendingReward(address(realPool)), 0, 'nothing left to claim');
    assertEq(_digest(), _before, 'harvest changed pool state');
    assertEq(IERC20(ZC).balanceOf(address(realPool)), _zcBefore, 'harvest moved ZC');
    assertEq(_keeper.balance, 0);

    // A second harvest right away: the real token's NothingToClaim
    vm.expectRevert();
    realPool.harvest();

    // Withdrawals and ragequits still work with the real token's transfer hooks
    (Note memory _a2,) = _relayFork(_a, 4000 ether, carol);
    (Note memory _b2,) = _withdrawFork(_b, 1000 ether, bob);
    _ragequitFork(_a2, alice);
    _ragequitFork(_b2, bob);
    assertEq(IERC20(ZC).balanceOf(address(realPool)), 0, 'everyone is out');
    assertEq(IERC20(ZC).balanceOf(alice), 6000 ether);
    assertEq(IERC20(ZC).balanceOf(bob), 5000 ether);
    assertEq(IERC20(ZC).balanceOf(carol), 3960 ether);

    // Rewards that accrued while the notes were still in: harvestable after everyone left
    uint256 _late = _z.pendingReward(address(realPool));
    if (_late != 0) {
      realPool.harvest();
      assertEq(safe.balance - _safeBefore, _pending + strayEth + _late);
    }
  }

  function test_fork_revertingTreasuryDoesNotBrickTheRealPool() public onFork {
    // TREASURY = a contract with no receive(): the Entrypoint proxy
    ZipPrivacyPool _p =
      new ZipPrivacyPool(address(entrypoint), WITHDRAWAL_VERIFIER, RAGEQUIT_VERIFIER, ZC, payable(address(entrypoint)));
    vm.prank(owner); // one pool per asset per Entrypoint: swap the real-ZC pool for this one
    entrypoint.removePool(IERC20(ZC));
    vm.prank(owner);
    entrypoint.registerPool(IERC20(ZC), IPrivacyPool(address(_p)), 1 ether, 0, 500);
    _use(_p);
    (Note memory _a,) = _depositFork(alice, 1000 ether);
    (Note memory _b,) = _depositFork(bob, 1000 ether);
    _approveLabels(_a, _b);
    address _src = IRealZc(ZC).rewardSource();
    vm.deal(_src, 1 ether);
    vm.prank(_src);
    IRealZc(ZC).notifyReward{value: 1 ether}(1 ether);
    uint256 _pending = IRealZc(ZC).pendingReward(address(_p));
    assertGt(_pending, 0);
    vm.expectRevert(ZipPrivacyPool.TreasuryTransferFailed.selector);
    _p.harvest();
    assertEq(IRealZc(ZC).pendingReward(address(_p)), _pending, 'rewards stay claimable');
    _relayFork(_a, 100 ether, carol);
    _ragequitFork(_b, bob);
  }

  /// @notice No hold cap or launch guard stops the pool from holding a large share of ZC: it is one address holding
  ///         everyone's deposits. 5% of the supply in five deposits, then all of it out again. (ZC's launch guard caps
  ///         every holder but the market at MAX_HOLD, 5% of the supply, but only for its first GUARD_BLOCKS blocks.)
  function test_fork_poolCanHoldALargeShareOfZc() public onFork {
    _use(realPool);
    IRealZc _z = IRealZc(ZC);
    emit log_named_uint('ZC launch guard ended at block', _z.guardEndsAtBlock());
    emit log_named_decimal_uint('ZC MAX_HOLD while the guard was active', _z.MAX_HOLD(), 18);
    assertFalse(_z.guardActive(), 'the launch guard is still active: deposits above MAX_HOLD in total would revert');
    uint256 _onePct = IERC20(ZC).totalSupply() / 100;
    emit log_named_decimal_uint('ZC total supply', IERC20(ZC).totalSupply(), 18);
    emit log_named_decimal_uint('ZC in the market (PoolManager)', IERC20(ZC).balanceOf(IRealZc(ZC).market()), 18);
    Note[5] memory _n;
    for (uint256 _i; _i < 5; ++_i) {
      (_n[_i],) = _depositFork(_i % 2 == 0 ? alice : bob, _onePct);
    }
    assertEq(IERC20(ZC).balanceOf(address(realPool)), 5 * _onePct);
    for (uint256 _i; _i < 5; ++_i) {
      _ragequitFork(_n[_i], _i % 2 == 0 ? alice : bob);
    }
    assertEq(IERC20(ZC).balanceOf(address(realPool)), 0);
    assertEq(IERC20(ZC).balanceOf(alice), 3 * _onePct);
  }

  /// @notice Gas of each pool operation with the real ZC vs the MockZC twin (same verifiers, same Entrypoint)
  function test_fork_gas_realZcVsMock() public onFork {
    Gas memory _real = _gasRun(realPool);
    Gas memory _mock = _gasRun(mockPool);
    emit log_named_uint('gas real ZC: deposit (Entrypoint.deposit)', _real.deposit);
    emit log_named_uint('gas mock ZC: deposit (Entrypoint.deposit)', _mock.deposit);
    emit log_named_uint('gas real ZC: relay (Entrypoint.relay)', _real.relay);
    emit log_named_uint('gas mock ZC: relay (Entrypoint.relay)', _mock.relay);
    emit log_named_uint('gas real ZC: direct withdraw', _real.withdraw);
    emit log_named_uint('gas mock ZC: direct withdraw', _mock.withdraw);
    emit log_named_uint('gas real ZC: ragequit', _real.ragequit);
    emit log_named_uint('gas mock ZC: ragequit', _mock.ragequit);
    // A sanity bound so a pathological transfer hook would show up as a failure, not only as a number
    assertLt(_real.deposit, _mock.deposit + 200_000, 'real ZC deposit is far more expensive');
    assertLt(_real.relay, _mock.relay + 200_000, 'real ZC relay is far more expensive');
  }

  function _gasRun(ZipPrivacyPool _p) internal returns (Gas memory _g) {
    _use(_p);
    Note memory _a;
    Note memory _b;
    (_a,) = _depositFork(alice, 1000 ether); // first deposit into the pool (cold tree)
    (_b, _g.deposit) = _depositFork(bob, 1000 ether); // measured: a typical deposit
    _approveLabels(_a, _b);
    (, _g.relay) = _relayFork(_a, 400 ether, carol);
    (, _g.withdraw) = _withdrawFork(_b, 100 ether, bob);
    Note memory _c;
    (_c,) = _depositFork(alice, 1000 ether);
    _g.ragequit = _ragequitFork(_c, alice);
  }
}

