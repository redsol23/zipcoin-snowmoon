"use client";

import {
  buildTree,
  context,
  depositSecrets,
  entrypointAbi,
  hashPrecommitment,
  insertGasHeadroom,
  parseDeployment,
  poolAbi,
  proveLeaf,
  proveSpend,
  randomSecrets,
  recoverNotes,
  syncFromCourier,
  toJson,
  withdrawalSecrets,
  type Deployment,
  type MasterKeys,
  type Note,
  type PoolState,
} from "@zipnet/sdk";
import { createPublicClient, http, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

import { markPendingSpent, prunePendingSpends, withoutPending } from "./pending-spends";

export type WalletConnectConfig = { projectId: string; chains: { id: number; rpcUrl: string }[] };
export type Config = { deployment: Deployment; rpcUrl: string; courierUrl: string; devWallet: boolean; walletConnect?: WalletConnectConfig | null };

export async function loadConfig(): Promise<Config> {
  const res = await fetch("/api/config");
  const j = await res.json();
  if (!res.ok) throw new Error(j.error);
  return { ...j, deployment: parseDeployment(j.deployment) };
}

export const publicClient = (c: Config) => createPublicClient({ transport: http(c.rpcUrl) }) as PublicClient;

export const erc20 = [
  { type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

/**
 * The pool as a courier serves it, checked against the chain before we trust it: the rebuilt state tree must match
 * `pool.currentRoot()` and the approved labels must hash to `entrypoint.latestRoot()`.
 */
export async function loadPool(c: Config, pub: PublicClient, prev?: PoolState): Promise<{ state: PoolState; labels: bigint[]; verified: boolean; lagging: boolean }> {
  // Private reads: every chunk of the state on a cold start, then only what changed since `prev`
  const [state, aspRes] = await Promise.all([syncFromCourier(c.courierUrl, prev), fetch(`${c.courierUrl}/asp`)]);
  const asp = (await aspRes.json()) as { labels: string[]; root: string };
  const labels = asp.labels.map(BigInt);
  const [poolRoot, aspRoot] = await Promise.all([
    pub.readContract({ address: c.deployment.pool, abi: [{ type: "function", name: "currentRoot", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }], functionName: "currentRoot" }),
    pub.readContract({ address: c.deployment.entrypoint, abi: entrypointAbi, functionName: "latestRoot" }).catch(() => 0n),
  ]);
  // A busy pool moves on between the courier's snapshot and our read. Any of the last 64 roots is fine: those are
  // exactly the roots a proof may use.
  const served = state.leaves.length ? buildTree(state.leaves).root : 0n;
  let stateOk = served === 0n || served === poolRoot;
  if (!stateOk) {
    const rootAbi = [{ type: "function", name: "roots", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }], stateMutability: "view" }] as const;
    const history = await Promise.all(Array.from({ length: 64 }, (_, i) => pub.readContract({ address: c.deployment.pool, abi: rootAbi, functionName: "roots", args: [BigInt(i)] })));
    stateOk = history.includes(served);
  }
  const aspOk = labels.length === 0 || buildTree(labels).root === aspRoot;
  // A delta that doesn't verify (the courier resynced or served something else) gets one clean cold sync
  if (!stateOk && prev) return loadPool(c, pub);
  return { state, labels, verified: stateOk && aspOk, lagging: !stateOk };
}

export type Pool = Awaited<ReturnType<typeof loadPool>>;

export function myNotes(c: Config, keys: MasterKeys, zipKey: Uint8Array, pool: Pool, badgeLocks = 0) {
  // +5: a lock made moments ago may not be indexed yet, and its return note must still be found once unlocked
  const r = recoverNotes(keys, c.deployment.scope, pool.state, { zipAddressKey: zipKey, badgeLocks: badgeLocks + 5 });
  // A note handed to a courier moments ago still looks unspent until the chain has the spend: leave it out
  prunePendingSpends(pool.state.withdrawals.map((w) => w.spentNullifier));
  const spendable = withoutPending(r.notes.filter((n) => pool.labels.includes(n.label)));
  return {
    ...r,
    spendable,
    waiting: r.notes.filter((n) => !pool.labels.includes(n.label)),
    largest: spendable.reduce((m, n) => (n.value > m ? n.value : m), 0n),
  };
}

/**
 * Smallest spendable note that covers `amount`. A proof spends one note, so the largest note is the most you can move at
 * once. Never a note already handed to a courier (the list may predate that spend).
 */
export function pickNote(notes: Note[], amount: bigint) {
  return withoutPending(notes).filter((n) => n.value >= amount).sort((a, b) => (a.value < b.value ? -1 : 1))[0] ?? null;
}

/** A courier's fees. `url` is the courier chosen for this action (see ./couriers); the job must go to the same one. */
export async function courierQuote(c: Config, url = c.courierUrl) {
  const q = (await (await fetch(`${url}/quote`)).json()) as { courier: Address; fees: Record<string, string> };
  return { courier: q.courier, url, fee: (kind: string) => BigInt(q.fees[kind] ?? "0") };
}

/** How long a courier may hold the proof before sending it (it never holds past the current approval epoch). */
export const HOLDS = [
  { sec: 0, label: "Send now" },
  { sec: 3600, label: "Within the hour" },
  { sec: 86_400, label: "Any time this epoch" },
] as const;

export type JobResult = { id: string; status: string; tx?: string; submitAt: number; deadline: number; receipt?: unknown };

/** Proves in this browser and hands the proof to a courier. */
export async function spend(
  c: Config,
  keys: MasterKeys | null,
  pool: Pool,
  note: Note,
  amount: bigint,
  kind: string,
  processooor: Address,
  data: Hex,
  holdSec: number,
  courierUrl = c.courierUrl,
): Promise<JobResult> {
  // Change goes to the spender's key; a link claimed in full leaves an empty change note, so random secrets do
  const next = keys ? withdrawalSecrets(keys, note.label, note.children) : randomSecrets();
  const proof = await proveSpend({
    value: note.value,
    label: note.label,
    nullifier: note.nullifier,
    secret: note.secret,
    newNullifier: next.nullifier,
    newSecret: next.secret,
    amount,
    context: context({ processooor, data }, c.deployment.scope),
    state: proveLeaf(pool.state.leaves, note.commitment),
    asp: proveLeaf(pool.labels, note.label),
  });
  const res = await fetch(`${courierUrl}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: toJson({ kind, holdSec, withdrawal: { processooor, data }, proof }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error ?? `The courier refused the job (${res.status}).`);
  const job = j as JobResult;
  // The courier took the note: never pick it again before the chain shows it spent (see ./pending-spends)
  if (job.status !== "failed") markPendingSpent(note.nullifier, job, courierUrl);
  return job;
}

/**
 * Combining notes: several notes proved against one BatchRelayer withdrawal and unzipped to one recipient in a single
 * transaction. It moves more than the largest note holds, but it shows those notes belong together.
 */
export async function spendBatch(
  c: Config,
  keys: MasterKeys,
  pool: Pool,
  parts: { note: Note; amount: bigint }[],
  data: Hex,
  holdSec: number,
  courierUrl = c.courierUrl,
): Promise<JobResult> {
  const processooor = c.deployment.batchRelayer;
  if (!processooor) throw new Error("Combining notes isn't available on this deployment.");
  const proofs = [];
  for (const p of parts) {
    const next = withdrawalSecrets(keys, p.note.label, p.note.children);
    proofs.push(
      await proveSpend({
        value: p.note.value,
        label: p.note.label,
        nullifier: p.note.nullifier,
        secret: p.note.secret,
        newNullifier: next.nullifier,
        newSecret: next.secret,
        amount: p.amount,
        context: context({ processooor, data }, c.deployment.scope),
        state: proveLeaf(pool.state.leaves, p.note.commitment),
        asp: proveLeaf(pool.labels, p.note.label),
      }),
    );
  }
  const res = await fetch(`${courierUrl}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: toJson({ kind: "batch", holdSec, withdrawal: { processooor, data }, proofs }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error ?? `The courier refused the job (${res.status}).`);
  const job = j as JobResult;
  if (job.status !== "failed") for (const p of parts) markPendingSpent(p.note.nullifier, job, courierUrl);
  return job;
}

/**
 * Zipping: a deposit from the connected wallet under the next secrets of the zip key. Two transactions. The deposit
 * gets gas headroom for its leaf insert (insertGasHeadroom: other deposits landing first in the block make it dearer
 * than estimated), and a reverted transaction is an error, never "zipped".
 */
export async function zip(c: Config, pub: PublicClient, wallet: WalletClient, keys: MasterKeys, nextIndex: bigint, amount: bigint) {
  const account = wallet.account!;
  const s = depositSecrets(keys, c.deployment.scope, nextIndex);
  const approve = await wallet.writeContract({ account, chain: null, address: c.deployment.zc, abi: erc20, functionName: "approve", args: [c.deployment.entrypoint, amount] });
  if ((await pub.waitForTransactionReceipt({ hash: approve })).status !== "success") throw new Error("Approving the ZC failed (the transaction reverted), so nothing was zipped.");
  const deposit = { account, chain: null, address: c.deployment.entrypoint, abi: entrypointAbi, functionName: "deposit", args: [c.deployment.zc, amount, hashPrecommitment(s.nullifier, s.secret)] } as const;
  const [estimate, depth] = await Promise.all([
    pub.estimateContractGas(deposit),
    pub.readContract({ address: c.deployment.pool, abi: poolAbi, functionName: "currentTreeDepth" }) as Promise<bigint>,
  ]);
  const hash = await wallet.writeContract({ ...deposit, gas: estimate + insertGasHeadroom(depth) });
  if ((await pub.waitForTransactionReceipt({ hash })).status !== "success") {
    throw new Error("The deposit failed (the transaction reverted), so nothing was zipped; your ZC is still in your wallet. Try again.");
  }
  return hash;
}
