"use client";

import {
  BADGE_PAYOUT,
  badgePayoutProof,
  checkBadgePayoutScope,
  depositSecrets,
  entrypointAbi,
  hashPrecommitment,
  poolAbi,
  proveExit,
  recoverNotes,
  toJson,
  zipBadgesAbi,
  type MasterKeys,
} from "@zipnet/sdk";
import type { Identity } from "@semaphore-protocol/core";
import { parseAbiItem, type Abi, type Address, type PublicClient } from "viem";

import { chooseCourierUrl } from "@/lib/couriers";
import type { Config, Pool } from "@/lib/wallet";

import { collectPayouts, payoutKey, resolveOwners, type DepositLog, type ParkedPayout, type ParkLog, type PayoutSource, type PoolStatus } from "./payouts-parked";
import { checkJob, zc } from "./ui";

/**
 * Finding this zip key's parked badge stakes on chain, and recovering them through a courier (see ./payouts-parked for
 * the model).
 *
 * Every recovery goes to a courier as a free job, authorised by a Semaphore proof by the lock's identity (already
 * public in `Locked`) over the group {identity}, so the person's wallet never sends or signs anything on-chain.
 * "Send back into the pool" deposits under a fresh deposit secret of this zip key, so the coins come back as an
 * ordinary private note. "Send to an address" and the ragequit pay a plain address, which links it to the payout.
 */

const parkedEv = parseAbiItem("event PayoutParked(uint256 indexed id, uint256 amount, uint256 precommitment, bytes reason)");
const depositedEv = parseAbiItem("event PayoutDeposited(uint256 indexed id, uint256 amount, uint256 precommitment, uint256 commitment, uint256 label)");

const assetConfigAbi = entrypointAbi as Abi;

export type ScanEnv = {
  config: Config;
  pub: PublicClient;
  keys: MasterKeys;
  /** Only finds notes rezipped to the zip address; payout notes never are, so callers without it may leave it out */
  zipAddressKey?: Uint8Array;
  pool: Pool;
  locks: { lockId: bigint; identityCommitment: bigint; unlocked: boolean }[];
};

const contractOf = (c: Config, _s: PayoutSource) => c.deployment.badges;
const SOURCES: PayoutSource[] = ["badge"];

/** Whether the pool takes ZC now, and its minimum deposit (a redirect needs both) */
export async function poolStatus(c: Config, pub: PublicClient): Promise<PoolStatus> {
  const cfg = (await pub.readContract({ address: c.deployment.entrypoint, abi: assetConfigAbi, functionName: "assetConfig", args: [c.deployment.zc] })) as readonly [Address, bigint, bigint, bigint];
  const exists = !/^0x0{40}$/i.test(cfg[0]);
  const dead = exists ? ((await pub.readContract({ address: cfg[0], abi: poolAbi as Abi, functionName: "dead" })) as boolean) : false;
  return { exists, dead, minDeposit: cfg[1] };
}

/** Every badge stake parked for this key, or sitting unapproved long enough to ragequit. */
export async function scanParkedPayouts(e: ScanEnv): Promise<ParkedPayout[]> {
  const { config: c, pub } = e;
  const fromBlock = BigInt(c.deployment.deployBlock);
  const [parkLogs, depositLogs, pool, head] = await Promise.all([
    Promise.all(SOURCES.map((s) => pub.getLogs({ address: contractOf(c, s), event: parkedEv, fromBlock }))),
    Promise.all(SOURCES.map((s) => pub.getLogs({ address: contractOf(c, s), event: depositedEv, fromBlock }))),
    poolStatus(c, pub),
    pub.getBlock(),
  ]);
  const parks: ParkLog[] = parkLogs.flatMap((logs, i) =>
    logs.map((l) => ({ source: SOURCES[i], id: l.args.id!, amount: l.args.amount!, precommitment: l.args.precommitment!, reason: l.args.reason ?? "0x", block: l.blockNumber })),
  );
  const deposits: DepositLog[] = depositLogs.flatMap((logs, i) =>
    logs.map((l) => ({ source: SOURCES[i], id: l.args.id!, amount: l.args.amount!, precommitment: l.args.precommitment!, commitment: l.args.commitment!, label: l.args.label!, block: l.blockNumber })),
  );

  const owners = resolveOwners({ locks: e.locks });

  // What is still parked now (a redirect or release empties it)
  const parkedNow = new Map<string, bigint>();
  const parkedKeys = [...new Set(parks.map((p) => payoutKey(p.source, p.id)))].filter((k) => owners.has(k));
  await Promise.all(
    parkedKeys.map(async (key) => {
      const [source, id] = key.split(":") as [PayoutSource, string];
      parkedNow.set(key, (await pub.readContract({ address: contractOf(c, source), abi: zipBadgesAbi, functionName: "parkedPayout", args: [BigInt(id)] })) as bigint);
    }),
  );

  // Every note the key controls, approved or not
  const { notes } = recoverNotes(e.keys, c.deployment.scope, e.pool.state, { zipAddressKey: e.zipAddressKey, badgeLocks: e.locks.length + 5 });
  const approvedLabels = new Set(e.pool.labels);
  // Block times only for the deposits that could be waiting on the ASP
  const waitingLabels = new Set(notes.filter((n) => !approvedLabels.has(n.label)).map((n) => n.label));
  const times = new Map<bigint, number>();
  await Promise.all(
    [...new Set(deposits.filter((d) => owners.has(payoutKey(d.source, d.id)) && waitingLabels.has(d.label)).map((d) => d.block))].map(async (b) =>
      times.set(b, Number((await pub.getBlock({ blockNumber: b })).timestamp)),
    ),
  );

  return collectPayouts({ owners, parks, deposits, parkedNow, notes, approvedLabels, pool, depositTime: (d) => times.get(d.block), now: Number(head.timestamp) });
}

