import assert from "node:assert/strict";
import { test } from "node:test";

import { Fees, median, zcPerEthFromSqrt } from "./fees";

const WAD = 10n ** 18n;
const GWEI = 10n ** 9n;
const Q96 = 2n ** 96n;

function book(o: { fixed?: bigint; minFee?: bigint; spot?: (bigint | null)[]; minSamples?: number } = {}) {
  const t = { now: 1_000_000, gasPrice: 10n * GWEI, spot: 1_000_000n * WAD, spots: 0 };
  const saved = { data: null as string | null };
  const f = new Fees({
    gasPrice: async () => t.gasPrice,
    spotZcPerEthWad: async () => {
      t.spots++;
      return t.spot;
    },
    fixedZcPerEthWad: o.fixed ?? 0n,
    minFeeWei: o.minFee ?? 0n,
    marginBps: 2000n,
    now: () => t.now,
    sampleSec: 60,
    twapSec: 1800,
    minSamples: o.minSamples ?? 5,
    refreshSec: 60,
    validSec: 600,
    store: { load: () => saved.data, save: (d) => void (saved.data = d) },
  });
  /** one sample per minute for `n` minutes at `price` */
  const run = async (n: number, price: bigint) => {
    for (let i = 0; i < n; i++) {
      t.spot = price;
      t.now += 60;
      await f.sample();
    }
  };
  return { f, t, run, saved };
}

test("zcPerEthFromSqrt: (sqrtP / 2^96)^2 as a wad", () => {
  assert.equal(zcPerEthFromSqrt(Q96), WAD); // price 1
  assert.equal(zcPerEthFromSqrt(Q96 * 1000n), 1_000_000n * WAD); // sqrt price 1000 -> 1,000,000 ZC per ETH
});

test("median", () => {
  assert.equal(median([3n, 1n, 2n]), 2n);
  assert.equal(median([4n, 1n, 3n, 2n]), 2n);
});

test("fee = gas × gas price × (1 + margin) in ZC, at the pool's median price", async () => {
  const { f, run } = book();
  await run(10, 1_000_000n * WAD);
  const { fee } = await f.quote(500_000n);
  // 500k gas × 10 gwei = 0.005 ETH, × 1.2 = 0.006 ETH, × 1,000,000 ZC/ETH = 6,000 ZC
  assert.equal(fee, 6_000n * WAD);
});

test("the minimum fee is a floor under every quote", async () => {
  const { f, run } = book({ minFee: 10_000n * WAD });
  await run(10, 1_000_000n * WAD);
  assert.equal((await f.quote(500_000n)).fee, 10_000n * WAD);
});

test("a fixed ZC_PER_ETH_WAD overrides the pool and needs no samples", async () => {
  const { f, t } = book({ fixed: 2_000_000n * WAD });
  assert.equal((await f.quote(500_000n)).fee, 12_000n * WAD);
  assert.equal(t.spots, 0);
});

test("a short spike in the pool price doesn't move the fee (median of the window)", async () => {
  const { f, run, t } = book();
  await run(20, 1_000_000n * WAD);
  // Someone pushes the pool so ZC looks 100x dearer (fees would drop 100x) for 5 minutes
  await run(5, 10_000n * WAD);
  t.now += 60; // past the quote refresh
  assert.equal((await f.quote(500_000n)).fee, 6_000n * WAD);
});

test("warm-up with few samples uses the highest ZC-per-ETH seen (can only overcharge)", async () => {
  const { f, run } = book();
  await run(1, 2_000_000n * WAD);
  await run(1, 1_000_000n * WAD);
  assert.equal(f.price(), 2_000_000n * WAD);
});

test("no price at all: quotes the floor only", async () => {
  const { f, t } = book({ minFee: 7n });
  t.spot = null as unknown as bigint;
  assert.equal((await f.quote(500_000n)).fee, 7n);
});

test("samples are saved and survive a restart", async () => {
  const { run, saved } = book();
  await run(6, 1_000_000n * WAD);
  const again = new Fees({ gasPrice: async () => 0n, fixedZcPerEthWad: 0n, minFeeWei: 0n, marginBps: 0n, now: () => 1_000_000 + 6 * 60, minSamples: 5, store: { load: () => saved.data, save: () => {} } });
  assert.equal(again.price(), 1_000_000n * WAD);
});

test("quotes are stable: a quote stays accepted for its validity window after gas rises, then expires", async () => {
  const { f, t, run } = book();
  await run(10, 1_000_000n * WAD);
  const q = await f.quote(500_000n);
  assert.equal(q.validUntil, t.now + 600);
  // Within the minute the snapshot is reused: the same quote
  t.gasPrice *= 3n;
  t.now += 30;
  assert.equal((await f.quote(500_000n)).fee, q.fee);
  // Later, new quotes are higher, but the old one is still honoured until it expires
  t.now += 120;
  const higher = await f.quote(500_000n);
  assert.equal(higher.fee, 3n * q.fee);
  assert.equal(await f.minAccepted(500_000n), q.fee);
  t.now = q.validUntil + 1;
  assert.equal(await f.minAccepted(500_000n), higher.fee);
});
