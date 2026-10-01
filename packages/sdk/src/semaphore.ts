/**
 * Badges and anonymous groups. A zip key also carries Semaphore identities, so one wallet signature unlocks both the
 * coins and the badges, and the same wallet always gets the same identities back.
 *
 * One identity per purpose (M-11). An identity commitment is public wherever it is used: in ZipBadges.Locked and in the
 * ZipPay calldata and `Paid` event. If a key used a single identity everywhere, every
 * anonymous payment would be linked to the others and to any wallet that ever locked a badge with it. So each purpose
 * derives its own identity from the master secret, with HKDF and a domain-separated `info`:
 *
 *   badge lock (per lock)       "zipnet semaphore v2/badge/<lock index>"       new badge locks and their tier groups
 *   badge (one per key)         "zipnet semaphore v2/badge"                    badge locks made before per-lock identities
 *   payer (per pay contract     "zipnet semaphore v2/payer/<pay addr>/<id>"   one merchant's payer group
 *          and merchant)
 *
 * All of them are recomputed from the zip key alone, so a restored wallet recovers them with nothing stored.
 *
 * Migration: `semaphoreIdentity` (the v1, one-per-key identity) is unchanged and still what old badge locks use. Wallets keep using it for anything already made with it (see `zipIdentities`) and use
 * the v2 identities for everything new; a v1 identity simply stops appearing once its locks have unlocked.
 * - Local data: no identity is ever stored (browser storage holds none), so there is nothing to convert. The web
 *   wallet finds badge locks made by either identity from `Locked` events and proves with the v1 identity while one
 *   of its locks is live; badge-return note indices keep counting across both identities, so no return secret repeats.
 * - Payer groups: no wallet joined one with the v1 identity (the web wallet, x402 and Veridia always sent 0), so the
 *   per-merchant payer identity starts clean.
 * - Existing v1 badge locks stay linked to each other, and to the wallet if they were locked from one; only new locks
 *   get the unlinked v2 identity.
 * - Per-lock badge identities (A-7, A-8): each new lock gets `badgeLockIdentity(k, index)`. Locks made with the one
 *   v2 badge identity, or the v1 identity, keep resolving through them. A wallet proves in a group with whichever of
 *   its live-lock identities is a member, highest tier first (`proverIn`), so a v1 lock never shadows a higher v2 one.
 * - Never lock from a wallet (ZipBadges.lock) with a zip-key identity: the Locked event would tie that identity to the
 *   wallet. Lock from a zipped note (lockAnon) instead.
 */
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { generateProof, Group, Identity } from "@semaphore-protocol/core";
import { encodeAbiParameters, keccak256, numberToBytes, numberToHex, type Address } from "viem";
import { poseidon2, poseidon3 } from "poseidon-lite";

import type { MasterKeys, NoteSecrets } from "./keys";

const keyedIdentity = (k: MasterKeys, info: string) =>
  new Identity(hkdf(sha256, numberToBytes(k.masterSecret, { size: 32 }), undefined, new TextEncoder().encode(info), 32));

/**
 * The zip key's original (v1) Semaphore identity, one per key. Kept for backwards compatibility: badge locks made
 * before per-purpose identities still use it. New code should use `badgeLockIdentity` or `payerIdentity`.
 */
export function semaphoreIdentity(k: MasterKeys) {
  return keyedIdentity(k, "zipnet semaphore v1");
}

export type IdentityPurpose = "badge" | "payer";

/** A per-purpose identity: HKDF(master secret, "zipnet semaphore v2/<purpose>[/<context>]"). */
export function derivedIdentity(k: MasterKeys, purpose: IdentityPurpose, context?: string) {
  return keyedIdentity(k, `zipnet semaphore v2/${purpose}${context === undefined ? "" : `/${context}`}`);
}

/**
 * The single v2 badge identity (one per key). New locks use `badgeLockIdentity(k, index)` instead (A-7); this one
 * stays so locks made with it keep resolving.
 */
export const badgeIdentity = (k: MasterKeys) => derivedIdentity(k, "badge");

/**
 * The identity for this key's `index`-th badge lock (A-7): HKDF(master secret, "zipnet semaphore v2/badge/<index>").
 * `index` is the same counter that numbers badge-return notes (`badgeReturnSecrets`): how many locks this key made
 * before. One identity per lock means a key can hold several live locks (Semaphore refuses the same commitment twice
 * in a group), its locks can't be linked to each other through a shared commitment, and a
 * published commitment can't be squatted to block the key's future locks (each new lock uses a fresh one).
 */
