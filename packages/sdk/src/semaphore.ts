/**
 * Badges and anonymous groups. A zip key also carries a Semaphore identity, so one wallet signature unlocks both the
 * coins and the badge, and the same wallet always gets the same identity back.
 */
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { generateProof, Group, Identity } from "@semaphore-protocol/core";
import { numberToBytes } from "viem";
import { poseidon3 } from "poseidon-lite";

import type { MasterKeys, NoteSecrets } from "./keys";

/** The zip key's Semaphore identity (its private key is HKDF-derived from the master secret). */
export function semaphoreIdentity(k: MasterKeys) {
  const sk = hkdf(sha256, numberToBytes(k.masterSecret, { size: 32 }), undefined, new TextEncoder().encode("zipnet semaphore v1"), 32);
  return new Identity(sk);
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

/** Semaphore v4 proof that `identity` is one of `members`, bound to `message` and `scope` (one use per scope). */
export async function proveMembership(identity: Identity, members: bigint[], message: bigint, scope: bigint): Promise<MembershipProof> {
  const p = await generateProof(identity, new Group(members), message, scope);
  return {
    merkleTreeDepth: BigInt(p.merkleTreeDepth),
    merkleTreeRoot: BigInt(p.merkleTreeRoot),
    nullifier: BigInt(p.nullifier),
    message: BigInt(p.message),
    scope: BigInt(p.scope),
    points: p.points.map(BigInt),
  };
}

/** Merkle siblings of `member` in a group, which ZipBadges.unlock needs to remove it. */
export function memberSiblings(members: bigint[], member: bigint): bigint[] {
  const g = new Group(members);
  const i = g.indexOf(member);
  if (i < 0) throw new Error("not a member of that group");
  return g.generateMerkleProof(i).siblings.map(BigInt);
}
