// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from '@oz/proxy/ERC1967/ERC1967Proxy.sol';
import {IERC20} from '@oz/token/ERC20/IERC20.sol';

import {Entrypoint} from 'contracts/Entrypoint.sol';
import {Constants} from 'contracts/lib/Constants.sol';
import {ProofLib} from 'contracts/lib/ProofLib.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPrivacyPool} from 'interfaces/IPrivacyPool.sol';

import {ZipCouriers} from 'zipnet/ZipCouriers.sol';
import {ZipMerchants} from 'zipnet/ZipMerchants.sol';
import {ZipPay} from 'zipnet/ZipPay.sol';
import {ZipPrivacyPool} from 'zipnet/ZipPrivacyPool.sol';
import {ZipProcessooor} from 'zipnet/ZipProcessooor.sol';

import {MockZC, ZipnetBase} from './ZipnetBase.sol';

/// @notice The parts of the ZC token beyond ERC-20 that matter to a pool holding it
interface IHolderRewards {
  function holderFeesEnabled() external view returns (bool);
  function market() external view returns (address);
  function rewardSource() external view returns (address);
  function rewardExcluded(address) external view returns (bool);
  function pendingReward(address) external view returns (uint256);
  function notifyReward(uint256) external payable;
}

/**
 * @notice Smoke test against mainnet state: the real ZC token, the 0xbow production verifiers and Entrypoint
 *         implementation, and a freshly deployed zipnet stack around them. Zip, relayed unzip and a taxed payment,
 *         with exact balance checks so any transfer hook that skims or reroutes value fails loudly.
 *
 *   ETHEREUM_MAINNET_RPC=<url> forge test --match-contract MainnetForkTest -vv
 *
 * Skipped when ETHEREUM_MAINNET_RPC is unset. Any full node works (the fork reads the latest block).
 */
