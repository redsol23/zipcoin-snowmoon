import fs from "node:fs";
import path from "node:path";

import { BAND_NAMES, bandsAbi, bandsDepositWorthIt, bandsDepositable, zcPendingReward } from "@zipnet/sdk";

import { cfg, pub } from "./config";
import { accept, GAS, Reject, type BandsKind } from "./jobs";

/**
 * The "bands" job. ZipLiquidityBands places the treasury's tax share (ZC) as one-sided liquidity ABOVE ZC's launch
 * range only (never below it, and never ETH), but only when someone calls its permissionless functions. Couriers do,
 * as free jobs, modelled on harvest.ts:
 *
 * - deposit(): every BANDS_EVERY_MIN (360), when depositable() says a deposit would add ZC and the ZC (at spot) is
 *   worth at least BANDS_MIN_VALUE_MULT (20) times the deposit's gas. The contract enforces its own caps.
 * - collect(band): once every 30 days per courier, for each band whose fees are worth that multiple of the gas.
 *   Fees go to the treasury Safe, never to the caller.
 * - claimRewards(): whenever ZC holds more ETH for the contract than the call costs (like a harvest). It sends all
 *   the contract's ETH to the Safe.
 * - forwardEth(): when the ETH waiting in the contract (harvests, rewards) is worth that multiple of its gas; all of
 *   it goes to the Safe.
 *
 * Every call is simulated first (accept), so a band the price has entered, a paused contract or a race with another
 * courier costs nothing.
 */

const EVERY_MIN = Number(process.env.BANDS_EVERY_MIN ?? "360");
const MIN_VALUE_MULT = BigInt(process.env.BANDS_MIN_VALUE_MULT ?? "20");
const COLLECT_EVERY_MS = 30 * 24 * 3_600_000;
const FILE = path.join(cfg.dataDir, "bands.json");

/** How often main.ts runs bandsDue */
export const bandsEveryMs = Math.max(1, EVERY_MIN) * 60_000;

const lastCollect = (): number => {
  try {
    return (JSON.parse(fs.readFileSync(FILE, "utf8")) as { lastCollect?: number }).lastCollect ?? 0;
  } catch {
    return 0;
  }
};

async function send(kind: BandsKind, args: unknown[] = []) {
  try {
    await accept({ kind, args }, 0, true);
    return true;
  } catch (e) {
    if (!(e instanceof Reject)) throw e;
    // Nothing to do (another courier was first, or ZC has nothing to claim): not worth a warning
    if (!/NothingToDeposit|NothingToClaim|TooSoon/.test(e.message)) console.warn(`[courier] ${kind} ${args.join(",")} skipped: ${e.message}`);
    return false;
  }
}

async function depositIfWorthIt(gasPrice: bigint) {
  const d = await bandsDepositable(pub, cfg.dep);
  if (!d?.ok) return;
  const [sqrtPriceX96] = (await pub.readContract({ address: cfg.dep.bands!, abi: bandsAbi, functionName: "slot0" })) as [bigint, number];
  const gas = await pub.estimateContractGas({ address: cfg.dep.bands!, abi: bandsAbi, functionName: "deposit", account: cfg.account }).catch(() => GAS.bands);
  if (!bandsDepositWorthIt({ zc: d.zc, eth: 0n, sqrtPriceX96, gas, gasPrice, mult: MIN_VALUE_MULT })) return;
  if (await send("bands")) console.log(`[courier] bands deposit sent (${d.zc} ZC wei)`);
}

/** ETH never goes into the bands: whatever has arrived (harvests, rewards) is passed on to the Safe */
async function forwardEthIfWorthIt(gasPrice: bigint) {
  const eth = await pub.getBalance({ address: cfg.dep.bands! });
  if (!bandsDepositWorthIt({ zc: 0n, eth, sqrtPriceX96: 0n, gas: GAS.bandsForward, gasPrice, mult: MIN_VALUE_MULT })) return;
  if (await send("bandsForward")) console.log(`[courier] bands forwardEth sent (${eth} ETH wei to the Safe)`);
}

async function collectIfDue(gasPrice: bigint) {
  if (Date.now() - lastCollect() < COLLECT_EVERY_MS) return;
  const bands = cfg.dep.bands!;
  const [sqrtPriceX96] = (await pub.readContract({ address: bands, abi: bandsAbi, functionName: "slot0" })) as [bigint, number];
  for (let band = 0; band < BAND_NAMES.length; band++) {
    const [tokenId] = (await pub.readContract({ address: bands, abi: bandsAbi, functionName: "bands", args: [BigInt(band)] })) as readonly bigint[];
    if (tokenId === 0n) continue;
    // The simulation returns the fees collect() would pay the Safe
    const fees = await pub
      .simulateContract({ address: bands, abi: bandsAbi, functionName: "collect", args: [band], account: cfg.account })
      .then((r) => r.result as readonly [bigint, bigint])
      .catch(() => null);
    if (!fees) continue;
    const [eth, zc] = fees;
    if (!bandsDepositWorthIt({ zc, eth, sqrtPriceX96, gas: GAS.bandsCollect, gasPrice, mult: MIN_VALUE_MULT })) continue;
    await send("bandsCollect", [band]);
  }
  fs.writeFileSync(FILE, JSON.stringify({ lastCollect: Date.now() }));
}

async function claimIfWorthIt(gasPrice: bigint) {
  const pending = await zcPendingReward(pub, cfg.dep, cfg.dep.bands!);
  if (pending === 0n || pending < (GAS.bandsClaim * gasPrice * (10_000n + cfg.feeMarginBps)) / 10_000n) return false;
  return send("bandsClaim");
}

/** One pass of the bands job; a no-op where ZipLiquidityBands isn't deployed */
export async function bandsDue() {
  if (!cfg.dep.bands) return;
  const gasPrice = await pub.getGasPrice();
  const claimed = await claimIfWorthIt(gasPrice); // claimRewards() also forwards the ETH already waiting
  await depositIfWorthIt(gasPrice);
  await collectIfDue(gasPrice);
  if (!claimed) await forwardEthIfWorthIt(gasPrice);
}
