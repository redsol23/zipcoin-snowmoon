import { describe, expect, it } from "vitest";

import { BADGE_PAYOUT, badgeIdentity, badgePayoutMessage, badgePayoutProof, masterKeys } from "../src/index";

describe("badge payout recovery", () => {
  it("a badge payout proof is the lock identity's SoloProof, bound to the action and target", async () => {
    const identity = badgeIdentity(masterKeys("test test test test test test test test test test test junk"));
    const to = "0x00000000000000000000000000000000000000bb" as const;
    const p = await badgePayoutProof(identity, 77n, BADGE_PAYOUT.release, to);
    // ZipBadges' SoloProof: the group {identity} has the identity as its root, and the message names the target
    expect(p.merkleTreeRoot).toBe(identity.commitment);
    expect(p.merkleTreeDepth).toBe(1n);
    expect(p.scope).toBe(77n);
    expect(p.message).toBe(badgePayoutMessage(BADGE_PAYOUT.release, to));
    expect(p.points).toHaveLength(8);
  }, 60_000);
});
