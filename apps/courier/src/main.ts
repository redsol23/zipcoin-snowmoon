/**
 * zipnet courier: a node of the layer between users and the chain.
 *
 *   GET  /health               status, bonded stake, pending rewards
 *   GET  /quote                this courier's fee per job kind (ZC wei), address, epoch end
 *   GET  /state                pool leaves + events (verify against pool.currentRoot())
 *   GET  /asp                  approved labels (verify against entrypoint.latestRoot())
 *   POST /jobs                 { kind, withdrawal?, proof?, args?, holdSec? } -> job (+ signed receipt if held)
 *   GET  /jobs/:id             job status
 *   POST /subscribe            { address, telegramChatId?, webhook? } doorstep notifications
 */
import http from "node:http";
import { formatEther } from "viem";

import { fromJson, toJson, zipCouriersAbi } from "@zipnet/sdk";

import { cfg, pub, wallet } from "./config";
import { startCover } from "./cover";
import { accept, deliverDue, epochEnd, GAS, jobs, quote, Reject, type Kind } from "./jobs";
import { startNotify, subscribe } from "./notify";
import { asp, refresh, state } from "./state";

const erc20 = [{ type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" }] as const;

async function bondIfNeeded() {
  if (cfg.bond === 0n) return;
  const [stake] = (await pub.readContract({ address: cfg.dep.couriers, abi: zipCouriersAbi, functionName: "couriers", args: [cfg.account.address] })) as [bigint, bigint, string];
  if (stake > 0n) return;
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ chain: null, address: cfg.dep.zc, abi: erc20, functionName: "approve", args: [cfg.dep.couriers, cfg.bond] }) });
  await pub.waitForTransactionReceipt({
    hash: await wallet.writeContract({ chain: null, address: cfg.dep.couriers, abi: zipCouriersAbi, functionName: "bond", args: [cfg.bond, cfg.publicUrl] }),
  });
  console.log(`[courier] bonded ${formatEther(cfg.bond)} ZC`);
}

type SemProof = { merkleTreeDepth: string; merkleTreeRoot: string; nullifier: string; message: string; scope: string; points: string[] };
const semProof = (p: SemProof) => ({
  merkleTreeDepth: BigInt(p.merkleTreeDepth),
  merkleTreeRoot: BigInt(p.merkleTreeRoot),
  nullifier: BigInt(p.nullifier),
  message: BigInt(p.message),
  scope: BigInt(p.scope),
  points: p.points.map((x) => BigInt(x)),
});

/** Posts, votes and unlocks arrive as JSON; give viem the exact types of ZipSignal.post / ZipPolls.vote / ZipBadges.unlock. */
function semaphoreArgs(kind: Kind, a?: unknown[]) {
  if (!a) return a;
  if (kind === "post") return [BigInt(a[0] as string), BigInt(a[1] as string), String(a[2]), semProof(a[3] as SemProof)];
  if (kind === "vote") return [BigInt(a[0] as string), Number(a[1]), a[2], semProof(a[3] as SemProof)];
  if (kind === "unlock") return [BigInt(a[0] as string), (a[1] as string[][]).map((g) => g.map((x) => BigInt(x)))];
  return a;
}

const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let s = "";
    req.on("data", (d) => {
      s += d;
      if (s.length > 200_000) reject(new Reject("body too large"));
    });
    req.on("end", () => resolve(s));
  });

async function route(req: http.IncomingMessage): Promise<[number, unknown]> {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "GET" && url.pathname === "/health") {
    const pending = (await pub.readContract({ address: cfg.dep.couriers, abi: zipCouriersAbi, functionName: "pending", args: [cfg.account.address] })) as bigint;
    return [200, { ok: true, courier: cfg.account.address, head: state.head, aspLabels: asp.labels.length, jobs: jobs.size, pendingRewards: pending }];
  }
  if (req.method === "GET" && url.pathname === "/quote") {
    const kinds = Object.keys(GAS) as Kind[];
    const fees = Object.fromEntries(await Promise.all(kinds.map(async (k) => [k, await quote(k)])));
    return [200, { courier: cfg.account.address, fees, relayFeeIsBps: true, epochEnd: await epochEnd(), marginSec: cfg.epochMarginSec }];
  }
  if (req.method === "GET" && url.pathname === "/state") return [200, state];
  if (req.method === "GET" && url.pathname === "/asp") return [200, asp];
  if (req.method === "GET" && url.pathname.startsWith("/jobs/")) {
    const j = jobs.get(url.pathname.slice(6));
    return j ? [200, { id: j.id, kind: j.kind, status: j.status, tx: j.tx, error: j.error, submitAt: j.submitAt, deadline: j.deadline, receipt: j.receipt }] : [404, { error: "no such job" }];
  }
  if (req.method === "POST" && url.pathname === "/jobs") {
    const b = fromJson<{ kind: Kind; withdrawal?: never; proof?: never; args?: unknown[]; holdSec?: number }>(await readBody(req), [
      "pA",
      "pB",
      "pC",
      "pubSignals",
    ]);
    const j = await accept({ kind: b.kind, withdrawal: b.withdrawal, proof: b.proof, args: semaphoreArgs(b.kind, b.args) }, Math.max(0, Number(b.holdSec ?? 0)));
    return [202, { id: j.id, status: j.status, tx: j.tx, submitAt: j.submitAt, deadline: j.deadline, receipt: j.receipt }];
  }
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
    try {
      [status, body] = await route(req);
    } catch (e) {
      [status, body] = e instanceof Reject ? [400, { error: e.message }] : [500, { error: (e as Error).message.split("\n")[0] }];
    }
    res.writeHead(status, { "content-type": "application/json", ...cors });
    res.end(toJson(body));
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
every(10_000, refresh);
every(5_000, deliverDue);
every(6 * 3_600_000, async () => {
  const pending = (await pub.readContract({ address: cfg.dep.couriers, abi: zipCouriersAbi, functionName: "pending", args: [cfg.account.address] })) as bigint;
  if (pending > 0n) await wallet.writeContract({ chain: null, address: cfg.dep.couriers, abi: zipCouriersAbi, functionName: "claim" });
});
startNotify();
startCover();
