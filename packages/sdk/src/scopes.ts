/**
 * Semaphore scopes of the badge-gated contracts, mirrored off-chain.
 *
 * Every scope is keccak256(abi.encode(tag, contract, chainId, ...ids)): naming the contract and the chain keeps a
 * redeployment (or another chain) from sharing a nullifier space with this one. Each contract keeps its own set of
 * spent nullifiers (it checks proofs with Semaphore's view `verifyProof`), so a proof copied from the mempool and fed
 * straight to Semaphore can't burn a pending action.
 */
import { encodeAbiParameters, hexToBigInt, keccak256, type Address } from "viem";

/** keccak256(abi.encode(tag, contract, chainId, ...ids)) as a bigint */
export const contractScope = (tag: string, contract: Address, chainId: bigint | number, ...ids: bigint[]): bigint =>
  hexToBigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "string" }, { type: "address" }, { type: "uint256" }, ...ids.map(() => ({ type: "uint256" }) as const)],
        [tag, contract, BigInt(chainId), ...ids],
      ),
    ),
  );

/** ZipSignal.scopeOf: one post per member, group, day and slot (the group keeps posts in two tiers unlinkable) */
export const signalScope = (signal: Address, chainId: bigint | number, groupId: bigint, day: bigint, slot: bigint) =>
  contractScope("zipnet.post", signal, chainId, groupId, day, slot);

/** ZipPolls.scopeOf: one vote per member per poll */
export const pollScope = (polls: Address, chainId: bigint | number, pollId: bigint) => contractScope("zipnet.poll", polls, chainId, pollId);

/** ZipBadges.payoutScope: a lock's payout-recovery proofs, single use via the lock's payout nonce */
export const badgePayoutScope = (badges: Address, chainId: bigint | number, lockId: bigint, nonce: bigint) =>
  contractScope("zipnet.badge.payout", badges, chainId, lockId, nonce);

/**
 * Checks a `payoutScope(lockId)` read from the RPC against local recomputation (A-9): ZipBadges exposes no nonce
 * getter, so this finds the nonce (a small counter) that reproduces it, and throws if none does, rather than proving
 * over a scope that may belong to another action.
 */
export function checkBadgePayoutScope(scope: bigint, badges: Address, chainId: bigint | number, lockId: bigint, maxNonce = 256n): bigint {
  for (let n = 0n; n < maxNonce; n++) if (badgePayoutScope(badges, chainId, lockId, n) === scope) return scope;
  throw new Error("The payout-recovery scope from the RPC doesn't match this lock, so no proof was made.");
}
