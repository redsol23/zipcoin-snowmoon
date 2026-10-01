/**
 * zipnet postman: the Association Set Provider.
 *
 * Decides which deposits may be spent privately and publishes the approved set's root on-chain.
 * - A deposit made by one of our own processooor contracts (rezips, merchant revenue, badge unlocks) is approved at
 *   once only when its ZC provably came out of an already-approved note: the pool paid that contract out of a spent
 *   note in the same transaction (for a badge unlock: in the lock's transaction), and no other ZC reached it there
 *   (trust.ts). The same contracts also take ZC straight from wallets (zipTo, pay, lock, stake); those deposits are
 *   public ones, screened and capped by the wallet that funded them.
 * - Every other deposit waits VET_DELAY_SEC, then is screened: a configurable denylist plus, on mainnet, the
 *   Chainalysis sanctions oracle. Rejected deposits stay rejected; their owners can always ragequit.
 * - Roots are pushed only at epoch boundaries (EPOCH_SEC). A withdrawal proof must name the latest ASP root, so a
 *   steady schedule is what lets couriers hold a proof and submit it at a random time inside the epoch.
 *
 * - An epoch counts as done only once updateRoot is mined (or the chain already has the root); a failed or unmined
 *   update is retried on the next tick. State is written atomically with a backup (store.ts).
 *
 * Serves GET /asp (root + labels, for provers; clients check the root against entrypoint.latestRoot()) and /health:
 * 200 when the RPC answers, the on-chain root was confirmed within 2 epochs and the last tick succeeded, else 503 with
 * the problems listed (epoch.ts).
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, http as httpTransport, parseAbiItem, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { buildTree, emptyState, entrypointAbi, parseDeployment, syncPool, type PoolState } from "@zipnet/sdk";

import { checkCaps, type ApprovedDeposit } from "./caps";
import { healthStatus, nextTickMs, publishEpoch } from "./epoch";
import { splitTransport } from "./rpc";
import { loadState, saveState } from "./store";
import { fundingOf, type Funding, type FundingIo } from "./trust";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};

const RPC_URL = env("RPC_URL");
/**
 * Optional: where updateRoot is broadcast. Unset = RPC_URL, the public mempool, which is fine here: only the POSTMAN
 * role may call updateRoot and the root is public anyway, so there is nothing to front-run (docs/DEPLOY.md).
 */
const SEND_RPC_URL = process.env.SEND_RPC_URL || undefined;
/** How long to wait for updateRoot to be mined before giving up and retrying on a later tick */
const CONFIRM_TIMEOUT_MS = Number(env("CONFIRM_TIMEOUT_SEC", "300")) * 1000;
const dep = parseDeployment(fs.readFileSync(env("DEPLOYMENT"), "utf8"));
const account = privateKeyToAccount(env("POSTMAN_KEY") as Hex);
const EPOCH_SEC = Number(env("EPOCH_SEC", "14400"));
const VET_DELAY_SEC = Number(env("VET_DELAY_SEC", "3600"));
const TICK_MS = Number(env("TICK_MS", "15000"));
/** Launch caps in ZC wei (0 = off): largest single deposit, and most one depositor may bring in per rolling 24h */
const CAPS = { maxDeposit: BigInt(env("MAX_DEPOSIT_WEI", "0")), maxDepositorDaily: BigInt(env("MAX_DEPOSITOR_DAILY_WEI", "0")) };
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
const wallet = createWalletClient({ account, transport: splitTransport(RPC_URL, SEND_RPC_URL) });

/** Our contracts: their deposits are approved at once when note-funded (trust.ts), and are public deposits otherwise */
const TRUSTED_DEPOSITORS = new Set([dep.rezip, dep.pay, dep.badges].filter((a): a is Address => !!a).map((a) => a.toLowerCase()));

// A corrupt state file falls back to its backup, or stops the postman: approvals are never silently reset (store.ts)
const saved = loadState(STATE_FILE);
const approved = new Set(saved.approved);
const approvedAt: Record<string, number> = saved.approvedAt ?? {};
const rejected = new Map(saved.rejected.map((r) => [r.label, r]));
/** Over the per-deposit cap. Kept in memory only, so raising MAX_DEPOSIT_WEI and restarting re-admits them. */
const capRejected = new Set<string>();
const persist = () =>
  saveState(STATE_FILE, { approved: [...approved], approvedAt, rejected: [...rejected.values()], lastEpoch: saved.lastEpoch, rootFreshAt: saved.rootFreshAt });
