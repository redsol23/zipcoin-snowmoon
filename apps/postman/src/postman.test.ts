import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { healthStatus, nextTickMs, publishEpoch, type PublishDeps } from "./epoch";
import { emptySaved, loadState, saveState, StateFileError, type Saved } from "./store";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "postman-test-"));
const quiet = () => {};
const state = (n: number): Saved => ({ approved: Array.from({ length: n }, (_, i) => String(100 + i)), approvedAt: {}, rejected: [], lastEpoch: n });

// ——— state file ———

test("saves atomically: the file is replaced whole, the previous save kept as .bak, no temp files left", () => {
  const dir = tmpDir();
  const f = path.join(dir, "postman.json");
  saveState(f, state(1));
  saveState(f, state(2));
  assert.deepEqual(loadState(f, quiet), state(2));
  assert.deepEqual(JSON.parse(fs.readFileSync(`${f}.bak`, "utf8")), state(1));
  assert.deepEqual(fs.readdirSync(dir).sort(), ["postman.json", "postman.json.bak"]);
});

test("a missing file on first start is a fresh state", () => {
  assert.deepEqual(loadState(path.join(tmpDir(), "none.json"), quiet), emptySaved());
});

test("a torn or corrupt file loads the last good backup, and is kept aside", () => {
  const dir = tmpDir();
  const f = path.join(dir, "postman.json");
  saveState(f, state(3));
  saveState(f, state(4));
  fs.writeFileSync(f, '{"approved":["100","101"'); // a partial write
  const logs: string[] = [];
  assert.deepEqual(loadState(f, (m) => logs.push(m)), state(3));
  assert.match(logs.join("\n"), /unreadable/);
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith("postman.json.corrupt-")));
});

test("a file of the wrong shape counts as corrupt too", () => {
  const dir = tmpDir();
  const f = path.join(dir, "postman.json");
  saveState(f, state(2));
  saveState(f, state(2));
  fs.writeFileSync(f, JSON.stringify({ approved: "everything", rejected: [], lastEpoch: 1 }));
  assert.deepEqual(loadState(f, quiet), state(2));
});

test("corrupt with no good backup: refuses to start rather than reset the approvals", () => {
  const dir = tmpDir();
  const f = path.join(dir, "postman.json");
  fs.writeFileSync(f, "garbage");
  assert.throws(() => loadState(f, quiet), StateFileError);
  fs.writeFileSync(`${f}.bak`, "also garbage");
  assert.throws(() => loadState(f, quiet), StateFileError);
});

test("file missing but backup present (a crash between copy and rename): loads the backup", () => {
  const dir = tmpDir();
  const f = path.join(dir, "postman.json");
  fs.writeFileSync(`${f}.bak`, JSON.stringify(state(5)));
  assert.deepEqual(loadState(f, quiet), state(5));
});

// ——— publishing ———

const EPOCH = 3600;
function chain(o: { latest?: bigint; failRead?: boolean; failSend?: number } = {}) {
  const c = { latest: o.latest ?? 0n, sends: [] as bigint[], failRead: o.failRead ?? false, failSend: o.failSend ?? 0, persisted: 0 };
  const saved = { lastEpoch: -1 } as { lastEpoch: number; rootFreshAt?: number };
  const deps = (now: number, root: bigint | null): PublishDeps => ({
    now: () => now,
    epochSec: EPOCH,
    root: () => root,
    latestRoot: async () => {
      if (c.failRead) throw new Error("HTTP request failed");
      return c.latest;
    },
    updateRoot: async (r) => {
      c.sends.push(r);
      if (c.failSend > 0) {
        c.failSend--;
        throw new Error("Timed out while waiting for transaction");
      }
      c.latest = r;
      return { hash: "0xabc" };
    },
    saved,
    persist: () => void c.persisted++,
  });
  return { c, saved, deps };
}

