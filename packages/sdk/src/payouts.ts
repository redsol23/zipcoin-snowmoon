/**
 * Recovering a badge lock's stake whose re-zip failed at unlock.
 *
 * ZipBadges deposits a lock's stake back into the pool at unlock, under the precommitment chosen when it was locked.
 * If that deposit fails (someone used the precommitment first, or the pool is gone) the stake is parked, and the
 * lock's identity can re-zip it under a new precommitment, send it to an address, or ragequit its note.
 */
import type { Address } from "viem";

import type { Identity } from "@semaphore-protocol/core";

import { BADGE_PAYOUT, badgePayoutMessage, proveMembership, type MembershipProof } from "./semaphore";

/**
 * ZipBadges authorises recovering a lock's payout with a Semaphore proof by the lock's identity over the one-member
 * group {that identity} (SoloProof), whose message binds the action and target (`badgePayoutMessage`). `scope` is
 * `payoutScope(lockId)` read from the chain: it carries a nonce, so each proof works once.
 */
export function badgePayoutProof(
  identity: Identity,
  scope: bigint,
  action: (typeof BADGE_PAYOUT)[keyof typeof BADGE_PAYOUT],
  target: bigint | Address,
): Promise<MembershipProof> {
  return proveMembership(identity, [identity.commitment], badgePayoutMessage(action, target), scope);
}