const approve = (label: string, now: number) => {
  approved.add(label);
  approvedAt[label] ??= now;
};

let state: PoolState = emptyState();
const waiting = new Set<string>();

const TRUST_CTX = { pool: dep.pool, zc: dep.zc, badges: dep.badges };
const LOCKED = parseAbiItem("event Locked(uint256 indexed lockId, uint8 tier, uint256 identityCommitment, uint256 value, uint64 unlockAt)");
const fundingIo: FundingIo = {
  tx: async (hash) => {
    const r = await pub.getTransactionReceipt({ hash });
    return { hash, from: r.from, logs: r.logs };
  },
  lockTx: async (lockId) => {
    const logs = await pub.getLogs({ address: dep.badges, event: LOCKED, args: { lockId }, fromBlock: BigInt(dep.deployBlock) });
    return logs[0]?.transactionHash ?? null;
  },
};
/** How each of our contracts' deposits was funded (decided once per label) */
const funding = new Map<string, Funding>();
/** The wallet that funded a public deposit made through one of our contracts: screened, and the caps apply to it */
const originOf = new Map<string, Address>();

/** Approved deposits with their approval time, for the rolling daily cap. */
async function approvedHistory(): Promise<ApprovedDeposit[]> {
  if (CAPS.maxDepositorDaily === 0n) return [];
  const out: ApprovedDeposit[] = [];
  for (const d of state.deposits) {
    const label = d.label.toString();
    // State files written before approvedAt existed fall back to the deposit's block time
    if (approved.has(label)) out.push({ depositor: originOf.get(label) ?? d.depositor, value: d.value, at: approvedAt[label] ?? (await timeOf(d.block)) });
  }
  return out;
}
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
/** Root of the approved set; an empty tree has no root yet, which the Entrypoint also reads as 0. */
let rootMemo = { size: 0, root: 0n };
/** Rebuilt only when the set grew (it only grows): every /asp request asked for it, a whole tree of every label each time */
const aspRoot = () => {
  if (rootMemo.size !== approved.size) rootMemo = { size: approved.size, root: buildTree(approvedLabels().map(BigInt)).root };
  return rootMemo.root;
};

