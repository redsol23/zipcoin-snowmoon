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

import {Entrypoint} from 'contracts/Entrypoint.sol';
import {PrivacyPoolComplex} from 'contracts/implementations/PrivacyPoolComplex.sol';
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
import {ZipRezip} from 'zipnet/ZipRezip.sol';
import {ZipSignal} from 'zipnet/ZipSignal.sol';

/// @notice Stand-in ZC for local runs; mainnet uses the sender.family token.
contract LocalZC is ERC20 {
  constructor(address _to) ERC20('zipcoin', 'ZC') {
    _mint(_to, 1_000_000_000 ether);
  }
}

/**
 * @notice Deploys the whole zipnet stack and writes deployments/<DEPLOYMENT>.json.
 *
 * Env (all optional; unset means "deploy a fresh one", which is what local runs want):
 *   ZC_ADDRESS                 token (mainnet: sender.family ZC 0x2CA7B61B23b15e75aC7AB60Dd6f627895d64a46E)
 *   WITHDRAWAL_VERIFIER        mainnet 0xbow: 0x022891F938Ae7fDC8Ab9Ead0FBf50aBA8C897D6d
 *   RAGEQUIT_VERIFIER          mainnet 0xbow: 0xa45ACa8604a73D80C551fAad6355A5c3A5565eC6
 *   ENTRYPOINT_IMPL            mainnet 0xbow: 0x15e355024de1CDc74ADdea7EBDf98418Ba5B1a2c
 *   SEMAPHORE_ADDRESS          existing Semaphore v4
 *   OWNER, POSTMAN, TREASURY   default to the broadcaster (local only; mainnet OWNER must be a Safe)
 *   PRIVATE_KEY                deployer key (required)
 *   DEPLOYMENT                 output name, default "local"
 * Economics (defaults = plan): MIN_DEPOSIT 1 ZC, MAX_RELAY_BPS 500, MIN_BURN 100 ZC, TAX_BPS 100,
 *   BURN_SHARE_BPS 5000, COURIER_SHARE_BPS 3000, MERCHANT_MIN_STAKE 1000 ZC, COURIER_MIN_STAKE 1000 ZC.
 *
 * The broadcaster initialises the Entrypoint as owner, registers the pool, then hands OWNER_ROLE to OWNER and
 * renounces its own, so no deployer key keeps power.
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
    uint256 deployBlock;
  }

  Stack internal s;
  address internal me;

  function run() external returns (Stack memory) {
    uint256 _key = vm.envUint('PRIVATE_KEY');
    me = vm.addr(_key);
    s.deployBlock = block.number;
    vm.startBroadcast(_key);
    _core();
    _features();
    _handOver();
    vm.stopBroadcast();
    _write(s);
    return s;
  }

  function _core() internal {
    s.zc = vm.envOr('ZC_ADDRESS', address(0));
    if (s.zc == address(0)) s.zc = address(new LocalZC(me));

    address _wv = vm.envOr('WITHDRAWAL_VERIFIER', address(0));
    if (_wv == address(0)) _wv = address(new WithdrawalVerifier());
    address _rv = vm.envOr('RAGEQUIT_VERIFIER', address(0));
    if (_rv == address(0)) _rv = address(new CommitmentVerifier());
    address _impl = vm.envOr('ENTRYPOINT_IMPL', address(0));
    if (_impl == address(0)) _impl = address(new Entrypoint());

    address _postman = vm.envOr('POSTMAN', me);
    Entrypoint _ep = Entrypoint(payable(address(new ERC1967Proxy(_impl, abi.encodeCall(Entrypoint.initialize, (me, _postman))))));
    PrivacyPoolComplex _pool = new PrivacyPoolComplex(address(_ep), _wv, _rv, s.zc);
    _ep.registerPool(
      IERC20(s.zc), IPrivacyPool(address(_pool)), vm.envOr('MIN_DEPOSIT', uint256(1 ether)), 0, vm.envOr('MAX_RELAY_BPS', uint256(500))
    );
    s.entrypoint = address(_ep);
    s.pool = address(_pool);
    s.scope = _pool.SCOPE();

    s.semaphore = vm.envOr('SEMAPHORE_ADDRESS', address(0));
    if (s.semaphore == address(0)) {
      s.semaphore = address(new Semaphore(ISemaphoreVerifier(address(new SemaphoreVerifier()))));
    }
  }

  function _features() internal {
    IPrivacyPool _p = IPrivacyPool(s.pool);
    ISemaphore _sem = ISemaphore(s.semaphore);
    uint256 _minBurn = vm.envOr('MIN_BURN', uint256(100 ether));
    s.broadcaster = address(new ZipBroadcaster(_p, _minBurn));
    s.doorstep = address(new ZipDoorstep(_p, _minBurn));
    s.rezip = address(new ZipRezip(_p));
    s.addressRegistry = address(new ZipAddressRegistry());
    s.merchants = address(new ZipMerchants(IERC20(s.zc), vm.envOr('MERCHANT_MIN_STAKE', uint256(1000 ether))));
    s.couriers = address(new ZipCouriers(_p, vm.envOr('COURIER_MIN_STAKE', uint256(1000 ether))));
    s.pay = address(
      new ZipPay(
        _p,
        ZipMerchants(s.merchants),
        vm.envOr('TAX_BPS', uint256(100)),
        vm.envOr('BURN_SHARE_BPS', uint256(5000)),
        vm.envOr('COURIER_SHARE_BPS', uint256(3000)),
        s.couriers,
        vm.envOr('TREASURY', me),
        _sem
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
  }

  function _handOver() internal {
    address _owner = vm.envOr('OWNER', me);
    if (_owner == me) return;
    bytes32 _ownerRole = keccak256('OWNER_ROLE');
    Entrypoint(payable(s.entrypoint)).grantRole(_ownerRole, _owner);
    Entrypoint(payable(s.entrypoint)).renounceRole(_ownerRole, me);
  }

  function _write(Stack memory _s) internal {
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
    string memory _json = vm.serializeAddress(_o, 'polls', _s.polls);
    string memory _file = string.concat('./deployments/', vm.envOr('DEPLOYMENT', string('local')), '.json');
    vm.writeJson(_json, _file);
    console.log('wrote', _file);
  }
}
