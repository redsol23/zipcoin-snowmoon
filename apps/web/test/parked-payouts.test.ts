import { entrypointAbi, poolAbi, type Note } from "@zipnet/sdk";
import { encodeErrorResult, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import {
  canRedirect,
  collectPayouts,
  explainPark,
  parkWhy,
  payoutKey,
  resolveOwners,
  UNAPPROVED_AFTER_SEC,
  type DepositLog,
  type ParkLog,
  type PayoutAuth,
  type PoolStatus,
} from "../src/components/wallet/payouts-parked";

const E18 = 10n ** 18n;
const OPEN: PoolStatus = { exists: true, dead: false, minDeposit: 1n * E18 };
const err = (errorName: string, abi: readonly unknown[] = entrypointAbi) => encodeErrorResult({ abi: abi as never, errorName } as never) as Hex;

const park = (o: Partial<ParkLog> & Pick<ParkLog, "source" | "id">): ParkLog => ({ amount: 100n * E18, precommitment: 1n, reason: err("PrecommitmentAlreadyUsed"), block: 10n, ...o });
const deposit = (o: Partial<DepositLog> & Pick<DepositLog, "source" | "id" | "label">): DepositLog => ({ amount: 100n * E18, precommitment: 2n, commitment: 3n, block: 20n, ...o });
const note = (label: bigint, value = 99n * E18): Note => ({ label, value, nullifier: 5n, secret: 6n, commitment: 7n, children: 0n, origin: "deposit" });

describe("why a payout parked", () => {
  it("decodes the pool's revert", () => {
    expect(parkWhy(err("PrecommitmentAlreadyUsed"), 5n * E18, OPEN)).toBe("precommitment-used");
    expect(parkWhy(err("PoolNotFound"), 5n * E18, OPEN)).toBe("pool-removed");
    expect(parkWhy(err("PoolIsDead", poolAbi), 5n * E18, OPEN)).toBe("pool-dead");
    expect(parkWhy(err("MinimumDepositAmount"), 5n * E18, OPEN)).toBe("below-minimum");
    expect(parkWhy("0x12345678", 5n * E18, OPEN)).toBe("other");
  });

  it("an empty reason means the contract didn't try: no pool, or under the minimum", () => {
    expect(parkWhy("0x", 5n * E18, { ...OPEN, exists: false })).toBe("pool-removed");
    expect(parkWhy("0x", E18 / 2n, OPEN)).toBe("below-minimum");
  });

  it("says in plain words, and only offers the pool when it can take the coins", () => {
    expect(explainPark("precommitment-used", "badge", OPEN, 5n * E18)).toMatch(/Someone deposited under the one-time code your badge stake.*back into the pool/);
    expect(explainPark("pool-dead", "badge", { ...OPEN, dead: true }, 5n * E18)).toMatch(/can only go to an address/);
    expect(explainPark("below-minimum", "badge", OPEN, E18 / 2n)).toMatch(/^Your badge stake was smaller.*minimum deposit \(1 ZC\)/);
    expect(canRedirect(5n * E18, OPEN)).toBe(true);
    expect(canRedirect(E18 / 2n, OPEN)).toBe(false);
    expect(canRedirect(5n * E18, { ...OPEN, dead: true })).toBe(false);
    expect(canRedirect(5n * E18, { ...OPEN, exists: false })).toBe(false);
  });
});

describe("whose payout it is", () => {
  const owners = resolveOwners({
    locks: [
      { lockId: 1n, identityCommitment: 111n, unlocked: true },
      { lockId: 2n, identityCommitment: 111n, unlocked: false },
    ],
  });

  it("badge locks once unlocked, by the identity that made them", () => {
    expect(owners.get("badge:1")).toEqual({ kind: "identity", commitment: 111n });
    expect(owners.has("badge:2")).toBe(false);
  });
});

describe("what needs the owner", () => {
  const auth: PayoutAuth = { kind: "identity", commitment: 1n };
  const now = 10_000_000;
  const base = {
    parks: [] as ParkLog[],
    deposits: [] as DepositLog[],
    parkedNow: new Map<string, bigint>(),
    notes: [] as Note[],
    approvedLabels: new Set<bigint>(),
    pool: OPEN,
    depositTime: () => now - UNAPPROVED_AFTER_SEC - 1,
    now,
  };

  it("lists a parked payout with its amount and latest reason", () => {
    const out = collectPayouts({
      ...base,
      owners: new Map([["badge:1", auth]]),
      parks: [park({ source: "badge", id: 1n, block: 5n, reason: "0x" }), park({ source: "badge", id: 1n, block: 9n })],
      parkedNow: new Map([["badge:1", 200n * E18]]),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ state: "parked", source: "badge", id: 1n, amount: 200n * E18, why: "precommitment-used", canRedirect: true, auth });
    expect(out[0].title).toMatch(/Badge lock #1/);
  });

  it("drops it once redirected or released, and ignores payouts that aren't ours", () => {
    const out = collectPayouts({
      ...base,
      owners: new Map([["badge:3", auth]]),
      parks: [park({ source: "badge", id: 3n }), park({ source: "badge", id: 4n })],
      parkedNow: new Map([
        ["badge:3", 0n],
        ["badge:4", 50n * E18],
      ]),
    });
    expect(out).toEqual([]);
  });

  it("offers the ragequit for a payout note the ASP hasn't approved after a day, and only then", () => {
    const owners = new Map([["badge:3", auth]]);
    const deposits = [deposit({ source: "badge", id: 3n, label: 77n, block: 20n }), deposit({ source: "badge", id: 3n, label: 78n, block: 30n })];
    // The latest deposit (a redirect) is the one that counts
    const stuck = collectPayouts({ ...base, owners, deposits, notes: [note(78n)] });
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toMatchObject({ state: "unapproved", id: 3n, amount: 99n * E18 });
    expect(stuck[0].state === "unapproved" && stuck[0].note.label).toBe(78n);
    expect(stuck[0].explanation).toMatch(/ragequit/);

    expect(collectPayouts({ ...base, owners, deposits, notes: [note(77n)] })).toEqual([]);
    expect(collectPayouts({ ...base, owners, deposits, notes: [note(78n)], approvedLabels: new Set([78n]) })).toEqual([]);
    expect(collectPayouts({ ...base, owners, deposits, notes: [note(78n)], depositTime: () => now - 60 })).toEqual([]);
    expect(collectPayouts({ ...base, owners, deposits, notes: [note(78n)], depositTime: () => undefined })).toEqual([]);
    expect(collectPayouts({ ...base, owners, deposits, notes: [note(78n, 0n)] })).toEqual([]);
  });

  it("a parked payout under the pool's minimum can't be redirected", () => {
    const out = collectPayouts({
      ...base,
      owners: new Map([["badge:1", auth]]),
      parks: [park({ source: "badge", id: 1n, reason: "0x" })],
      parkedNow: new Map([["badge:1", E18 / 2n]]),
    });
    expect(out[0]).toMatchObject({ state: "parked", why: "below-minimum", canRedirect: false });
  });

  it("lists parked payouts first, largest first", () => {
    const owners = new Map<string, PayoutAuth>([
      ["badge:1", auth],
      ["badge:2", auth],
      ["badge:3", auth],
    ]);
    const out = collectPayouts({
      ...base,
      owners,
      parks: [park({ source: "badge", id: 1n }), park({ source: "badge", id: 2n })],
      parkedNow: new Map([
        ["badge:1", 5n * E18],
        ["badge:2", 9n * E18],
      ]),
      deposits: [deposit({ source: "badge", id: 3n, label: 78n })],
      notes: [note(78n, 500n * E18)],
    });
    expect(out.map((p) => p.key)).toEqual(["badge:2", "badge:1", "badge:3"]);
  });
});

describe("the courier job", () => {
  it("names one of the courier's payout kinds and orders the arguments as the contract takes them", async () => {
    const { recoveryJob } = await import("../src/components/wallet/parked-scan");
    const to = "0x00000000000000000000000000000000000000bb" as const;
    expect(recoveryJob("badge", { action: "redirect" }, 1n, 5n, "auth")).toEqual({ kind: "badgeRedirect", args: [1n, 5n, "auth"] });
    expect(recoveryJob("badge", { action: "release", to }, 2n, to, "auth")).toEqual({ kind: "badgeRelease", args: [2n, to, "auth"] });
    expect(recoveryJob("badge", { action: "ragequit", to }, 3n, to, "auth", "proof")).toEqual({ kind: "badgeRagequit", args: [3n, "proof", to, "auth"] });
  });
});
