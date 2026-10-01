// What /api/config hands the browser. Only values meant for every visitor: PUBLIC_RPC_URL is the RPC the browser may
// use. RPC_URL is the server's own node (often with a key in the URL) and must never reach a browser, so there is no
// fallback to it: without PUBLIC_RPC_URL the wallet gets a clear configuration error instead.
import fs from "node:fs";

import { walletConnectProjectId } from "./security-headers";

type Env = Record<string, string | undefined>;

export const MISSING_PUBLIC_RPC =
  "This server has no PUBLIC_RPC_URL set, so the wallet has no RPC to use. The operator must set PUBLIC_RPC_URL to a public, rate-limited RPC endpoint (the server's own RPC_URL is never sent to browsers).";

/** Configuration problems to log at start-up (instrumentation.ts) and to answer /api/config with. */
export function configProblems(env: Env): string[] {
  const out: string[] = [];
  if (!env.PUBLIC_RPC_URL?.trim()) out.push(MISSING_PUBLIC_RPC);
  if (!env.DEPLOYMENT || !fs.existsSync(env.DEPLOYMENT)) out.push("Set DEPLOYMENT to a deployments/*.json file (run ./scripts/local-up.sh for a local one).");
  return out;
}

export function publicConfig(env: Env): { status: number; body: Record<string, unknown> } {
  const path = env.DEPLOYMENT;
  if (!path || !fs.existsSync(path)) {
    return { status: 503, body: { error: "Set DEPLOYMENT to a deployments/*.json file (run ./scripts/local-up.sh for a local one)." } };
  }
  const rpcUrl = env.PUBLIC_RPC_URL?.trim();
  if (!rpcUrl) return { status: 503, body: { error: MISSING_PUBLIC_RPC, code: "PUBLIC_RPC_URL_UNSET" } };
  const deployment = JSON.parse(fs.readFileSync(path, "utf8"));
  const projectId = walletConnectProjectId(env);
  const chainId = Number(deployment.chainId);
  return {
    status: 200,
    body: {
      deployment,
      rpcUrl,
      courierUrl: env.PUBLIC_COURIER_URL ?? env.COURIER_URL ?? "http://127.0.0.1:8720",
      devWallet: Boolean(env.DEV_FAUCET_KEY),
      // Mobile wallets (WalletConnect through Reown's relay): only with a project ID. The project ID is public by
      // design (it is in every relay URL). The one chain is the deployment's (mainnet, Sepolia or the local chain),
      // with our public RPC, so the SDK never falls back to Reown's RPC.
      walletConnect: projectId && Number.isSafeInteger(chainId) && chainId > 0 ? { projectId, chains: [{ id: chainId, rpcUrl }] } : null,
    },
  };
}
