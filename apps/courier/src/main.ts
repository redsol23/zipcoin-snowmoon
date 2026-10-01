/**
 * zipnet courier: a node of the layer between users and the chain.
 *
 *   GET  /health               status, bonded stake, pending rewards (ZC tax share and ETH), version, when it last
 *                              sent a job (any kind, its own cover included; to the minute)
 *   GET  /quote                this courier's fee per job kind (ZC wei), address, epoch end
 *   GET  /state                pool leaves + events (verify against pool.currentRoot()); ETag / If-None-Match
 *   GET  /state/meta           head, counts, chunk size (private reads: clients fetch every chunk, or a delta)
 *   GET  /state/chunk          ?kind=leaves|deposits|withdrawals|ragequits|rezips&i=N, fixed-size chunk
 *   GET  /state/delta          ?l&d&w&r&z = counts the client holds -> tails after them
 *   GET  /asp                  approved labels (verify against entrypoint.latestRoot())
 *   POST /jobs                 { kind, withdrawal?, proof?, args?, holdSec? } -> job (+ signed receipt if held)
 *   GET  /jobs/:id             job status, tx hash included. The id is a capability: 122 random bits, returned only
 *                              to the submitter (POST reply, or sealed back), never listed or logged in full, so only
 *                              the submitter can look a job up. Don't publish it.
 *   POST /subscribe            { address, telegramChatId?, webhook? } doorstep notifications
 *   POST /relay-hop            { to, envelope } first hop: forward a sealed job to another bonded courier
 *   POST /sealed               { envelope } destination: open, accept, reply sealed to the client
 */
import fs from "node:fs";
import http from "node:http";
import { formatEther } from "viem";

import { etagOf, STATE_KINDS, stateChunk, stateDelta, stateMeta, fromJson, toJson, pendingEth, zipCouriersAbi, type StateKind } from "@zipnet/sdk";

import { bandsDue, bandsEveryMs } from "./bands";
import { clientKey } from "./budget";
import { cfg, envelope, fees, pub, sender } from "./config";
import { startCover } from "./cover";
import { harvestDue } from "./harvest";
import { checkReceiptKey, deliverDue, epochEnd, GAS, jobs, pruneJobs, quote, recoverSending, Reject, type Kind } from "./jobs";
import { acceptBody, openSealed, parseJob, relayHop } from "./relay";
import { startNotify, subscribe } from "./notify";
import { asp, refresh, state, watchAspTurn } from "./state";

/** Shown on /health, so the public status page can tell which couriers run which release */
const VERSION = String(JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "dev");

/** When this courier last sent anything, to the minute: a liveness signal that says nothing about whose job it was */
function lastJobAt() {
  let last = 0;
  for (const j of jobs.values()) if (j.status === "sent" && j.submitAt > last) last = j.submitAt;
  return last ? Math.floor(last / 60_000) * 60 : null;
}

const erc20 = [{ type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" }] as const;

async function bondIfNeeded() {
  if (cfg.bond === 0n) return;
  const [stake] = (await pub.readContract({ address: cfg.dep.couriers, abi: zipCouriersAbi, functionName: "couriers", args: [cfg.account.address] })) as [bigint, bigint, string];
  if (stake > 0n) return;
  await sender.send("background", { address: cfg.dep.zc, abi: erc20, functionName: "approve", args: [cfg.dep.couriers, cfg.bond] });
  const separateKey = cfg.receiptAccount.address.toLowerCase() !== cfg.account.address.toLowerCase();
  await sender.send(
    "background",
    separateKey
      ? { address: cfg.dep.couriers, abi: zipCouriersAbi, functionName: "bondWithKey", args: [cfg.bond, cfg.publicUrl, cfg.receiptAccount.address] }
      : { address: cfg.dep.couriers, abi: zipCouriersAbi, functionName: "bond", args: [cfg.bond, cfg.publicUrl] },
  );
  console.log(`[courier] bonded ${formatEther(cfg.bond)} ZC${separateKey ? `, receipts signed by ${cfg.receiptAccount.address}` : ""}`);
}

/** The client address for per-client limits (budget.ts clientKey; TRUST_PROXY behind a tunnel or proxy) */
const clientOf = (req: http.IncomingMessage) => clientKey(req.socket.remoteAddress, req.headers["x-forwarded-for"], cfg.trustProxy);

const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let s = "";
    req.on("data", (d) => {
      s += d;
      if (s.length > 400_000) reject(new Reject("body too large"));
    });
    req.on("end", () => resolve(s));
  });

