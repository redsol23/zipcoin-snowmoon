import { parseEther, type Hex } from "viem";

import {
  context,
  depositSecrets,
  encodeRelay,
  encodeSend,
  entrypointAbi,
  hashPrecommitment,
  masterKeys,
  proveLeaf,
  proveSpend,
  randomSecrets,
  recoverNotes,
  sealSecrets,
  withdrawalSecrets,
  zipAddressKeys,
  type Note,
} from "@zipnet/sdk";

import { cfg, pub, wallet } from "./config";
import { accept, GAS } from "./jobs";
import { asp, refresh, state } from "./state";

/**
 * Cover traffic: this courier keeps some ZC zipped and moves it around at random (Poisson) times, so the pool
 * always has background activity and a real user's deposit→withdraw timing stops standing out.
 *
 * Only pool actions: rezip to itself, or unzip part to its own wallet and zip it back later. Never token swaps,
 * never anything that looks like market volume. Capped by a daily gas budget. Publicly disclosed as a feature.
 * (Veridia's character agents are the richer version of this: the same traffic, living a story.)
 */

const erc20 = [{ type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" }] as const;
const spent = { day: 0, wei: 0n };

function budgetLeft(kind: keyof typeof GAS, gasPrice: bigint) {
  const day = Math.floor(Date.now() / 86_400_000);
  if (spent.day !== day) Object.assign(spent, { day, wei: 0n });
  const cost = GAS[kind] * gasPrice;
  if (spent.wei + cost > cfg.coverDailyGasWei) return false;
  spent.wei += cost;
  return true;
}

async function prove(k: ReturnType<typeof masterKeys>, n: Note, amount: bigint, processooor: Hex, data: Hex) {
  const next = withdrawalSecrets(k, n.label, n.children);
  return proveSpend({
    value: n.value,
    label: n.label,
    nullifier: n.nullifier,
    secret: n.secret,
    newNullifier: next.nullifier,
    newSecret: next.secret,
    amount,
    context: context({ processooor: processooor as `0x${string}`, data }, cfg.dep.scope),
    state: proveLeaf(state.leaves, n.commitment),
    asp: proveLeaf(asp.labels, n.label),
  });
}

async function act() {
  const k = masterKeys(cfg.coverMnemonic!);
  const zipKey = zipAddressKeys(k.masterSecret);
  await refresh();
  const mine = recoverNotes(k, cfg.dep.scope, state, { zipAddressKey: zipKey.privateKey });
  const spendable = mine.notes.filter((n) => asp.labels.includes(n.label) && n.value >= parseEther("2"));
  const gasPrice = await pub.getGasPrice();

  if (spendable.length === 0 || Math.random() < 0.2) {
    if (!budgetLeft("relay", gasPrice)) return;
    // Zip fresh cover funds from the courier wallet (a deposit that looks like any other)
    const amount = parseEther(String(5 + Math.floor(Math.random() * 45)));
    const s = depositSecrets(k, cfg.dep.scope, mine.nextDepositIndex);
    await pub.waitForTransactionReceipt({
      hash: await wallet.writeContract({ chain: null, address: cfg.dep.zc, abi: erc20, functionName: "approve", args: [cfg.dep.entrypoint, amount] }),
    });
    await pub.waitForTransactionReceipt({
      hash: await wallet.writeContract({
        chain: null,
        address: cfg.dep.entrypoint,
        abi: entrypointAbi,
        functionName: "deposit",
        args: [cfg.dep.zc, amount, hashPrecommitment(s.nullifier, s.secret)],
      }),
    });
    console.log(`[cover] zipped ${amount / 10n ** 18n} ZC`);
    return;
  }

  const n = spendable[Math.floor(Math.random() * spendable.length)];
  const amount = (n.value * BigInt(20 + Math.floor(Math.random() * 60))) / 100n;
  if (Math.random() < 0.6) {
    if (!budgetLeft("rezip", gasPrice)) return;
    const to = randomSecrets();
    const data = encodeSend({
      precommitment: hashPrecommitment(to.nullifier, to.secret),
      ciphertext: sealSecrets(zipKey.publicKey, to),
      courier: { feeRecipient: cfg.account.address, fee: 0n },
    });
    await accept({ kind: "rezip", withdrawal: { processooor: cfg.dep.rezip, data }, proof: await prove(k, n, amount, cfg.dep.rezip, data) }, 0, true);
    console.log(`[cover] rezipped ${amount / 10n ** 18n} ZC to itself`);
  } else {
    if (!budgetLeft("relay", gasPrice)) return;
    const data = encodeRelay(cfg.account.address, cfg.account.address, 0n);
    await accept({ kind: "relay", withdrawal: { processooor: cfg.dep.entrypoint, data }, proof: await prove(k, n, amount, cfg.dep.entrypoint, data) }, 0, true);
    console.log(`[cover] unzipped ${amount / 10n ** 18n} ZC to its wallet`);
  }
}

/** Poisson process: exponential gaps with mean 1/rate. */
export function startCover() {
  if (!cfg.coverPerHour || !cfg.coverMnemonic) return;
  const next = () => setTimeout(run, (-Math.log(1 - Math.random()) * 3_600_000) / cfg.coverPerHour);
  const run = async () => {
    try {
      await act();
    } catch (e) {
      console.error("[cover]", (e as Error).message.split("\n")[0]);
    }
    next();
  };
  console.log(`[cover] on: ~${cfg.coverPerHour}/h, budget ${cfg.coverDailyGasWei} wei/day`);
  next();
}