test("the epoch is recorded only after updateRoot is confirmed; a failure retries on the next tick", async () => {
  const { c, saved, deps } = chain({ failSend: 1 });
  const t = 10 * EPOCH + 5;
  await assert.rejects(publishEpoch(deps(t, 7n)), /Timed out/);
  assert.equal(saved.lastEpoch, -1, "not marked done");
  assert.equal(saved.rootFreshAt, undefined);
  assert.equal(await publishEpoch(deps(t + 15, 7n)), "published");
  assert.equal(saved.lastEpoch, 10);
  assert.equal(saved.rootFreshAt, t + 15);
  assert.deepEqual(c.sends, [7n, 7n]);
  assert.equal(await publishEpoch(deps(t + 30, 7n)), "not-due");
});

test("an RPC failure reading the root is a failure, never a reason to publish", async () => {
  const { c, saved, deps } = chain({ latest: 7n, failRead: true });
  await assert.rejects(publishEpoch(deps(5 * EPOCH, 7n)));
  assert.deepEqual(c.sends, []);
  assert.equal(saved.lastEpoch, -1);
});

test("root already on-chain: the epoch is done without a transaction, and the root counts as fresh", async () => {
  const { c, saved, deps } = chain({ latest: 9n });
  assert.equal(await publishEpoch(deps(3 * EPOCH, 9n)), "unchanged");
  assert.deepEqual(c.sends, []);
  assert.equal(saved.lastEpoch, 3);
  assert.equal(saved.rootFreshAt, 3 * EPOCH);
});

test("nothing approved yet: no root to publish", async () => {
  const { c, deps } = chain();
  assert.equal(await publishEpoch(deps(EPOCH, null)), "empty");
  assert.deepEqual(c.sends, []);
});

// ——— health ———

test("health: ok when the RPC answers, the root is fresh and the last tick succeeded", () => {
  const h = healthStatus({ now: 10_000, epochSec: EPOCH, startedAt: 0, rootFreshAt: 9_000, rpcOk: true, lastTickOkAt: 9_990 });
  assert.equal(h.ok, true);
  assert.deepEqual(h.problems, []);
});

test("health: a root not confirmed for more than 2 epochs is stale", () => {
  const h = healthStatus({ now: 10 * EPOCH, epochSec: EPOCH, startedAt: 0, rootFreshAt: 10 * EPOCH - 2 * EPOCH - 1, rpcOk: true, lastTickOkAt: 10 * EPOCH });
  assert.equal(h.ok, false);
  assert.equal(h.staleRoot, true);
  // never confirmed since start-up counts from start-up
  assert.equal(healthStatus({ now: 3 * EPOCH, epochSec: EPOCH, startedAt: 0, rpcOk: true, lastTickOkAt: 3 * EPOCH }).staleRoot, true);
  assert.equal(healthStatus({ now: EPOCH, epochSec: EPOCH, startedAt: 0, rpcOk: true }).ok, true);
});

test("health: RPC unreachable, or the last tick failed, is not ok and says why", () => {
  const base = { now: 10_000, epochSec: EPOCH, startedAt: 0, rootFreshAt: 9_000 };
  const down = healthStatus({ ...base, rpcOk: false, lastTickOkAt: 9_990 });
  assert.equal(down.ok, false);
  assert.match(down.problems.join(), /rpc unreachable/);
  const failing = healthStatus({ ...base, rpcOk: true, lastTickOkAt: 9_900, lastError: { at: 9_990, message: "updateRoot reverted" } });
  assert.equal(failing.ok, false);
  assert.match(failing.problems.join(), /updateRoot reverted/);
  // recovered: the error is still reported, but no longer fails health
  const recovered = healthStatus({ ...base, rpcOk: true, lastTickOkAt: 9_995, lastError: { at: 9_990, message: "updateRoot reverted" } });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.lastError?.message, "updateRoot reverted");
});

test("ticks: on the tick clock, and just past every epoch turn so the publish isn't a whole tick late", () => {
  const E = 120;
  assert.equal(nextTickMs(1_000_000, 15_000, E), 15_000, "mid-epoch: a normal tick");
  assert.equal(nextTickMs(1_079_000, 15_000, E), 1_250, "the turn at 1,080 s comes first: 250 ms after it");
  assert.equal(nextTickMs(1_080_000, 15_000, E), 15_000, "a tick at the turn publishes itself");
  assert.equal(nextTickMs(1_080_100, 3_000, E), 3_000);
  assert.ok(nextTickMs(1_079_999, 15_000, E) <= 251);
});
