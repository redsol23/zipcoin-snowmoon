import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { createServer, RateLimit } from "./server";

async function start(opts: Partial<Parameters<typeof createServer>[1]> = {}, ledger: unknown = { ok: true, big: 1n }) {
  const s = createServer(
    { ledger: () => ledger, privacy: () => null, status: () => ({ ok: true }), health: () => ({ ok: true }) },
    { origins: ["https://zipcoin.org", "https://www.zipcoin.org"], devOrigins: false, ratePerMin: 100, trustProxy: false, ...opts },
  );
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => s.close(() => r())) };
}

test("serves the cached documents with strict headers", async () => {
  const s = await start();
  try {
    const r = await fetch(`${s.base}/v1/ledger`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, big: "1" });
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    assert.match(r.headers.get("cache-control")!, /max-age=30/);
    assert.equal((await fetch(`${s.base}/v1/privacy`)).status, 503, "not computed yet");
    assert.equal((await fetch(`${s.base}/v1/nope`)).status, 404);
    assert.equal((await fetch(`${s.base}/v1/ledger`, { method: "POST" })).status, 405);
  } finally {
    await s.close();
  }
});

test("CORS answers zipcoin.org only (and localhost when dev origins are on)", async () => {
  const s = await start();
  const dev = await start({ devOrigins: true });
  try {
    const acao = async (base: string, origin: string) => (await fetch(`${base}/v1/status`, { headers: { origin } })).headers.get("access-control-allow-origin");
    assert.equal(await acao(s.base, "https://zipcoin.org"), "https://zipcoin.org");
    assert.equal(await acao(s.base, "https://www.zipcoin.org"), "https://www.zipcoin.org");
    assert.equal(await acao(s.base, "https://evil.example"), null);
    assert.equal(await acao(s.base, "https://zipcoin.org.evil.example"), null);
    assert.equal(await acao(s.base, "http://localhost:4317"), null);
    assert.equal(await acao(dev.base, "http://localhost:4317"), "http://localhost:4317");
    assert.equal(await acao(dev.base, "http://127.0.0.1:4317"), "http://127.0.0.1:4317");
    assert.equal(await acao(dev.base, "http://localhost.evil.example"), null);
    const pre = await fetch(`${s.base}/v1/status`, { method: "OPTIONS", headers: { origin: "https://zipcoin.org" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-methods"), "GET, HEAD, OPTIONS");
  } finally {
    await Promise.all([s.close(), dev.close()]);
  }
});

test("rate limit per IP, per minute", async () => {
  const s = await start({ ratePerMin: 3 });
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(`${s.base}/health`)).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  } finally {
    await s.close();
  }
  let t = 0;
  const rl = new RateLimit(2, () => t);
  assert.deepEqual([rl.allow("a").ok, rl.allow("a").ok, rl.allow("a").ok, rl.allow("b").ok], [true, true, false, true]);
  t = 60_001;
  assert.equal(rl.allow("a").ok, true, "a new minute");
  rl.sweep();
});

test("behind a proxy the client is the proxy's last X-Forwarded-For hop", async () => {
  const s = await start({ ratePerMin: 1, trustProxy: true });
  try {
    const as = (ip: string) => fetch(`${s.base}/health`, { headers: { "x-forwarded-for": `9.9.9.9, ${ip}` } }).then((r) => r.status);
    assert.deepEqual([await as("1.1.1.1"), await as("2.2.2.2"), await as("1.1.1.1")], [200, 200, 429]);
  } finally {
    await s.close();
  }
});
