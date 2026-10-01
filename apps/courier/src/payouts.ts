import { BADGE_PAYOUT, badgePayoutMessage, SNARK_SCALAR_FIELD } from "@zipnet/sdk";
import { isAddress, type Address } from "viem";

/**
 * Recovering parked badge stakes (C-1) and ragequitting unapproved returned notes (M-12), carried for the owner so
 * their wallet never appears on-chain.
 *
 * ZipBadges has redirectPayout / releasePayout / ragequitPayout. The owner's authorisation travels in the arguments (a
 * Semaphore proof by the lock's identity) and binds the action, its target and a one-use nonce, so the courier can
 * only submit exactly what the owner asked for. The payout itself can't pay a fee (the contract has no fee path, and
 * the whole point is that the owner may hold nothing else), so these are free, rate-limited jobs like `unlock`.
 *
 * Pure (no config), so it can be tested without a chain.
 */

export const PAYOUT_KINDS = ["badgeRedirect", "badgeRelease", "badgeRagequit"] as const;
export type PayoutKind = (typeof PAYOUT_KINDS)[number];

export const isPayoutKind = (k: string): k is PayoutKind => (PAYOUT_KINDS as readonly string[]).includes(k);

export type PayoutContract = "badges";
export type PayoutCall = "redirectPayout" | "releasePayout" | "ragequitPayout";

/** Which deployment contract and function each kind calls (the client never picks the address) */
export function payoutTarget(kind: PayoutKind): { contract: PayoutContract; fn: PayoutCall } {
  const contract: PayoutContract = "badges";
  const fn: PayoutCall = kind.endsWith("Redirect") ? "redirectPayout" : kind.endsWith("Release") ? "releasePayout" : "ragequitPayout";
  return { contract, fn };
}

/**
 * Gas per call, measured on a local chain (638k / 304k / 562k for redirect / release / ragequit), plus headroom. Each
 * call verifies a Semaphore proof (about 250k); a redirect makes a pool deposit; a ragequit verifies a Groth16 proof
 * and pays out.
 */
export const PAYOUT_GAS: Record<PayoutKind, bigint> = {
  badgeRedirect: 750_000n,
  badgeRelease: 400_000n,
  badgeRagequit: 700_000n,
};

export class PayoutArgError extends Error {}
const bad = (m: string): never => {
  throw new PayoutArgError(m);
};

const U256 = 2n ** 256n;

/** A uint from JSON: a bigint, a safe integer, or a decimal (or 0x) string */
function uint(v: unknown, what: string, max = U256): bigint {
  let x: bigint | null = null;
  if (typeof v === "bigint") x = v;
  else if (typeof v === "number" && Number.isSafeInteger(v)) x = BigInt(v);
  else if (typeof v === "string" && /^(\d{1,78}|0x[0-9a-fA-F]{1,64})$/.test(v)) x = BigInt(v);
  if (x === null || x < 0n || x >= max) bad(`${what} must be a whole number below ${max === U256 ? "2^256" : max.toString()}`);
  return x as bigint;
}

const id = (v: unknown) => {
  const x = uint(v, "payout id", 2n ** 64n);
  if (x === 0n) bad("payout id must be at least 1");
  return x;
};

function recipient(v: unknown): Address {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) bad("recipient must be an address");
  if (/^0x0{40}$/i.test(v as string)) bad("recipient can't be the zero address");
  return v as Address;
}

function precommitment(v: unknown) {
  const x = uint(v, "precommitment", SNARK_SCALAR_FIELD);
  if (x === 0n) bad("precommitment can't be zero");
  return x;
}

const arr = (v: unknown, n: number, what: string): unknown[] => (Array.isArray(v) && v.length === n ? v : bad(`${what} must have ${n} entries`));

export type SemaphoreProofArg = { merkleTreeDepth: bigint; merkleTreeRoot: bigint; nullifier: bigint; message: bigint; scope: bigint; points: bigint[] };

