import http from "node:http";

/**
 * The HTTP side: three cached JSON documents, read-only. CORS only for zipcoin.org (and localhost when DEV_ORIGINS
 * is on), a per-IP rate limit kept in memory for a minute at most, strict headers, and no request logging at all.
 */

export type Docs = { ledger: () => unknown; privacy: () => unknown; status: () => unknown; health: () => unknown };

export type ServerOptions = {
  origins: string[];
  devOrigins: boolean;
  /** Requests per IP per minute */
  ratePerMin: number;
  /** Behind a reverse proxy: take the client address from the last X-Forwarded-For hop */
  trustProxy: boolean;
  now?: () => number;
};

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-site",
  "x-frame-options": "DENY",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "permissions-policy": "interest-cohort=()",
};

const DEV = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/** A fixed one-minute window per IP. Entries are dropped when their window ends; nothing is written anywhere. */
export class RateLimit {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(
    private perMin: number,
    private now: () => number = Date.now,
  ) {}
  allow(ip: string): { ok: boolean; retryAfter: number } {
    const t = this.now();
    if (this.hits.size > 50_000) this.sweep();
    let h = this.hits.get(ip);
    if (!h || h.reset <= t) {
      h = { n: 0, reset: t + 60_000 };
      this.hits.set(ip, h);
    }
    h.n++;
    return { ok: h.n <= this.perMin, retryAfter: Math.ceil((h.reset - t) / 1000) };
  }
  sweep() {
    const t = this.now();
    for (const [ip, h] of this.hits) if (h.reset <= t) this.hits.delete(ip);
  }
}

export function clientIp(req: http.IncomingMessage, trustProxy: boolean) {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const last = (Array.isArray(xff) ? xff.join(",") : xff ?? "").split(",").map((s) => s.trim()).filter(Boolean).at(-1);
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function createServer(docs: Docs, opts: ServerOptions) {
  const limit = new RateLimit(opts.ratePerMin, opts.now);
  const sweeper = setInterval(() => limit.sweep(), 60_000);
  sweeper.unref();
  const allowed = new Set(opts.origins);
  const routes: Record<string, () => unknown> = {
    "/v1/ledger": docs.ledger,
    "/v1/privacy": docs.privacy,
    "/v1/status": docs.status,
    "/health": docs.health,
  };

  return http.createServer((req, res) => {
    const origin = req.headers.origin;
    const cors: Record<string, string> = { vary: "Origin" };
    if (origin && (allowed.has(origin) || (opts.devOrigins && DEV.test(origin)))) {
      cors["access-control-allow-origin"] = origin;
      cors["access-control-allow-methods"] = "GET, HEAD, OPTIONS";
      cors["access-control-max-age"] = "600";
    }
    const send = (code: number, body: unknown, extra: Record<string, string> = {}) => {
      const text = body === null ? "" : JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v));
      res.writeHead(code, { ...HEADERS, ...cors, ...extra });
      res.end(req.method === "HEAD" ? undefined : text);
    };

    if (req.method === "OPTIONS") return send(204, null, { "cache-control": "max-age=600" });
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, { ok: false, error: "read-only" }, { allow: "GET, HEAD, OPTIONS" });

    const r = limit.allow(clientIp(req, opts.trustProxy));
    if (!r.ok) return send(429, { ok: false, error: "slow down" }, { "retry-after": String(r.retryAfter) });

    const path = (req.url ?? "/").split("?")[0];
    const route = routes[path];
    if (!route) return send(404, { ok: false, error: "not found" });
    const body = route();
    if (body === null || body === undefined) return send(503, { ok: false, error: "warming up" }, { "retry-after": "10", "cache-control": "no-store" });
    send(200, body, { "cache-control": "public, max-age=30" });
  });
}
