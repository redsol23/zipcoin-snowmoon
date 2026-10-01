import assert from "node:assert/strict";
import { test } from "node:test";

import { keccak256, toHex } from "viem";

import { addr, at, DEP, E, FakeChain, KEYS, makeStats, SAFE } from "./testkit";

const OWNER_ROLE = keccak256(toHex("OWNER_ROLE"));
const POSTMAN_ROLE = keccak256(toHex("ASP_POSTMAN"));
const DEPLOYER = addr(0xdead01);
const POSTMAN = addr(0x9057);
const HIDDEN = ["batchRelayer", "semaphore"] as const;

type Ledger = {
  contracts: { key: string; address: string | null; control: string; balances?: Record<string, string | null>; live?: Record<string, unknown> }[];
  flows: Record<string, Record<string, Record<string, string | number>> & { deposited?: never }>;
  windows: Record<string, { fromBlock: string }>;
};

function chain() {
  const c = new FakeChain();
  c.onRead(at("bands"), "SAFE", SAFE).onRead(at("bands"), "paused", false);
  c.onRead(at("pay"), "TREASURY", at("bands")).onRead(at("pay"), "TAX_BPS", 100n).onRead(at("pay"), "BURN_SHARE_BPS", 5000n).onRead(at("pay"), "COURIER_SHARE_BPS", 3000n);
  c.onRead(at("pool"), "TREASURY", SAFE);
  c.onRead(SAFE, "getThreshold", 2n).onRead(SAFE, "getOwners", [addr(0xa1), addr(0xa2), addr(0xa3)]);
  // ZC balances and holder rewards: every holder but the token itself
  c.onRead(at("zc"), "balanceOf", ([a]: readonly unknown[]) => ((a as string).toLowerCase() === at("pool").toLowerCase() ? 5_000n * E : 7n * E));
  c.onRead(at("zc"), "pendingReward", () => 3n);
  c.balances.set(SAFE.toLowerCase(), 2n * E);
  c.storage.set(at("entrypoint").toLowerCase(), `0x000000000000000000000000${"ab".repeat(20)}`);
  // Entrypoint roles: the deployer hands the owner role to the Safe
  c.emit(at("entrypoint"), "RoleGranted", 10n, { role: OWNER_ROLE, account: DEPLOYER, sender: DEPLOYER });
  c.emit(at("entrypoint"), "RoleGranted", 10n, { role: POSTMAN_ROLE, account: POSTMAN, sender: DEPLOYER });
  c.emit(at("entrypoint"), "RoleGranted", 11n, { role: OWNER_ROLE, account: SAFE, sender: DEPLOYER });
  c.emit(at("entrypoint"), "RoleRevoked", 11n, { role: OWNER_ROLE, account: DEPLOYER, sender: DEPLOYER });
  // Sales tax: one split in the last day, one this week, one long ago
  c.emit(at("pay"), "TaxSplit", 99_000n, { burned: 50n, toCouriers: 30n, toTreasury: 20n });
  c.emit(at("pay"), "TaxSplit", 60_000n, { burned: 500n, toCouriers: 300n, toTreasury: 200n });
  c.emit(at("pay"), "TaxSplit", 100n, { burned: 5000n, toCouriers: 3000n, toTreasury: 2000n });
  // The bands: ZC deposits (above the launch range), fees to the Safe, harvested ETH forwarded to the Safe
  c.emit(at("bands"), "Deposited", 95_000n, { band: 0, tokenId: 1n, liquidity: 1n, zcIn: 1_000_000n * E, caller: addr(0xc1) });
  c.emit(at("bands"), "Deposited", 1_000n, { band: 1, tokenId: 2n, liquidity: 1n, zcIn: 500_000n * E, caller: addr(0xc1) });
  c.emit(at("bands"), "FeesCollected", 99_500n, { band: 0, eth: 7n, zc: 9n });
  c.emit(at("bands"), "EthToSafe", 99_600n, { eth: E / 20n });
  // Pool harvests
  c.emit(at("pool"), "Harvested", 50_000n, { claimed: E, forwarded: E });
  // Activity on contracts that are off must not show up anywhere
  c.emit(at("batchRelayer"), "TaxSplit", 99_000n, { burned: 1n, toCouriers: 1n, toTreasury: 1n });
  return c;
}

