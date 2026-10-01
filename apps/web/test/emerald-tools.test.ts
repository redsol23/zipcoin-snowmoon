import { parseEther } from "viem";
import { describe, expect, it } from "vitest";

import { ALL_TOOLS, BASE_TOOLS, FEATURE_PROMPT, FEATURE_READ_TOOLS, isFeatureReadTool, parseBaseProposal, zcAmount } from "../src/lib/emerald/tools";

const ADDR = "0x1111111111111111111111111111111111111111";

describe("tool schemas", () => {
  it("are closed objects whose required list names every property", () => {
    for (const t of ALL_TOOLS) {
      expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(t.input_schema.type).toBe("object");
      expect(t.input_schema.additionalProperties).toBe(false);
      expect([...t.input_schema.required].sort()).toEqual(Object.keys(t.input_schema.properties).sort());
      expect(t.description.length).toBeGreaterThan(40);
    }
  });

  it("have unique names, and the read tools are recognised as such", () => {
    for (const t of FEATURE_READ_TOOLS) expect(isFeatureReadTool(t.name)).toBe(true);
    for (const t of BASE_TOOLS) expect(isFeatureReadTool(t.name)).toBe(false);
    expect(BASE_TOOLS.map((t) => t.name)).toEqual(["get_wallet", "check_recipient", "list_merchants", "read_inbox", "pool_activity", "propose_action"]);
    expect(new Set(ALL_TOOLS.map((t) => t.name)).size).toBe(ALL_TOOLS.length);
  });

  it("read tools take no input", () => {
    for (const t of FEATURE_READ_TOOLS) expect(t.input_schema.properties).toEqual({});
  });

  it("the prompt names every read tool", () => {
    for (const t of FEATURE_READ_TOOLS) expect(FEATURE_PROMPT).toContain(t.name);
  });
});

describe("amounts", () => {
  it("parses plain decimals", () => {
    expect(zcAmount("10", "x")).toBe(parseEther("10"));
    expect(zcAmount(" 2.5 ", "x")).toBe(parseEther("2.5"));
    expect(zcAmount("0", "x", true)).toBe(0n);
  });
  it("rejects anything else", () => {
    for (const v of ["0", "-1", "1e3", "abc", "", "1.", ".5", "1,000", 10, null, "0.0000000000000000001"]) expect(() => zcAmount(v, "x")).toThrow();
  });
});

describe("propose_action checks (tool calls aren't schema-enforced)", () => {
  const base = { amount_zc: "5", to: null, merchant_id: null, message: null, target: null, hold: "now", reason: "r" };
  it("accepts well-formed actions", () => {
    expect(parseBaseProposal({ ...base, action: "send", to: ADDR })).toMatchObject({ ok: true, proposal: { action: "send", to: ADDR, hold: "now" } });
    expect(parseBaseProposal({ ...base, action: "pay", merchant_id: "2" })).toMatchObject({ ok: true });
    expect(parseBaseProposal({ ...base, action: "speak", message: "hi", hold: "epoch" })).toMatchObject({ ok: true, proposal: { hold: "epoch" } });
    expect(parseBaseProposal({ ...base, action: "send_link", hold: "whenever" })).toMatchObject({ ok: true, proposal: { hold: "now" } });
  });
  it("rejects what would fail or mislead at Confirm", () => {
    expect(parseBaseProposal({ ...base, action: "steal" })).toMatchObject({ ok: false });
    expect(parseBaseProposal({ ...base, action: "send" })).toMatchObject({ ok: false, error: expect.stringMatching(/needs to/) });
    expect(parseBaseProposal({ ...base, action: "send", to: "0xnope" })).toMatchObject({ ok: false });
    expect(parseBaseProposal({ ...base, action: "pay" })).toMatchObject({ ok: false, error: expect.stringMatching(/merchant_id/) });
    expect(parseBaseProposal({ ...base, action: "knock", to: ADDR })).toMatchObject({ ok: false, error: expect.stringMatching(/message/) });
    expect(parseBaseProposal({ ...base, action: "zip", amount_zc: "-3" })).toMatchObject({ ok: false });
  });
});
