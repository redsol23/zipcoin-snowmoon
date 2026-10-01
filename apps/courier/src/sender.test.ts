import assert from "node:assert/strict";
import { test } from "node:test";

import { fromHex, keccak256, toHex, type Hex } from "viem";

import { classify, Sender, TxDropped, type SenderStore } from "./sender";

/**
 * A fake chain behind a private relay, for one account. The relay keeps what it is sent in its own pool, which the read
 * node never sees: the read node only knows mined transactions, so its count is the LATEST count, and a pending
 * transaction is invisible until it is mined (or lost, when the relay drops it).
 *
 * "Signing" encodes { nonce, tag, fee } as the raw transaction, so the hash is keccak(raw) as for a real one.
 */
type Tx = { nonce: number; tag: string; fee: string };
function relay() {
  const n = {
    /** mined transactions, by nonce */
    mined: [] as (Tx & { hash: Hex })[],
    /** the relay's private pool, by hash */
    pool: new Map<Hex, Tx>(),
    /** every raw transaction the relay accepted */
    accepted: [] as Tx[],
    /** tags whose call reverts in simulation */
    reverts: new Set<string>(),
    /** what the next sendRaw calls do instead (one entry per call) */
    script: [] as ("underpriced" | "timeoutButArrived" | "timeoutLost" | "revert" | { stall: Promise<void> })[],
    /** the next latestNonce() read lags by this much (a stale replica), once */
    lagOnce: 0,
    get latest() {
      return this.mined.length;
    },
    /** mines the next nonce: the highest-fee version the relay holds for it */
    mine() {
      const want = this.latest;
      let best: [Hex, Tx] | undefined;
      for (const [h, t] of this.pool) if (t.nonce === want && (!best || BigInt(t.fee) > BigInt(best[1].fee))) best = [h, t];
      if (!best) return false;
      this.mined.push({ ...best[1], hash: best[0] });
      for (const [h, t] of this.pool) if (t.nonce <= want) this.pool.delete(h);
      return true;
    },
    mineAll() {
      while (this.mine());
    },
    /** the relay gives up on everything it holds (Flashbots Protect after 25 blocks) */
    dropAll() {
      this.pool.clear();
    },
    /** someone else uses the key: a transaction at the next nonce that isn't ours */
    foreign() {
      this.mined.push({ nonce: this.latest, tag: "foreign", fee: "1", hash: keccak256(toHex(`foreign-${this.latest}`)) });
    },
  };
  const encode = (t: Tx) => toHex(JSON.stringify(t));
  const io = {
    async latestNonce() {
      const lag = n.lagOnce;
      n.lagOnce = 0;
      return n.latest - lag;
    },
    async fees() {
      return { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n };
    },
    async sign(args: Record<string, unknown>, nonce: number, fees: { maxFeePerGas: bigint }) {
      const tag = String(args.tag);
      if (n.reverts.has(tag)) throw new Error("The contract function reverted.\nDetails: execution reverted: NullifierAlreadySpent()");
      return encode({ nonce, tag, fee: fees.maxFeePerGas.toString() });
    },
    async signCancel(nonce: number, fees: { maxFeePerGas: bigint }) {
      return encode({ nonce, tag: "cancel", fee: fees.maxFeePerGas.toString() });
    },
    async sendRaw(raw: Hex): Promise<Hex> {
      const t = JSON.parse(fromHex(raw, "string")) as Tx;
      const hash = keccak256(raw);
      const step = n.script.shift();
      if (step && typeof step === "object") await step.stall;
      if (step === "underpriced") throw Object.assign(new Error("Transaction creation failed."), { cause: { details: "transaction underpriced" } });
      if (step === "revert") throw Object.assign(new Error("RPC Request failed."), { cause: { details: "insufficient funds for gas * price + value" } });
      if (step === "timeoutLost") throw Object.assign(new Error("The request took too long to respond."), { name: "TimeoutError" });
      if (t.nonce < n.latest) throw Object.assign(new Error("Nonce provided for the transaction is lower than the current nonce of the account."), { cause: { name: "NonceTooLowError", details: "nonce too low" } });
      if (n.pool.has(hash)) throw Object.assign(new Error("Transaction creation failed."), { cause: { details: "already known" } });
      n.pool.set(hash, t);
      n.accepted.push(t);
      if (step === "timeoutButArrived") throw Object.assign(new Error("HTTP request failed."), { name: "HttpRequestError" });
      return hash;
    },
    async receipt(hash: Hex) {
      const m = n.mined.find((x) => x.hash === hash);
      return m ? { transactionHash: hash, status: "success" as const, tag: m.tag } : null;
    },
  };
  return { n, io };
}

