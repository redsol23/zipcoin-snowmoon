import fs from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { parseEther } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { capConfig, costUsd, MODEL_PRICES, pricesFor, RateLimit, SpendCap } from "../src/lib/emerald/budget";
import type { GateDeps } from "../src/lib/emerald/gate";

/** Emerald's daily DeepSeek budget and per-session limits. DeepSeek is a local stand-in that reports `usage`. */

describe("cost and cap", () => {
  it("prices a call from DeepSeek's usage fields, cache hits at the cached rate", () => {
    const p = MODEL_PRICES["deepseek-flash"];
    // 1M cached + 1M uncached input + 1M output
    expect(costUsd({ prompt_tokens: 2e6, prompt_cache_hit_tokens: 1e6, prompt_cache_miss_tokens: 1e6, completion_tokens: 1e6 }, p)).toBeCloseTo(p.hit + p.miss + p.out);
    // without the cache split, all input counts as uncached
    expect(costUsd({ prompt_tokens: 1e6, completion_tokens: 0 }, p)).toBeCloseTo(p.miss);
    // an unknown model is priced as the dearest; env overrides win
    expect(pricesFor("some-new-model", {})).toEqual(MODEL_PRICES["deepseek-v4-pro"]);
    expect(pricesFor("deepseek-flash", { EMERALD_USD_PER_M_OUTPUT: "9" }).out).toBe(9);
  });

  it("config: a $10 default, 'none' turns it off, a token cap on its own", () => {
    expect(capConfig({})).toMatchObject({ usdCap: 10, tokenCap: null });
    expect(capConfig({ EMERALD_DAILY_USD_CAP: "none", EMERALD_DAILY_TOKEN_CAP: "500000" })).toMatchObject({ usdCap: null, tokenCap: 500000 });
  });

  it("reserves each call's worst case, settles the real cost, rests when the next call wouldn't fit, wakes at 00:00 UTC", () => {
    let now = Date.UTC(2026, 8, 28, 22, 0);
    const cap = new SpendCap({ usdCap: 1, tokenCap: null }, () => now);
    const a = cap.reserve(0.6, 1000);
    expect(a.ok).toBe(true);
    // a second call in flight can't also count on the same budget
    const b = cap.reserve(0.6, 1000);
    expect(b).toEqual({ ok: false, until: Date.UTC(2026, 8, 29) / 1000 });
    if (a.ok) cap.settle(a.r, 0.1, 500); // it really cost 10 cents
    expect(cap.reserve(0.6, 1000).ok).toBe(true);
    now = Date.UTC(2026, 8, 29, 0, 1);
    expect(cap.status()).toMatchObject({ spentUsd: 0, day: "2026-09-29" });
  });

  it("a token cap works the same way", () => {
    const cap = new SpendCap({ usdCap: null, tokenCap: 10_000 });
    const r = cap.reserve(0, 9_000);
    expect(r.ok).toBe(true);
    if (r.ok) cap.settle(r.r, 0, 9_000);
    expect(cap.reserve(0, 2_000).ok).toBe(false);
  });

  it("the day's spend survives a restart through EMERALD_BUDGET_FILE", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "emerald-")), "budget.json");
    const now = () => Date.UTC(2026, 8, 28, 12);
    const a = new SpendCap({ usdCap: 1, tokenCap: null, file }, now);
    const r = a.reserve(0.5, 0);
    if (r.ok) a.settle(r.r, 0.9, 0);
    const b = new SpendCap({ usdCap: 1, tokenCap: null, file }, now);
    expect(b.status().spentUsd).toBeCloseTo(0.9);
    expect(b.reserve(0.2, 0).ok).toBe(false);
  });

  it("rate limit: a sliding window per key", () => {
    let t = 0;
    const rl = new RateLimit(2, 60_000, () => t);
    expect([rl.limited("a"), rl.limited("a"), rl.limited("a"), rl.limited("b")]).toEqual([false, false, true, false]);
    t = 61_000;
    expect(rl.limited("a")).toBe(false);
  });
});

