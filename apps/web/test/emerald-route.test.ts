import { createServer, type Server } from "node:http";

import { parseEther } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { GateDeps } from "../src/lib/emerald/gate";
import { ALL_TOOLS } from "../src/lib/emerald/tools";

/**
 * The route never reaches DeepSeek here: a local stand-in answers the way its OpenAI-compatible API does (a 401 for a
 * bad key, a tool call, then text) and records each request, so the model, tools and prompt are checked offline. The
 * gate's chain access is injected.
 */

type Seen = { auth: string; body: { model: string; messages: { role: string; content: string }[]; tools: { type: string; function: { name: string; parameters: unknown } }[]; tool_choice: string } };
let server: Server;
let seen: Seen[] = [];
let reply: (n: number) => { status: number; body: unknown } = () => ({ status: 500, body: {} });
const ENV = ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "EMERALD_MODEL"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

const SECRET = "t".repeat(40);
const deps = (over: Partial<GateDeps> = {}): GateDeps => ({
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
  ...over,
});

async function load(d: GateDeps | null = deps()) {
  vi.resetModules();
  const server = await import("../src/lib/emerald/server");
  server.setGateDeps(d);
  const gate = await import("../src/lib/emerald/gate");
  const route = await import("../src/app/api/emerald/route");
  return { route, gate };
}

const post = (route: { POST: (r: Request) => Promise<Response> }, body: unknown, headers: Record<string, string> = {}) =>
  route.POST(new Request("http://localhost/api/emerald", { method: "POST", body: JSON.stringify(body), headers: { "x-forwarded-for": `t-${Math.random()}`, ...headers } }));
const hello = { messages: [{ role: "user", content: "hello" }] };

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      seen.push({ auth: String(req.headers.authorization), body: JSON.parse(raw) });
      const r = reply(seen.length);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
});

beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  seen = [];
});

afterAll(() => {
  server.close();
  for (const k of ENV) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]));
});

const useFake = (key = "sk-test") => {
  process.env.DEEPSEEK_API_KEY = key;
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};
const unauthorized = { status: 401, body: { error: { message: "Authentication Fails, Your api key is invalid", type: "authentication_error", param: null, code: "invalid_request_error" } } };
const toolCall = {
  status: 200,
  body: {
    id: "c1",
    object: "chat.completion",
    model: "deepseek-flash",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: { role: "assistant", content: "", reasoning_content: "They want their balance.", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_wallet", arguments: "{}" } }] },
      },
    ],
  },
};
const text = { status: 200, body: { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "You hold 5 ZC.", reasoning_content: "Read it off." } }] } };

describe("emerald route", () => {
  it("answers 503 with no DeepSeek key, before the gate and without any network call", async () => {
    const { route } = await load();
    const res = await post(route, hello);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/DeepSeek API key/);
    expect(seen).toHaveLength(0);
  });

  it("refuses with the accepted options when nobody signed in, without calling the model", async () => {
    useFake();
    const { route } = await load();
    const res = await post(route, hello);
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.emerald.badge.private).toBe(true);
    expect(j.emerald.wallet.private).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("answers 503 when DeepSeek refuses the key (OpenAI-shaped 401)", async () => {
    useFake("sk-wrong");
    reply = () => unauthorized;
    const { route, gate } = await load();
    const token = gate.sign(SECRET, { k: "badge", exp: Math.floor(Date.now() / 1000) + 60 });
    const res = await post(route, hello, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(503);
    expect(seen).toHaveLength(1);
    expect(seen[0].auth).toBe("Bearer sk-wrong");
  });

  it("sends the model, the system prompt and every tool in the OpenAI format, and runs a tool loop", async () => {
    useFake();
    process.env.EMERALD_MODEL = "deepseek-v4-pro";
    reply = (n) => (n === 1 ? toolCall : text);
    const { route, gate } = await load();
    const token = gate.sign(SECRET, { k: "wallet", exp: Math.floor(Date.now() / 1000) + 60 });
    const auth = { authorization: `Bearer ${token}` };

    const r1 = await post(route, hello, auth);
    expect(r1.status).toBe(200);
    const j1 = await r1.json();
    expect(j1.finish_reason).toBe("tool_calls");
    expect(j1.message.tool_calls[0].function.name).toBe("get_wallet");
    expect(j1.message.reasoning_content).toBe("They want their balance.");

    const sent = seen[0].body;
    expect(sent.model).toBe("deepseek-v4-pro");
    expect(sent.tool_choice).toBe("auto");
    expect(sent.messages[0].role).toBe("system");
    expect(sent.messages[0].content).toMatch(/Don't give investment advice or price predictions/);
    expect(sent.messages[0].content).toMatch(/Parked payouts/);
    expect(sent.tools.map((t) => t.function.name)).toEqual(ALL_TOOLS.map((t) => t.name));
    expect(sent.tools.every((t) => t.type === "function")).toBe(true);

    // The browser appends the assistant turn as returned (reasoning_content included) and the tool result
    const history = [...hello.messages, j1.message, { role: "tool", tool_call_id: "call_1", content: '{"zipped_zc":"5"}' }];
    const r2 = await post(route, { messages: history }, auth);
    const j2 = await r2.json();
    expect(j2).toMatchObject({ finish_reason: "stop", message: { role: "assistant", content: "You hold 5 ZC." } });
    const back = seen[1].body.messages as unknown as Record<string, unknown>[];
    expect(back[2]).toMatchObject({ role: "assistant", reasoning_content: "They want their balance." });
    expect(back[3]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
  });

  it("uses DeepSeek's general chat model by default", async () => {
    useFake();
    reply = () => text;
    const { route, gate } = await load();
    const token = gate.sign(SECRET, { k: "badge", exp: Math.floor(Date.now() / 1000) + 60 });
    await post(route, hello, { authorization: `Bearer ${token}` });
    expect(seen[0].body.model).toBe("deepseek-flash");
  });

  it("rejects a malformed conversation before anything else", async () => {
    useFake();
    const { route } = await load();
    expect((await post(route, { messages: [] })).status).toBe(400);
    expect((await post(route, { messages: [{ role: "system", content: "x" }] })).status).toBe(400);
    expect((await post(route, { messages: [{ role: "assistant", content: "x" }] })).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("GET lists the options, and 503s when the gate can't read the chain", async () => {
    const { route } = await load();
    const ok = await route.GET(new Request("http://localhost/api/emerald"));
    expect((await ok.json()).emerald.badge.minTier).toBe(1);
    const off = await load(null);
    const saved = process.env.DEPLOYMENT;
    delete process.env.DEPLOYMENT;
    expect((await off.route.GET(new Request("http://localhost/api/emerald"))).status).toBe(503);
    if (saved !== undefined) process.env.DEPLOYMENT = saved;
  });
});
