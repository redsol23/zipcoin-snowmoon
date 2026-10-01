# Deploying zipnet to mainnet

A runbook from a clean checkout to a live stack: contracts, postman, couriers, web app and Veridia. Every value you
must choose is marked **DECISION** and collected in the [decision list](#decisions-to-make-before-launch) at the
end. Nothing here is done by a script on its own; each step is run and checked by hand.

**Env template:** [`deploy/mainnet.env.example`](../deploy/mainnet.env.example) lists every deploy and service variable
with the decided launch values filled in and placeholders for keys, Safes and URLs.

**Infrastructure:** the services can all run on one VPS behind a Cloudflare Tunnel; see
[One-box deployment](#one-box-deployment) and [`deploy/README.md`](../deploy/README.md). The commands in steps 5-8b show
each service's settings; on the one box the same variables go into `/srv/zipnet/env/*.env` and the keys into Docker
secrets. Rehearse the contract deploy on Sepolia first: [`scripts/deploy-sepolia.sh`](../scripts/deploy-sepolia.sh).

> The contracts are unaudited. Launch with the deposit caps on (step 5) and keep them on until an audit lands.

## 0. What goes where

| Piece | What it is | Where it runs |
|---|---|---|
| Contracts | Entrypoint proxy (0xbow implementation), one ZC privacy pool, ten zipnet processooors | Ethereum mainnet |
| Postman | The Association Set Provider: approves deposits, publishes the ASP root once per epoch | One server, one hot key |
| Courier | Relays proofs, holds them for timing privacy, serves pool state, earns fees and tax share | One or more servers, each with its own bonded key |
| Web app | Wallet, merchant pages, Veridia viewer | Static host / Node host behind the domain |
| Veridia | The Snowmoon residents (AI agents) that also act as cover traffic | One server, funded key |
| Stats API | Read-only JSON behind zipcoin.org's Ledger, Privacy meter and Status pages | `api.zipcoin.org`, no key |

## 1. Preflight

```sh
pnpm install
node scripts/fetch-semaphore-artifacts.mjs      # downloads Semaphore depths 1-16 and checks every SHA-256 pin
cd contracts && forge test                      # full suite, real proofs through FFI
cd .. && ./scripts/e2e.sh                       # the whole story on a fresh local chain; rewrites docs/GAS.md
ETHEREUM_MAINNET_RPC=<url> forge test --root contracts --match-contract MainnetForkTest -vv
```

The fork test deploys a fresh stack against the **real** ZC token and the 0xbow production verifiers, then zips,
relays an unzip and makes a taxed payment with exact balance checks. It must pass on the block you deploy at: it is
what proves ZC's transfer hooks deliver exact amounts to and from the pool.

## 2. Keys and accounts

| Role | Holds | Notes |
|---|---|---|
| Deployer | ETH for gas only | Throwaway. The deploy script hands `OWNER_ROLE` to `OWNER` and renounces its own. |
| `OWNER` **DECISION** | Entrypoint owner: registers pools, sets pool config (including the vetting fee), can upgrade the Entrypoint | On chain 1, an OpenZeppelin `TimelockController` with a minimum delay of at least `OWNER_MIN_DELAY` (default 48h). `OWNER_SAFE` is its only proposer and executor (or the executor is open), and it has no admin but itself: deploy it with `new TimelockController(172800, [ownerSafe], [ownerSafe], address(0))`. An upgrade can redirect relayed withdrawals, and a vetting fee skims deposits (R2-M3, core L-5), so users get the delay to leave first. Contract-made deposits refuse any fee anyway (deferred payouts park, live re-zips revert). |
| `OWNER_SAFE` **DECISION** | The Safe (1-of-1 by owner decision) that proposes and executes through the `OWNER` timelock | A Safe (canonical v1.3.0 / v1.4.1 singleton) with no modules and no guard, unless listed in `SAFE_ALLOWED_MODULES`. |
| `POSTMAN` **DECISION** | Pushes ASP roots | A hot key on the postman server. Can only publish roots; it cannot move funds. Rotate via `OWNER`. |
| `TREASURY` **DECISION** | The treasury Safe: owns ZipLiquidityBands and receives everything it pays out (fees, exits, and all ETH the bands contract receives); receives the pool's harvested ETH | A Safe. ZipPay's 20% tax share (default split) goes to ZipLiquidityBands (`TAX_TREASURY`, immutable), see step 4b. |
| Courier keys | Bonded ZC stake + ETH for gas | One per courier server. Bond ≥ `COURIER_MIN_STAKE`. |
| Veridia key | ZC + ETH for the residents' actions | Optional at launch. |

## 3. Deploy the contracts

### One command

[`scripts/deploy-mainnet.sh`](../scripts/deploy-mainnet.sh) runs this whole step from one env file (a filled copy of
[`deploy/mainnet.env.example`](../deploy/mainnet.env.example), kept out of the repo). The decisions it carries: 1-of-1
Safes (`SAFE_THRESHOLD=1`, `SAFE_MIN_THRESHOLD=1`, `SAFE_MIN_OWNERS=1`), the 48h timelock, and the bands on.

```sh
./scripts/deploy-mainnet.sh fork --env-file deploy/mainnet.env.example   # 1. rehearsal; the template runs as is
./scripts/deploy-mainnet.sh owners --env-file ~/zipnet-mainnet.env       # 2. simulate the Safes + timelock
CONFIRM_BROADCAST=mainnet ./scripts/deploy-mainnet.sh owners --env-file ~/zipnet-mainnet.env   # 3. create them
#    paste the printed OWNER, OWNER_SAFE, TREASURY into the env file
./scripts/deploy-mainnet.sh dry --env-file ~/zipnet-mainnet.env          # 4. Deploy on the real RPC, nothing sent
CONFIRM_BROADCAST=mainnet ./scripts/deploy-mainnet.sh broadcast --env-file ~/zipnet-mainnet.env  # 5. --slow, check()
```

- **fork** starts `anvil --fork-url` (`FORK_RPC_URL`, else `ETHEREUM_MAINNET_RPC`, else a public node), runs
  `Owners.s.sol` with a test signer (anvil account 1; 1-of-1 Safes at the canonical Safe v1.4.1 addresses), then
  `Deploy.s.sol` with the file's launch config and every chain-1 guard, then `check()`. It prints every address and
  the deployer's total gas and its ETH cost at the current gas price. The receipts go to `contracts/broadcast/fork/`,
  the JSON to `contracts/deployments/mainnet-fork-local*.json`.
- **owners** runs `Owners.s.sol`: two Safe v1.4.1 proxies from `SAFE_OWNERS` / `SAFE_THRESHOLD` and a
  `TimelockController(OWNER_MIN_DELAY, [ownerSafe], [ownerSafe], address(0))`. It sends only with
  `CONFIRM_BROADCAST=mainnet`, then writes `deployments/mainnet-owners.json` and prints the three lines for the env
  file. Deploy can't create them itself: its guard checks them before it broadcasts anything.
- **dry** is the exact Deploy without `--broadcast` (a random throwaway sender when `PRIVATE_KEY` is unset).
- **broadcast** needs `CONFIRM_BROADCAST=mainnet`, sends with `--slow` (plus `--verify` when `ETHERSCAN_API_KEY` is
  set), runs `check()` and prints the addresses. Commit `contracts/deployments/mainnet.json`.

Every mode refuses a chain other than 1 and any Deploy variable that is unset or still a `<placeholder>` (names only:
it never prints a key or an RPC URL). Variables already in the environment win over the file.

**Cost**: the fork rehearsal prints the deployer's total gas and its ETH cost at the day's gas price. Fund the
deployer with 2x that estimate.

### By hand

```sh
cd contracts
PRIVATE_KEY=<deployer> DEPLOYMENT=mainnet \
ZC_ADDRESS=0x2CA7B61B23b15e75aC7AB60Dd6f627895d64a46E \
WITHDRAWAL_VERIFIER=0x022891F938Ae7fDC8Ab9Ead0FBf50aBA8C897D6d \
RAGEQUIT_VERIFIER=0xa45ACa8604a73D80C551fAad6355A5c3A5565eC6 \
ENTRYPOINT_IMPL=0x15e355024de1CDc74ADdea7EBDf98418Ba5B1a2c \
SEMAPHORE_ADDRESS=0x8A1fd199516489B0Fb7153EB5f075cDAC83c693D \
OWNER=<owner timelock> OWNER_SAFE=<owner safe> TREASURY=<treasury safe> POSTMAN=<postman address> \
POSTMAN_CAPS_ACK=MAX_DEPOSIT_WEI,MAX_DEPOSITOR_DAILY_WEI \
BANDS_POSITION_MANAGER=0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e BANDS_HOOK=0xCb69D5aBe0589AF4c57b0dCCA292980D5E52C0c0 \
BANDS_MAX_DAY_ZC=10000000000000000000000000 \
TAX_TREASURY=bands HARVEST_TREASURY=safe \
MIN_DEPOSIT=1000000000000000000 MAX_RELAY_BPS=500 TAX_BPS=100 BURN_SHARE_BPS=5000 COURIER_SHARE_BPS=3000 \
MIN_BURN=100000000000000000000 MERCHANT_MIN_STAKE=1000000000000000000000 COURIER_MIN_STAKE=1000000000000000000000 \
PAYER_GROUP_MIN_BASE=10000000000000000000000 \
forge script script/Deploy.s.sol:Deploy --rpc-url $ETHEREUM_MAINNET_RPC --slow --broadcast --verify
```

Order of play:

1. **Rehearse on a mainnet fork.** Start `anvil --fork-url $ETHEREUM_MAINNET_RPC --port 8601` and run the exact
   command above against `--rpc-url http://127.0.0.1:8601`: first without `--broadcast` (read the whole trace), then
   with it, then `--sig 'check()'` (step 4 below). Stop the anvil. The fork has chain id 1, so every guard below runs.
2. **Dry run on mainnet**: the exact command without `--broadcast`.
3. **Broadcast** with `--slow`, and send nothing else from the deployer until it finishes. The bands contract must
   know the pool's address before the pool exists, so the script predicts both from the deployer's nonce and asserts
   each prediction (`bands contract is not at the predicted address ...` / `pool is not at the predicted address the
   bands contract expects ...`). `--slow` sends one transaction at a time and waits for each receipt, so nothing can
   reorder them. These asserts run in the simulation only. If the nonce still moved on chain, nothing breaks: the pool
   pays the bands contract's real address, and the bands contract accepts ETH from any sender, so a wrong
   `HARVEST_SOURCE` only mislabels it (`check()` warns).
4. **Check on chain** before announcing any address: `DEPLOYMENT=mainnet OWNER=… POSTMAN=… TREASURY=… DEPLOYER=<deployer
   address> forge script script/Deploy.s.sol:Deploy --sig 'check()' --rpc-url $ETHEREUM_MAINNET_RPC` (simulation
   only, no `--broadcast`) reads `deployments/mainnet.json` and checks:
   - every recorded address has code;
   - the Entrypoint's ZC pool is the recorded pool, with vetting fee 0, `MIN_DEPOSIT` and `MAX_RELAY_BPS`;
   - the pool's Entrypoint, asset and scope;
   - `OWNER` holds `OWNER_ROLE` and the deployer does not; `POSTMAN` holds `ASP_POSTMAN`;
   - `OWNER` is a timelock with at least `OWNER_MIN_DELAY`;
   - every note-spending contract uses the recorded pool;
   - ZipPay pays the recorded couriers and merchants, with `MIN_JOIN_BASE` at least the floor;
   - the pool harvest and the tax go to the bands contract or its Safe, which is `TREASURY` (both to `TREASURY` without
     bands);
   - the harvest destination accepts ETH from the pool and from ZipPolls (the poll escrow).

   If any of these fail, redeploy before announcing. Then run the `cast` checks below.

**Mainnet guard.** On chain 1 the script reads its whole config first and refuses (reverts before broadcasting
anything) instead of falling back. Off chain 1 the same variables are optional and unset means "deploy a fresh one"
(local dev, e2e and the tests rely on that). Every chain-1 refusal:

| Variable | Refuses when | Message (prefix `mainnet: ` unless noted) |
|---|---|---|
| `ZC_ADDRESS` | unset (no stand-in ZC is ever deployed on chain 1) | `ZC_ADDRESS must be set (the script never deploys a stand-in ZC on chain 1)` |
| | not `0x2CA7…a46E` / no code / `totalSupply() != 1e27` / no `holderFeesEnabled()` | `ZC_ADDRESS is not ZC …` / `ZC_ADDRESS has no code` / `ZC_ADDRESS totalSupply is not 1e27; not ZC` / `ZC_ADDRESS does not answer holderFeesEnabled(); not ZC` |
| `WITHDRAWAL_VERIFIER`, `RAGEQUIT_VERIFIER`, `ENTRYPOINT_IMPL` | unset, or not the 0xbow address above, unless `ALLOW_FRESH_VERIFIERS=1` | `<NAME> must be set to the 0xbow production contract (ALLOW_FRESH_VERIFIERS=1 deploys a fresh one)` / `<NAME> is not the 0xbow production contract …` |
| | set but no code; the implementation is not UUPS (`proxiableUUID()`) | `<NAME> has no code` / `ENTRYPOINT_IMPL is not a UUPS implementation` |
| `ALLOW_FRESH_VERIFIERS` | Escape hatch; leave it unset. `1` deploys fresh verifiers and a fresh implementation from the vendored sources (or accepts other ones) and logs a WARNING. They verify the same proofs, but they are a new, unreviewed deployment, not the 0xbow instances the fork test and the audit cover. | |
| `SEMAPHORE_ADDRESS` | unset / not the canonical `0x8A1f…693D` / no code / `verifier()` is not `0x4DeC…31f8` | `set SEMAPHORE_ADDRESS to the canonical Semaphore v4` / `SEMAPHORE_ADDRESS is not the canonical Semaphore v4 …` / `SEMAPHORE_ADDRESS has no code on this chain` (no prefix) / `SEMAPHORE_ADDRESS verifier() is not the canonical SemaphoreVerifier` |
| `OWNER`, `OWNER_SAFE`, `TREASURY`, `POSTMAN` | unset / equal to the deployer | `<ROLE> must be set` / `<ROLE> must not be the deployer` |
| | `OWNER_SAFE == TREASURY`; `OWNER` equal to either Safe; `POSTMAN` equal to any of them | `OWNER_SAFE and TREASURY must be different Safes` / `OWNER must be the timelock OWNER_SAFE proposes through, not a Safe` / `POSTMAN must be its own hot key, not a Safe` |
| `OWNER` | no code / no `getMinDelay()` / delay below `OWNER_MIN_DELAY` / `OWNER_SAFE` not a proposer / `OWNER_SAFE` not an executor (and the executor role not open) / the deployer or `OWNER_SAFE` holds the timelock admin role | `OWNER has no code; it must be an OpenZeppelin TimelockController that OWNER_SAFE proposes through` / `OWNER does not answer getMinDelay(); …` / `the OWNER timelock delay is Ns, below OWNER_MIN_DELAY M` / `OWNER_SAFE is not a proposer on the OWNER timelock` / `OWNER_SAFE cannot execute on the OWNER timelock` / `the OWNER timelock must have no admin but itself (deploy it with admin = address(0))` |
| `OWNER_MIN_DELAY` | Optional, default 172800 (48h). Refuses below 1 day. | `OWNER_MIN_DELAY is below 1 day` |
| `OWNER_SAFE`, `TREASURY` | no code / no `getThreshold()` or `getOwners()` / threshold below `SAFE_MIN_THRESHOLD` / fewer owners than `SAFE_MIN_OWNERS` / not a proxy of the Safe v1.3.0 or v1.4.1 singleton (slot 0) / a module enabled / a guard set | `<ROLE> has no code; it must be a Safe` / `<ROLE> does not answer getThreshold(); not a Safe` / `<ROLE> Safe threshold is N, below SAFE_MIN_THRESHOLD 2` / `<ROLE> Safe has N owners, below SAFE_MIN_OWNERS 3` / `<ROLE> is not a proxy of a known Safe singleton …` / `<ROLE> has module … enabled; a module bypasses the threshold …` / `<ROLE> has guard … set …` |
| `SAFE_ALLOWED_MODULES`, `SAFE_SINGLETONS_EXTRA` | Optional, comma-separated. Modules (or a guard) the Safes may have anyway; further Safe singletons to accept. | |
| `SAFE_MIN_THRESHOLD`, `SAFE_MIN_OWNERS` | Optional, default 2 and 3; the launch sets both to 1 (the 1-of-1 decision). Refuses a threshold of 0 or fewer owners than the threshold. | `bad SAFE_MIN_THRESHOLD / SAFE_MIN_OWNERS` |
| `PAYER_GROUP_MIN_BASE` | below 10,000 ZC (`1e22`): a payer-group join costs only the tax on this base (core L-2) | `PAYER_GROUP_MIN_BASE must be at least 10000 ZC (1e22 wei): a payer-group join costs only its tax` |
| `DEPLOY_BATCH_RELAYER` | Never refuses. Default true: the upstream BatchRelayer backs the wallet's combined-notes unzip. It is outside 0xbow's audits and anyone can take a balance it holds (pool review L-1), so nothing may ever send it funds directly; it only receives a withdrawal and pays it out in the same transaction. `false` leaves it out, and the wallet then unzips one note at a time. | |
| `POSTMAN_CAPS_ACK` | not exactly `MAX_DEPOSIT_WEI,MAX_DEPOSITOR_DAILY_WEI` | `set MAX_DEPOSIT_WEI and MAX_DEPOSITOR_DAILY_WEI in the postman env, then POSTMAN_CAPS_ACK=…` |
| `TAX_TREASURY` | unset (the tax never goes to the Safe unless `safe` is written out) | `TAX_TREASURY must be set explicitly: "bands" (the launch decision) or "safe"` |
| `HARVEST_TREASURY` | unset | `HARVEST_TREASURY must be set explicitly: "safe" (the launch default) or "bands"` |
| both (every chain) | not `bands`, `safe`, the `TREASURY` address or the (predicted) bands address; `bands` without the bands config | `<NAME> must be "bands", "safe", or the TREASURY Safe or bands contract address; got …` / `<NAME>=bands needs BANDS_POSITION_MANAGER and BANDS_HOOK (the bands contract is not being deployed)` (no prefix) |
| `BANDS_POSITION_MANAGER`, `BANDS_HOOK` | only one set (every chain) | `BANDS_POSITION_MANAGER and BANDS_HOOK must be set together (both or neither)` (no prefix) |
| | not `0xbD21…ee9e` / `0xCb69…C0c0`; its `poolManager()` is not `0x0000…8A90`; its `permit2()` is not `0x0000…8BA3`; ZC's `market()` / `factory()` are not the PoolManager / `0x8D37…860c`; the factory's `poolKeyFor(ZC)` is not (ETH, ZC, 10000, 200, hook); `startTickOf(ZC) != 196600` | `BANDS_POSITION_MANAGER is not the v4 PositionManager …` / `BANDS_HOOK is not ZC launch hook …` / `… poolManager() is not the v4 PoolManager` / `… permit2() is not Permit2` / `ZC market() is not the v4 PoolManager` / `ZC factory() is not the launch factory` / `ZC pool key (factory poolKeyFor) is not ETH/ZC, fee 10000, tickSpacing 200, BANDS_HOOK` / `ZC start tick is not 196600 …` |
| `BANDS_MAX_DAY_ZC` | unset while bands is configured | `set <NAME> explicitly (immutable economics have no silent default on chain 1)` |
| `MIN_DEPOSIT`, `MAX_RELAY_BPS`, `MIN_BURN`, `TAX_BPS`, `BURN_SHARE_BPS`, `COURIER_SHARE_BPS`, `MERCHANT_MIN_STAKE`, `COURIER_MIN_STAKE`, `PAYER_GROUP_MIN_BASE` | unset | same |
| `DEPLOYMENT` | unset or `local`; contains `/`, `\` or `.` (the services' `DEPLOYMENT` is a path; forge's is a name) | `set DEPLOYMENT (e.g. mainnet); the output must not overwrite local.json` / `DEPLOYMENT is a file name (e.g. mainnet), not a path: …` |
| `PRIVATE_KEY` | unset (every chain) | forge's own env error |

`test/deploy/DeployScript.t.sol` runs every refusal above under `vm.chainId(1)`. It also deploys the stack with each
allowed `HARVEST_TREASURY` and harvests through it, and, with `ETHEREUM_MAINNET_RPC` set, runs the launch config
against real mainnet state:

```sh
forge test --match-path test/deploy/DeployScript.t.sol
```

Notes:

- `SEMAPHORE_ADDRESS` is the canonical Semaphore v4 (source: https://docs.semaphore.pse.dev/deployed-contracts).
- The deposit caps are postman settings (step 5), not contract state, so the script can't check them.
  `POSTMAN_CAPS_ACK` is your confirmation that both are in the postman's env.
- `BANDS_POSITION_MANAGER` and `BANDS_HOOK` deploy ZipLiquidityBands (step 4b) with `TREASURY` as its Safe.
  `TAX_TREASURY=bands` sends ZipPay's tax share to it (decision 18). `HARVEST_TREASURY=safe` keeps the pool's harvest
  going to the Safe. `bands` sends it to the bands contract instead, which never puts ETH into liquidity: `forwardEth()` passes it on to
  the Safe.
  A hex bands address is treated exactly like `bands`. Off chain 1, an unset `TAX_TREASURY` means the bands contract
  when it is deployed, else `TREASURY`; an unset `HARVEST_TREASURY` means `TREASURY`.
- Output: `contracts/deployments/mainnet.json`. Commit it: every service and the web app read it.
- Economics are constructor arguments and **immutable**: tax rate, split, minimum burn, stake minimums and badge tier
  thresholds (edit `_tiers` in `Deploy.s.sol` to change them). Changing them later means a redeploy and migration.

**Check after deploy**

```sh
cast call <entrypoint> "hasRole(bytes32,address)(bool)" $(cast keccak OWNER_ROLE) <safe>       # true
cast call <entrypoint> "hasRole(bytes32,address)(bool)" $(cast keccak OWNER_ROLE) <deployer>   # false
cast call <entrypoint> "hasRole(bytes32,address)(bool)" $(cast keccak ASP_POSTMAN) <postman>   # true
cast call <pay> "TREASURY()(address)"                                                          # <bands>
cast call <bands> "SAFE()(address)"                                                            # the Safe
cast call <pool> "TREASURY()(address)"                                                         # the Safe (or <bands>)
cast call <safe> "getThreshold()(uint256)"; cast call <safe> "getOwners()(address[])"          # 1 of 1 (SAFE_MIN_*), both Safes (the script checks it too)
```

## 4. ZC holder rewards (read before launch)

ZC pays ETH holder rewards to every address that holds it. The pool, merchant stakes, courier bonds and poll escrows
are holders too, and none of them can call `ZC.claim()`, so their share accrues where nobody can take it. The
fork test `test_fork_holderRewardsAccrueToThePool` measures it: the stranded share is simply the pool's ZC divided by
ZC's `eligibleSupply()`.

Options, one of which is a **DECISION**:

1. **Ask for exclusion.** If the token's reward exclusion (`rewardExcluded`) can be set for the zipnet contracts, the
   rewards go to other holders instead of being stranded. The token has no public setter in its ABI, so this depends
   on the token's operator.
2. **Accept it.** The stranded ETH is lost to everyone; users zipping ZC give up their rewards while zipped. Say so in
   the wallet.
3. **Claim and pass through.** A new pool implementation (or a wrapper token) that can call `claim()` and forward the
   ETH, e.g. to the courier reward pool. This is a contract change and needs an audit.

Transfers themselves are exact: the fork test checks deposits, relays and tax splits to the wei.

## 4b. Treasury liquidity bands (ZipLiquidityBands)

The treasury's share of the sales tax is ZC. Instead of sitting in the Safe it becomes one-sided liquidity in ZC's
Uniswap v4 pool, in three fixed ZC bands that all lie **above** the locked launch position (ticks 127,600 to 196,600,
FDV about 2.9 to 2,875 ETH), beyond its sell-out point, so it never takes a share of the fees that pay ZC holders.

**Owner decision (2026-09-29): above the launch range only.** The bands supplement liquidity only above the range the
launch position covers; nothing is ever added at or below it. The earlier ETH-only bands below the launch range (D1,
D2) were removed, and ETH is never put into liquidity.

| Band | Asset | Ticks | FDV (ETH) | Launch weight |
|---|---|---|---|---|
| U1 | ZC | 115,200 to 127,600 | about 2,875 to 9,935 | 100% (70% later) |
| U2 | ZC | 92,200 to 115,200 | about 9,935 to 99,000 | 0 (20% later) |
| U3 | ZC | -887,200 to 92,200 | above about 99,000 | 0 (10% later) |

- Anyone may call `deposit()` (couriers do, as the free `bands` job). It adds ZC only, and only to a band the price is
  entirely below, with the ETH maximum at 0; a band the price is in is skipped and its share goes to the next band
  out. No oracle is involved and there is nothing to sandwich. `collect(band)` sends fees to the Safe.
- ETH: the contract accepts ETH from anyone (ZC's holder rewards on the ZC waiting in it, and the pool's or escrows'
  harvests with `HARVEST_TREASURY=bands`) and never adds it to the pool. `forwardEth()` (anyone; couriers do) sends
  all of it to the Safe, and so does `claimRewards()`. Monitor `EthReceived` and `EthToSafe`.
- The Safe alone can change the caps (within the immutable `BANDS_MAX_DAY_ZC` ceiling, default 10M ZC a day), the
  weights, pause, and `setForwardAll(true)` (the escape hatch: from then on everything reaching the contract goes
  straight to the Safe). The exits (`withdraw`, `withdrawAll`, `release` of a position NFT, `sweep`) pay only the
  Safe. Nothing can send funds or NFTs anywhere else. `check()` asserts every band lies above the launch range.
- Launch caps: 1M ZC per call, 2M ZC per 24h, deposits at least 24h apart. Raise them after 4 to 8 weeks of watching
  `Deposited`, `Skipped` and `FeesCollected`.
- It is new custody code, so it is in the audit scope with the rest. `BandsFork.t.sol` runs it against the real pool.
- Public wording: the positions and their fees belong to the treasury; they are not a price floor or price support,
  and they do not pay holders. Never describe them as support, a floor, a backstop, yield or returns.

```sh
cast call <bands> "poolKey()((address,address,uint24,int24,address))"   # (0x0, ZC, 10000, 200, 0xCb69…C0c0)
cast call <bands> "depositable()(uint256,bool)"                             # ZC it would add now
cast call <bands> "bands(uint256)(uint256,uint128,uint128,uint128)" 0   # U1: NFT id, ZC in, fees (ETH, ZC)
cast balance <bands>                                                       # ETH waiting for forwardEth() to the Safe
```

## 5. Postman

```sh
cd apps/postman
RPC_URL=<rpc> DEPLOYMENT=../../contracts/deployments/mainnet.json POSTMAN_KEY=<postman key> \
EPOCH_SEC=3600 VET_DELAY_SEC=1800 \
SANCTIONS_ORACLE=0x40C57923924B5c5c5455c48D93317139ADDaC8fb \
MAX_DEPOSIT_WEI=1000000000000000000000000 MAX_DEPOSITOR_DAILY_WEI=3000000000000000000000000 \
STATE_FILE=/var/lib/zipnet/postman.json PORT=8710 node node_modules/tsx/dist/cli.mjs src/main.ts
```

- `EPOCH_SEC` **DECISION**: how often the ASP root changes. Longer epochs give couriers more room to hold proofs
  (better timing privacy) but make new deposits wait longer to become spendable. Code default 4 hours; launch: 1 hour.
- `VET_DELAY_SEC` **DECISION**: how long a public deposit waits before screening. Code default 1 hour; launch: 30 min.
- Deposit caps **DECISION**: `MAX_DEPOSIT_WEI` rejects any single deposit above it (the owner can ragequit);
  `MAX_DEPOSITOR_DAILY_WEI` holds a depositor's deposits once they pass that total in a rolling 24h and approves them
  as the window rolls. Both are off when unset. A deposit made by zipnet's own contracts (rezips, merchant revenue,
  badge unlocks) skips the delay, screening and caps only when its ZC provably came out of an already-approved note:
  the pool paid that contract out of a spent note in the same transaction (for a badge unlock, in the lock's), and no
  other ZC reached the contract there (`apps/postman/src/trust.ts`). The same contracts also take ZC from wallets
  (`zipTo`, `pay` to a payee precommitment, `lock`, `stake`); those deposits are vetted like any public deposit, with
  the screening and the caps applied to the wallet that sent the funding transaction. `/health` shows how many deposits
  the caps are holding. The daily window counts approval times, so queued deposits can't burst through when it rolls.
  Caps are per address: anyone can split across fresh addresses, so they slow a bad day down rather than bound it.
  Over-cap rejections are kept in memory only; raising `MAX_DEPOSIT_WEI` and restarting the postman re-admits them.
- `DENYLIST_FILE`: optional newline-separated addresses to reject.
- Back up `STATE_FILE`: it is the ordered list of approved labels. The published roots are a prefix chain of it; a
  lost file can be rebuilt from `RootUpdated` events plus deposits, but that is slow. Writes are atomic (temp file,
  fsync, rename) and keep the previous save as `STATE_FILE.bak`. A corrupt or partial file is kept aside as
  `STATE_FILE.corrupt-<time>` and the backup is loaded (approvals made since that save are decided again); with no
  good backup the postman refuses to start rather than begin again with no approvals. Restore the file to continue.
- An epoch counts as done only once `updateRoot` is mined successfully (or the chain already holds the root). A failed,
  reverted or unmined update (`CONFIRM_TIMEOUT_SEC`, 300) is retried on the next tick (`TICK_MS`, 15 s).
- `/health` is truthful: it answers **503** unless the RPC answers a live call, the on-chain root was confirmed within
  the last 2 epochs (every epoch the postman publishes or confirms its root, so older means publishing is failing), and
  the last tick succeeded. The body lists `problems`, `rootAgeSec`, `lastTickOkAt` and `lastError`. Point a
  monitor at it.
- `SEND_RPC_URL` (optional): where `updateRoot` is broadcast; reads stay on `RPC_URL`. Unset, it goes to the public
  mempool through `RPC_URL`, which is fine: only the `POSTMAN` role may call `updateRoot` and the root is public
  anyway, so there is nothing to front-run. A retry after a dropped update reuses the same nonce (the read node's
  count), so it can't double-publish.

## 6. Couriers

```sh
cd apps/courier
RPC_URL=<own node> SEND_RPC_URL=<private relay> DEPLOYMENT=../../contracts/deployments/mainnet.json COURIER_KEY=<courier key> \
POSTMAN_URL=https://postman.<domain> PUBLIC_URL=https://courier1.<domain> \
BOND_WEI=1000000000000000000000 MIN_FEE_WEI=<floor> FEE_MARGIN_BPS=2000 \
EPOCH_MARGIN_SEC=120 COVER_PER_HOUR=<n> COVER_DAILY_GAS_WEI=<budget> COVER_MNEMONIC=<cover wallet phrase> \
FREE_RELAYS_PER_DAY=500 DATA_DIR=/var/lib/zipnet/courier PORT=8720 \
node node_modules/tsx/dist/cli.mjs src/main.ts
```

- The courier bonds on first start if `BOND_WEI` is set and it holds the ZC.
- **Receipt key.** Held relay, batch and rezip jobs come with a signed delivery receipt (it binds the exact call; a
  report after the deadline delivers that call and slashes only if it succeeds), which ZipCouriers checks with plain ECDSA only (an
  EIP-7702 delegation or a contract signer can't void it). They are signed by `RECEIPT_KEY`, or by `COURIER_KEY` when
  unset. A separate `RECEIPT_KEY` is registered on the first bond (`bondWithKey`); to change it later call
  `rotateSigningKey` from the courier address: the new key counts at once, the old one for two `UNBOND_DELAY`s more.
  The courier refuses held jobs while the contract doesn't accept its receipt key.
- **Held-job delivery.** A receipted job is sent at least `DELIVER_MARGIN_SEC` (300) before its deadline, plus
  `SEND_SLOT_SEC` (3) per receipted job waiting ahead of it; a new held job that can't meet that is refused. Due jobs
  go into the send queue together (receipts are awaited separately), and a failed send is retried with backoff unless
  it reverted, so an RPC error never turns a promised delivery into a missed one. A receipted job that can no longer
  be delivered logs `ALERT`.
- **The ASP epoch turn.** A held pool proof that arrives too late in its ASP epoch for a receipt (inside the last
  `EPOCH_MARGIN_SEC` plus the delivery margin) is sent at once, without a receipt, instead of being refused. Only in
  the last `ASP_TURN_GUARD_SEC` (12, about a block) before the turn, where even a transaction sent now may land on the
  new root, is it refused.
- **Job retention.** Jobs live in `DATA_DIR/jobs.json` plus an append log (`jobs.log`), compacted on start and after
  each prune. A finished job (sent or failed) stays in it
  and on `/jobs/:id` for `JOBS_RETENTION_DAYS` (7), and is pruned hourly after that.
- **Fees.** A job's fee is `gas × gasPrice × (1 + FEE_MARGIN_BPS/10 000)`, priced in ZC, and never below
  `MIN_FEE_WEI` (see `apps/courier/src/fees.ts`). `gas` is the job's measured gas, `gasPrice` the read node's.
  There is no ZC/ETH oracle, so the ZC price is the courier's own time-weighted view of ZC's Uniswap v4 pool: it reads
  the spot price through `ZipLiquidityBands.slot0()` (the PoolManager via `extsload`, as the bands job does) every
  `FEE_SAMPLE_SEC` (60) and prices at the **median** of its samples over `FEE_TWAP_SEC` (1800). One manipulated block
  can't move it; holding the pool off-market for over half the window is what it would take, and arbitrage makes that
  expensive. Until `FEE_MIN_SAMPLES` (5) samples exist it uses the highest ZC-per-ETH sampled, so a warm-up can only
  overcharge. Samples are kept in `DATA_DIR`, so restarts keep their history. `ZC_PER_ETH_WAD`, if set, overrides the
  pool with a fixed price (keep it current). Off a local chain the courier **refuses to start** without
  `MIN_FEE_WEI` and a price source (the bands contract, or `ZC_PER_ETH_WAD`). **DECISION**: `MIN_FEE_WEI`.
- Quotes are stable: `/quote` gives `feesValidUntil`, and until then the courier accepts any fee a quote in the last
  `QUOTE_VALID_SEC` (600) asked for, so a job isn't refused because gas moved while its proof was being made. A new
  quote snapshot is taken at most every `QUOTE_REFRESH_SEC` (60).
- Cover traffic spends real gas: `COVER_DAILY_GAS_WEI` bounds it. **DECISION**: how much to spend per day.
- Free relays (anonymous posts, poll votes, badge unlocks) are paid by the
  courier; `FREE_RELAYS_PER_DAY` bounds it. A job counts only after it simulates successfully, and the courier's own
  jobs (harvests, bands) never count. `FREE_RESERVED_SHARE` (0.2) of the day is kept for parked-payout recovery, no other kind may use more than `FREE_KIND_SHARE` (0.5) of it, and one client may make
  `FREE_PER_CLIENT_PER_HOUR` (60) free-job attempts an hour. Behind a tunnel or proxy set `TRUST_PROXY=1` so the client
  is the `X-Forwarded-For` address; without it a private or loopback peer (the proxy) is not limited per client.
- **Private mempool: `SEND_RPC_URL`.** Semaphore proofs and spend proofs are valid for whoever lands them first, so
  anyone watching the public mempool can copy a relayed transaction and front-run it (taking the courier's fee, or
  just burning the courier's gas on a revert). So a courier reads from `RPC_URL` (its own node: state, simulations,
  gas, receipts, nonces) and broadcasts signed transactions only to `SEND_RPC_URL`, a private relay. Unset, sends go
  to `RPC_URL`; on mainnet always set it. No provider is built in; options (September 2026):

  | Relay | Endpoint | Notes |
  |---|---|---|
  | Flashbots Protect | `https://rpc.flashbots.net/fast` (Sepolia: `https://rpc-sepolia.flashbots.net/`) | Reverting transactions aren't included and cost nothing. Tries the next 25 blocks by default (`?blockRange=N`), then drops the transaction (status `FAILED`). Status: `https://protect.flashbots.net/tx/<hash>`. Pending private transactions only show in `eth_getTransactionCount("pending")` for requests signed with `X-Flashbots-Signature`. [quick start](https://docs.flashbots.net/flashbots-protect/quick-start), [settings](https://docs.flashbots.net/flashbots-protect/settings-guide), [status API](https://docs.flashbots.net/flashbots-protect/additional-documentation/status-api), [nonces](https://docs.flashbots.net/flashbots-protect/nonce-management) |
  | MEV Blocker | `https://rpc.mevblocker.io/noreverts` (no revert costs) or `/fullprivacy` (nothing shared with searchers); also `/fast`, `/maxbackruns`, `/nochecks` | Transactions are simulated in a pending block (except `/nochecks`). How long it keeps trying isn't documented. [endpoints](https://docs.mevblocker.io/reference/api/transaction-endpoints) |

  Prefer an endpoint that doesn't include reverting transactions: a relayed proof someone else already spent then
  costs nothing. Because a private relay hides pending transactions from the read node, the courier keeps its own
  nonce book (`apps/courier/src/sender.ts`, saved as `DATA_DIR/sender.json`): the next nonce is the read node's
  latest count plus the nonces it has in flight; "already known" counts as sent; a nonce taken by something else is
  skipped, never replaced. A transaction that hasn't landed `RESEND_AFTER_SEC` (120) after its last send is
  re-simulated and resent at the same nonce with fees raised 25%; if it no longer simulates, its nonce is left alone
  until `ABANDON_AFTER_SEC` (600, longer than Flashbots' 25 blocks) has passed since the last send, and only then filled
  with a 0-value transfer to itself so later nonces can land. A nonce is never given to another job while something
  sent for it might still land. Don't send from the courier key by hand while the courier runs; if you must, it
  recovers (nonce too low: skip), but a job whose nonce you took is reported as not delivered.
- Where ZipLiquidityBands is deployed (step 4b), the courier runs its `bands` job every `BANDS_EVERY_MIN` (360): a
  `deposit()` (ZC only) only when `depositable()` says so and the ZC (at spot) is worth at least `BANDS_MIN_VALUE_MULT`
  (20) times the gas, a `collect` of each band's fees to the Safe once a month when they are worth the same multiple,
  `claimRewards()` whenever ZC's pending ETH for it beats the call's gas (it sends all the contract's ETH to the Safe),
  and otherwise `forwardEth()` when the ETH waiting in the contract is worth the same multiple of its gas. These are the courier's own jobs; clients
  cannot submit them.
- Jobs are marked `sending` on disk before their transaction is sent. On restart the courier waits for any whose
  transaction is still in its nonce book (it may yet land), checks the others' receipts, and re-simulates the rest
  before sending anything again. `/health` shows `txInFlight`.

## 7. Web app

```sh
cd apps/web
node scripts/copy-artifacts.mjs                 # verifies pinned Semaphore artifacts, copies them to public/
DEPLOYMENT=../../contracts/deployments/mainnet.json PUBLIC_RPC_URL=<browser rpc> \
PUBLIC_COURIER_URL=https://courier1.<domain> VERIDIA_URL=https://veridia.<domain> pnpm build && pnpm start
```

- Never set `DEV_FAUCET_KEY` in production.
- Proving artifacts are served from the app's own origin (`/artifacts/`). Nothing is fetched from a third party at
  proving time.
- `PUBLIC_RPC_URL` is visible to every visitor: use a key restricted to the domain, or a public endpoint. It is the
  only RPC `/api/config` ever hands the browser: there is no fallback to `RPC_URL` (the server's own node). Unset,
  `/api/config` answers 503 with a configuration error that the wallet shows, and the server logs it at start-up.

### Web security headers

`apps/web/src/middleware.ts` sets them on every page and API response (the policy is `src/lib/security-headers.ts`):

| Route | Content-Security-Policy `frame-ancestors` | X-Frame-Options |
|---|---|---|
| everything (wallet, `/`, `/claim`, `/api/*`, …) | `'none'` | `DENY` |

The rest of the CSP is the same on every route (plus the WalletConnect origins below, when configured):

```
default-src 'self'; script-src 'self' 'nonce-<per request>' 'strict-dynamic' 'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:;
connect-src 'self' <PUBLIC_RPC_URL> <PUBLIC_COURIER_URL/COURIER_URL> <POSTMAN_URL> https://api.zipcoin.org <COURIER_ORIGINS, or https:>;
worker-src 'self' blob:; frame-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none';
form-action 'self'; frame-ancestors …; upgrade-insecure-requests
```

- Scripts: a fresh nonce per request; Next reads it from the request and puts it on its own scripts, so the root
  layout renders every page per request. No inline script runs without it. `'wasm-unsafe-eval'` and `blob:` workers
  are for the in-browser prover (snarkjs builds its worker threads from a Blob). Development adds `'unsafe-eval'` and
  localhost connections, and drops HSTS and `upgrade-insecure-requests`.
- Styles allow `'unsafe-inline'`: React renders `style` attributes and `next/font` inlines its font rules. Styles
  can't run code.
- Couriers: their URLs come from the chain, so no fixed list can be complete. `COURIER_ORIGINS` (comma-separated
  origins) pins the list: strict, but a courier bonded later is blocked until it is added (the wallet then moves on to
  another courier, as for one that is down). Unset, `connect-src` allows any `https:` origin: every courier works,
  at the cost that injected script could send data to any https host. Script injection is what the nonce policy
  stops, so this is the default; set `COURIER_ORIGINS` for the strict version. `STATS_ORIGIN` overrides
  `https://api.zipcoin.org`. Emerald calls DeepSeek from the server, so DeepSeek isn't in `connect-src`.
- Also on every response: `Strict-Transport-Security: max-age=63072000; includeSubDomains`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a `Permissions-Policy` that turns off
  camera, microphone, geolocation, payment, USB/serial/HID/Bluetooth, sensors, screen capture and ad topics, and allows
  only `clipboard-write=(self)` (copying links).
- With a Reown project ID set (next section), every page except `/api/*` also gets
  `wss://relay.walletconnect.org` in `connect-src` and `https://verify.walletconnect.org` in `frame-src`. Without
  one, neither appears anywhere.

### Mobile wallets (WalletConnect via Reown)

The wallet's "Connect" picker lists every browser wallet that announces itself (EIP-6963; `window.ethereum` when none
do), remembers the last choice (its reverse-DNS id, never an address, in `localStorage`), and, when a Reown project ID
is set, offers **Mobile wallet (WalletConnect)**. Without a project ID that option is hidden and nothing of Reown's is
in the page or its CSP.

How it's built, so a first visit makes no third-party request:

- Package: `@walletconnect/universal-provider` (the EIP-1193 layer under both `@walletconnect/ethereum-provider` and
  AppKit, with no UI). `ethereum-provider` 2.x hard-depends on `@reown/appkit` for its QR modal, which pulls fonts,
  wallet images and the wallet list from Reown's servers. The SDK and the QR encoder (`uqr`, MIT, local) are a
  separate chunk served from our own origin, fetched only when a visitor picks the option (or when a visitor who used
  it before comes back and their session is restored).
- The QR code is drawn by the page from the pairing URI (an SVG path). On phones the picker shows "Open a wallet app"
  (`wc:`) and the MetaMask, Rainbow and Trust universal links instead, and signature requests switch to the wallet app.
- Telemetry off (`telemetryEnabled: false`), and no analytics, onramp, swaps, email or social login (those exist only
  in AppKit, which isn't used). The one chain proposed is the deployment's (mainnet, Sepolia or the local chain, from
  `/api/config`), with `PUBLIC_RPC_URL` as its RPC, so the SDK never uses Reown's RPC.
- Disconnect ends the session in the wallet too. Sessions persist in the browser (IndexedDB) and are restored on the
  next visit without a prompt; the zip key still needs "Unlock".
- The connect UI says: "WalletConnect routes the connection through Reown's relay. Your zip secrets and proofs never
  leave this device." The relay carries end-to-end encrypted messages between the page and the wallet, and sees both
  ends' IP addresses and the project ID.

Origins allowed when it is on (checked against `@walletconnect/core` 2.25):

| Origin | Directive | Why |
|---|---|---|
| `wss://relay.walletconnect.org` | `connect-src` | The relay (the SDK's only default relay URL): pairing, session and every request to the wallet |
| `https://verify.walletconnect.org` | `frame-src` | Verify: a hidden iframe registers each session proposal so the wallet can show the domain as verified (anti-phishing) |

Deliberately not allowed: `rpc.walletconnect.org` (we pass our own RPC), `pulse.walletconnect.org` (telemetry, off),
`echo.walletconnect.com` (push notifications, wallet side only), `relay.walletconnect.com` / `verify.walletconnect.com`
(older hosts the 2.x SDK doesn't use), and any Reown script, font or image origin. If `COURIER_ORIGINS` is unset,
`connect-src` already allows any `https:` origin (see above); telemetry is off in code either way.

The pages it's on: every page except `/api/*`. Not only
`/wallet`, because moving between pages is client-side: the policy of the page a visitor landed on stays in force.

Setting it up (owner):

1. Sign in at [dashboard.reown.com](https://dashboard.reown.com), create a project (type: an app, not a wallet), and
   copy its **Project ID**. It is public by design (it is in every relay URL), so it isn't a secret.
2. In the project's **Domain** settings (the allowlist), add exactly the origins that serve the wallet:
   `https://zipcoin.org`, `https://www.zipcoin.org`, `https://app.zipcoin.org` (and a staging origin if you use one).
   Format `[scheme://]hostname[:port]`; a wildcard can replace a whole label (`https://*.zipcoin.org`), but listing the
   hosts is stricter. Other origins are then refused by the relay; `localhost` is always allowed; an empty list allows
   every origin, so don't leave it empty. Changes take about 15 minutes.
3. Set `WALLETCONNECT_PROJECT_ID=<project id>` in the web app's environment (`env/web.env`) and restart it. It is read
   at request time: it turns on the CSP origins above and `/api/config` hands it to the wallet.
   `NEXT_PUBLIC_REOWN_PROJECT_ID` is accepted as an alias.
4. Check: open `/wallet` in a desktop browser, pick "Mobile wallet (WalletConnect)", scan with a phone wallet, approve,
   sign the unlock message, then Disconnect. The browser's network panel should show only our origin, the relay socket
   and the Verify frame.

License: since August 2025 the WalletConnect SDK is under the WalletConnect Community License (not MIT/Apache).
Development use is royalty-free; past Reown's published RPC or monthly-active-user thresholds a paid commercial license
is required (see the license in `node_modules/@walletconnect/universal-provider/LICENSE.md` and reown.com/terms-of-service).

### Emerald (the wallet assistant)

Emerald runs on DeepSeek's OpenAI-compatible API and is only for ZC holders; the server enforces it.

```sh
DEEPSEEK_API_KEY=<key> EMERALD_MODEL=deepseek-flash \
EMERALD_SESSION_SECRET=<32+ random characters> RPC_URL=<server rpc> \
EMERALD_MIN_TIER=1 EMERALD_MIN_HOLD_WEI=100000000000000000000000 \
EMERALD_DAILY_USD_CAP=10 EMERALD_BUDGET_FILE=/var/lib/zipnet/emerald-budget.json
```

| Variable | Meaning | Default |
|---|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek key. Without it Emerald answers 503. | none |
| `EMERALD_MODEL` | DeepSeek model id | `deepseek-flash` (the general chat model) |
| `DEEPSEEK_BASE_URL` | Only to point at a stand-in in tests | `https://api.deepseek.com` |
| `EMERALD_SESSION_SECRET` | HMAC key for sign-in sessions and wallet challenges. Unset: a random per-process key (sessions end on restart and don't work across instances). | random |
| `RPC_URL` | Server-side RPC for the gate's checks (badge proofs, balances). Never sent to browsers. | `PUBLIC_RPC_URL`, then local |
| `EMERALD_MIN_TIER` **DECISION** | Lowest badge tier (as numbered in the wallet) whose holders get in anonymously | 1 |
| `EMERALD_MIN_HOLD_WEI` **DECISION** | ZC a wallet must hold to sign in with a signature (this links the wallet) | 100,000 ZC |
| `EMERALD_EPOCH_SEC` | Badge proofs are scoped to this epoch; defaults to `EPOCH_SEC`; keep it equal to the postman's | 3600 |
| `EMERALD_DAILY_USD_CAP` **DECISION** | DeepSeek spend per UTC day. Each call reserves its worst case and settles at the real cost from the response's `usage` (cache hits at the cached rate). When the next call wouldn't fit, Emerald replies that it is resting until 00:00 UTC, before the gate. `none` turns the cap off. | 10 |
| `EMERALD_DAILY_TOKEN_CAP` | A cap in tokens instead of (or as well as) dollars | none |
| `EMERALD_USD_PER_M_INPUT`, `EMERALD_USD_PER_M_CACHED`, `EMERALD_USD_PER_M_OUTPUT` | USD per million tokens, if DeepSeek's prices change. Built in: its published peak rates ([pricing](https://api-docs.deepseek.com/quick_start/pricing), September 2026: deepseek-flash 0.3 / 0.006 / 1.2; deepseek-v4-pro 1.32 / 0.044 / 3.96); off-peak use is over-counted, never under. An unlisted model is priced as the dearest. | built in |
| `EMERALD_BUDGET_FILE` | Keeps the day's spend across restarts | memory only |
| `EMERALD_SESSION_PER_MIN`, `EMERALD_SESSION_PER_DAY` | Requests per session (a badge session or a wallet session), checked before the model is called. Per IP: 30 a minute. | 10, 200 |

## 8. Veridia (optional at launch)

```sh
cd apps/veridia
RPC_URL=<rpc> DEPLOYMENT=../../contracts/deployments/mainnet.json TREASURY_KEY=<veridia key> COURIER_URL=https://courier1.<domain> \
VERIDIA_SEED=<seed> VERIDIA_LLM=auto DEEPSEEK_API_KEY=<key> VERIDIA_MODEL=deepseek-flash \
ACTIONS_PER_HOUR=6 VERIDIA_DAILY_GAS_WEI=<wei> MAX_HOLD_SEC=<n> DATA_DIR=/var/lib/zipnet/veridia \
node node_modules/tsx/dist/cli.mjs src/main.ts
```

`ACTIONS_PER_HOUR` × the gas table (docs/GAS.md) × the gas price is the ETH it burns per hour; `VERIDIA_DAILY_GAS_WEI`
(default 0.02 ETH) caps a day, after which residents only post scripted lines that touch no chain. Minds run on DeepSeek
when `DEEPSEEK_API_KEY` is set (`VERIDIA_MODEL`, default `deepseek-flash`), scripted otherwise. **Decided**: small budget.
The residents' anonymous actions go through a courier (and so its private relay). Their own public transactions and the
treasury's funding are broadcast through `SEND_RPC_URL` when set (reads stay on `RPC_URL`); each waits for its receipt
before the next, so a private relay needs no extra nonce handling here.

## 8b. Stats API (api.zipcoin.org)

`apps/stats` serves the data behind [zipcoin.org/ledger](https://zipcoin.org/ledger/),
[/privacy-meter](https://zipcoin.org/privacy-meter/) and [/status](https://zipcoin.org/status/). It holds no key and
sends no transaction: it reads the chain, the deployment JSON and the public `/health` of the postman and the couriers,
recomputes everything every 60 seconds and serves it from memory.

| Endpoint | What it returns |
|---|---|
| `GET /v1/ledger` | Every allowlisted contract and wallet: role, controller, powers, live facts (Safe threshold and signer count, Entrypoint owner and postman, bands `SAFE`/`paused`, the tax split), ETH / ZC balances and ZC holder rewards pending; flows summed over 24h / 7d / all time: the sales-tax split (burn / couriers / treasury share), bands deposits and everything the bands paid the Safe, pool harvests |
| `GET /v1/privacy` | Deposits into the pool per window, the distinct outside depositors (project addresses left out), note sizes in five buckets, and the method in words. Counts only, never an address |
| `GET /v1/status` | The postman (reachable, approved count, last ASP root: time, epoch, age) and each bonded courier (bond, active or unbonding, reachable, version, minutes since its last job) |
| `GET /health` | `{ ok, updatedAt }` for an uptime check |

**The allowlist is the confidentiality switch.** Only entries with `"show": true` in
[`apps/stats/public-contracts.json`](../apps/stats/public-contracts.json) appear in any response, and the site draws the
same file's roles and controllers at build time. The default shows the pool, Entrypoint, ZC, ZipPay, ZipMerchants,
ZipCouriers, ZipBadges, ZipSignal, ZipPolls, ZipBroadcaster, ZipDoorstep, ZipRezip, ZipAddressRegistry,
ZipLiquidityBands and the treasury Safe. Everything else stays off, address included, until its launch: then set
`"show": true`, write its name, role, controller and powers, rebuild the site (`node site/build.mjs`) and restart the
service. The privacy meter still leaves every deployed contract's address out of its counts, whether shown or not,
and serves no count of them.

```sh
cd apps/stats
RPC_URL=<services' own node> DEPLOYMENT=../../contracts/deployments/mainnet.json PORT=8750 HOST=127.0.0.1 \
POSTMAN_URL=http://127.0.0.1:8710 EPOCH_SEC=3600 TRUST_PROXY=1 \
EXCLUDE_FILE=/etc/zipnet/stats-exclude.txt PROJECT_FUNDERS=<Veridia treasury address> \
node node_modules/tsx/dist/cli.mjs src/main.ts
```

| Variable | Meaning | Default |
|---|---|---|
| `RPC_URL`, `DEPLOYMENT` | Chain and deployment JSON (read-only) | required |
| `PORT`, `HOST` | Where it listens; keep it on loopback behind the TLS proxy | `8750`, `127.0.0.1` |
| `ALLOWLIST` | The allowlist file | `apps/stats/public-contracts.json` |
| `POSTMAN_URL` | The postman, for `/v1/status`; may be a loopback or private address | unset: shown as not configured |
| `EPOCH_SEC` | Epoch length if the postman doesn't answer | `14400` |
| `SAFE_ADDRESS` | The treasury Safe, if it shouldn't be read from `bands.SAFE()` / `pay.TREASURY()` | read on-chain |
| `EXCLUDE_FILE`, `EXCLUDE_ADDRESSES` | The project's own wallets the chain can't tell apart: Veridia's residents and treasury, couriers' cover wallets (the courier addresses themselves are left out automatically). Private: never served | none |
| `PROJECT_FUNDERS` | Wallets whose ZC recipients count as the project's (Veridia's treasury funds its residents) | none |
| `CORS_ORIGINS` | Pages allowed to read it | `https://zipcoin.org,https://www.zipcoin.org` |
| `DEV_ORIGINS` | Also allow `http://localhost:*` (local only) | off |
| `RATE_LIMIT_PER_MIN` | Requests per IP per minute, counted in memory for one minute; never logged | `60` |
| `TRUST_PROXY` | Take the client address from the proxy's last `X-Forwarded-For` hop | off |
| `REFRESH_MS`, `PROBE_TIMEOUT_MS` | Refresh period; timeout per `/health` probe | `60000`, `4000` |
| `CONFIRMATIONS`, `LOG_CHUNK` | Blocks to stay behind the head; `eth_getLogs` range per call | `2`, `5000` |
| `ALLOW_PRIVATE_ENDPOINTS` | Probe http and private-network courier URLs (local only). Off in production: courier URLs are anyone's, so only public https endpoints are probed, checked again at connect time | off |

Hosting it on the VPS: the one-box stack runs it as the `stats` container behind the tunnel (see
[One-box deployment](#one-box-deployment)). By hand: Node 22 and `pnpm install --frozen-lockfile` in a checkout; a process manager (systemd unit or
tmux, like the other services) running the command above as an unprivileged user; a TLS reverse proxy (Caddy or nginx)
for `api.zipcoin.org` → `127.0.0.1:8750` that appends `X-Forwarded-For` and keeps no access log (or one without client
addresses); a DNS record for `api.zipcoin.org`. It needs about 100 MB of memory. The first start reads every event since
`deployBlock`; later refreshes read only new blocks. The site's CSP already allows `connect-src https://api.zipcoin.org`;
until the API answers, the pages say "Goes live at launch" and show the allowlisted roles and controllers.

## One-box deployment

Everything off-chain on one Ubuntu 24.04 VPS (4-8 GB), reachable only through a Cloudflare Tunnel with no inbound
port open. The runbook is [`deploy/README.md`](../deploy/README.md); the pieces:

| Piece | File |
|---|---|
| Server hardening: key-only SSH (`UsePAM yes`), ufw deny-all inbound, Tailscale or console admin, fail2ban, unattended upgrades, Docker, time sync, swap | [`deploy/bootstrap.sh`](../deploy/bootstrap.sh) |
| Services: postman, courier1..N, Veridia, stats (`api.`), web app + Emerald (`app.`), the archive, cloudflared, and a small edge proxy for the web app's headers | [`deploy/compose/docker-compose.yml`](../deploy/compose/docker-compose.yml) |
| Images: multi-stage pnpm workspace builds, non-root, read-only root filesystem, Semaphore artifacts fetched at build time against the pinned hashes | [`docker/`](../docker) |
| Settings and secrets: per-service env files and one Docker secret file per key (mode 600), never in an image | [`deploy/compose/env/`](../deploy/compose/env) |
| Hostnames, DNS, Cloudflare Access, framing and CSP | [`deploy/cloudflared/config.yml.example`](../deploy/cloudflared/config.yml.example), [`deploy/cloudflared/ROUTES.md`](../deploy/cloudflared/ROUTES.md) |
| Encrypted (age) backups with rotation; restore | [`deploy/backup.sh`](../deploy/backup.sh), [`deploy/RESTORE.md`](../deploy/RESTORE.md) |
| Uptime check with webhook alerts, cron table | [`deploy/ops/healthcheck.sh`](../deploy/ops/healthcheck.sh), [`deploy/ops/crontab.example`](../deploy/ops/crontab.example) |
| Upgrade and rollback by git-SHA image tag | [`deploy/ops/release.sh`](../deploy/ops/release.sh) |
| Mainnet contracts in one command (fork rehearsal, owners, dry run, broadcast) | [`scripts/deploy-mainnet.sh`](../scripts/deploy-mainnet.sh) |
| Sepolia rehearsal (simulation by default; broadcast only with `--broadcast`; `--owners` creates its Safes and timelock) | [`scripts/deploy-sepolia.sh`](../scripts/deploy-sepolia.sh), [`deploy/sepolia.env.example`](../deploy/sepolia.env.example) |

Differences from running each service by hand as in steps 5-8b:

- Paths are fixed inside the containers: `DEPLOYMENT=/deployments/<DEPLOYMENT_FILE>`, state under `/var/lib/zipnet`
  (bind-mounted from `/srv/zipnet/data/<service>`), optional files under `/etc/zipnet` (from `/srv/zipnet/config`).
- Services reach each other on the compose network (`http://postman:8710`, `http://courier1:8720`, ...). Public URLs
  (`PUBLIC_URL`, `PUBLIC_COURIER_URL`) are derived from `ZIPNET_DOMAIN`.
- The stats API listens on the container network with `TRUST_PROXY=1`: cloudflared appends the visitor's address as
  the last `X-Forwarded-For` hop.
- The dev pages are blocked at the edge.
- Check the files statically with `pnpm run deploy:check` (shellcheck, `docker compose config`, Caddyfile and tunnel
  ingress validation).

## 9. After launch

- Watch the postman's `/health` (`approved`, `rejected`, `heldByCaps`) and each courier's `/health`
  (`pendingRewards`, job counts).
- Confirm the first ASP root lands at the first epoch boundary and a small real zip → unzip round-trip works through
  the web app before announcing.
- Raise or lift the caps (restart the postman with new values) as confidence grows.

## Decisions to make before launch

Most are decided. **Decided** rows are what the launch will use; the repo defaults stay local-friendly until the deploy env sets them.

| # | Decision | Status | Where it is set |
|---|---|---|---|
| 1 | **Owner Safe** for the Entrypoint | **Decided:** a 1-of-1 Safe on the owner's key (was 2-of-3), acting through a 48h OpenZeppelin TimelockController (R2-M3) | `OWNER` (the timelock) and `OWNER_SAFE` at deploy |
| 2 | **Postman key** and who runs the postman | **Decided:** the owner, on their VPS (hot key, roots only, rotatable by `OWNER`) | `POSTMAN`, `POSTMAN_KEY` |
| 3 | **Treasury** for the tax share (immutable) | **Decided:** a plain 1-of-1 treasury Safe (was 2-of-3). The tax share itself now goes to ZipLiquidityBands (row 18), whose every output pays that Safe | `TREASURY`, `TAX_TREASURY` at deploy |
| 4 | **Tax rate and split** (immutable) | **Decided:** 1%; 50% burn / 30% couriers / 20% treasury | `TAX_BPS`, `BURN_SHARE_BPS`, `COURIER_SHARE_BPS` |
| 5 | **Minimum burn, merchant stake, courier stake, badge tiers** (immutable) | open; defaults 100 / 1,000 / 1,000 ZC; tiers 3k / 30k / 365k / 3.65M ZC-days | deploy env and `Deploy.s.sol` |
| 6 | **Epoch length** and vetting delay | **Decided:** 1 h and 30 min | `EPOCH_SEC=3600`, `VET_DELAY_SEC=1800` |
| 7 | **Launch deposit caps** | **Decided:** 1M ZC per deposit, 3M ZC per depositor per day | `MAX_DEPOSIT_WEI`, `MAX_DEPOSITOR_DAILY_WEI` |
| 8 | **ZC holder rewards** on ZC our contracts hold | **Decided:** harvest. The pool gets a minimal `harvest()` to `TREASURY` (a change to 0xbow code, reviewed separately); stakes, bonds and badge locks harvest to their stakers | pool deploy, see step 4 |
| 9 | **RPC** | **Decided:** the owner's own node for the services; a rate-limited public proxy for the web app | `RPC_URL`, `PUBLIC_RPC_URL` |
| 10 | **Domain** | open | DNS + `PUBLIC_URL`s |
| 11 | **Couriers** | **Decided:** open to anyone who stakes, from day one; operators submit through a private relay (`SEND_RPC_URL`) | courier env |
| 12 | **Veridia** | **Decided:** a small action budget with a daily gas cap; minds on DeepSeek | Veridia env |
| 13 | **Semaphore** | **Decided:** the canonical mainnet deployment | `SEMAPHORE_ADDRESS=0x8A1fd199516489B0Fb7153EB5f075cDAC83c693D` |
| 14 | **Audit** | **Decided:** audit before any mainnet deployment | — |
| 15 | **Emerald** | **Decided:** DeepSeek; gated by a tier-1+ badge proof or 100k ZC in a signed wallet | `DEEPSEEK_API_KEY`, `EMERALD_*` |
| 16 | Emerald badge tier for anonymous access | **Decided:** tier 1 and up | `EMERALD_MIN_TIER` |
| 17 | Emerald wallet minimum for signed (linked) access | **Decided:** 100,000 ZC | `EMERALD_MIN_HOLD_WEI` |
| 18 | **Treasury liquidity bands** (ZipLiquidityBands, step 4b) | **Decided (owner):** build it. ZipPay's tax share goes to it (immutable); three fixed one-sided ZC bands above the launch range only (owner decision 2026-09-29: nothing below it; the ETH bands were removed and all ETH it receives goes to the Safe); permissionless deposits by couriers; every output pays the Safe. Open: whether the pool's harvest goes to it too (default no; it would only pass through to the Safe), when to widen the caps and weights | `BANDS_POSITION_MANAGER`, `BANDS_HOOK`, `TAX_TREASURY`, `HARVEST_TREASURY`, `BANDS_*` |
| 19 | **Public ledger allowlist** (stats API and site, step 8b) | **Decided:** the pool, Entrypoint, ZC, ZipPay, ZipMerchants, ZipCouriers, ZipBadges, ZipSignal, ZipPolls, ZipBroadcaster, ZipDoorstep, ZipRezip, ZipAddressRegistry, ZipLiquidityBands and the treasury Safe. Every other feature stays off until the owner flips it at its launch | `apps/stats/public-contracts.json` |