async function tick() {
  state = await syncPool(pub, dep, state, { fromBlock: BigInt(dep.deployBlock) });
  const now = Math.floor(Date.now() / 1000);

  for (const d of state.deposits) {
    const label = d.label.toString();
    if (approved.has(label) || rejected.has(label) || capRejected.has(label)) continue;
    let origin = d.depositor;
    if (TRUSTED_DEPOSITORS.has(d.depositor.toLowerCase())) {
      let f = funding.get(label);
      if (!f) {
        f = await fundingOf(d, TRUST_CTX, fundingIo);
        funding.set(label, f);
        if (!f.noteFunded) console.log(`[postman] ${d.depositor} deposit ${label.slice(0, 12)}… funded by ${f.origin}, vetting it as a public deposit (${f.reason})`);
      }
      if (f.noteFunded) {
        approve(label, now);
        continue;
      }
      origin = f.origin;
      originOf.set(label, origin);
    }
    if (now - (await timeOf(d.block)) < VET_DELAY_SEC) continue;
    const reason = (await screen(origin)) ?? (origin === d.depositor ? null : await screen(d.depositor));
    if (reason) {
      rejected.set(label, { label, depositor: d.depositor, reason: origin === d.depositor ? reason : `${reason}: funded by ${origin}` });
      console.log(`[postman] rejected ${origin} (${reason}); they can ragequit`);
      continue;
    }
    const cap = checkCaps(CAPS, { depositor: origin, value: d.value }, await approvedHistory(), now);
    if (cap.verdict === "reject") {
      capRejected.add(label);
      console.log(`[postman] rejected ${d.depositor} deposit of ${d.value} (${cap.reason}); they can ragequit`);
    } else if (cap.verdict === "wait") {
      if (!waiting.has(label)) console.log(`[postman] holding ${d.depositor} deposit of ${d.value}: ${cap.reason}`);
      waiting.add(label);
    } else {
      approve(label, now);
      waiting.delete(label);
    }
  }
  persist();

  await publishEpoch({
    now: () => Math.floor(Date.now() / 1000),
    epochSec: EPOCH_SEC,
    root: () => (approved.size ? aspRoot() : null),
    // Before the first root the Entrypoint's latestRoot() reverts (an empty list), which reads as 0. Any other failure
    // (the RPC is down) throws: it must never look like "no root yet"
    latestRoot: () =>
      (pub.readContract({ address: dep.entrypoint, abi: entrypointAbi, functionName: "latestRoot" }) as Promise<bigint>).catch((e: unknown) => {
        if (e instanceof BaseError && e.walk((c) => c instanceof ContractFunctionRevertedError)) return 0n;
        throw e;
      }),
    updateRoot: async (root) => {
      // The Entrypoint wants a 32-64 char IPFS CID; until sets are pinned the label list is served at /asp and the
      // "CID" is a content tag derived from the root, which clients can recompute.
      const cid = `zipnet-asp-${root.toString(16).padStart(64, "0").slice(0, 40)}`;
      const hash = await wallet.writeContract({ chain: null, address: dep.entrypoint, abi: entrypointAbi, functionName: "updateRoot", args: [root, cid] });
      const r = await pub.waitForTransactionReceipt({ hash, timeout: CONFIRM_TIMEOUT_MS });
      if (r.status !== "success") throw new Error(`updateRoot reverted in ${hash}`);
      return { hash };
    },
    saved,
    persist,
    log: (m) => console.log(`[postman] ${m} (${approved.size} labels)`),
  });
}

const startedAt = Math.floor(Date.now() / 1000);
let lastTickOkAt: number | undefined;
let lastError: { at: number; message: string } | undefined;
/** A live RPC check, cached briefly so /health can't be used to hammer the node */
let rpcCheck = { at: 0, ok: false };
async function rpcOk() {
  const now = Date.now();
  if (now - rpcCheck.at > 10_000) {
    const ok = await pub.getBlockNumber({ cacheTime: 0 }).then(
      () => true,
      () => false,
    );
    rpcCheck = { at: now, ok };
  }
  return rpcCheck.ok;
}

async function health() {
  const h = healthStatus({ now: Math.floor(Date.now() / 1000), epochSec: EPOCH_SEC, startedAt, rootFreshAt: saved.rootFreshAt, rpcOk: await rpcOk(), lastError, lastTickOkAt });
  return {
    ...h,
    head: state.head.toString(),
    lastEpoch: saved.lastEpoch,
    approved: approved.size,
    rejected: rejected.size,
    overCap: capRejected.size,
    heldByCaps: waiting.size,
    caps: { maxDeposit: CAPS.maxDeposit.toString(), maxDepositorDaily: CAPS.maxDepositorDaily.toString() },
  };
}

http
  .createServer(async (req, res) => {
    const h = req.url === "/health" ? await health() : null;
    const body = req.url === "/asp" ? { root: aspRoot().toString(), labels: approvedLabels(), epochSec: EPOCH_SEC } : h;
    // A failing /health answers 503, so a plain HTTP monitor sees it
    res.writeHead(!body ? 404 : h && !h.ok ? 503 : 200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(body ?? { error: "not found" }));
  })
  .listen(PORT, () => console.log(`[postman] ${account.address} serving /asp on :${PORT}, epoch ${EPOCH_SEC}s`));

const loop = async () => {
  try {
    await tick();
    lastTickOkAt = Math.floor(Date.now() / 1000);
  } catch (e) {
    lastError = { at: Math.floor(Date.now() / 1000), message: (e as Error).message.split("\n")[0].slice(0, 300) };
    console.error("[postman]", e);
  }
  // On its own clock, and at each epoch turn: the root goes out a tick's work after the turn, not up to TICK_MS later
  setTimeout(loop, nextTickMs(Date.now(), TICK_MS, EPOCH_SEC));
};
loop();