async function route(req: http.IncomingMessage): Promise<[number, unknown, Record<string, string>?]> {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "GET" && url.pathname === "/health") {
    const pending = (await pub.readContract({ address: cfg.dep.couriers, abi: zipCouriersAbi, functionName: "pending", args: [cfg.account.address] })) as bigint;
    const eth = await pendingEth(pub, cfg.dep, "couriers", cfg.account.address).catch(() => 0n);
    return [200, { ok: true, courier: cfg.account.address, head: state.head, aspLabels: asp.labels.length, jobs: jobs.size, pendingRewards: pending, pendingEth: eth, version: VERSION, lastJobAt: lastJobAt(), txInFlight: sender.pendingNonces.length }];
  }
  if (req.method === "GET" && url.pathname === "/quote") {
    const kinds = Object.keys(GAS) as Kind[];
    const quotes = await Promise.all(kinds.map(async (k) => [k, await quote(k)] as const));
    const fees = Object.fromEntries(quotes.map(([k, q]) => [k, q.fee]));
    // Every fee here is honoured until feesValidUntil (unix sec), even if gas or the ZC price moves meanwhile
    const feesValidUntil = Math.min(...quotes.map(([, q]) => q.validUntil));
    return [200, { courier: cfg.account.address, fees, feesValidUntil, relayFeeIsBps: true, batchFeeIsBps: true, epochEnd: await epochEnd(), marginSec: cfg.epochMarginSec, encryptionKey: envelope.publicKey }];
  }
  if (req.method === "GET" && url.pathname === "/state") {
    const tag = etagOf(state);
    return req.headers["if-none-match"] === tag ? [304, null, { etag: tag }] : [200, state, { etag: tag }];
  }
  if (req.method === "GET" && url.pathname === "/state/meta") return [200, stateMeta(state)];
  if (req.method === "GET" && url.pathname === "/state/chunk") {
    const kind = url.searchParams.get("kind") as StateKind;
    if (!STATE_KINDS.includes(kind)) throw new Reject("unknown kind");
    return [200, stateChunk(state, kind, Number(url.searchParams.get("i") ?? "0"))];
  }
  if (req.method === "GET" && url.pathname === "/state/delta") {
    const n = (k: string) => Math.max(0, Number(url.searchParams.get(k) ?? "0") | 0);
    return [200, stateDelta(state, { leaves: n("l"), deposits: n("d"), withdrawals: n("w"), ragequits: n("r"), rezips: n("z") })];
  }
  if (req.method === "GET" && url.pathname === "/asp") return [200, asp];
  if (req.method === "GET" && url.pathname.startsWith("/jobs/")) {
    const j = jobs.get(url.pathname.slice(6));
    return j ? [200, { id: j.id, kind: j.kind, status: j.status, tx: j.tx, error: j.error, submitAt: j.submitAt, deadline: j.deadline, receipt: j.receipt }] : [404, { error: "no such job" }];
  }
  if (req.method === "POST" && url.pathname === "/jobs") {
    return [202, await acceptBody(parseJob(await readBody(req)), clientOf(req))];
  }
  if (req.method === "POST" && url.pathname === "/relay-hop") return [200, await relayHop(JSON.parse(await readBody(req)), req.socket.remoteAddress ?? "?")];
  // The first hop is the client here: its address keys the per-client free-job limit
  if (req.method === "POST" && url.pathname === "/sealed") return [200, await openSealed(JSON.parse(await readBody(req)), clientOf(req))];
  if (req.method === "POST" && url.pathname === "/subscribe") {
    subscribe(JSON.parse(await readBody(req)));
    return [200, { ok: true }];
  }
  return [404, { error: "not found" }];
}

http
  .createServer(async (req, res) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
    if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
    let status: number;
    let body: unknown;
    let extra: Record<string, string> | undefined;
    try {
      [status, body, extra] = await route(req);
    } catch (e) {
      [status, body] = e instanceof Reject ? [400, { error: e.message }] : [500, { error: (e as Error).message.split("\n")[0] }];
    }
    res.writeHead(status, { "content-type": "application/json", "access-control-expose-headers": "etag", ...cors, ...extra });
    res.end(status === 304 ? undefined : toJson(body));
  })
  .listen(cfg.port, () => console.log(`[courier] ${cfg.account.address} on :${cfg.port}`));

const every = (ms: number, fn: () => Promise<void>) => {
  const go = async () => {
    try {
      await fn();
    } catch (e) {
      console.error("[courier]", (e as Error).message.split("\n")[0]);
    }
    setTimeout(go, ms);
  };
  go();
};

await bondIfNeeded().catch((e) => console.error("[courier] bond failed:", (e as Error).message.split("\n")[0]));
await checkReceiptKey().catch((e) => console.error("[courier] reading the receipt signing key failed:", (e as Error).message.split("\n")[0]));
await recoverSending().catch((e) => console.error("[courier] recovering in-flight jobs failed:", (e as Error).message.split("\n")[0]));
every(3_600_000, async () => pruneJobs());
every(10_000, refresh);
// The ASP epoch turn: the new root served as soon as the chain has it, not on the next refresh (state.ts)
every(1_000, watchAspTurn);
// The pool price samples fee quotes use (fees.ts); a no-op with ZC_PER_ETH_WAD set
every(cfg.feeSampleSec * 1000, () => fees.sample());
every(5_000, deliverDue);
every(6 * 3_600_000, async () => {
  const pending = (await pub.readContract({ address: cfg.dep.couriers, abi: zipCouriersAbi, functionName: "pending", args: [cfg.account.address] })) as bigint;
  if (pending > 0n) await sender.write("background", { chain: null, address: cfg.dep.couriers, abi: zipCouriersAbi, functionName: "claim" });
  if ((await pendingEth(pub, cfg.dep, "couriers", cfg.account.address)) > 0n) {
    await sender.write("background", { chain: null, address: cfg.dep.couriers, abi: zipCouriersAbi, functionName: "claimEth" });
  }
});
// ZC's ETH holder rewards: harvest each ZC-holding contract once its pending ETH is worth the gas
every(30 * 60_000, harvestDue);
// Treasury liquidity bands: deposit when worth 20x the gas, collect fees to the Safe monthly, claim ZC rewards
every(bandsEveryMs, bandsDue);
startNotify();
startCover();