// ---------------------------------------------------------------------------------------------------------------
// recovering
// ---------------------------------------------------------------------------------------------------------------

export type RecoverEnv = {
  config: Config;
  pub: PublicClient;
  keys: MasterKeys;
  /** The key's badge identities (v2 and v1): the one that made the lock proves */
  badgeIdentities: Identity[];
  /** The key's next unused deposit index (recoverNotes' nextDepositIndex): a redirect lands there */
  nextDepositIndex: bigint;
};

export type Recovery = { action: "redirect" } | { action: "release"; to: Address } | { action: "ragequit"; to: Address };

const KIND = { redirect: "Redirect", release: "Release", ragequit: "Ragequit" } as const;
const BADGE_ACTION = { redirect: BADGE_PAYOUT.redirect, release: BADGE_PAYOUT.release, ragequit: BADGE_PAYOUT.ragequit } as const;

/** The owner's authorisation for `action` on `p` with `target`, as the contract checks it */
async function authorise(e: RecoverEnv, p: ParkedPayout, action: Recovery["action"], target: bigint | Address): Promise<unknown> {
  const contract = contractOf(e.config, p.source);
  const commitment = p.auth.commitment;
  const identity = e.badgeIdentities.find((i) => i.commitment === commitment);
  if (!identity) throw new Error("This badge was locked by an identity this zip key doesn't hold.");
  // The scope carries the lock's payout nonce, which only payoutScope exposes: check the read against a local recomputation (A-9)
  const read = (await e.pub.readContract({ address: contract, abi: zipBadgesAbi, functionName: "payoutScope", args: [p.id] })) as bigint;
  const scope = checkBadgePayoutScope(read, contract, e.config.deployment.chainId, p.id);
  return badgePayoutProof(identity, scope, BADGE_ACTION[action], target);
}

/** The courier job for a recovery: kind and arguments (exported for tests and the e2e script's shape) */
export function recoveryJob(source: PayoutSource, r: Recovery, id: bigint, target: bigint | Address, auth: unknown, ragequitProof?: unknown) {
  const kind = `${source}${KIND[r.action]}`;
  const args = r.action === "ragequit" ? [id, ragequitProof, target, auth] : [id, target, auth];
  return { kind, args };
}

/**
 * Recovers `p` through a courier. Returns what to tell the person. The courier simulates first and refuses a job that
 * would revert, so a stale view costs nothing.
 */
export async function recoverPayout(e: RecoverEnv, p: ParkedPayout, r: Recovery): Promise<{ text: string; tx?: string }> {
  if (r.action === "ragequit" && p.state !== "unapproved") throw new Error("Only a payout note the approver never cleared can be taken out this way.");
  if (r.action !== "ragequit" && p.state !== "parked") throw new Error("That payout isn't parked any more.");
  if (r.action === "redirect" && p.state === "parked" && !p.canRedirect) throw new Error("The pool can't take this payout right now; send it to an address instead.");

  let target: bigint | Address;
  if (r.action === "redirect") {
    const s = depositSecrets(e.keys, e.config.deployment.scope, e.nextDepositIndex);
    target = hashPrecommitment(s.nullifier, s.secret);
  } else target = r.to;

  const ragequitProof = p.state === "unapproved" ? await proveExit(p.note.value, p.note.label, p.note.nullifier, p.note.secret) : undefined;
  const auth = await authorise(e, p, r.action, target);
  const job = recoveryJob(p.source, r, p.id, target, auth, ragequitProof);

  const url = await chooseCourierUrl(e.config, e.pub);
  const res = await fetch(`${url}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: toJson({ ...job, holdSec: 0 }) });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error ?? `The courier refused the job (${res.status}).`);
  const done = checkJob(j as { id: string; status: string; tx?: string });

  const text =
    r.action === "redirect"
      ? `${zc(p.amount)} ZC is going back into the pool as a note only your zip key can spend. It becomes spendable once the approver clears it.`
      : `${zc(p.amount)} ZC is on its way to ${(r as { to: Address }).to.slice(0, 8)}…. Anyone can see that address received this payout.`;
  return { text, tx: done.tx };
}