const quiet = () => {};
const memStore = (): SenderStore & { data: string | null } => {
  const s = { data: null as string | null, load: () => s.data, save: (d: string) => void (s.data = d) };
  return s;
};
const deferred = () => {
  let open!: () => void;
  const stall = new Promise<void>((r) => (open = r));
  return { stall, open };
};
const clock = () => {
  const c = { t: 1_000_000, now: () => c.t };
  return c;
};

test("the relay hides pending transactions: concurrent sends still get consecutive nonces, none reused", async () => {
  const { n, io } = relay();
  const s = new Sender({ io, log: quiet });
  const hashes = await Promise.all([
    s.write("background", { tag: "cover" }),
    s.write("background", { tag: "harvest" }),
    s.write("user", { tag: "job" }),
    s.write("background", { tag: "claim" }),
    s.write("user", { tag: "job2" }),
  ]);
  assert.equal(n.latest, 0, "nothing mined: the read node's count never moved");
  assert.equal(new Set(hashes).size, 5);
  assert.deepEqual(n.accepted.map((x) => x.nonce).sort(), [0, 1, 2, 3, 4]);
  assert.deepEqual(s.pendingNonces, [0, 1, 2, 3, 4]);
  n.mineAll();
  await s.tick();
  assert.deepEqual(s.pendingNonces, []);
  assert.equal((await s.waitForReceipt(hashes[2])).transactionHash, hashes[2]);
});

test("a user's job goes ahead of queued cover and harvest sends", async () => {
  const { n, io } = relay();
  const gate = deferred();
  n.script.push({ stall: gate.stall }); // the first send (cover) is in flight and slow
  const s = new Sender({ io, log: quiet });
  const all = [s.write("background", { tag: "cover" }), s.write("background", { tag: "harvest" }), s.write("background", { tag: "cover2" })];
  await new Promise((r) => setImmediate(r));
  all.push(s.write("user", { tag: "job" }));
  assert.deepEqual(s.queued, { user: 1, background: 2 });
  gate.open();
  await Promise.all(all);
  assert.deepEqual(
    n.accepted.map((x) => x.tag),
    ["cover", "job", "harvest", "cover2"],
  );
  assert.deepEqual(n.accepted.map((x) => x.nonce), [0, 1, 2, 3]);
});

test("the in-flight book survives a restart: the new process doesn't reuse a nonce that may still land", async () => {
  const { n, io } = relay();
  const store = memStore();
  const a = new Sender({ io, store, log: quiet });
  await a.write("user", { tag: "job" }); // nonce 0, pending in the relay, invisible to the read node
  const b = new Sender({ io, store, log: quiet }); // restart
  await b.write("user", { tag: "job2" });
  assert.deepEqual(n.accepted.map((x) => x.nonce), [0, 1]);
  n.mineAll();
  await b.tick();
  assert.deepEqual(b.pendingNonces, []);
});

test('"already known" is a successful send, not a reason to skip the nonce', async () => {
  const { n, io } = relay();
  const c = clock();
  // maxBumps 0: a resend repeats the same fees, so it is the identical signed transaction
  const s = new Sender({ io, now: c.now, resendAfterMs: 60_000, maxBumps: 0, log: quiet });
  n.script.push("timeoutButArrived"); // the relay got it but the answer was lost
  const h = await s.write("user", { tag: "job" });
  assert.deepEqual(s.pendingNonces, [0], "booked as in flight: it may have arrived");
  c.t += 61_000;
  await s.tick(); // resent identically: the relay answers "already known"
  assert.equal(n.accepted.length, 1);
  assert.deepEqual(s.pendingNonces, [0]);
  await s.write("user", { tag: "job2" });
  assert.deepEqual(n.accepted.map((x) => x.nonce), [0, 1]);
  n.mineAll();
  await s.tick();
  assert.equal((await s.waitForReceipt(h)).transactionHash, h);
});

