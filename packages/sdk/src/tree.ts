/**
 * Privacy Pools hashing and Merkle helpers. Ports of `hashPrecommitment`, `getCommitment` and `generateMerkleProof`
 * from @0xbow/privacy-pools-core-sdk (crypto.ts, Apache-2.0), with the same Poseidon arities and the same 32-deep
 * padded LeanIMT proofs the circuits expect.
 */
import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon1, poseidon2, poseidon3 } from "poseidon-lite";

/** BN254 scalar field: every signal and hash lives below it. */
export const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** The withdrawal circuit's fixed tree depth; shorter proofs are padded with zero siblings. */
export const MAX_TREE_DEPTH = 32;

/** Poseidon(nullifier): what the pool records when a note is spent. */
export function hashNullifier(nullifier: bigint) {
  return poseidon1([nullifier]);
}

/** Poseidon(nullifier, secret): the precommitment a depositor submits. */
export function hashPrecommitment(nullifier: bigint, secret: bigint) {
  return poseidon2([nullifier, secret]);
}

/** Poseidon(value, label, precommitment): the leaf the pool inserts for a note. */
export function hashCommitment(value: bigint, label: bigint, precommitment: bigint) {
  return poseidon3([value, label, precommitment]);
}

const pair = (a: bigint, b: bigint) => poseidon2([a, b]);

/** LeanIMT over `leaves` in insertion order, hashed pairwise with Poseidon, as in the pool's State contract. */
export function buildTree(leaves: bigint[]): LeanIMT<bigint> {
  const t = new LeanIMT<bigint>(pair);
  if (leaves.length > 0) t.insertMany(leaves);
  return t;
}

export type TreeProof = { root: bigint; depth: bigint; index: bigint; siblings: bigint[] };

/** Inclusion proof for `leaf`, in the shape the circuit takes (siblings padded to MAX_TREE_DEPTH). */
export function proveLeaf(leaves: bigint[], leaf: bigint): TreeProof {
  const t = buildTree(leaves);
  const at = t.indexOf(leaf);
  if (at === -1) throw new Error("leaf not in tree");
  const { siblings, index } = t.generateProof(at);
  const padded = siblings.concat(Array<bigint>(Math.max(0, MAX_TREE_DEPTH - siblings.length)).fill(0n));
  return { root: t.root, depth: BigInt(t.depth), index: BigInt(index), siblings: padded };
}
