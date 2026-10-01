import { harvestTargets, zcPendingReward } from "@zipnet/sdk";

import { cfg, pub } from "./config";
import { accept, GAS, Reject } from "./jobs";

/**
 * The "harvest" job. ZC pays its holders ETH, and the zipnet contracts that hold ZC for people (the pool, merchant
 * stakes, courier bonds, badge locks) only pass it on when someone calls their permissionless harvest(). Couriers do
 * that as a free job, whenever a contract's unclaimed ETH at the token is worth more than the gas the call costs.
 */

/**
 * Minimum unclaimed ETH (wei) worth a harvest. HARVEST_MIN_WEI if set. Otherwise it is what the call burns at today's
 * gas price, GAS.harvest × gasPrice, plus the fee margin (FEE_MARGIN_BPS, 20% by default): at 1 gwei that is
 * 150k × 1 gwei × 1.2 = 0.00018 ETH.
 */
export async function harvestThreshold(): Promise<bigint> {
  if (cfg.harvestMinWei !== undefined) return cfg.harvestMinWei;
  const gasPrice = await pub.getGasPrice();
  return (GAS.harvest * gasPrice * (10_000n + cfg.feeMarginBps)) / 10_000n;
}

/** Harvests every contract whose pending ETH at the token clears the threshold. A contract with nothing to claim is skipped. */
export async function harvestDue() {
  const min = await harvestThreshold();
  for (const target of harvestTargets(cfg.dep)) {
    const pending = await zcPendingReward(pub, cfg.dep, target); // 0 when the token pays no rewards (local stand-in)
    if (pending === 0n || pending < min) continue;
    try {
      await accept({ kind: "harvest", args: [target] }, 0, true);
    } catch (e) {
      // Someone else harvested first: the simulation reverts with the token's NothingToClaim(). Nothing to do.
      if (e instanceof Reject && e.message.includes("NothingToClaim")) continue;
      if (e instanceof Reject) console.warn(`[courier] harvest ${target} skipped: ${e.message}`);
      else throw e;
    }
  }
}
