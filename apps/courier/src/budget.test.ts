import assert from "node:assert/strict";
import { test } from "node:test";

import { clientKey, FreeBudget } from "./budget";

const make = (over: Partial<ConstructorParameters<typeof FreeBudget>[0]> = {}) => {
  let t = Date.UTC(2026, 8, 29, 12);
  const b = new FreeBudget({ perDay: 10, reservedShare: 0.2, kindShare: 0.5, perClientPerHour: 0, critical: new Set(["badgeRelease", "badgeRedirect"]), now: () => t, ...over });
  return { b, advance: (ms: number) => (t += ms) };
};

/** A job the way accept() runs it: admit, simulate, then spend if the simulation passed */
const run = (b: FreeBudget, kind: string, simulates = true, client: string | null = null) => {
  const r = b.admit(kind, client);
  if (r) return r;
  if (!simulates) return "simulation reverted";
  const again = b.room(kind);
  if (again) return again;
  b.spend(kind);
  return null;
};

test("M-3: junk that fails simulation doesn't use the budget", () => {
  const { b } = make();
  for (let i = 0; i < 1000; i++) assert.equal(run(b, "vote", false), "simulation reverted");
  assert.equal(b.usedToday, 0);
  assert.equal(run(b, "vote"), null);
});

test("M-3: one kind can't take more than its share, and the reserve is kept for payout recovery", () => {
  const { b } = make();
  for (let i = 0; i < 5; i++) assert.equal(run(b, "vote"), null);
  assert.match(run(b, "vote") ?? "", /vote jobs are used up/);
  for (let i = 0; i < 3; i++) assert.equal(run(b, "post"), null);
  // 8 of 10 used by general kinds: the last 2 are reserved
  assert.match(run(b, "unlock") ?? "", /kept for payout recovery/);
  assert.equal(run(b, "badgeRelease"), null);
  assert.equal(run(b, "badgeRedirect"), null);
  assert.match(run(b, "badgeRelease") ?? "", /used up for today/);
});

test("M-3: payout recovery can use the whole day, and the budget resets at UTC midnight", () => {
  const { b, advance } = make();
  for (let i = 0; i < 10; i++) assert.equal(run(b, "badgeRelease"), null);
  assert.match(run(b, "badgeRelease") ?? "", /used up/);
  advance(12 * 3_600_000);
  assert.equal(run(b, "badgeRelease"), null);
});

test("M-3: per-client attempts per hour, counted before simulation", () => {
  const { b, advance } = make({ perDay: 1000, perClientPerHour: 3 });
  assert.equal(run(b, "vote", false, "1.1.1.1"), "simulation reverted");
  assert.equal(run(b, "vote", true, "1.1.1.1"), null);
  assert.equal(run(b, "vote", true, "1.1.1.1"), null);
  assert.match(run(b, "vote", true, "1.1.1.1") ?? "", /too many/);
  assert.equal(run(b, "vote", true, "2.2.2.2"), null, "another client is unaffected");
  assert.equal(run(b, "vote", true, null), null, "no client key: not limited per client");
  advance(3_600_001);
  assert.equal(run(b, "vote", true, "1.1.1.1"), null);
});

test("client keys: the forwarded address behind a trusted proxy; never a shared private or loopback address", () => {
  assert.equal(clientKey("172.18.0.5", "9.9.9.9, 1.2.3.4", true), "1.2.3.4");
  assert.equal(clientKey("172.18.0.5", undefined, true), null);
  assert.equal(clientKey("172.18.0.5", "1.2.3.4", false), null, "an untrusted header is ignored");
  assert.equal(clientKey("::ffff:127.0.0.1", undefined, false), null);
  assert.equal(clientKey("203.0.113.9", undefined, false), "203.0.113.9");
});
