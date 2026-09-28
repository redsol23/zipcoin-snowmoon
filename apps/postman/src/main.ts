/**
 * zipnet postman: the Association Set Provider.
 *
 * Decides which deposits may be spent privately and publishes the approved set's root on-chain.
 * - Deposits made by our own processooor contracts (rezips, merchant revenue, badge unlocks) are approved at once:
 *   their value came out of notes that were already approved.
 * - Every other deposit waits VET_DELAY_SEC, then is screened: a configurable denylist plus, on mainnet, the
 *   Chainalysis sanctions oracle. Rejected deposits stay rejected; their owners can always ragequit.
 * - Roots are pushed only at epoch boundaries (EPOCH_SEC). A withdrawal proof must name the latest ASP root, so a
 *   steady schedule is what lets couriers hold a proof and submit it at a random time inside the epoch.
 *
 * Serves GET /asp (root + labels, for provers; clients check the root against entrypoint.latestRoot()) and /health.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createPublicClient, createWalletClient, http as httpTransport, parseAbiItem, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { buildTree, emptyState, entrypointAbi, parseDeployment, syncPool, type PoolState } from "@zipnet/sdk";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};

const RPC_URL = env("RPC_URL");
const dep = parseDeployment(fs.readFileSync(env("DEPLOYMENT"), "utf8"));
const account = privateKeyToAccount(env("POSTMAN_KEY") as Hex);
const EPOCH_SEC = Number(env("EPOCH_SEC", "14400"));
const VET_DELAY_SEC = Number(env("VET_DELAY_SEC", "3600"));
const TICK_MS = Number(env("TICK_MS", "15000"));
const PORT = Number(env("PORT", "8710"));
const STATE_FILE = env("STATE_FILE", path.resolve(".postman-state.json"));
/** Chainalysis sanctions oracle; mainnet 0x40C57923924B5c5c5455c48D93317139ADDaC8fb. Unset = denylist only. */
const SANCTIONS_ORACLE = process.env.SANCTIONS_ORACLE as Address | undefined;
const DENYLIST = new Set(
  (process.env.DENYLIST_FILE ? fs.readFileSync(process.env.DENYLIST_FILE, "utf8") : "")
    .split(/\s+/)
    .filter(Boolean)
    .map((a) => a.toLowerCase()),
);

const pub = createPublicClient({ transport: httpTransport(RPC_URL) });
const wallet = createWalletClient({ account, transport: httpTransport(RPC_URL) });

/** Deposits whose depositor is one of our contracts spend value from already-approved notes. */
const TRUSTED_DEPOSITORS = new Set([dep.rezip, dep.pay, dep.badges].map((a) => a.toLowerCase()));

type Saved = { approved: string[]; rejected: { label: string; depositor: string; reason: string }[]; lastEpoch: number };
const saved: Saved = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : { approved: [], rejected: [], lastEpoch: -1 };
const approved = new Set(saved.approved);
const rejected = new Map(saved.rejected.map((r) => [r.label, r]));
const persist = () =>
  fs.writeFileSync(STATE_FILE, JSON.stringify({ approved: [...approved], rejected: [...rejected.values()], lastEpoch: saved.lastEpoch }));

let state: PoolState = emptyState();
const blockTime = new Map<bigint, number>();

async function timeOf(block: bigint) {
  if (!blockTime.has(block)) blockTime.set(block, Number((await pub.getBlock({ blockNumber: block })).timestamp));
  return blockTime.get(block)!;
}

async function screen(depositor: Address): Promise<string | null> {
  if (DENYLIST.has(depositor.toLowerCase())) return "denylist";
  if (SANCTIONS_ORACLE) {
    const hit = await pub.readContract({
      address: SANCTIONS_ORACLE,
      abi: [parseAbiItem("function isSanctioned(address) view returns (bool)")],
      functionName: "isSanctioned",
      args: [depositor],
    });
    if (hit) return "sanctions oracle";
  }
  return null;
}

/** Approved labels in approval order. Append-only, so every published root is a prefix of the next list. */
const approvedLabels = () => [...approved];

async function tick() {
  state = await syncPool(pub, dep, state, { fromBlock: BigInt(dep.deployBlock) });
  const now = Math.floor(Date.now() / 1000);

  for (const d of state.deposits) {
    const label = d.label.toString();
    if (approved.has(label) || rejected.has(label)) continue;
    if (TRUSTED_DEPOSITORS.has(d.depositor.toLowerCase())) {
      approved.add(label);
      continue;
    }
    if (now - (await timeOf(d.block)) < VET_DELAY_SEC) continue;
    const reason = await screen(d.depositor);
    if (reason) {
      rejected.set(label, { label, depositor: d.depositor, reason });
      console.log(`[postman] rejected ${d.depositor} (${reason}); they can ragequit`);
    } else approved.add(label);
  }
  persist();

  const epoch = Math.floor(now / EPOCH_SEC);
  const labels = approvedLabels();
  if (epoch === saved.lastEpoch || labels.length === 0) return;
  const root = buildTree(labels.map(BigInt)).root;
  const latest = await pub.readContract({ address: dep.entrypoint, abi: entrypointAbi, functionName: "latestRoot" }).catch(() => 0n);
  saved.lastEpoch = epoch;
  persist();
  if (root === latest) return;

  // The Entrypoint wants a 32-64 char IPFS CID; until sets are pinned the label list is served at /asp and the
  // "CID" is a content tag derived from the root, which clients can recompute.
  const cid = `zipnet-asp-${root.toString(16).padStart(64, "0").slice(0, 40)}`;
  const hash = await wallet.writeContract({ chain: null, address: dep.entrypoint, abi: entrypointAbi, functionName: "updateRoot", args: [root, cid] });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`[postman] epoch ${epoch}: root ${root} (${labels.length} labels) tx ${hash}`);
}

http
  .createServer((req, res) => {
    const body =
      req.url === "/asp"
        ? { root: buildTree(approvedLabels().map(BigInt)).root.toString(), labels: approvedLabels(), epochSec: EPOCH_SEC }
        : req.url === "/health"
          ? { ok: true, head: state.head.toString(), approved: approved.size, rejected: rejected.size }
          : null;
    res.writeHead(body ? 200 : 404, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(body ?? { error: "not found" }));
  })
  .listen(PORT, () => console.log(`[postman] ${account.address} serving /asp on :${PORT}, epoch ${EPOCH_SEC}s`));

const loop = async () => {
  try {
    await tick();
  } catch (e) {
    console.error("[postman]", e);
  }
  setTimeout(loop, TICK_MS);
};
loop();
