import assert from "node:assert/strict";
import { test } from "node:test";

import { keccak256, toHex } from "viem";

import { addr, at, E, FakeChain, makeStats, SAFE } from "./testkit";

const A = addr(0xa);
const B = addr(0xb);
const COURIER = addr(0xc0c0);
const LISTED = addr(0xd);
const FUNDER = addr(0xf);
const FUNDED = addr(0xfe);
const POSTMAN = addr(0x9057);

type Window = { deposits: number; projectDeposits: number; outsideDeposits: number; outsideDepositors: number; outsideValue: string; buckets: { minZc: number; maxZc: number | null; deposits: number }[] };
type Report = { enabled: boolean; windows: Record<string, Window>; pool: Record<string, number>; method: { summary: string; steps: string[]; caveats: string[] } };

function chain() {
  const c = new FakeChain();
  c.onRead(at("bands"), "SAFE", SAFE);
  const dep = (who: string, value: bigint, block: bigint) => c.emit(at("pool"), "Deposited", block, { _depositor: who, _commitment: 1n, _label: 1n, _value: value, _precommitmentHash: 1n });
  // Outside: A three times (once long ago), B once
  dep(A, 50n * E, 20n);
  dep(A, 500n * E, 60_000n);
  dep(A.toUpperCase().replace("0X", "0x"), 5_000n * E, 99_000n); // same address, other case
  dep(B, 250_000n * E, 99_500n);
  // The project's own: a courier's cover traffic, a rezip, a contract that is off, the Safe, the postman, a listed
  // wallet (a Veridia resident, say), and a wallet a project funder sent ZC to
  c.emit(at("couriers"), "Bonded", 15n, { courier: COURIER, stake: 1000n * E, endpoint: "https://c.example" });
  c.emit(at("entrypoint"), "RoleGranted", 10n, { role: keccak256(toHex("ASP_POSTMAN")), account: POSTMAN, sender: POSTMAN });
  c.emit(at("zc"), "Transfer", 30n, { from: FUNDER, to: FUNDED, value: 10n * E });
  c.emit(at("zc"), "Transfer", 30n, { from: A, to: B, value: 10n * E }); // not a funder: B stays outside
  for (const who of [COURIER, at("rezip"), at("batchRelayer"), SAFE, POSTMAN, LISTED, FUNDED, FUNDER]) dep(who, 100n * E, 99_900n);
  c.emit(at("pool"), "Withdrawn", 99_950n, { _processooor: at("pay"), _value: 1n, _spentNullifier: 1n, _newCommitment: 1n });
  return c;
}

test("counts distinct outside depositors per window, leaving out the project's own addresses", async () => {
  const s = makeStats(chain(), { exclude: [LISTED], funders: [FUNDER] });
  await s.refresh();
  const r = s.privacy as unknown as Report;
  assert.equal(r.enabled, true);
  assert.deepEqual(
    Object.fromEntries(Object.entries(r.windows).map(([w, v]) => [w, [v.deposits, v.outsideDeposits, v.outsideDepositors, v.projectDeposits]])),
    { "24h": [10, 2, 2, 8], "7d": [11, 3, 2, 8], all: [12, 4, 2, 8] },
  );
  assert.equal(r.windows["24h"].outsideValue, (255_000n * E).toString());
  assert.deepEqual(r.pool, { depositsEver: 12, withdrawalsEver: 1, ragequitsEver: 0 });
});

test("note sizes go into five coarse buckets", async () => {
  const s = makeStats(chain(), { exclude: [LISTED], funders: [FUNDER] });
  await s.refresh();
  const all = (s.privacy as unknown as Report).windows.all.buckets;
  assert.deepEqual(
    all.map((b) => [b.minZc, b.maxZc, b.deposits]),
    [
      [0, 100, 1],
      [100, 1000, 1],
      [1000, 10000, 1],
      [10000, 100000, 0],
      [100000, null, 1],
    ],
  );
});

test("without the operator's list, unknown project wallets count as outside (the page says so)", async () => {
  const s = makeStats(chain());
  await s.refresh();
  const r = s.privacy as unknown as Report;
  // LISTED, FUNDED and FUNDER now count; couriers, contracts, the Safe and the postman are still left out on-chain
  assert.equal(r.windows["24h"].outsideDepositors, 5);
  assert.ok(r.method.caveats.some((c) => /project wallet we don't know about/.test(c)));
});

test("the report never contains an address", async () => {
  const s = makeStats(chain(), { exclude: [LISTED], funders: [FUNDER] });
  await s.refresh();
  assert.doesNotMatch(JSON.stringify(s.privacy), /0x[0-9a-fA-F]{40}/);
  assert.equal((s.privacy as Record<string, unknown>).excluded, undefined, "not even how many were left out");
});

test("the method is spelled out for the page", async () => {
  const s = makeStats(chain());
  await s.refresh();
  const m = (s.privacy as unknown as Report).method;
  assert.ok(m.summary.length > 50 && m.steps.length >= 3 && m.caveats.length >= 3);
});
