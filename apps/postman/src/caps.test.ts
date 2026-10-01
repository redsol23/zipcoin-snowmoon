import assert from "node:assert/strict";
import { test } from "node:test";

import { checkCaps, DAY_SEC } from "./caps";

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const now = 1_000_000;

test("caps off: anything goes", () => {
  assert.deepEqual(checkCaps({ maxDeposit: 0n, maxDepositorDaily: 0n }, { depositor: A, value: 10n ** 30n }, [], now), { verdict: "ok" });
});

test("per-deposit cap rejects larger deposits and allows the cap itself", () => {
  const caps = { maxDeposit: 1000n, maxDepositorDaily: 0n };
  assert.equal(checkCaps(caps, { depositor: A, value: 1001n }, [], now).verdict, "reject");
  assert.equal(checkCaps(caps, { depositor: A, value: 1000n }, [], now).verdict, "ok");
});

test("daily cap makes the depositor wait, counting only their last 24 hours", () => {
  const caps = { maxDeposit: 0n, maxDepositorDaily: 1000n };
  const history = [
    { depositor: A, value: 700n, at: now - 60 },
    { depositor: A, value: 900n, at: now - DAY_SEC - 1 }, // aged out
    { depositor: B, value: 900n, at: now - 60 }, // someone else
  ];
  assert.equal(checkCaps(caps, { depositor: A, value: 300n }, history, now).verdict, "ok");
  assert.equal(checkCaps(caps, { depositor: A, value: 301n }, history, now).verdict, "wait");
  // the same deposit fits once the earlier one ages out
  assert.equal(checkCaps(caps, { depositor: A, value: 301n }, history, now + DAY_SEC).verdict, "ok");
});

test("depositor match ignores address case", () => {
  const caps = { maxDeposit: 0n, maxDepositorDaily: 100n };
  const history = [{ depositor: A.toUpperCase().replace("0X", "0x"), value: 100n, at: now }];
  assert.equal(checkCaps(caps, { depositor: A, value: 1n }, history, now).verdict, "wait");
});
