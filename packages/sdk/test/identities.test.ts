import { Identity } from "@semaphore-protocol/core";
import { encodeAbiParameters, keccak256 } from "viem";
import { describe, expect, it } from "vitest";

import { masterKeys } from "../src/keys";
import { badgeRewardAccount } from "../src/rewards";
import {
  BADGE_PAYOUT,
  badgeIdentity,
  badgeLockIdentity,
  badgePayoutMessage,
  derivedIdentity,
  identityFor,
  payerIdentity,
  payerJoinCommitment,
  proverIn,
  scanBadgeLockIdentities,
  semaphoreIdentity,
  zipIdentities,
} from "../src/semaphore";

const PHRASE = "test test test test test test test test test test test junk";
const OTHER = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const PAY = "0x1111111111111111111111111111111111111111" as const;
const OTHER_PAY = "0x2222222222222222222222222222222222222222" as const;

describe("per-purpose Semaphore identities (M-11)", () => {
  const k = masterKeys(PHRASE);

  it("keeps the v1 identity unchanged, so old badge locks still resolve", () => {
    // Pinned: the commitment the pre-M-11 SDK derived for this phrase (HKDF(master secret, "zipnet semaphore v1"))
    expect(semaphoreIdentity(k).commitment).toBe(21265178895394841828426140348987535503968202130518838248128674951690927458586n);
    expect(zipIdentities(k).legacy.commitment).toBe(semaphoreIdentity(k).commitment);
  });

  it("derives a distinct identity per purpose, and per merchant and pay contract for payer groups", () => {
    const all = [
      semaphoreIdentity(k),
      badgeIdentity(k),
      payerIdentity(k, PAY, 1n),
      payerIdentity(k, PAY, 2n),
      payerIdentity(k, OTHER_PAY, 1n),
    ].map((i) => i.commitment);
    expect(new Set(all).size).toBe(all.length);
  });

  it("is deterministic from the zip key alone (a restored wallet gets the same identities)", () => {
    const again = masterKeys(PHRASE);
    expect(badgeIdentity(again).commitment).toBe(badgeIdentity(k).commitment);
    expect(payerIdentity(again, PAY, 7n).commitment).toBe(payerIdentity(k, PAY, 7n).commitment);
    // pay addresses are case-insensitive
    expect(payerIdentity(k, PAY.toUpperCase().replace("0X", "0x") as `0x${string}`, 7n).commitment).toBe(
      payerIdentity(k, PAY, 7n).commitment,
    );
  });

  it("differs between zip keys", () => {
    const o = masterKeys(OTHER);
    expect(badgeIdentity(o).commitment).not.toBe(badgeIdentity(k).commitment);
    expect(payerIdentity(o, PAY, 1n).commitment).not.toBe(payerIdentity(k, PAY, 1n).commitment);
  });

  it("separates the domains: a purpose can't be reached through another's context", () => {
    expect(derivedIdentity(k, "payer").commitment).not.toBe(badgeIdentity(k).commitment);
    expect(derivedIdentity(k, "badge", "").commitment).not.toBe(badgeIdentity(k).commitment);
  });

  it("zipIdentities lists v2 first, then v1, and identityFor finds a lock's identity", () => {
    const ids = zipIdentities(k);
    expect(ids.badges.map((i) => i.commitment)).toEqual([badgeIdentity(k).commitment, semaphoreIdentity(k).commitment]);
    expect(identityFor(ids.badges, semaphoreIdentity(k).commitment)).toBe(ids.legacy);
    expect(identityFor(ids.badges, new Identity("someone else").commitment)).toBeNull();
  });

  it("derives one badge identity per lock (A-7), apart from the one-per-key badge and v1 identities", () => {
    const a = badgeLockIdentity(k, 0n);
    const b = badgeLockIdentity(k, 1n);
    expect(a.commitment).not.toBe(b.commitment);
    expect(a.commitment).toBe(derivedIdentity(k, "badge", "0").commitment);
    expect(a.commitment).not.toBe(badgeIdentity(k).commitment);
    expect(a.commitment).not.toBe(semaphoreIdentity(k).commitment);
    expect(badgeLockIdentity(masterKeys(OTHER), 0n).commitment).not.toBe(a.commitment);
  });

  it("derives one badge ETH reward address per lock (I-3), keeping the one-per-key address for older locks", () => {
    const perKey = badgeRewardAccount(k).address;
    expect(badgeRewardAccount(k, 0n).address).not.toBe(perKey);
    expect(badgeRewardAccount(k, 0n).address).not.toBe(badgeRewardAccount(k, 1n).address);
    expect(badgeRewardAccount(k, 3n).address).toBe(badgeRewardAccount(masterKeys(PHRASE), 3n).address);
  });

  it("finds per-lock identities by scanning indices past gaps, as a restored wallet would", () => {
    const used = new Set([badgeLockIdentity(k, 2n).commitment, badgeLockIdentity(k, 9n).commitment, badgeLockIdentity(k, 25n).commitment]);
    const found = scanBadgeLockIdentities(k, (c) => used.has(c), 2, 20).map(([i]) => i);
    expect(found).toEqual([2n, 9n, 25n]);
    expect(scanBadgeLockIdentities(k, (c) => used.has(c), 0, 5).map(([i]) => i)).toEqual([2n]);
  });

  it("proves with the first candidate in the group, so a v1 lock doesn't shadow a higher-tier lock (A-8)", () => {
    const tier3 = badgeLockIdentity(k, 1n);
    const legacy = semaphoreIdentity(k);
    const tier3Group = [5n, tier3.commitment];
    const tier1Group = [legacy.commitment, tier3.commitment, 7n];
    expect(proverIn([tier3, legacy], tier3Group)).toBe(tier3);
    expect(proverIn([tier3, legacy], tier1Group)).toBe(tier3);
    expect(proverIn([legacy], tier3Group)).toBeNull();
  });

  it("sends a payer identity only on the first payment at a merchant", () => {
    const id = payerIdentity(k, PAY, 3n);
    expect(payerJoinCommitment(id, [1n, 2n])).toBe(id.commitment);
    expect(payerJoinCommitment(id, [1n, id.commitment])).toBe(0n);
  });

  it("badgePayoutMessage matches ZipBadges.payoutMessage (keccak256(abi.encode(uint8, uint256)))", () => {
    const to = "0x000000000000000000000000000000000000bEEF" as const;
    expect(badgePayoutMessage(BADGE_PAYOUT.release, to)).toBe(
      BigInt(keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }], [2, BigInt(to)]))),
    );
    expect(badgePayoutMessage(BADGE_PAYOUT.redirect, 123n)).toBe(
      BigInt(keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }], [1, 123n]))),
    );
  });
});
