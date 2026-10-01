"use client";

import { listCouriers, pickCourier, type CourierInfo } from "@zipnet/sdk";
import type { PublicClient } from "viem";

import type { Config } from "./wallet";

/**
 * Which courier carries the next action: one of the bonded couriers, chosen with probability proportional to stake,
 * so the wallet doesn't send everything through one relayer. Falls back to the configured courier when the registry
 * has none reachable.
 */

let cache: { at: number; list: CourierInfo[] } = { at: 0, list: [] };

async function bonded(c: Config, pub: PublicClient) {
  if (Date.now() - cache.at > 60_000) cache = { at: Date.now(), list: await listCouriers(pub, c.deployment.couriers, BigInt(c.deployment.deployBlock)) };
  return cache.list;
}

export async function chooseCourierUrl(c: Config, pub: PublicClient): Promise<string> {
  try {
    const pick = pickCourier(await bonded(c, pub));
    if (pick) {
      const url = pick.endpoint.replace(/\/$/, "");
      // A courier that doesn't answer its quote in time isn't worth the wait; fall back
      const ok = await fetch(`${url}/quote`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
      if (ok) return url;
    }
  } catch {
    /* registry unreadable: use the configured courier */
  }
  return c.courierUrl;
}