test("the ledger lists the allowlisted contracts with who controls them and live balances", async () => {
  const s = makeStats(chain());
  await s.refresh();
  const l = s.ledger as Ledger;
  assert.deepEqual(
    l.contracts.map((c) => c.key),
    ["pool", "entrypoint", "zc", "pay", "merchants", "couriers", "badges", "signal", "polls", "broadcaster", "doorstep", "rezip", "addressRegistry", "bands", "safe"],
  );
  const by = Object.fromEntries(l.contracts.map((c) => [c.key, c]));
  assert.equal(by.safe.address, SAFE, "the Safe is read from the bands contract");
  assert.deepEqual(by.safe.live, { isSafe: true, threshold: 2, signers: 3 });
  assert.equal(by.safe.balances!.eth, (2n * E).toString());
  assert.equal(by.pool.balances!.zc, (5_000n * E).toString());
  assert.equal(by.pool.balances!.zcRewardsPending, "3");
  assert.equal(by.zc.balances!.zc, null, "the token doesn't hold itself");
  const ep = by.entrypoint.live as { owners: { address: string; is: string | null }[]; postman: string[]; implementation: string };
  assert.deepEqual(ep.owners, [{ address: SAFE, is: "treasury Safe" }], "the deployer renounced; the Safe owns it");
  assert.deepEqual(ep.postman, [POSTMAN]);
  assert.equal(ep.implementation, `0x${"ab".repeat(20)}`);
  assert.deepEqual((by.pay.live as { split: unknown }).split, { burnBps: 5000, couriersBps: 3000, treasuryBps: 2000 });
});

test("flows are summed over 24h, 7d and all time", async () => {
  const s = makeStats(chain());
  await s.refresh();
  const l = s.ledger as Ledger;
  assert.equal(l.windows["24h"].fromBlock, "92800");
  assert.equal(l.windows["7d"].fromBlock, "49600");
  assert.equal(l.windows.all.fromBlock, "10");
  const tax = l.flows.salesTax;
  assert.deepEqual(tax["24h"], { count: 1, burned: "50", couriers: "30", treasury: "20" });
  assert.deepEqual(tax["7d"], { count: 2, burned: "550", couriers: "330", treasury: "220" });
  assert.deepEqual(tax.all, { count: 3, burned: "5550", couriers: "3330", treasury: "2220" });
  const bands = l.flows.bands as unknown as Record<string, Record<string, Record<string, string | number>>>;
  // ZC deposited above the launch range (ZC only), fees to the Safe, ETH forwarded to the Safe (never deposited)
  assert.deepEqual(bands.deposited["24h"], { count: 1, zc: (1_000_000n * E).toString() });
  assert.deepEqual(bands.deposited.all, { count: 2, zc: (1_500_000n * E).toString() });
  assert.deepEqual(bands.feesToSafe["24h"], { count: 1, eth: "7", zc: "9" });
  assert.deepEqual(bands.ethToSafe["24h"], { count: 1, eth: (E / 20n).toString() });
  assert.deepEqual(bands.ethToSafe.all, { count: 1, eth: (E / 20n).toString() });
  assert.deepEqual(l.flows.poolHarvests["24h"], { count: 0, claimed: "0", forwarded: "0" });
  assert.deepEqual(l.flows.poolHarvests["7d"], { count: 1, claimed: E.toString(), forwarded: E.toString() });
});

test("nothing about a contract that is off appears in any document", async () => {
  const s = makeStats(chain());
  await s.refresh();
  const all = JSON.stringify([s.ledger, s.privacy, s.status]).toLowerCase();
  for (const k of HIDDEN) {
    assert.ok(!all.includes((DEP[k] as string).toLowerCase()), `${k}'s address leaked`);
    assert.ok(!all.includes(`"${k.toLowerCase()}"`), `${k} named`);
  }
  // The Safe's signers are people's keys: only their count is served
  for (const n of [0xa1, 0xa2, 0xa3]) assert.ok(!all.includes(addr(n).toLowerCase()));
});

test("switching an entry off removes it and its flows", async () => {
  const { parseAllowlist } = await import("./allowlist");
  const allow = parseAllowlist({
    contracts: [{ key: "pool", show: true, name: "Pool", contract: "ZipPrivacyPool", control: "none", role: "holds notes", controller: "No owner." }, { key: "pay", show: false }, { key: "bands", show: false }],
  });
  const s = makeStats(chain(), { allow });
  await s.refresh();
  const l = s.ledger as Ledger;
  assert.deepEqual(l.contracts.map((c) => c.key), ["pool"]);
  assert.deepEqual(Object.keys(l.flows), ["poolHarvests"]);
  const all = JSON.stringify(l).toLowerCase();
  for (const k of ["pay", "bands"] as const) assert.ok(!all.includes((DEP[k] as string).toLowerCase()));
});

test("refreshes only fetch new blocks", async () => {
  const c = chain();
  const s = makeStats(c);
  await s.refresh();
  const first = c.calls.logs;
  c.tip = 100_010n;
  c.emit(at("pay"), "TaxSplit", 100_005n, { burned: 1n, toCouriers: 1n, toTreasury: 1n });
  await s.refresh();
  assert.ok(c.calls.logs - first < first / 5, "the second refresh is one chunk");
  assert.equal((s.ledger as Ledger).flows.salesTax.all.count, 4);
  assert.ok(KEYS.length > 0);
});

test("a treasury address that isn't a Safe is called out", async () => {
  const c = chain();
  c.reads.delete(`${SAFE.toLowerCase()}:getThreshold`);
  const s = makeStats(c);
  await s.refresh();
  const safe = (s.ledger as Ledger).contracts.find((x) => x.key === "safe")!;
  assert.deepEqual(safe.live, { isSafe: false });
});
