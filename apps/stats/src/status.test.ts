import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { isPrivateIp, makeProbe, refuseUrl } from "./probe";
import { addr, at, E, FakeChain, fakeProbe, makeStats, NOW, SAFE } from "./testkit";

const UP = addr(0x1);
const SLOW = addr(0x2);
const GONE = addr(0x3);
const LEAVING = addr(0x4);

type Status = {
  postman: { configured: boolean; reachable?: boolean; approved?: number; error?: string; lastRoot: { at: number; ageSec: number; epoch: number; epochSec: number; published: number } | null };
  couriers: { address: string; endpoint: string; bond: string; active: boolean; unbonding: boolean; reachable: boolean | null; version: string | null; lastJobAgeSec: number | null; error?: string }[];
};

function chain() {
  const c = new FakeChain();
  c.onRead(at("bands"), "SAFE", SAFE);
  const info: Record<string, [bigint, bigint, string, boolean]> = {
    [UP]: [5000n * E, 0n, "https://up.example/", true],
    [SLOW]: [1000n * E, 0n, "https://slow.example", true],
    [GONE]: [0n, 0n, "https://gone.example", false],
    [LEAVING]: [2000n * E, BigInt(NOW + 86_400), "https://leaving.example", false],
  };
  for (const a of Object.keys(info)) c.emit(at("couriers"), "Bonded", 20n, { courier: a, stake: 1n, endpoint: "x" });
  c.emit(at("couriers"), "EndpointSet", 30n, { courier: UP, endpoint: "https://up.example/" });
  c.onRead(at("couriers"), "couriers", ([a]: readonly unknown[]) => info[a as string].slice(0, 3));
  c.onRead(at("couriers"), "isActive", ([a]: readonly unknown[]) => info[a as string][3]);
  c.emit(at("entrypoint"), "RootUpdated", 99_000n, { _root: 1n, _ipfsCID: "x", _timestamp: BigInt(NOW - 7200) });
  c.emit(at("entrypoint"), "RootUpdated", 99_900n, { _root: 2n, _ipfsCID: "y", _timestamp: BigInt(NOW - 600) });
  return c;
}

const couriersProbe = fakeProbe({
  "https://up.example/health": { ok: true, status: 200, body: { ok: true, version: "0.1.0", lastJobAt: NOW - 90, pendingRewards: "123" } },
  "https://slow.example/health": { ok: false, error: "timeout" },
});
const postmanProbe = fakeProbe({
  "http://postman.internal:8710/health": { ok: true, body: { ok: true, approved: 12, rejected: 1, heldByCaps: 0 } },
  "http://postman.internal:8710/asp": { ok: true, body: { root: "2", labels: ["1"], epochSec: 3600 } },
});

test("status reports the postman's last root and each bonded courier", async () => {
  const s = makeStats(chain(), { postmanUrl: "http://postman.internal:8710" }, { probe: couriersProbe, postman: postmanProbe });
  await s.refresh();
  const st = s.status as unknown as Status;
  assert.equal(st.postman.reachable, true);
  assert.equal(st.postman.approved, 12);
  assert.deepEqual(st.postman.lastRoot, { at: NOW - 600, ageSec: 600, epoch: Math.floor((NOW - 600) / 3600), epochSec: 3600, published: 2 });
  assert.deepEqual(
    st.couriers.map((c) => [c.address, c.bond, c.active, c.unbonding, c.reachable, c.version, c.lastJobAgeSec, c.error ?? null]),
    [
      [UP, (5000n * E).toString(), true, false, true, "0.1.0", 90, null],
      [LEAVING, (2000n * E).toString(), false, true, null, null, null, null],
      [SLOW, (1000n * E).toString(), true, false, false, null, null, "timeout"],
    ],
    "sorted by bond; an unbonded courier is gone; an unbonding one isn't probed",
  );
  assert.ok(!JSON.stringify(st).includes("pendingRewards"), "only chosen fields of a courier's /health are passed on");
});

test("an unreachable postman is reported, and the last root still comes from the chain", async () => {
  const s = makeStats(chain(), { postmanUrl: "http://down.internal:1" }, { probe: couriersProbe, postman: fakeProbe({}) });
  await s.refresh();
  const st = s.status as unknown as Status;
  assert.equal(st.postman.reachable, false);
  assert.equal(st.postman.error, "unreachable");
  assert.equal(st.postman.lastRoot!.ageSec, 600);
  assert.equal(st.postman.lastRoot!.epochSec, 3600, "falls back to EPOCH_SEC");
});

test("courier URLs can't point the service at private networks", () => {
  const prod = { allowPrivate: false, allowHttp: false };
  assert.equal(refuseUrl("https://courier.example.org", prod), null);
  assert.equal(refuseUrl("https://courier.example.org:8443/x", prod), null);
  assert.equal(refuseUrl("http://courier.example.org", prod), "not https");
  for (const u of ["https://127.0.0.1", "https://10.1.2.3", "https://192.168.1.1", "https://172.20.0.1", "https://100.81.1.1", "https://169.254.169.254", "https://[::1]", "https://[fd00::1]", "https://localhost", "https://box.local"])
    assert.equal(refuseUrl(u, prod), "private address", u);
  assert.equal(refuseUrl("https://user:pw@courier.example.org", prod), "credentials in URL");
  assert.equal(refuseUrl("https://courier.example.org:22", prod), "port not allowed");
  assert.equal(refuseUrl("file:///etc/passwd", prod), "not https");
  assert.equal(refuseUrl("http://127.0.0.1:8720", { allowPrivate: true, allowHttp: true }), null);
  assert.equal(isPrivateIp("8.8.8.8"), false);
  assert.equal(isPrivateIp("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateIp("2606:4700::1111"), false);
});

async function server(handler: http.RequestListener) {
  const s = http.createServer(handler);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => s.close(() => r())) };
}

test("the probe times out, caps the size and refuses private addresses resolved from names", async () => {
  const hang = await server(() => {});
  const big = await server((_, res) => res.end(JSON.stringify({ x: "y".repeat(50_000) })));
  const fine = await server((_, res) => res.end(JSON.stringify({ ok: true })));
  try {
    const dev = makeProbe({ timeoutMs: 300, allowPrivate: true, allowHttp: true });
    const t0 = Date.now();
    assert.equal((await dev(`${hang.url}/health`)).error, "timeout");
    assert.ok(Date.now() - t0 < 2000);
    assert.equal((await dev(`${big.url}/health`)).error, "response too large");
    assert.deepEqual((await dev(`${fine.url}/health`)).body, { ok: true });
    // "localhost" resolves to loopback: refused at connect time in production mode
    const prod = makeProbe({ timeoutMs: 1000, allowPrivate: false, allowHttp: true });
    const port = new URL(fine.url).port;
    assert.equal((await prod(`http://localhost:${port}/health`)).error, "private address");
    assert.equal((await prod(`http://localhost.:${port}/health`)).ok, false);
  } finally {
    await Promise.all([hang.close(), big.close(), fine.close()]);
  }
});