test("no answer and it never arrived: booked, then resent at the same nonce after the timeout", async () => {
  const { n, io } = relay();
  const c = clock();
  const s = new Sender({ io, now: c.now, resendAfterMs: 60_000, log: quiet });
  n.script.push("timeoutLost");
  const h = await s.write("user", { tag: "job" });
  assert.equal(n.accepted.length, 0);
  c.t += 61_000;
  await s.tick();
  assert.deepEqual(n.accepted.map((x) => [x.nonce, x.tag]), [[0, "job"]]);
  n.mineAll();
  await s.tick();
  const r = await s.waitForReceipt(h);
  assert.notEqual(r.transactionHash, h, "the version that landed was the resend (higher fee, new hash)");
});

test("nonce too low on a new send (the key was used elsewhere): move past it, never replace", async () => {
  const { n, io } = relay();
  const s = new Sender({ io, log: quiet });
  await s.write("background", { tag: "a" }); // 0
  n.mineAll();
  await s.tick();
  n.foreign(); // an operator's manual claim used nonce 1
  n.lagOnce = 1; // and the replica we read hasn't seen it yet
  const h = await s.write("user", { tag: "job" });
  assert.deepEqual(n.accepted.map((x) => x.nonce), [0, 2], "nonce 1 was refused as too low, and skipped");
  assert.equal(n.accepted.at(-1)!.nonce, 2);
  n.mineAll();
  await s.tick();
  assert.equal((await s.waitForReceipt(h)).transactionHash, h);
});

test("relay drop: after the timeout the same call is re-simulated and resent at the same nonce with a higher fee", async () => {
  const { n, io } = relay();
  const c = clock();
  const s = new Sender({ io, now: c.now, resendAfterMs: 120_000, log: quiet });
  const h0 = await s.write("user", { tag: "job" }); // 0
  const h1 = await s.write("background", { tag: "cover" }); // 1
  n.dropAll(); // the relay gave up on both
  c.t += 60_000;
  await s.tick();
  assert.equal(n.accepted.length, 2, "not yet: it may just be slow");
  const later = await s.write("user", { tag: "job2" }); // a new job meanwhile gets nonce 2, never 0 or 1
  assert.equal(n.accepted.at(-1)!.nonce, 2);
  c.t += 61_000;
  await s.tick();
  const resent = n.accepted.slice(3);
  assert.deepEqual(resent.map((x) => [x.nonce, x.tag]), [[0, "job"], [1, "cover"]]);
  assert.ok(resent.every((x) => BigInt(x.fee) > 100n), "fees raised");
  n.mineAll();
  await s.tick();
  const r0 = await s.waitForReceipt(h0);
  assert.equal((r0 as unknown as { tag: string }).tag, "job");
  assert.notEqual(r0.transactionHash, h0);
  assert.equal((await s.waitForReceipt(h1) as unknown as { tag: string }).tag, "cover");
  assert.equal((await s.waitForReceipt(later)).transactionHash, later);
});

test("if the original lands after a resend, its receipt is the answer", async () => {
  const { n, io } = relay();
  const c = clock();
  const s = new Sender({ io, now: c.now, resendAfterMs: 60_000, log: quiet });
  const h = await s.write("user", { tag: "job" });
  c.t += 61_000;
  await s.tick(); // resent at a higher fee; both versions sit in the pool
  assert.equal(n.pool.size, 2);
  // The builder takes the old one anyway
  const old = [...n.pool].find(([hash]) => hash === h)!;
  n.mined.push({ ...old[1], hash: h });
  n.pool.clear();
  await s.tick();
  assert.equal((await s.waitForReceipt(h)).transactionHash, h);
});

