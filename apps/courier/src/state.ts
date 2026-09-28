import { buildTree, emptyState, entrypointAbi, syncPool, verifyState, type PoolState } from "@zipnet/sdk";

import { cfg, pub } from "./config";

/**
 * The verifiable state server: pool leaves and events rebuilt from the chain, plus the postman's approved labels.
 * Nothing here needs trust: clients rebuild the trees and compare their roots with `pool.currentRoot()` and
 * `entrypoint.latestRoot()`, so any courier (or any node at all) can serve it.
 */

export let state: PoolState = emptyState();
export let asp: { root: bigint; labels: bigint[] } = { root: 0n, labels: [] };

export async function refresh() {
  state = await syncPool(pub, cfg.dep, state, { fromBlock: BigInt(cfg.dep.deployBlock) });
  if (!(await verifyState(pub, cfg.dep.pool, state))) {
    console.error("[courier] rebuilt state root differs from chain; resyncing from scratch");
    state = await syncPool(pub, cfg.dep, emptyState(), { fromBlock: BigInt(cfg.dep.deployBlock) });
  }
  try {
    const r = (await (await fetch(`${cfg.postmanUrl}/asp`)).json()) as { labels: string[] };
    const labels = r.labels.map(BigInt);
    const onchain = (await pub.readContract({ address: cfg.dep.entrypoint, abi: entrypointAbi, functionName: "latestRoot" })) as bigint;
    // The postman's list may already include labels for the next epoch; serve the prefix matching the live root
    for (let n = labels.length; n > 0; n--) {
      if (buildTree(labels.slice(0, n)).root === onchain) {
        asp = { root: onchain, labels: labels.slice(0, n) };
        break;
      }
    }
  } catch (e) {
    console.error("[courier] postman unreachable:", (e as Error).message);
  }
}
