import assert from "node:assert/strict";
import { test } from "node:test";

import { clipBytes, DAY_SEC, freeSlot, MAX_POST_BYTES, POST_MARGIN_SEC, POSTS_PER_DAY, postHoldCap, useSlot } from "./slots";

test("a resident never gets the same slot twice in a day and group, and runs out after POSTS_PER_DAY", () => {
  let used: string[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < POSTS_PER_DAY; i++) {
    const s = freeSlot(used, 100n, 7n);
    assert.notEqual(s, null);
    assert.ok(!seen.has(s!), `slot ${s} reused`);
    seen.add(s!);
    used = useSlot(used, 100n, 7n, s!);
  }
  assert.equal(freeSlot(used, 100n, 7n), null);
  // another group, or the next day, has its own slots
  assert.notEqual(freeSlot(used, 100n, 8n), null);
  assert.notEqual(freeSlot(used, 101n, 7n), null);
});

test("slots are picked at random among the free ones", () => {
  const used = useSlot(useSlot([], 5n, 1n, 0), 5n, 1n, 3);
  assert.equal(freeSlot(used, 5n, 1n, () => 0), 1);
  assert.equal(freeSlot(used, 5n, 1n, () => 0.99), 4);
});

test("useSlot forgets earlier days", () => {
  const used = useSlot(["98:1:0", "99:1:2", "100:1:4"], 100n, 1n, 1);
  assert.deepEqual(used, ["100:1:4", "100:1:1"]);
});

test("the courier's hold never carries a post past the chain day's end", () => {
  const midnight = 1000 * DAY_SEC;
  assert.equal(postHoldCap(midnight + 60, 600), 600);
  assert.equal(postHoldCap(midnight + DAY_SEC - POST_MARGIN_SEC - 100, 600), 100);
  assert.equal(postHoldCap(midnight + DAY_SEC - POST_MARGIN_SEC, 600), 0);
  assert.equal(postHoldCap(midnight + DAY_SEC - 10, 600), null);
});

test("clipBytes keeps posts within the contract's byte limit without splitting characters", () => {
  assert.equal(clipBytes("short"), "short");
  const long = "é".repeat(400); // 800 bytes
  const c = clipBytes(long);
  assert.ok(new TextEncoder().encode(c).length <= MAX_POST_BYTES);
  assert.equal(c, "é".repeat(MAX_POST_BYTES / 2));
});
