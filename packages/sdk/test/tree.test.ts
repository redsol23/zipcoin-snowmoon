import { describe, expect, it } from "vitest";

import { buildTree, insertGasHeadroom, INSERT_GAS_PER_LEVEL, treeDepthOf } from "../src/tree";

describe("state tree gas headroom", () => {
  it("treeDepthOf is the LeanIMT's depth for that many leaves", () => {
    for (const n of [0, 1, 2, 3, 4, 5, 8, 9, 31, 32, 33, 100]) {
      expect(treeDepthOf(n), `n = ${n}`).toBe(buildTree(Array.from({ length: n }, (_, i) => BigInt(i + 1))).depth);
    }
  });

  it("allows a hash on every level, and one more level, per insert", () => {
    expect(insertGasHeadroom(9n)).toBe(11n * INSERT_GAS_PER_LEVEL);
    expect(insertGasHeadroom(9, 3)).toBe(33n * INSERT_GAS_PER_LEVEL);
  });
});
