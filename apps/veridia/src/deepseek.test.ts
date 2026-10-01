import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { chatJson, LlmError, NoKey } from "./deepseek";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.VERIDIA_MODEL;
  delete process.env.DEEPSEEK_BASE_URL;
});

function stub(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return calls;
}

test("no key: throws NoKey without calling out", async () => {
  const calls = stub(200, {});
  await assert.rejects(chatJson({ system: "s", user: "u" }), NoKey);
  assert.equal(calls.length, 0);
});

test("sends an OpenAI-style JSON-mode request with the key only in the header", async () => {
  process.env.DEEPSEEK_API_KEY = "test-key-not-real";
  const calls = stub(200, { choices: [{ message: { content: '{"action":"rest","line":"naps"}' }, finish_reason: "stop" }] });
  const out = await chatJson({ system: "json please", user: "scene" });
  assert.deepEqual(out, { action: "rest", line: "naps" });
  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  const body = JSON.parse(calls[0].init.body as string);
  assert.equal(body.model, "deepseek-flash");
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer test-key-not-real");
  assert.ok(!(calls[0].init.body as string).includes("test-key-not-real"));
});

test("model and thinking effort are configurable", async () => {
  process.env.DEEPSEEK_API_KEY = "k";
  process.env.VERIDIA_MODEL = "deepseek-v4-pro";
  const calls = stub(200, { choices: [{ message: { content: "{}" }, finish_reason: "stop" }] });
  await chatJson({ system: "json", user: "u", thinking: "high" });
  const body = JSON.parse(calls[0].init.body as string);
  assert.equal(body.model, "deepseek-v4-pro");
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.reasoning_effort, "high");
});

test("HTTP errors carry the status and nothing of the response", async () => {
  process.env.DEEPSEEK_API_KEY = "k";
  stub(401, { error: { message: "Authentication Fails, your api key: ****k is invalid" } });
  await assert.rejects(chatJson({ system: "json", user: "u" }), (e: unknown) => e instanceof LlmError && e.status === 401 && e.message === "HTTP 401");
});

test("empty or cut-off completions are errors", async () => {
  process.env.DEEPSEEK_API_KEY = "k";
  stub(200, { choices: [{ message: { content: "" }, finish_reason: "stop" }] });
  await assert.rejects(chatJson({ system: "json", user: "u" }), LlmError);
  stub(200, { choices: [{ message: { content: '{"a":' }, finish_reason: "length" }] });
  await assert.rejects(chatJson({ system: "json", user: "u" }), LlmError);
});
