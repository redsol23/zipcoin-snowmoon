import { describe, expect, it } from "vitest";

import { parseDeployment } from "../src/deployment";

const base = { chainId: 1, deployBlock: "7", scope: "42", pool: "0x00000000000000000000000000000000000000aa" };

describe("parseDeployment", () => {
  it("reads a full local deployment", () => {
    const d = parseDeployment({ ...base, batchRelayer: "0x00000000000000000000000000000000000000cc" });
    expect(d.scope).toBe(42n);
    expect(d.deployBlock).toBe(7);
    expect(d.batchRelayer).toBe("0x00000000000000000000000000000000000000cc");
  });

  it("treats skipped contracts as absent, whether left out or written as zero", () => {
    const omitted = parseDeployment(JSON.stringify(base));
    expect(omitted.batchRelayer).toBeUndefined();
    const zero = "0x0000000000000000000000000000000000000000";
    const zeroed = parseDeployment({ ...base, batchRelayer: zero });
    expect("batchRelayer" in zeroed).toBe(false);
    expect(zeroed.pool).toBe(base.pool);
  });

  it("reads the optional liquidity bands contract", () => {
    expect(parseDeployment(base).bands).toBeUndefined();
    expect(parseDeployment({ ...base, bands: "0x0000000000000000000000000000000000000000" }).bands).toBeUndefined();
    expect(parseDeployment({ ...base, bands: "0x00000000000000000000000000000000000000ff" }).bands).toBe("0x00000000000000000000000000000000000000ff");
  });
});