test("a dropped call that no longer simulates keeps its nonce until nothing can land, then a cancel fills it", async () => {
  const { n, io } = relay();
  const c = clock();
  const s = new Sender({ io, now: c.now, resendAfterMs: 60_000, abandonAfterMs: 600_000, log: quiet });
  const h = await s.write("user", { tag: "job" }); // 0
  const waited = s.waitForReceipt(h).then(
    () => "landed",
    (e) => (e instanceof TxDropped ? "dropped" : `other: ${e}`),
  );
  const after = await s.write("background", { tag: "cover" }); // 1, stuck behind 0
  n.dropAll();
  n.reverts.add("job"); // e.g. the note was spent another way meanwhile
  c.t += 61_000;
  await s.tick();
  assert.deepEqual(n.accepted.slice(2).map((x) => x.tag), ["cover"], "the job isn't resent (it would revert); cover is");
  const next = await s.write("user", { tag: "job2" });
  assert.equal(n.accepted.at(-1)!.nonce, 2, "nonce 0 isn't handed to another job while the first may still land");
  c.t += 600_000;
  await s.tick();
  const cancel = n.accepted.find((x) => x.tag === "cancel");
  assert.ok(cancel);
  assert.equal(cancel.nonce, 0);
  n.mineAll();
  await s.tick();
  assert.equal(await waited, "dropped");
  assert.equal((await s.waitForReceipt(after) as unknown as { tag: string }).tag, "cover");
  assert.equal((await s.waitForReceipt(next) as unknown as { tag: string }).tag, "job2");
  assert.deepEqual(n.mined.map((x) => x.tag), ["cancel", "cover", "job2"]);
});

test("a nonce used by a transaction that isn't ours: the waiter learns it was dropped", async () => {
  const { n, io } = relay();
  const s = new Sender({ io, log: quiet });
  const h = await s.write("user", { tag: "job" });
  n.dropAll();
  n.foreign(); // nonce 0 used elsewhere
  const p = s.waitForReceipt(h);
  for (let i = 0; i < 3; i++) await s.tick(); // a few ticks' grace for a lagging receipt index
  await assert.rejects(p, TxDropped);
});

test("underpriced: the same nonce again with fees raised", async () => {
  const { n, io } = relay();
  n.script.push("underpriced", "underpriced");
  const s = new Sender({ io, log: quiet });
  await s.write("user", { tag: "job" });
  assert.equal(n.accepted.length, 1);
  assert.equal(n.accepted[0].nonce, 0);
  assert.equal(n.accepted[0].fee, "157"); // 100 * 1.25 * 1.25, rounded up
});

test("a revert (in simulation, or refused by the relay) uses no nonce and doesn't block the queue", async () => {
  const { n, io } = relay();
  n.reverts.add("bad");
  const s = new Sender({ io, log: quiet });
  const [bad, good] = await Promise.allSettled([s.write("background", { tag: "bad" }), s.write("user", { tag: "job" })]);
  assert.equal(bad.status, "rejected");
  assert.equal(good.status, "fulfilled");
  n.script.push("revert");
  await assert.rejects(s.write("user", { tag: "job2" }), /RPC Request failed/);
  await s.write("user", { tag: "job3" });
  assert.deepEqual(n.accepted.map((x) => x.nonce), [0, 1]);
});

test("classify reads viem's wrapped node errors", () => {
  const wrap = (details: string, name = "Error") => Object.assign(new Error("Transaction creation failed."), { cause: Object.assign(new Error(details), { name, details }) });
  assert.equal(classify(wrap("nonce too low")), "nonceLow");
  assert.equal(classify(wrap("x", "NonceTooLowError")), "nonceLow");
  assert.equal(classify(wrap("nonce too high")), "nonceHigh");
  assert.equal(classify(wrap("replacement transaction underpriced")), "slotTaken");
  assert.equal(classify(wrap("already known")), "known");
  assert.equal(classify(wrap("transaction underpriced")), "underpriced");
  assert.equal(classify(wrap("max fee per gas less than block base fee")), "underpriced");
  assert.equal(classify(wrap("insufficient funds for gas * price + value")), "other");
  assert.equal(classify(Object.assign(new Error("HTTP request failed."), { name: "HttpRequestError" })), "transport");
  assert.equal(classify(new Error("execution reverted: NothingToClaim()")), "other");
});
