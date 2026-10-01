"use client";

import { formatEther } from "viem";

import { scanParkedPayouts } from "@/components/wallet/parked-scan";
import type { MyLock } from "@/components/wallet/WalletProvider";

import type { Ctx } from "../actions";

/** What Emerald's read-only wallet tools report, computed in the browser from the same scan the wallet's tabs use. */

/** The wallet context plus the badge locks (for the parked-payout scan). */
export type FeatureCtx = Ctx & { locks: MyLock[] };

const fmt = (v: bigint) => Number(formatEther(v)).toLocaleString("en-US", { maximumFractionDigits: 4 });

/** Runs a read-only feature tool; undefined if the name isn't one. */
export async function runFeatureRead(name: string, c: FeatureCtx): Promise<unknown> {
  switch (name) {
    case "parked_payouts": {
      // Read only: the same scan as the Parked tab
      const items = await scanParkedPayouts({ config: c.config, pub: c.pub, keys: c.keys, pool: c.pool, locks: c.locks });
      return {
        count: items.length,
        payouts: items.map((p) => ({
          what: p.title,
          amount_zc: fmt(p.amount),
          state: p.state === "parked" ? "parked (the deposit back into the pool failed)" : "in the pool, but the approver hasn't cleared it for over a day",
          why: p.explanation,
          choices: p.state === "unapproved" ? ["ragequit to an address (public)"] : p.canRedirect ? ["send back into the pool (private)", "send to an address (public)"] : ["send to an address (public)"],
        })),
        where: "The wallet's Parked tab, next to Unzip. Recovering happens there, through a courier; Emerald can't do it.",
      };
    }
    default:
      return undefined;
  }
}
