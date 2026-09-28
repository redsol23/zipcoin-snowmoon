"use client";

import {
  buildTree,
  context,
  depositSecrets,
  entrypointAbi,
  hashPrecommitment,
  parseDeployment,
  parsePoolState,
  proveLeaf,
  proveSpend,
  randomSecrets,
  recoverNotes,
  toJson,
  withdrawalSecrets,
  type Deployment,
  type MasterKeys,
  type Note,
  type PoolState,
} from "@zipnet/sdk";
import { createPublicClient, http, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

export type Config = { deployment: Deployment; rpcUrl: string; courierUrl: string; devWallet: boolean };

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
export async function loadPool(c: Config, pub: PublicClient) {
  const [stateRes, aspRes] = await Promise.all([fetch(`${c.courierUrl}/state`), fetch(`${c.courierUrl}/asp`)]);
  const state = parsePoolState<PoolState>(await stateRes.text());
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
  return { state, labels, verified: stateOk && aspOk, lagging: !stateOk };
}

export type Pool = Awaited<ReturnType<typeof loadPool>>;

export function myNotes(c: Config, keys: MasterKeys, zipKey: Uint8Array, pool: Pool) {
  const r = recoverNotes(keys, c.deployment.scope, pool.state, { zipAddressKey: zipKey });
  const spendable = r.notes.filter((n) => pool.labels.includes(n.label));
  return {
    ...r,
    spendable,
    waiting: r.notes.filter((n) => !pool.labels.includes(n.label)),
    largest: spendable.reduce((m, n) => (n.value > m ? n.value : m), 0n),
  };
}

/** Smallest spendable note that covers `amount`. A proof spends one note, so the largest note is the most you can move at once. */
export function pickNote(notes: Note[], amount: bigint) {
  return notes.filter((n) => n.value >= amount).sort((a, b) => (a.value < b.value ? -1 : 1))[0] ?? null;
}

export async function courierQuote(c: Config) {
  const q = (await (await fetch(`${c.courierUrl}/quote`)).json()) as { courier: Address; fees: Record<string, string> };
  return { courier: q.courier, fee: (kind: string) => BigInt(q.fees[kind] ?? "0") };
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
  const res = await fetch(`${c.courierUrl}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: toJson({ kind, holdSec, withdrawal: { processooor, data }, proof }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error ?? `The courier refused the job (${res.status}).`);
  return j as JobResult;
}

/** Zipping: a deposit from the connected wallet under the next secrets of the zip key. Two transactions. */
export async function zip(c: Config, pub: PublicClient, wallet: WalletClient, keys: MasterKeys, nextIndex: bigint, amount: bigint) {
  const account = wallet.account!;
  const s = depositSecrets(keys, c.deployment.scope, nextIndex);
  const approve = await wallet.writeContract({ account, chain: null, address: c.deployment.zc, abi: erc20, functionName: "approve", args: [c.deployment.entrypoint, amount] });
  await pub.waitForTransactionReceipt({ hash: approve });
  const hash = await wallet.writeContract({
    account,
    chain: null,
    address: c.deployment.entrypoint,
    abi: entrypointAbi,
    functionName: "deposit",
    args: [c.deployment.zc, amount, hashPrecommitment(s.nullifier, s.secret)],
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}