/** A Semaphore proof over the one-member group {the lock's identity} (SoloProof), bound to this action and target */
function soloProof(v: unknown, action: number, target: bigint): SemaphoreProofArg {
  if (!v || typeof v !== "object") bad("authorisation must be a Semaphore proof");
  const p = v as Record<string, unknown>;
  const depth = uint(p.merkleTreeDepth, "merkleTreeDepth", 33n);
  if (depth < 1n) bad("merkleTreeDepth must be 1 to 32");
  const out = {
    merkleTreeDepth: depth,
    merkleTreeRoot: uint(p.merkleTreeRoot, "merkleTreeRoot"),
    nullifier: uint(p.nullifier, "nullifier"),
    message: uint(p.message, "message"),
    scope: uint(p.scope, "scope"),
    points: arr(p.points, 8, "points").map((x, i) => uint(x, `points[${i}]`)),
  };
  if (out.merkleTreeRoot === 0n) bad("the proof names no identity");
  // The contract checks this too; refusing here keeps a proof for another action or target from costing us a simulation
  if (out.message !== badgePayoutMessage(action as 1 | 2 | 3, target)) bad("the proof doesn't authorise this action and target");
  return out;
}

export type RagequitProofArg = { pA: [bigint, bigint]; pB: [[bigint, bigint], [bigint, bigint]]; pC: [bigint, bigint]; pubSignals: [bigint, bigint, bigint, bigint] };

/** ProofLib.RagequitProof: commitment, nullifier hash, value, label */
function ragequitProof(v: unknown): RagequitProofArg {
  if (!v || typeof v !== "object") bad("ragequit proof missing");
  const p = v as Record<string, unknown>;
  const pair = (x: unknown, what: string) => arr(x, 2, what).map((y, i) => uint(y, `${what}[${i}]`)) as [bigint, bigint];
  const pB = arr(p.pB, 2, "pB").map((row, i) => pair(row, `pB[${i}]`)) as [[bigint, bigint], [bigint, bigint]];
  const pubSignals = arr(p.pubSignals, 4, "pubSignals").map((y, i) => uint(y, `pubSignals[${i}]`, SNARK_SCALAR_FIELD)) as RagequitProofArg["pubSignals"];
  if (pubSignals[2] === 0n) bad("the note to ragequit holds nothing");
  return { pA: pair(p.pA, "pA"), pB, pC: pair(p.pC, "pC"), pubSignals };
}

/**
 * Checks a payout job's JSON arguments and gives viem the exact types:
 *   *Redirect  [id, newPrecommitment, auth]
 *   *Release   [id, to, auth]
 *   *Ragequit  [id, ragequitProof, to, auth]
 * where auth is a Semaphore proof by the lock's identity.
 * @throws PayoutArgError with a message for the client
 */
export function payoutArgs(kind: PayoutKind, a: unknown): unknown[] {
  const { fn } = payoutTarget(kind);
  const n = fn === "ragequitPayout" ? 4 : 3;
  const args = arr(a, n, `${kind} arguments`);
  const payoutId = id(args[0]);
  const action = fn === "redirectPayout" ? BADGE_PAYOUT.redirect : fn === "releasePayout" ? BADGE_PAYOUT.release : BADGE_PAYOUT.ragequit;
  const auth = (target: bigint | Address, raw: unknown) => soloProof(raw, action, typeof target === "bigint" ? target : BigInt(target));
  if (fn === "redirectPayout") {
    const pre = precommitment(args[1]);
    return [payoutId, pre, auth(pre, args[2])];
  }
  if (fn === "releasePayout") {
    const to = recipient(args[1]);
    return [payoutId, to, auth(to, args[2])];
  }
  const proof = ragequitProof(args[1]);
  const to = recipient(args[2]);
  return [payoutId, proof, to, auth(to, args[3])];
}