// ——— the route ———

let server: Server;
let calls = 0;
const usage = { prompt_tokens: 20_000, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 20_000, completion_tokens: 2_000, total_tokens: 22_000 };
const ENV = ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "EMERALD_MODEL", "EMERALD_DAILY_USD_CAP", "EMERALD_DAILY_TOKEN_CAP", "EMERALD_SESSION_PER_MIN"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const SECRET = "t".repeat(40);

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Hello." } }], usage }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
});
afterAll(() => {
  server.close();
  for (const k of ENV) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]));
});
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  process.env.DEEPSEEK_API_KEY = "sk-test";
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  calls = 0;
});

async function load() {
  vi.resetModules();
  const budget = await import("../src/lib/emerald/budget");
  budget.resetEmeraldBudget();
  const srv = await import("../src/lib/emerald/server");
  srv.setGateDeps({
    chainId: 1,
    minTier: 1,
    minHoldWei: parseEther("100000"),
    epochSec: 14_400,
    secret: SECRET,
    sessionSec: 3600,
    now: () => Math.floor(Date.now() / 1000),
    tierGroup: async () => 1n,
    verifyBadgeProof: async () => true,
    balanceOf: async () => 0n,
    verifySignature: async () => true,
  });
  const gate = await import("../src/lib/emerald/gate");
  const route = await import("../src/app/api/emerald/route");
  return { route, gate, budget };
}

const hello = { messages: [{ role: "user", content: "hello" }] };
const post = (route: { POST: (r: Request) => Promise<Response> }, body: unknown, headers: Record<string, string> = {}) =>
  route.POST(new Request("http://localhost/api/emerald", { method: "POST", body: JSON.stringify(body), headers: { "x-forwarded-for": `t-${Math.random()}`, ...headers } }));

describe("emerald route with a budget", () => {
  it("counts each answer's real cost, then rests until tomorrow without calling the model", async () => {
    // deepseek-flash: 20k uncached input + 2k output = 0.006 + 0.0024 = $0.0084 per answer; the worst case reserved is
    // higher, so with a 3-cent cap a few answers fit and then Emerald rests
    process.env.EMERALD_DAILY_USD_CAP = "0.03";
    const { route, gate, budget } = await load();
    const auth = { authorization: `Bearer ${gate.sign(SECRET, { k: "badge", exp: Math.floor(Date.now() / 1000) + 600, n: "1" })}` };
    const statuses: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      const j = await (await post(route, hello, auth)).json();
      statuses.push(Boolean(j.resting));
    }
    const answered = statuses.filter((r) => !r).length;
    expect(answered).toBeGreaterThan(0);
    expect(statuses.slice(answered).every(Boolean)).toBe(true);
    expect(calls).toBe(answered);
    expect(budget.emeraldCap().status().spentUsd).toBeCloseTo(answered * 0.0084, 6);

    const r = await post(route, hello, auth);
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.message.content).toMatch(/resting until tomorrow/);
    expect(calls).toBe(answered);
    // and the sign-in panel knows
    const { route: plain } = await load();
    process.env.EMERALD_DAILY_USD_CAP = "0";
    expect((await (await plain.GET(new Request("http://localhost/api/emerald"))).json()).resting).toEqual(expect.any(Number));
  });

  it("per-session limit: a session over EMERALD_SESSION_PER_MIN gets 429, before any model call", async () => {
    process.env.EMERALD_SESSION_PER_MIN = "3";
    const { route, gate } = await load();
    const token = gate.sign(SECRET, { k: "badge", exp: Math.floor(Date.now() / 1000) + 600, n: "42" });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await post(route, hello, { authorization: `Bearer ${token}` })).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    expect(calls).toBe(3);
    // another session isn't affected
    const other = gate.sign(SECRET, { k: "badge", exp: Math.floor(Date.now() / 1000) + 600, n: "43" });
    expect((await post(route, hello, { authorization: `Bearer ${other}` })).status).toBe(200);
  });
});
