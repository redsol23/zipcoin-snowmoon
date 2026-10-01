// Builds Emerald's gate from the environment and the deployment. Server-only. Tests swap it with setGateDeps.
import { randomBytes } from "node:crypto";
import fs from "node:fs";

import { parseDeployment, semaphoreAbi, zipBadgesAbi, type Deployment } from "@zipnet/sdk";
import { createPublicClient, http, parseAbi, parseEther, type PublicClient } from "viem";

import type { GateDeps } from "./gate";

const balanceAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
let injected: GateDeps | null = null;
let built: Promise<GateDeps> | null = null;

/** For tests: use these instead of the environment and the chain. */
export const setGateDeps = (d: GateDeps | null) => {
  injected = d;
  built = null;
};

export class GateUnavailable extends Error {}

export function gateDeps(): Promise<GateDeps> {
  if (injected) return Promise.resolve(injected);
  built ??= build().catch((e) => {
    built = null;
    throw e;
  });
  return built;
}

let warned = false;

async function build(): Promise<GateDeps> {
  const path = process.env.DEPLOYMENT;
  if (!path || !fs.existsSync(path)) throw new GateUnavailable("Emerald can't check ZC holdings: set DEPLOYMENT on this server.");
  const dep: Deployment = parseDeployment(fs.readFileSync(path, "utf8"));
  const pub = createPublicClient({ transport: http(process.env.RPC_URL ?? process.env.PUBLIC_RPC_URL ?? "http://127.0.0.1:8546") }) as PublicClient;

  let secret = process.env.EMERALD_SESSION_SECRET ?? "";
  if (secret.length < 32) {
    // Sessions still work, but only in this process and only until it restarts
    if (!warned) console.warn("EMERALD_SESSION_SECRET is unset or shorter than 32 characters; using a random per-process secret.");
    warned = true;
    // Next bundles each route separately, so a per-module secret would differ between /challenge and /session:
    // keep one per process on globalThis
    const g = globalThis as { __emeraldFallbackSecret?: string };
    secret = g.__emeraldFallbackSecret ??= randomBytes(32).toString("hex");
  }

  return {
    chainId: dep.chainId,
    minTier: Math.max(1, Math.floor(Number(process.env.EMERALD_MIN_TIER ?? "1") || 1)),
    minHoldWei: BigInt(process.env.EMERALD_MIN_HOLD_WEI || parseEther("100000").toString()),
    epochSec: Math.max(60, Number(process.env.EMERALD_EPOCH_SEC ?? process.env.EPOCH_SEC ?? "3600") || 3600),
    sessionSec: 3600,
    secret,
    now: () => Math.floor(Date.now() / 1000),
    tierGroup: async (tier) => {
      const n = Number(await pub.readContract({ address: dep.badges, abi: zipBadgesAbi, functionName: "tierCount" }));
      return tier >= 1 && tier <= n ? ((await pub.readContract({ address: dep.badges, abi: zipBadgesAbi, functionName: "tierGroups", args: [BigInt(tier - 1)] })) as bigint) : null;
    },
    verifyBadgeProof: (groupId, p) =>
      pub.readContract({
        address: dep.semaphore,
        abi: semaphoreAbi,
        functionName: "verifyProof",
        args: [groupId, { ...p, points: p.points as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint] }],
      }) as Promise<boolean>,
    balanceOf: (a) => pub.readContract({ address: dep.zc, abi: balanceAbi, functionName: "balanceOf", args: [a] }),
    verifySignature: (address, message, signature) => pub.verifyMessage({ address, message, signature }),
  };
}
