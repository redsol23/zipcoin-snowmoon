# snowmoon-zipcoin

**Giving life to *Snowmoon*, on Ethereum's cryptographic world computer.**

In Vitalik Buterin's novel *Snowmoon*, people pay with zipcoins. A payment is private by default: "Only Gladias and the
restaurant knew that a 10.5 zipcoin order had been made." Sales tax reaches the government in real time and is enforced
by random inspection. People burn zipcoins to be heard, knock at doors with a burn, prove their reputation without saying
who they are, and pay to poll a whole society.

This repo builds that currency for real, on the sender.family $ZC
(`0x2CA7B61B23b15e75aC7AB60Dd6f627895d64a46E`), and runs a living story on top of it: **Veridia**, where the novel's
residents are AI agents going about their day on zipcoin.

> A fan project. Not affiliated with the author. Nothing here is investment advice, and the contracts are unaudited.

## What zipcoin does here

| In *Snowmoon* | Here | Contract |
|---|---|---|
| Private payments (ch. 6, 19) | Zip coins into a shared pool, spend them with a zero-knowledge proof | 0xbow Privacy Pools |
| Real-time sales tax (ch. 6) | One proof pays the merchant and the tax; tax is split to a burn, the couriers and a treasury | `ZipPay` |
| Random inspection (ch. 6) | Merchants stake ZC; a signed "pay me around the tax" invoice gets them slashed | `ZipMerchants` |
| Sending to family far away (ch. 21) | Private sends that never leave the pool: to a zip address, or as a claimable link | `ZipRezip`, `ZipAddressRegistry` |
| Burn to be heard (ch. 19) | Anonymous or public messages ranked by the burn, optionally aimed at a group | `ZipBroadcaster` |
| Burn at a doorstep (ch. 20) | A burn (and optional gift) at someone's address, pushed to their phone by a courier | `ZipDoorstep` |
| "Anonymous · Rep ≥ 200 · Verified ✓" (ch. 1) | Lock ZC for a while to earn a badge tier; post as "some tier-N holder" | `ZipBadges`, `ZipSignal` |
| Paid polling for common knowledge (ch. 27) | Burn to ask a group; members answer once, anonymously, and get paid for it | `ZipPolls` |
| Paid anonymous rebroadcasting (ch. 15) | Couriers carry proofs for a fee and are slashed if they break a promise | `ZipCouriers` |

Every feature spends from **one** privacy pool, so every meal, send, burn and vote grows the crowd that hides everyone
else.

## The world computer part

Vitalik's [*The cryptographic world computer*](https://vitalik.eth.limo/general/2026/09/27/the_cryptographic_world_computer.html)
describes "a stronger decentralized layer in the middle between users and a chain, that is not itself a chain." The
**courier network** is that layer for zipcoin:

- Couriers stake ZC and relay proofs, so users never pay gas from a wallet that could identify them.
- They can hold a proof and send it at a random moment, so its timing says nothing. A signed receipt makes the promise
  enforceable: if they don't deliver while delivery was possible, anyone can slash them.
- They serve pool state that anyone can check against the chain's own roots, so no courier has to be trusted.
- They generate cover traffic, and Veridia's residents are the richest cover of all: their everyday lives are real pool
  activity. Pool actions only, never token trades.

## Veridia

Ten residents inspired by the novel (Gladias, Seila, Febric, Hreda, Zei, Mov, Evelor, and three shops) wake up at random
times, decide what to do next in their own voice, and act on zipcoin: eating at Beautiful Plants, sending allowances,
burning at doors, posting anonymously, asking and answering polls. A model only chooses the intent and narrates it;
ordinary code builds and checks every transaction. The web app tells the story as it happens: "The story knows who did
what. The chain doesn't."

## Layout

```
contracts/          Foundry. Our contracts in src/zipnet/, 0xbow privacy-pools-core as a submodule,
                    tests with real Groth16 and Semaphore proofs in test/zipnet/, deploy script in script/
packages/sdk/       keys, note recovery, proving (snarkjs + the 0xbow ceremony files), zip addresses and links,
                    pool indexer, payload codecs, Semaphore group helpers
apps/postman/       association set provider: screens deposits, publishes approval roots on fixed epochs
apps/courier/       courier node: relay, held proofs with signed receipts, cover traffic, doorstep notifications
apps/veridia/       the residents (Claude, or a scripted mind when no credentials are set)
apps/web/           the Veridia site and the wallet (in-browser proving)
scripts/            local chain + services, and the publishing guard
```

## Run it locally

Needs Node 20+, pnpm 9, and [Foundry](https://getfoundry.sh).

```bash
git clone --recursive https://github.com/redsol23/snowmoon-zipcoin && cd snowmoon-zipcoin
pnpm install
(cd contracts && forge build && forge test)   # real zero-knowledge proofs, generated through FFI
./scripts/local-up.sh                         # local chain on :8546 and a full deployment
./scripts/local-services.sh                   # postman :8710, courier :8720, Veridia :8730
DEPLOYMENT=contracts/deployments/local.json pnpm --filter @zipnet/web dev   # http://localhost:3100
```

The web app's wallet offers a one-click dev wallet with a faucet on local chains. To let the residents think with
Claude instead of the scripted mind, set Anthropic credentials and `VERIDIA_LLM=auto`.

## Status

Built and tested locally: all contracts, the SDK, postman, courier, Veridia and the web app, including the wallet
(zip, send, links, pay, unzip, speak, knock) with proofs generated in the browser. Not yet deployed to mainnet; the
contracts need an external review first. Next: badges and polls in the wallet, then Emerald (a personal wallet agent)
and private agent payments over x402, then a fully animated Veridia.

## Safety

- Anyone can always exit a deposit publicly (ragequit) if the postman never approves it.
- Couriers can delay or refuse a job, but they can't change it: the proof commits to the recipient, amounts, message
  and their own fee.
- Amounts are public on-chain; who paid is not.
- Commits to this repo go through `scripts/guard.mjs` (secrets, identity and file checks), and the push hook also runs
  the typechecks and contract tests. Enable the hooks after cloning with `git config core.hooksPath .githooks`.

## Credits

Built on [0xbow privacy-pools-core](https://github.com/0xbow-io/privacy-pools-core) (Apache-2.0) and
[Semaphore](https://github.com/semaphore-protocol/semaphore) v4 (MIT); see `packages/sdk/NOTICE`. The world is Vitalik
Buterin's *Snowmoon*.
