import assert from "node:assert/strict";
import { test } from "node:test";

import { addressOf, parseAllowlist } from "./allowlist";
import { ALLOW, DEP, SAFE } from "./testkit";

test("the default allowlist shows only the public contracts", () => {
  assert.deepEqual(
    [...ALLOW.keys].sort(),
    ["addressRegistry", "badges", "bands", "broadcaster", "couriers", "doorstep", "entrypoint", "merchants", "pay", "polls", "pool", "rezip", "safe", "signal", "zc"].sort(),
  );
  for (const off of ["batchRelayer", "semaphore"])
    assert.equal(ALLOW.keys.has(off), false, `${off} must be off by default`);
});

test("every shown entry says who controls it", () => {
  for (const e of ALLOW.shown) {
    assert.ok(e.role.length > 20 && e.controller.length > 5, e.key);
    assert.ok(["none", "safe", "external"].includes(e.control), e.key);
  }
});

test("an entry that is off needs no text and is dropped", () => {
  const a = parseAllowlist({ contracts: [{ key: "batchRelayer", show: false }, { key: "pool", show: true, name: "P", contract: "C", control: "none", role: "r", controller: "c" }] });
  assert.deepEqual(a.shown.map((e) => e.key), ["pool"]);
});

test("a shown entry without its text, a bad control or a duplicate key is refused", () => {
  assert.throws(() => parseAllowlist({ contracts: [{ key: "pool", show: true, name: "P" }] }), /no contract/);
  assert.throws(() => parseAllowlist({ contracts: [{ key: "pool", show: true, name: "P", contract: "C", control: "owner", role: "r", controller: "c" }] }), /control/);
  assert.throws(() => parseAllowlist({ contracts: [{ key: "pool" }, { key: "pool" }] }), /twice/);
  assert.throws(() => parseAllowlist({ contracts: [{ key: "../x" }] }), /bad key/);
});

test("addresses come from the deployment, and the Safe from the chain", () => {
  assert.equal(addressOf("pool", DEP, null), DEP.pool);
  assert.equal(addressOf("safe", DEP, SAFE), SAFE);
  assert.equal(addressOf("safe", DEP, null), null);
  assert.equal(addressOf("bands", { ...DEP, bands: "0x0000000000000000000000000000000000000000" }, null), null);
});