export function badgeLockIdentity(k: MasterKeys, index: bigint): Identity {
  // Deriving an identity costs a Baby Jubjub multiplication and wallets rescan often, so keep them per key object
  let m = lockIdentityCache.get(k);
  if (!m) lockIdentityCache.set(k, (m = new Map()));
  let id = m.get(index);
  if (!id) m.set(index, (id = derivedIdentity(k, "badge", index.toString())));
  return id;
}
const lockIdentityCache = new WeakMap<MasterKeys, Map<bigint, Identity>>();

/**
 * The per-lock badge identities this key has used, found by scanning indices against commitments seen on chain
 * (`used`, e.g. from ZipBadges.Locked events), as notes are found: the scan continues `gap` indices past the last hit
 * and at least `start + gap` (pass the number of this key's locks made with the older identities as `start`, since
 * their indices were used up by them). Returns [index, identity] pairs in index order.
 */
export function scanBadgeLockIdentities(k: MasterKeys, used: (commitment: bigint) => boolean, start = 0, gap = 20): [bigint, Identity][] {
  const found: [bigint, Identity][] = [];
  for (let i = 0, limit = start + gap; i < limit; i++) {
    const id = badgeLockIdentity(k, BigInt(i));
    if (used(id.commitment)) {
      found.push([BigInt(i), id]);
      limit = Math.max(limit, i + 1 + gap);
    }
  }
  return found;
}

/**
 * The identity to prove with in a group (A-8): the first of `candidates` (the caller orders them, e.g. live locks by
 * tier, highest first) whose commitment is a member, or null.
 */
export const proverIn = (candidates: Identity[], members: bigint[]): Identity | null => candidates.find((i) => members.includes(i.commitment)) ?? null;

/**
 * The identity for one merchant's payer group on one pay contract (each pay contract keeps its own groups), so
 * payer-group memberships at different merchants can't be linked to each other.
 */
export const payerIdentity = (k: MasterKeys, pay: Address, merchantId: bigint) =>
  derivedIdentity(k, "payer", `${pay.toLowerCase()}/${merchantId}`);

/**
 * The `identityCommitment` to put in a payment: the merchant's payer identity on the first payment, 0 once it is a
 * member. Sending it again would publish it again and link the repeat visits (the contract would skip the join anyway).
 */
export function payerJoinCommitment(identity: Identity, groupMembers: bigint[]) {
  return groupMembers.includes(identity.commitment) ? 0n : identity.commitment;
}

/** Every identity a zip key may have used for badges, newest first (v2, then the v1 identity). */
export function zipIdentities(k: MasterKeys) {
  const legacy = semaphoreIdentity(k);
  const badge = badgeIdentity(k);
  return { badge, legacy, badges: [badge, legacy] };
}

/** The identity in `candidates` whose commitment is `commitment` (e.g. the one that made a given badge lock). */
export function identityFor(candidates: Identity[], commitment: bigint) {
  return candidates.find((i) => i.commitment === commitment) ?? null;
}

/** ZipBadges payout-recovery actions (the contract's PAYOUT_* constants). */
export const BADGE_PAYOUT = { redirect: 1, release: 2, ragequit: 3 } as const;

/**
 * Message of a ZipBadges payout-recovery proof: keccak256(abi.encode(uint8 action, uint256 target)), where target is
 * the new precommitment (redirect) or the recipient address as a number (release, ragequit). The scope comes from
 * `payoutScope(lockId)` on chain (it includes a nonce that changes after each use). The proof is a Semaphore proof by
 * the lock's identity over the one-member group {its commitment}.
 */
export function badgePayoutMessage(action: (typeof BADGE_PAYOUT)[keyof typeof BADGE_PAYOUT], target: bigint | Address) {
  const t = typeof target === "bigint" ? target : BigInt(target);
  return BigInt(keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }], [action, t])));
}

/** Domain separating badge-return notes from deposits (scope) and change notes (label). */
const BADGE_RETURN = 0x62616467652d72657475726en; // "badge-return"

/**
 * Secrets of the note a badge lock returns to when it unlocks: the `index`-th lock this key has made. Derived, so the
 * returned coins are recovered like any other note.
 */
