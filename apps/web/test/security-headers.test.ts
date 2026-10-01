import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";

import { middleware } from "../src/middleware";
import { connectSources, securityHeaders, WALLETCONNECT_CONNECT_ORIGINS, walletConnectProjectId, walletConnectRoute } from "../src/lib/security-headers";

const ENV = {
  PUBLIC_RPC_URL: "https://rpc.public.example/v1/abc",
  PUBLIC_COURIER_URL: "https://courier1.zipcoin.org",
  POSTMAN_URL: "https://postman.zipcoin.org",
  RPC_URL: "https://rpc.internal.example/SECRET",
};
const KEYS = [...Object.keys(ENV), "COURIER_ORIGINS", "COURIER_URL", "STATS_ORIGIN"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]));
});

/** The CSP as a map of directive -> sources */
const csp = (h: string | null) => Object.fromEntries((h ?? "").split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));

function get(url: string) {
  Object.assign(process.env, ENV);
  const res = middleware(new NextRequest(url));
  return res.headers;
}

describe("security headers per route (middleware)", () => {
  it.each(["https://app.zipcoin.org/", "https://app.zipcoin.org/wallet", "https://app.zipcoin.org/api/config", "https://app.zipcoin.org/claim"])("%s: strict CSP, not frameable, HSTS and the rest", (url) => {
    const h = get(url);
    const p = csp(h.get("content-security-policy"));
    expect(p["frame-ancestors"]).toEqual(["'none'"]);
    expect(h.get("x-frame-options")).toBe("DENY");
    expect(p["script-src"]).toContain("'strict-dynamic'");
    expect(p["script-src"].some((s: string) => /^'nonce-[A-Za-z0-9+/=]{20,}'$/.test(s))).toBe(true);
    expect(p["script-src"]).not.toContain("'unsafe-inline'");
    expect(p["object-src"]).toEqual(["'none'"]);
    expect(p["base-uri"]).toEqual(["'none'"]);
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("referrer-policy")).toBe("no-referrer");
    expect(h.get("permissions-policy")).toMatch(/camera=\(\)/);
    // vitest runs with NODE_ENV=test: treated like development (no HSTS); production is checked below
  });

  it("the nonce is fresh per request and passed to Next on the request", () => {
    const a = csp(get("https://app.zipcoin.org/wallet").get("content-security-policy"))["script-src"];
    const b = csp(get("https://app.zipcoin.org/wallet").get("content-security-policy"))["script-src"];
    expect(a.find((s: string) => s.startsWith("'nonce-"))).not.toBe(b.find((s: string) => s.startsWith("'nonce-")));
    const res = middleware(new NextRequest("https://app.zipcoin.org/wallet"));
    // NextResponse.next({ request: { headers } }) forwards overridden request headers under x-middleware-request-*
    expect(res.headers.get("x-middleware-request-x-nonce")).toMatch(/^[A-Za-z0-9+/=]{20,}$/);
    expect(res.headers.get("x-middleware-request-content-security-policy")).toContain(`'nonce-${res.headers.get("x-middleware-request-x-nonce")}'`);
  });
});

describe("policy details", () => {
  it("production: HSTS, upgrade-insecure-requests, no unsafe-eval", () => {
    const h = securityHeaders({ pathname: "/wallet", nonce: "n", env: ENV, dev: false });
    expect(h["Strict-Transport-Security"]).toBe("max-age=63072000; includeSubDomains");
    expect(h["Content-Security-Policy"]).toContain("upgrade-insecure-requests");
    expect(csp(h["Content-Security-Policy"])["script-src"]).not.toContain("'unsafe-eval'");
    expect(csp(h["Content-Security-Policy"])["script-src"]).toContain("'wasm-unsafe-eval'");
    expect(csp(h["Content-Security-Policy"])["worker-src"]).toEqual(["'self'", "blob:"]);
  });

  it("connect-src: the public RPC, couriers, stats API and postman; never the server's RPC or DeepSeek", () => {
    const c = connectSources(ENV, false);
    expect(c).toEqual(expect.arrayContaining(["'self'", "https://rpc.public.example", "https://courier1.zipcoin.org", "https://postman.zipcoin.org", "https://api.zipcoin.org"]));
    expect(c.join(" ")).not.toContain("rpc.internal.example");
    expect(c.join(" ")).not.toContain("deepseek");
  });

  it("courier origins: any https: by default, or exactly COURIER_ORIGINS when set", () => {
    expect(connectSources(ENV, false)).toContain("https:");
    const pinned = connectSources({ ...ENV, COURIER_ORIGINS: "https://courier2.example, https://courier3.example:8443" }, false);
    expect(pinned).not.toContain("https:");
    expect(pinned).toEqual(expect.arrayContaining(["https://courier2.example", "https://courier3.example:8443"]));
  });
});

describe("WalletConnect origins", () => {
  const PID = "0123456789abcdef0123456789abcdef";
  const policy = (pathname: string, env: Record<string, string | undefined>) =>
    csp(securityHeaders({ pathname, nonce: "n", env: { ...ENV, ...env }, dev: false })["Content-Security-Policy"]);

  it("none without a Reown project ID", () => {
    const p = policy("/wallet", {});
    expect(p["connect-src"].join(" ")).not.toMatch(/walletconnect|reown/);
    expect(p["frame-src"]).toEqual(["'self'"]);
    expect(walletConnectProjectId({})).toBeNull();
    expect(walletConnectProjectId({ WALLETCONNECT_PROJECT_ID: "  " })).toBeNull();
    expect(walletConnectProjectId({ WALLETCONNECT_PROJECT_ID: "bad id; script-src *" })).toBeNull();
  });

  it.each(["WALLETCONNECT_PROJECT_ID", "NEXT_PUBLIC_REOWN_PROJECT_ID"])("with %s: exactly the relay and Verify, on wallet pages", (key) => {
    for (const path of ["/", "/wallet", "/claim", "/network"]) {
      const p = policy(path, { [key]: PID });
      expect(p["connect-src"].filter((s: string) => /walletconnect|reown/.test(s))).toEqual(WALLETCONNECT_CONNECT_ORIGINS);
      expect(p["connect-src"]).toContain("wss://relay.walletconnect.org");
      expect(p["frame-src"]).toEqual(["'self'", "https://verify.walletconnect.org"]);
      // Never Reown's RPC, telemetry or anything that could run code
      expect(p["connect-src"].join(" ")).not.toMatch(/rpc\.walletconnect|pulse\.walletconnect|echo\.walletconnect/);
      expect(p["script-src"].join(" ")).not.toMatch(/walletconnect|reown/);
      expect(p["img-src"]).toEqual(["'self'", "data:", "blob:"]);
    }
  });

  it("not on /api", () => {
    for (const path of ["/api", "/api/config"]) {
      const p = policy(path, { WALLETCONNECT_PROJECT_ID: PID });
      expect(p["connect-src"].join(" ")).not.toMatch(/walletconnect/);
      expect(p["frame-src"]).toEqual(["'self'"]);
    }
    expect(walletConnectRoute("/apiary")).toBe(true);
  });

  it("through the middleware", () => {
    process.env.WALLETCONNECT_PROJECT_ID = PID;
    try {
      expect(csp(get("https://app.zipcoin.org/wallet").get("content-security-policy"))["connect-src"]).toContain("wss://relay.walletconnect.org");
      expect(csp(get("https://app.zipcoin.org/api/config").get("content-security-policy"))["connect-src"]).not.toContain("wss://relay.walletconnect.org");
    } finally {
      delete process.env.WALLETCONNECT_PROJECT_ID;
    }
  });
});
