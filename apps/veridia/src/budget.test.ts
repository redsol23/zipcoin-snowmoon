import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { GasBudget, OverBudget } from "./budget";

const DAY = 86_400_000;

test("the cap blocks spending past it and refills on the next UTC day", () => {
  let now = 10 * DAY + 5_000;
  const b = new GasBudget(1_000n, undefined, () => now);
  b.check(600n);
  b.charge(600n);
  assert.equal(b.exhausted(), false);
  assert.throws(() => b.check(500n), OverBudget);
  b.charge(400n);
  assert.equal(b.exhausted(), true);
  assert.equal(b.msToReset(), DAY - 5_000);
  now = 11 * DAY;
  assert.equal(b.exhausted(), false);
  assert.equal(b.spent(), 0n);
});

test("a zero cap means no cap", () => {
  const b = new GasBudget(0n);
  b.charge(10n ** 30n);
  b.check(10n ** 30n);
  assert.equal(b.exhausted(), false);
});

test("today's spend survives a restart, yesterday's doesn't", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "veridia-budget-")), "b.json");
  let now = 20 * DAY + 1;
  new GasBudget(100n, file, () => now).charge(70n);
  assert.equal(new GasBudget(100n, file, () => now).spent(), 70n);
  now = 21 * DAY + 1;
  assert.equal(new GasBudget(100n, file, () => now).spent(), 0n);
});
