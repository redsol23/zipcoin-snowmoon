# Security

## The privacy pool

ZC deposits live in `ZipPrivacyPool` (`contracts/src/zipnet/ZipPrivacyPool.sol`). It is the 0xbow Privacy Pools
ERC-20 pool, `PrivacyPoolComplex` from `contracts/lib/privacy-pools-core` (pinned at `d494b63`; the audit reports are in
`contracts/lib/privacy-pools-core/audit/`). The upstream code runs unchanged behind the upstream `Entrypoint`, with the
upstream circuits and verifiers.

### What we changed

ZC pays its holders ETH rewards. The pool holds everyone's ZC, so the token pays the pool as a holder. That ETH belongs
to no depositor. The subclass adds three things to collect it, and nothing else:

1. an immutable `TREASURY`, set in the constructor (it can't be zero);
2. `receive()`, which accepts ETH only from the pool's `ASSET` (the ZC token, when its `claim()` pays out);
3. `harvest()`, which anyone may call. It calls `ASSET.claim()` and forwards the pool's whole ETH balance to `TREASURY`.

It overrides no upstream function and adds no storage (`TREASURY` is immutable). Neither addition reads or writes pool
state, and `claim()` pays ETH without moving ZC.

### Behaviour worth knowing (each point is covered by a test)

- When there is nothing to claim, `harvest()` reverts with ZC's `NothingToClaim()`. It also reverts if ETH was forced in
  (SELFDESTRUCT, block rewards) and nothing is pending. That ETH goes out with the next successful harvest.
- If `TREASURY` refuses ETH (reverts, runs out of gas, or re-enters and reverts), the whole harvest reverts and the
  rewards stay claimable at the token. Deposits, withdrawals and ragequits are unaffected. `TREASURY` is immutable, so a
  treasury that can never accept ETH would strand the ETH rewards forever. It could never strand the ZC notes. Use a
  Safe: the fork test harvests into a real Safe v1.4.1.
- A re-entrant `TREASURY` gains nothing. A nested harvest finds nothing to claim, or it claims rewards that arrived
  meanwhile and pays them to `TREASURY` too. Nothing is counted twice, and the pool ends with no ETH.
- Real ZC doesn't pay swap fees to holders in the swap itself. The fees accrue to ZC's locked launch position. The
  launch locker's permissionless `collect()` then passes the holders' share to `ZC.notifyReward`. The fork test runs
  that whole path: a real 5 ETH round trip, then `collect()`, `harvest()` and the Safe.
- The pool must not be excluded from ZC rewards, or there is nothing to harvest. The fork test checks this against the
  live token.
- Real ZC's transfer hooks take nothing. Every deposit, relay, withdrawal and ragequit moves the exact amount on the
  fork. ZC's launch guard capped every holder except the market at 5% of the supply. It applied only for the first 3
  blocks and has ended. While it was active, the pool (one address holding everyone's deposits) could not have gone
  above that. The fork test puts 5% of the supply in the pool and takes it all out again.

## The test suite (`contracts/test/zipnet/pool/`)

| File | What it proves |
| --- | --- |
| `PoolDifferential.t.sol` | **Differential.** Upstream `PrivacyPoolComplex` and `ZipPrivacyPool` are deployed at the same address (snapshot, run, revert, redeploy), so they share SCOPE, labels and contexts. Each runs the same fuzzed 24-step sequences: deposits (including below-minimum and reused-precommitment ones), relayed and direct withdrawals, ragequits (some by strangers), ASP updates that drop labels, replays, front-runs, stale proofs, reward accrual, ZC donations, direct ETH and wind-down. After every step, both pools must agree on success, return and revert data, every event, the root and its 64-root history, nonce, raw slots 0-9, every label's depositor, every nullifier and all balances. The only allowed difference is `harvest()` (the zip pool's events and TREASURY's ETH). The fixed sequence pins every step's outcome, and a pool with one changed storage write fails the harness. |
| `PoolRealProofs.t.sol` | The same differential with **real Groth16 proofs** (the 0xbow circuits via the FFI prover) and the production verifiers. A proof made against upstream verifies on `ZipPrivacyPool`. It also checks that the fuzzing model's predicted public signals equal the ones the circuits output. |
| `PoolInvariant.t.sol` + `PoolHandler.sol` | **Invariants** under a mixed campaign. Honest actors deposit, relay, withdraw, ragequit, donate ZC and send ETH. Anyone harvests, ZC accrues rewards, ETH is forced in, and the ASP narrows. `TREASURY` switches between accepting, reverting, burning gas and three re-entrant modes. Attackers front-run, replay, forge proofs, steal ragequit proofs and call restricted functions. The invariants are listed below. |
| `PoolHarvest.t.sol` | `harvest()`/`receive()` against every kind of TREASURY, with a full user round trip after each one to show that nothing is bricked. |
| `PoolStorageLayout.t.sol` | **Storage layout snapshot.** The expected slots (0-9) are hard-coded and checked with `vm.load` on both pools after real state changes, including the mapping bases and the LeanIMT struct. A second test compares `forge inspect ... storageLayout` for both contracts over FFI. Any storage shift fails CI. |
| `PoolFork.t.sol` | **Mainnet fork** with the real ZC token, the 0xbow production verifiers and Entrypoint implementation, and a real Safe as TREASURY. It runs real swaps through ZC's v4 pool, real proofs and exact balances, and measures gas against a MockZC twin. It is skipped without `ETHEREUM_MAINNET_RPC`. |
| `PoolModel.sol` | Shared pieces: `ModelVerifier`, the honest prover, `TreasuryActor`. The asset is `MockZC` from `ZipnetBase.sol`, which settles rewards on every transfer and pays by `call` from `claim()`, and reverts `NothingToClaim()` when there is nothing to pay. |

**Invariants** (checked after every call, in `invariant_pool`):

1. The pool's ZC balance is at least the value of all unspent notes. It equals that value plus direct donations.
2. The pool keeps no ETH. The only ETH it can hold is ETH forced in since the last successful harvest, and a harvest
   empties it. It never accepts ETH from anyone but ZC.
3. `TREASURY` has received exactly the ETH that left ZC as the pool's claims, plus any forced ETH that a harvest swept.
4. `harvest()` never changes pool state: root, root history, nonce, dead, raw slots, depositors, nullifiers, ZC balance.
5. Only note owners move note value. No attack ever succeeds, and attackers never hold ZC.
6. Every unspent note can be ragequit by its owner, whatever harvests or TREASURY did. After all ragequits the pool holds
   exactly the donations. At the end of each run, every approved note can also be fully withdrawn.

**Model assumption.** Fuzzing can't generate real Groth16 proofs, so `ModelVerifier` stands in for circuit soundness.
A proof verifies only if the note's owner attested its exact public signals. Everything the contracts check runs for
real: processooor, context, state and ASP roots, depths, nullifiers, the depositor and commitment membership.
`PoolRealProofs.t.sol` ties the model to the real circuits.

## Running it

From `contracts/`:

```sh
# default: moderate depth (differential 128 fuzz runs; invariant 64 runs x 50 calls), about a minute
forge test --match-path 'test/zipnet/pool/*' --threads 2

# deeper: differential 2000 runs; invariant 1000 runs x 200 calls (the pooldeep profile in foundry.toml)
FOUNDRY_PROFILE=pooldeep forge test --match-path 'test/zipnet/pool/Pool[DI]*' --threads 2

# mainnet fork (real ZC, real Safe, real swaps, gas); any full node, the public ones work
ETHEREUM_MAINNET_RPC=https://eth-mainnet.public.blastapi.io forge test --match-path test/zipnet/pool/PoolFork.t.sol --threads 1 -vv
```

The inline `forge-config` comments on the tests override `foundry.toml`, so change depth through the `pooldeep`
profile, or by editing those numbers. `FOUNDRY_INVARIANT_RUNS` is ignored. `PoolRealProofs.t.sol` and
`PoolFork.t.sol` need node and the `packages/sdk` dependencies for the FFI prover.