export function badgeReturnSecrets(k: MasterKeys, index: bigint): NoteSecrets {
  return {
    nullifier: poseidon3([k.masterNullifier, BADGE_RETURN, index]),
    secret: poseidon3([k.masterSecret, BADGE_RETURN, index]),
  };
}

export type MembershipProof = {
  merkleTreeDepth: bigint;
  merkleTreeRoot: bigint;
  nullifier: bigint;
  message: bigint;
  scope: bigint;
  points: bigint[];
};

/**
 * Proving artifacts are served by us, never fetched from a third party at proving time: in Node from
 * `artifacts/semaphore/` in this package, in the browser from `/artifacts/semaphore/` on the app's own origin. Both
 * are checked against the pinned hashes in artifacts/semaphore/manifest.json when fetched
 * (scripts/fetch-semaphore-artifacts.mjs) and when copied for the web app (apps/web/scripts/copy-artifacts.mjs).
 */
export const MAX_SEMAPHORE_DEPTH = 16;

let semaphoreDir: string | null = typeof window === "undefined" ? null : `${window.location.origin}/artifacts/semaphore/`;

export const setSemaphoreArtifactsDir = (dir: string) => {
  semaphoreDir = dir.endsWith("/") || dir.endsWith("\\") ? dir : dir + "/";
};

async function semaphoreArtifacts(depth: number) {
  if (depth > MAX_SEMAPHORE_DEPTH) {
    throw new Error(`This group needs depth-${depth} Semaphore artifacts; only depths 1-${MAX_SEMAPHORE_DEPTH} are pinned (scripts/fetch-semaphore-artifacts.mjs --pin).`);
  }
  if (!semaphoreDir) {
    const { fileURLToPath } = await import(/* webpackIgnore: true */ "node:url");
    const rel = ["..", "artifacts", "semaphore", ""].join("/"); // not a literal, so bundlers leave it alone
    semaphoreDir = fileURLToPath(new URL(rel, import.meta.url));
  }
  const files = { wasm: `${semaphoreDir}semaphore-${depth}.wasm`, zkey: `${semaphoreDir}semaphore-${depth}.zkey` };
  if (typeof window === "undefined") {
    const { existsSync } = await import(/* webpackIgnore: true */ "node:fs");
    if (!existsSync(files.zkey)) throw new Error(`Semaphore artifacts missing at ${semaphoreDir}; run "node scripts/fetch-semaphore-artifacts.mjs" from the repo root.`);
  }
  return files;
}

/** Semaphore v4 proof that `identity` is one of `members`, bound to `message` and `scope` (one use per scope). */
export async function proveMembership(identity: Identity, members: bigint[], message: bigint, scope: bigint): Promise<MembershipProof> {
  const group = new Group(members);
  const depth = Math.max(1, group.depth);
  const p = await generateProof(identity, group, message, scope, depth, await semaphoreArtifacts(depth));
  return {
    merkleTreeDepth: BigInt(p.merkleTreeDepth),
    merkleTreeRoot: BigInt(p.merkleTreeRoot),
    nullifier: BigInt(p.nullifier),
    message: BigInt(p.message),
    scope: BigInt(p.scope),
    points: p.points.map(BigInt),
  };
}

/**
 * The nullifier this identity's proofs carry under `scope` (Semaphore v4: Poseidon(hash(scope), secret), where hash is
 * keccak256 >> 8). Lets a wallet find its own entries without revealing anything.
 */
export function semaphoreNullifier(identity: Identity, scope: bigint) {
  return poseidon2([BigInt(keccak256(numberToHex(scope, { size: 32 }))) >> 8n, identity.secretScalar]);
}

/**
 * Whether a courier or RPC error is Semaphore's MerkleTreeRootIsExpired (selector 0x9581a990, undecoded by callers
 * without Semaphore's ABI). Semaphore dates a root from its creation, so in a group quiet for longer than its
 * merkleTreeDuration (1 hour) any join or leave voids proofs in flight against the old root at once (A-5). Nothing was
 * spent: rebuild the group and prove again.
 */
export const isRootExpiredError = (e: unknown) => /MerkleTreeRootIsExpired|0x9581a990/i.test(e instanceof Error ? e.message : String(e));

/** Merkle siblings of `member` in a group, which ZipBadges.unlock needs to remove it. */
export function memberSiblings(members: bigint[], member: bigint): bigint[] {
  const g = new Group(members);
  const i = g.indexOf(member);
  if (i < 0) throw new Error("not a member of that group");
  return g.generateMerkleProof(i).siblings.map(BigInt);
}
