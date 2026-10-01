import { emptyState, entrypointAbi, poolAbi, syncPool, type PoolState } from "@zipnet/sdk";

import { cfg, pub } from "./config";
import { AspPrefix, aspTurnWatched, RecentRoots } from "./roots";

/**
 * The verifiable state server: pool leaves and events rebuilt from the chain, plus the postman's approved labels.
 * Nothing here needs trust: clients rebuild the trees and compare their roots with `pool.currentRoot()` and
 * `entrypoint.latestRoot()`, so any courier (or any node at all) can serve it.
 */

export let state: PoolState = emptyState();
export let asp: { root: bigint; labels: bigint[] } = { root: 0n, labels: [] };
/** The pool's recent state roots, for the root age of held pool proofs (roots.ts) */
export const recentRoots = new RecentRoots();

const aspPrefix = new AspPrefix();

/** The pool's root at the block the state was synced to (a leaf landing after it must not read as a mismatch) */
const rootAtHead = () => pub.readContract({ address: cfg.dep.pool, abi: poolAbi, functionName: "currentRoot", blockNumber: state.head }) as Promise<bigint>;

let lastHead = -1n;

export async function refresh() {
  // Up to the block before the head while the chain moves: a node may answer for the newest block before it serves all
  // of its logs, and then the leaves come up short against the root and the whole state is synced again from the
  // deploy block. A head that hasn't moved since the last refresh (an idle chain, a dev chain mining on demand) is old
  // enough to take whole.
  const head = await pub.getBlockNumber({ cacheTime: 0 });
  const to = head === lastHead || head === 0n ? head : head - 1n;
  lastHead = head;
  state = await syncPool(pub, cfg.dep, state, { fromBlock: BigInt(cfg.dep.deployBlock), toBlock: to });
  // Checked against the tree kept incrementally (not one rebuilt from every leaf on each refresh), at the synced block
  recentRoots.update(state.leaves);
  if (recentRoots.root !== (await rootAtHead())) {
    console.error("[courier] rebuilt state root differs from chain; resyncing from scratch");
    state = await syncPool(pub, cfg.dep, emptyState(), { fromBlock: BigInt(cfg.dep.deployBlock) });
    recentRoots.reset();
    recentRoots.update(state.leaves);
  }
  await refreshAsp();
}

/** The postman's ASP epoch (from /asp), for watching its turn; 0 until known */
let aspEpochSec = 0;

let aspRefreshing: Promise<void> | null = null;

/** The approved labels matching the chain's ASP root, from the postman (one refresh at a time; a second caller shares it) */
export function refreshAsp() {
  aspRefreshing ??= (async () => {
    try {
      const r = (await (await fetch(`${cfg.postmanUrl}/asp`)).json()) as { labels: string[]; epochSec?: number };
      if (typeof r.epochSec === "number") aspEpochSec = r.epochSec;
      const labels = r.labels.map(BigInt);
      const onchain = (await pub.readContract({ address: cfg.dep.entrypoint, abi: entrypointAbi, functionName: "latestRoot" })) as bigint;
      // The postman's list may already include labels for the next epoch; serve the prefix matching the live root
      const n = aspPrefix.match(labels, onchain);
      if (n > 0) asp = { root: onchain, labels: labels.slice(0, n) };
    } catch (e) {
      console.error("[courier] postman unreachable:", (e as Error).message);
    } finally {
      aspRefreshing = null;
    }
  })();
  return aspRefreshing;
}

/** Seconds after the turn the watch keeps looking for the epoch's publish (roots.ts aspTurnWatched) */
const ASP_WATCH_SEC = 300;
let aspSeenEpoch = -1;

/**
 * Run every second (main.ts): from the ASP epoch's turn until its publish is seen, the chain's root is read and, once
 * it moves, the new labels are served at once instead of on the next 10 s refresh (roots.ts aspTurnWatched). The
 * epoch counts as seen once the postman says it has published it (lastEpoch, recorded only after its updateRoot was
 * mined, or found the root already there) and we serve the chain's root.
 */
export async function watchAspTurn() {
  const epoch = aspTurnWatched(Date.now() / 1000, aspEpochSec, aspSeenEpoch, ASP_WATCH_SEC);
  if (epoch === null) return;
  let onchain: bigint;
  let h: { lastEpoch?: number };
  try {
    [onchain, h] = await Promise.all([
      pub.readContract({ address: cfg.dep.entrypoint, abi: entrypointAbi, functionName: "latestRoot" }) as Promise<bigint>,
      fetch(`${cfg.postmanUrl}/health`).then((r) => r.json() as Promise<{ lastEpoch?: number }>),
    ]);
  } catch {
    return; // no root yet, or the postman or the node is away: the 10 s refresh says so
  }
  if (onchain !== asp.root) await refreshAsp();
  if (typeof h.lastEpoch === "number" && h.lastEpoch >= epoch && asp.root === onchain) aspSeenEpoch = epoch;
}
