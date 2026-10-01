import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTree } from "@zipnet/sdk";

import { AspPrefix, aspPublishPending, aspTurnWatched, InsertRate, lateHeldPoolProof, poolRootPressed, RecentRoots } from "./roots";

test("pool root age: roots are counted in inserts since, and a held proof goes before it leaves the 64-root history", () => {
  const r = new RecentRoots(8);
  const leaves = Array.from({ length: 20 }, (_, i) => BigInt(i + 1));
  r.update(leaves.slice(0, 12));
  const rootAt = (n: number) => buildTree(leaves.slice(0, n)).root;
  assert.equal(r.age(rootAt(12)), 0, "the current root");
  assert.equal(r.age(rootAt(10)), 2);
  assert.equal(r.age(rootAt(3)), null, "older than it keeps");
  r.update(leaves);
  assert.equal(r.age(rootAt(13)), 7, "7 inserts later");
  assert.equal(r.age(rootAt(12)), null, "fell out of the 8 kept");
  r.update(leaves.slice(0, 5));
  assert.equal(r.age(rootAt(5)), 0, "a resync starts over");

  assert.equal(poolRootPressed([]), false);
  assert.equal(poolRootPressed([46]), false, "one proof, 47 of 48 inserts used");
  assert.equal(poolRootPressed([47]), true, "its own insert would make 48: send now");
  assert.equal(poolRootPressed([20, 0, 5, 12, 2, 1, 7, 9, 3, 4, 6, 8, 10, 11, 13, 14, 15, 16, 17, 18, 19, 1, 2, 3, 4, 5, 6, 7]), true, "a job's own inserts count too");
  assert.equal(poolRootPressed([20]), false);
  assert.equal(poolRootPressed([20], 1.5), true, "at 1.5 inserts/s, 30 more come before it lands");
  assert.equal(r.age(rootAt(5), 9), 4, "the size on chain, when fresher than the last sync");

  const rate = new InsertRate(60_000);
  assert.equal(rate.perSec(), 0);
  rate.add(0, 100);
  rate.add(10_000, 120);
  assert.equal(rate.perSec(), 2);
  rate.add(70_000, 130);
  assert.ok(Math.abs(rate.perSec() - 10 / 60) < 1e-9, "the first sample left the window");
});

test("ASP prefix: the longest prefix of the postman's labels with the chain's root, hashing only new labels", () => {
  const labels = Array.from({ length: 12 }, (_, i) => BigInt(1000 + i));
  const rootOf = (n: number) => buildTree(labels.slice(0, n)).root;
  const a = new AspPrefix();
  assert.equal(a.match(labels.slice(0, 10), rootOf(9)), 9, "one label approved but not yet published");
  assert.equal(a.match(labels, rootOf(9)), 9);
  assert.equal(a.match(labels, rootOf(12)), 12, "published");
  assert.equal(a.match(labels, 42n), 0, "no prefix has that root");
  assert.equal(a.match([7n, ...labels.slice(1)], buildTree([7n, ...labels.slice(1, 4)]).root), 4, "a different list starts over");

  const t = new AspPrefix(3);
  assert.equal(t.match(labels, rootOf(11)), 11, "within the tail it keeps");
  const u = new AspPrefix(3);
  assert.equal(u.match(labels, rootOf(5)), 5, "further back than the tail: rebuilt with every root");

  const r = new RecentRoots(8);
  assert.equal(r.root, 0n, "an empty pool's root reads 0");
  r.update(labels);
  assert.equal(r.root, rootOf(12));
});

test("ASP root: a held pool proof is refused only while this epoch's publish is due and will change the root", () => {
  const at = { now: 1_205, epochSec: 120, postmanRoot: 7n, onchainRoot: 6n };
  assert.equal(aspPublishPending({ ...at, lastEpoch: 9 }), true, "epoch 10 turned 5 s ago, root not yet replaced");
  assert.equal(aspPublishPending({ ...at, lastEpoch: 10 }), false, "published: the proof names the new root or fails at simulation");
  assert.equal(aspPublishPending({ ...at, lastEpoch: 9, postmanRoot: 6n }), false, "nothing new approved: the publish keeps the root");
  assert.equal(aspPublishPending({ ...at, now: 1_199, lastEpoch: 9 }), false, "mid-epoch the postman's list may run ahead of the chain; nothing lands before the epoch ends");
});

test("ASP turn: watched from the turn until the epoch's publish is seen, for a bounded window", () => {
  const E = 120;
  assert.equal(aspTurnWatched(1_200.5, E, 9, 300), 10, "epoch 10 just turned, not seen yet");
  assert.equal(aspTurnWatched(1_200.5, E, 10, 300), null, "seen: nothing to do until the next turn");
  assert.equal(aspTurnWatched(1_319, E, 9, 300), 10, "still unseen late in a short epoch: keep looking");
  assert.equal(aspTurnWatched(14_400 * 10 + 301, 14_400, 9, 300), null, "past the window: the 10 s refresh takes over");
  assert.equal(aspTurnWatched(1_200.5, 0, -1, 300), null, "the epoch length isn't known yet");
});

test("ASP turn: a held pool proof too late for a receipt goes now, unless the turn is within the guard", () => {
  assert.equal(lateHeldPoolProof(1_190, 1_200, 2), "send", "10 s left: a block or two to land before the turn");
  assert.equal(lateHeldPoolProof(1_198, 1_200, 2), "refuse", "the last block: it may land on the new root");
  assert.equal(lateHeldPoolProof(1_199, 1_200, 0), "send");
});
