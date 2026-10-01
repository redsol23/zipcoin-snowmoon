/**
 * zipnet stats: the read-only data service behind zipcoin.org's Ledger, Privacy meter and Status pages, served at
 * https://api.zipcoin.org.
 *
 *   GET /v1/ledger    allowlisted contracts and wallets: role, controller, powers, live balances; flows over 24h / 7d / all
 *   GET /v1/privacy   distinct outside depositors in the pool over the same windows, note-size buckets, and the method
 *   GET /v1/status    the postman (reachable, last ASP root, its age) and each bonded courier (reachable, bond, version)
 *   GET /health       { ok, updatedAt }
 *
 * It holds no key and sends no transaction. It reads RPC_URL, the deployment JSON, and the public /health of the
 * postman and couriers; everything is recomputed every REFRESH_MS (60s) and served from memory. Only contracts with
 * "show": true in the allowlist (public-contracts.json) appear anywhere in a response. No request is logged.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isAddress, type Address } from "viem";

import { loadAllowlist } from "./allowlist";
import { rpcChain } from "./chain";
import { makeProbe } from "./probe";
import { createServer } from "./server";
import { Stats } from "./stats";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};
const flag = (k: string) => process.env[k] === "1" || process.env[k] === "true";
const addresses = (s: string) =>
  s
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((a) => {
      if (!isAddress(a)) throw new Error(`not an address: ${a}`);
      return a as Address;
    });

const here = path.dirname(fileURLToPath(import.meta.url));
const dep = JSON.parse(fs.readFileSync(env("DEPLOYMENT"), "utf8"));
const allow = loadAllowlist(env("ALLOWLIST", path.join(here, "..", "public-contracts.json")));
const PORT = Number(env("PORT", "8750"));
const REFRESH_MS = Number(env("REFRESH_MS", "60000"));
const TIMEOUT_MS = Number(env("PROBE_TIMEOUT_MS", "4000"));

const stats = new Stats(
  {
    dep: { ...dep, chainId: Number(dep.chainId), deployBlock: Number(dep.deployBlock) },
    allow,
    safe: process.env.SAFE_ADDRESS ? addresses(process.env.SAFE_ADDRESS)[0] : undefined,
    postmanUrl: process.env.POSTMAN_URL || undefined,
    epochSec: Number(env("EPOCH_SEC", "14400")),
    exclude: addresses([process.env.EXCLUDE_ADDRESSES ?? "", process.env.EXCLUDE_FILE ? fs.readFileSync(process.env.EXCLUDE_FILE, "utf8") : ""].join(" ")),
    funders: addresses(process.env.PROJECT_FUNDERS ?? ""),
    confirmations: BigInt(env("CONFIRMATIONS", "2")),
    logChunk: BigInt(env("LOG_CHUNK", "5000")),
  },
  {
    chain: rpcChain(env("RPC_URL")),
    // Courier endpoints are anyone's URLs: public https only, unless ALLOW_PRIVATE_ENDPOINTS (local development)
    probe: makeProbe({ timeoutMs: TIMEOUT_MS, allowPrivate: flag("ALLOW_PRIVATE_ENDPOINTS"), allowHttp: flag("ALLOW_PRIVATE_ENDPOINTS") }),
    // The postman URL is the operator's own setting, so it may be on the same host or private network
    postmanProbe: makeProbe({ timeoutMs: TIMEOUT_MS, allowPrivate: true, allowHttp: true }),
    now: () => Math.floor(Date.now() / 1000),
  },
);

createServer(
  {
    ledger: () => stats.ledger,
    privacy: () => stats.privacy,
    status: () => stats.status,
    health: () => ({ ok: stats.updatedAt > 0 && !stats.lastError, updatedAt: stats.updatedAt || null }),
  },
  {
    origins: env("CORS_ORIGINS", "https://zipcoin.org,https://www.zipcoin.org").split(",").map((s) => s.trim()).filter(Boolean),
    devOrigins: flag("DEV_ORIGINS"),
    ratePerMin: Number(env("RATE_LIMIT_PER_MIN", "60")),
    trustProxy: flag("TRUST_PROXY"),
  },
).listen(PORT, env("HOST", "127.0.0.1"), () => console.log(`[stats] serving /v1/ledger, /v1/privacy, /v1/status on :${PORT}, ${allow.shown.length} contracts on the allowlist`));

const loop = async () => {
  const t0 = Date.now();
  try {
    await stats.refresh();
  } catch (e) {
    // Keep serving the last good documents; say what failed without request data (there is none here)
    stats.lastError = (e as Error).message?.split("\n")[0] ?? "refresh failed";
    console.error(`[stats] refresh failed: ${stats.lastError}`);
  }
  setTimeout(loop, Math.max(5_000, REFRESH_MS - (Date.now() - t0)));
};
loop();
