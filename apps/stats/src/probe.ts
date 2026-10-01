import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * Asks a service for its /health, carefully: courier endpoints are URLs anyone can publish by bonding, so this server
 * must not become a way to reach its own network. Only http(s) on the default or a high port; the address a name
 * resolves to is checked at connect time (so DNS rebinding can't slip past), and loopback, private, link-local,
 * CGNAT and multicast ranges are refused unless `allowPrivate` (local development). No redirects, no cookies, a hard
 * timeout and a small size cap. Only the fields the caller picks out of the JSON are ever used.
 */
export type ProbeResult = { ok: boolean; ms: number; status?: number; body?: unknown; error?: string };
export type Probe = (url: string) => Promise<ProbeResult>;

export type ProbeOptions = { timeoutMs: number; allowPrivate: boolean; allowHttp: boolean; maxBytes?: number };

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("ff") || v.startsWith("64:ff9b");
  }
  return true;
}

/** Why a URL can't be probed, or null if it may be */
export function refuseUrl(raw: string, opts: Pick<ProbeOptions, "allowPrivate" | "allowHttp">): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "not a URL";
  }
  if (u.protocol !== "https:" && !(opts.allowHttp && u.protocol === "http:")) return "not https";
  if (u.username || u.password) return "credentials in URL";
  const port = u.port ? Number(u.port) : null;
  if (port !== null && port < 1024 && port !== 443 && port !== 80) return "port not allowed";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && !opts.allowPrivate && isPrivateIp(host)) return "private address";
  if (!opts.allowPrivate && /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) return "private address";
  return null;
}

export function makeProbe(opts: ProbeOptions): Probe {
  const maxBytes = opts.maxBytes ?? 16_384;
  const lookup: net.LookupFunction = (hostname, options, cb) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return (cb as (e: Error | null) => void)(err);
      const list = addrs as dns.LookupAddress[];
      const bad = !opts.allowPrivate && list.some((a) => isPrivateIp(a.address));
      if (bad || list.length === 0) return (cb as (e: Error | null) => void)(new Error("private address"));
      if ((options as { all?: boolean }).all) (cb as (e: null, a: dns.LookupAddress[]) => void)(null, list);
      else (cb as (e: null, a: string, f: number) => void)(null, list[0].address, list[0].family);
    });
  };

  return (raw) =>
    new Promise<ProbeResult>((resolve) => {
      const t0 = Date.now();
      const done = (r: Omit<ProbeResult, "ms">) => resolve({ ...r, ms: Date.now() - t0 });
      const why = refuseUrl(raw, opts);
      if (why) return done({ ok: false, error: why });
      const u = new URL(raw);
      const mod = u.protocol === "https:" ? https : http;
      const req = mod.get(
        u,
        { lookup, timeout: opts.timeoutMs, headers: { accept: "application/json", "user-agent": "zipcoin-stats" }, agent: false },
        (res) => {
          let size = 0;
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > maxBytes) {
              req.destroy();
              done({ ok: false, status: res.statusCode, error: "response too large" });
            } else chunks.push(c);
          });
          res.on("end", () => {
            if (size > maxBytes) return;
            const status = res.statusCode ?? 0;
            let body: unknown;
            try {
              body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              return done({ ok: false, status, error: "not JSON" });
            }
            done({ ok: status >= 200 && status < 300, status, body, ...(status >= 300 ? { error: `HTTP ${status}` } : {}) });
          });
          res.on("error", () => done({ ok: false, error: "connection error" }));
        },
      );
      const hard = setTimeout(() => {
        req.destroy();
        done({ ok: false, error: "timeout" });
      }, opts.timeoutMs);
      req.on("timeout", () => {
        req.destroy();
        done({ ok: false, error: "timeout" });
      });
      req.on("error", (e) => done({ ok: false, error: /private address/.test(e.message) ? "private address" : "unreachable" }));
      req.on("close", () => clearTimeout(hard));
    });
}
