// Security headers for every page, set by src/middleware.ts. Pure (no Node APIs) so it runs in the middleware and in
// tests. See docs/DEPLOY.md, "Web security headers", for the policy per route and the choices below.
//
// Script policy: a fresh nonce per request plus 'strict-dynamic'. Next reads the nonce from the request's CSP header
// and puts it on its own inline and chunk scripts (the root layout is dynamic so every page gets it); scripts those
// load are trusted through 'strict-dynamic'. No 'unsafe-inline' for scripts. 'wasm-unsafe-eval' lets the in-browser
// prover (snarkjs/ffjavascript) compile WebAssembly, and worker-src blob: lets it start its worker threads, which it
// builds from a Blob. Development adds 'unsafe-eval' for React's dev tooling.
//
// Framing: no page may be framed at all (frame-ancestors 'none', X-Frame-Options DENY).
//
// Connections: the browser talks to PUBLIC_RPC_URL, the couriers, the stats API and the postman; Emerald's model is
// called by the server, so it isn't listed. Courier URLs come from the chain (ZipCouriers), so they can't be known
// when the header is written: COURIER_ORIGINS pins a list (a courier outside it simply fails to answer, and the wallet
// moves on to the next), and unset allows any https: origin for connect-src only. Scripts stay nonce-only either way.
//
// WalletConnect (mobile wallets through Reown's relay) is off unless a Reown project ID is set. When it is on, the
// relay's WebSocket joins connect-src and Reown's Verify page joins frame-src, on every page except /api (see
// walletConnectRoute). Nothing else of Reown's is allowed: the SDK is loaded from our own origin, only after a
// visitor picks "Mobile wallet", with telemetry off and our own RPC for every chain. docs/DEPLOY.md lists each origin.

type Env = Record<string, string | undefined>;

export const DEFAULT_STATS_ORIGIN = "https://api.zipcoin.org";

/**
 * The Reown (WalletConnect) origins the browser needs once a visitor picks "Mobile wallet". Checked against
 * @walletconnect/core 2.25: the relay is its only default relay URL (RELAYER_DEFAULT_RELAY_URL), and Verify registers
 * the session proposal from a hidden iframe on verify.walletconnect.org/v3 so the wallet can show our domain as
 * verified. Deliberately absent: rpc.walletconnect.org (we pass our own RPC for every chain), pulse.walletconnect.org
 * (telemetry, turned off), echo.walletconnect.com (push, wallet side only), and the .com relay (not used by 2.x).
 */
export const WALLETCONNECT_CONNECT_ORIGINS = ["wss://relay.walletconnect.org"];
export const WALLETCONNECT_FRAME_ORIGINS = ["https://verify.walletconnect.org"];

/** The Reown project ID, or null when WalletConnect is off */
export function walletConnectProjectId(env: Env): string | null {
  const id = (env.WALLETCONNECT_PROJECT_ID || env.NEXT_PUBLIC_REOWN_PROJECT_ID || "").trim();
  return /^[A-Za-z0-9_-]{8,128}$/.test(id) ? id : null;
}

/**
 * Pages that may use WalletConnect: not /api (no pages). Every other page is included, not only /wallet: moving between pages is client-side, so the policy of the page a
 * visitor landed on (say /) is the one in force when they open the wallet.
 */
export const walletConnectRoute = (pathname: string) => pathname !== "/api" && !pathname.startsWith("/api/");

const list = (v: string | undefined) => (v ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

/** The origin of a URL, or null if it isn't one */
export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "ws:" || u.protocol === "wss:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** connect-src sources (see the top of the file) */
export function connectSources(env: Env, dev: boolean, walletConnect = false): string[] {
  const out = new Set<string>(["'self'"]);
  const add = (u: string | undefined) => {
    const o = originOf(u);
    if (o) out.add(o);
  };
  add(env.PUBLIC_RPC_URL);
  add(env.PUBLIC_COURIER_URL);
  add(env.COURIER_URL);
  add(env.POSTMAN_URL);
  add(env.STATS_ORIGIN || DEFAULT_STATS_ORIGIN);
  const couriers = list(env.COURIER_ORIGINS);
  if (couriers.length === 0) out.add("https:");
  for (const c of couriers) {
    if (c === "https:") out.add("https:");
    else add(c);
  }
  if (walletConnect) for (const o of WALLETCONNECT_CONNECT_ORIGINS) out.add(o);
  if (dev) for (const s of ["http://localhost:*", "http://127.0.0.1:*", "ws://localhost:*", "ws://127.0.0.1:*"]) out.add(s);
  return [...out];
}

export function contentSecurityPolicy(o: { nonce: string; env: Env; dev: boolean; walletConnect?: boolean }): string {
  const d: [string, string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", `'nonce-${o.nonce}'`, "'strict-dynamic'", "'wasm-unsafe-eval'", ...(o.dev ? ["'unsafe-eval'"] : [])]],
    // React renders style attributes and next/font inlines its @font-face rules; styles can't run code
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", connectSources(o.env, o.dev, o.walletConnect)],
    ["worker-src", ["'self'", "blob:"]],
    // Only our own pages in frames, plus Reown's Verify page when WalletConnect is on
    ["frame-src", ["'self'", ...(o.walletConnect ? WALLETCONNECT_FRAME_ORIGINS : [])]],
    ["manifest-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ];
  const csp = d.map(([k, v]) => `${k} ${v.join(" ")}`);
  if (!o.dev) csp.push("upgrade-insecure-requests");
  return csp.join("; ");
}

/** Every security header for one request */
export function securityHeaders(o: { pathname: string; nonce: string; env: Env; dev: boolean }): Record<string, string> {
  const walletConnect = walletConnectProjectId(o.env) !== null && walletConnectRoute(o.pathname);
  const h: Record<string, string> = {
    "Content-Security-Policy": contentSecurityPolicy({ nonce: o.nonce, env: o.env, dev: o.dev, walletConnect }),
    "X-Content-Type-Options": "nosniff",
    // Legacy clickjacking guard for browsers without frame-ancestors
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    // Nothing here uses the camera, microphone, location or payment APIs; copying links needs clipboard-write
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=(), display-capture=(), interest-cohort=(), browsing-topics=(), clipboard-read=(), clipboard-write=(self)",
  };
  if (!o.dev) h["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains";
  return h;
}

/** A base64 nonce from 16 random bytes */
export function makeNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b));
}