contract MainnetForkTest is ZipnetBase {
  address internal constant ZC = 0x2CA7B61B23b15e75aC7AB60Dd6f627895d64a46E;
  address internal constant WITHDRAWAL_VERIFIER = 0x022891F938Ae7fDC8Ab9Ead0FBf50aBA8C897D6d;
  address internal constant RAGEQUIT_VERIFIER = 0xa45ACa8604a73D80C551fAad6355A5c3A5565eC6;
  address internal constant ENTRYPOINT_IMPL = 0x15e355024de1CDc74ADdea7EBDf98418Ba5B1a2c;

  bool internal forked;
  /// @dev Not makeAddr('treasury'): that address carries a live EIP-7702 sweeper on mainnet (pool review I-5)
  address internal treasury = makeAddr('zipnet-fork-treasury');
  ZipMerchants internal merchants;
  ZipCouriers internal couriers;
  ZipPay internal zipPay;

  function setUp() public override {
    string memory _rpc = vm.envOr('ETHEREUM_MAINNET_RPC', string(''));
    if (bytes(_rpc).length == 0) return;
    vm.createSelectFork(_rpc);
    forked = true;
    for (uint256 _i; _i < 3; ++_i) {
      address _c = [ZC, WITHDRAWAL_VERIFIER, ENTRYPOINT_IMPL][_i];
      assertGt(_c.code.length, 0, 'mainnet contract missing');
    }

    zc = MockZC(ZC); // only its ERC-20 surface is used here
    entrypoint = Entrypoint(
      payable(address(new ERC1967Proxy(ENTRYPOINT_IMPL, abi.encodeCall(Entrypoint.initialize, (owner, postman)))))
    );
    pool = new ZipPrivacyPool(address(entrypoint), WITHDRAWAL_VERIFIER, RAGEQUIT_VERIFIER, ZC, payable(treasury));
    vm.prank(owner);
    entrypoint.registerPool(IERC20(ZC), IPrivacyPool(address(pool)), 1 ether, 0, 500);
    scope = pool.SCOPE();

    merchants = new ZipMerchants(IERC20(ZC), 1000 ether);
    couriers = new ZipCouriers(IPrivacyPool(address(pool)), 1000 ether);
    zipPay = new ZipPay(
      IPrivacyPool(address(pool)), merchants, 100, 5000, 3000, address(couriers), treasury, semaphore, 10 ether
    );
  }

  modifier onFork() {
    if (!forked) vm.skip(true);
    _;
  }

  /// @dev Real transfers out of the market (the Uniswap v4 PoolManager holds the liquidity), so every hook runs
  function _fund(address _to, uint256 _value) internal {
    address _market = IHolderRewards(ZC).market();
    uint256 _before = IERC20(ZC).balanceOf(_to);
    vm.prank(_market);
    IERC20(ZC).transfer(_to, _value);
    assertEq(IERC20(ZC).balanceOf(_to) - _before, _value, 'ZC transfer delivered a different amount');
  }

  function _zipFork(address _who, uint256 _value) internal returns (Note memory _n) {
    _fund(_who, _value);
    (uint256 _nullifier, uint256 _secret) = _secrets();
    uint256 _poolBefore = IERC20(ZC).balanceOf(address(pool));
    vm.startPrank(_who);
    IERC20(ZC).approve(address(entrypoint), _value);
    uint256 _c = entrypoint.deposit(IERC20(ZC), _value, _precommitment(_nullifier, _secret));
    vm.stopPrank();
    assertEq(IERC20(ZC).balanceOf(address(pool)) - _poolBefore, _value, 'pool received less than the note records');

    uint256 _label = uint256(keccak256(abi.encodePacked(scope, pool.nonce()))) % Constants.SNARK_SCALAR_FIELD;
    _n = Note(_value, _label, _nullifier, _secret);
    assertEq(_commitment(_n), _c, 'commitment mirror');
    stateLeaves.push(_c);
    _approve(_label);
  }

  function test_fork_zipRelayedUnzipAndPay() public onFork {
    Note memory _n = _zipFork(makeAddr('alice'), 1000 ether);

    // relayed unzip: 100 ZC to a fresh address, 1% to the relayer
    address _bob = makeAddr('bob');
    address _relayer = makeAddr('relayer');
    IPrivacyPool.Withdrawal memory _w = IPrivacyPool.Withdrawal(
      address(entrypoint), abi.encode(IEntrypoint.RelayData({recipient: _bob, feeRecipient: _relayer, relayFeeBPS: 100}))
    );
    (ProofLib.WithdrawProof memory _p, Note memory _change) = _prove(_n, 100 ether, _w);
    entrypoint.relay(_w, _p, scope);
    _spent(_p);
    assertEq(IERC20(ZC).balanceOf(_bob), 99 ether, 'bob');
    assertEq(IERC20(ZC).balanceOf(_relayer), 1 ether, 'relayer');
    assertEq(IERC20(ZC).balanceOf(address(pool)), 900 ether, 'pool');

    // taxed payment from the change note: 10 ZC base + 0.1 ZC tax (50% burn / 30% couriers / 20% treasury)
    address _shop = makeAddr('shop');
    _fund(_shop, 1000 ether);
    vm.startPrank(_shop);
    IERC20(ZC).approve(address(merchants), 1000 ether);
    uint256 _id = merchants.register(_shop, 1000 ether, 'fork:shop');
    vm.stopPrank();

    ZipPay.Payment memory _pay = ZipPay.Payment({
      merchantId: _id,
      base: 10 ether,
      orderId: keccak256('fork order'),
      payeePrecommitment: 0,
      identityCommitment: 0,
      receipt: '',
      courier: ZipProcessooor.Courier(address(0), 0)
    });
    IPrivacyPool.Withdrawal memory _pw = IPrivacyPool.Withdrawal(address(zipPay), abi.encode(_pay));
    (ProofLib.WithdrawProof memory _pp,) = _prove(_change, 10.1 ether, _pw);
    uint256 _burnBefore = IERC20(ZC).balanceOf(BURN);
    zipPay.payAnon(_pw, _pp);
    _spent(_pp);
    assertEq(IERC20(ZC).balanceOf(_shop), 10 ether, 'merchant');
    assertEq(IERC20(ZC).balanceOf(BURN) - _burnBefore, 0.05 ether, 'burned');
    assertEq(IERC20(ZC).balanceOf(address(couriers)), 0.03 ether, 'couriers');
    assertEq(IERC20(ZC).balanceOf(treasury), 0.02 ether, 'treasury');
    assertEq(IERC20(ZC).balanceOf(address(pool)), 889.9 ether, 'pool after pay');
  }

  /**
   * @notice ZC's ETH holder rewards on tokens the zipnet contracts hold: the pool accrues them like any holder, and
   *         its harvest() claims them from the real token and forwards them to the treasury. (Merchant stakes, courier
   *         bonds and badge locks share theirs with their stakers through ZcRewardsHarvester.)
   */
  function test_fork_holderRewardsAccrueToThePool_andHarvestToTreasury() public onFork {
    IHolderRewards _zc = IHolderRewards(ZC);
    _zipFork(makeAddr('alice'), 1000 ether);
    if (!_zc.holderFeesEnabled() || _zc.rewardExcluded(address(pool))) return;

    uint256 _before = _zc.pendingReward(address(pool));
    address _source = _zc.rewardSource();
    vm.deal(_source, 100 ether);
    vm.prank(_source);
    _zc.notifyReward{value: 100 ether}(100 ether);
    uint256 _accrued = _zc.pendingReward(address(pool)) - _before;
    emit log_named_decimal_uint('ETH rewards stranded in the pool per 100 ETH distributed', _accrued, 18);
    assertGt(_accrued, 0, 'pool is not accruing rewards');

    uint256 _zcBefore = IERC20(ZC).balanceOf(address(pool));
    uint256 _pending = _zc.pendingReward(address(pool));
    // The test's deterministic pool address can already hold dust on mainnet (1 wei at the time of writing);
    // harvest forwards the whole balance, so that dust goes to the treasury with the claim
    uint256 _dust = address(pool).balance;
    uint256 _claimed = ZipPrivacyPool(payable(address(pool))).harvest();
    assertEq(_claimed, _pending, 'claim differs from pendingReward');
    assertEq(treasury.balance, _claimed + _dust, 'treasury did not receive the harvest');
    assertEq(address(pool).balance, 0, 'pool kept ETH');
    assertEq(_zc.pendingReward(address(pool)), 0);
    assertEq(IERC20(ZC).balanceOf(address(pool)), _zcBefore, 'harvest moved ZC');
  }
}
