import type { Address, PublicClient } from "viem";

import { zipLiquidityBandsAbi } from "./abi";
import type { Deployment } from "./deployment";
import { zcRewardsAbi } from "./rewards";

/**
 * ZipLiquidityBands: the treasury's tax share (ZC), placed as one-sided liquidity in ZC's Uniswap v4 pool in three
 * fixed bands ABOVE the locked launch range only (beyond the price at which the launch position has sold all its ZC).
 * Nothing is ever added at or below the launch range, and ETH is never put into liquidity: ETH that reaches the
 * contract (rewards, harvests) goes to the treasury Safe through forwardEth() / claimRewards(). Anyone may call
 * deposit(), collect(band), claimRewards() and forwardEth(); couriers do, as the free "bands" job. Every output goes
 * to the treasury Safe.
 */

/** The bands contract with the token's errors, so claimRewards()' NothingToClaim revert decodes */
export const bandsAbi = [...zipLiquidityBandsAbi, ...zcRewardsAbi] as const;

export const BAND_NAMES = ["U1", "U2", "U3"] as const;

/** The locked launch position's ticks: [sell-out, launch price]. Every band's upper tick is at or below BANDS_LAUNCH_LOWER. */
export const BANDS_LAUNCH_LOWER = 127_600;
export const BANDS_LAUNCH_UPPER = 196_600;

/** The bands' ticks, [lower, upper], as the contract fixes them */
export const BAND_TICKS: readonly (readonly [number, number])[] = [
  [115_200, 127_600],
  [92_200, 115_200],
  [-887_200, 92_200],
];

/** Fully diluted value (1e9 ZC) in ETH at a tick of the ETH/ZC pool, whose price is ZC per ETH = 1.0001^tick */
export const fdvAtTick = (tick: number) => 1e9 / Math.pow(1.0001, tick);

export type BandStatus = {
  index: number;
  name: (typeof BAND_NAMES)[number];
  lower: number;
  upper: number;
  /** FDV range in ETH, low to high */
  fdv: [number, number];
  weightBps: number;
  /** 0 until the band's first deposit */
  tokenId: bigint;
  zcIn: bigint;
  feesEth: bigint;
  feesZc: bigint;
  /** the price is entirely below the band, so a deposit can add ZC to it */
  outOfRange: boolean;
};

export type BandsStatus = {
  address: Address;
  safe: Address;
  tick: number;
  paused: boolean;
  forwardAll: boolean;
  /** ETH waiting in the contract for forwardEth() (it all goes to the Safe) */
  ethToForward: bigint;
  /** unix seconds, 0 before the first deposit */
  lastDeposit: number;
  caps: { perCallZc: bigint; dayZc: bigint; minZc: bigint; minInterval: number };
  depositable: { zc: bigint; ok: boolean };
  bands: BandStatus[];
};

const read = (client: PublicClient, address: Address, functionName: string, args: unknown[] = []) =>
  client.readContract({ address, abi: zipLiquidityBandsAbi, functionName, args } as never) as Promise<unknown>;

/** The ZC deposit() would add now, or null when the bands contract isn't deployed */
export async function bandsDepositable(client: PublicClient, dep: Deployment) {
  if (!dep.bands) return null;
  const [zc, ok] = (await read(client, dep.bands, "depositable")) as [bigint, boolean];
  return { zc, ok };
}

/** Everything a read-only status view shows, or null when the bands contract isn't deployed */
export async function bandsStatus(client: PublicClient, dep: Deployment): Promise<BandsStatus | null> {
  const address = dep.bands;
  if (!address) return null;
  const r = (fn: string, args: unknown[] = []) => read(client, address, fn, args);
  const [safe, slot0, paused, forwardAll, last, caps, depositable, ethToForward] = await Promise.all([
    r("SAFE"),
    r("slot0"),
    r("paused"),
    r("forwardAll"),
    r("lastDeposit"),
    r("caps"),
    r("depositable"),
    client.getBalance({ address }),
  ]);
  const bands = await Promise.all(
    BAND_NAMES.map(async (name, index) => {
      const [ticks, weight, state, out] = await Promise.all([r("bandTicks", [index]), r("weights", [BigInt(index)]), r("bands", [BigInt(index)]), r("outOfRange", [index])]);
      const [lower, upper] = (ticks as [number, number]).map(Number);
      const [tokenId, zcIn, feesEth, feesZc] = state as [bigint, bigint, bigint, bigint];
      const fdv: [number, number] = [fdvAtTick(upper), fdvAtTick(lower)];
      return { index, name, lower, upper, fdv, weightBps: Number(weight), tokenId, zcIn, feesEth, feesZc, outOfRange: out as boolean } as BandStatus;
    }),
  );
  const [perCallZc, dayZc, minZc, minInterval] = caps as [bigint, bigint, bigint, number];
  const [zc, ok] = depositable as [bigint, boolean];
  return {
    address,
    safe: safe as Address,
    tick: Number((slot0 as [bigint, number])[1]),
    paused: paused as boolean,
    forwardAll: forwardAll as boolean,
    ethToForward,
    lastDeposit: Number(last),
    caps: { perCallZc, dayZc, minZc, minInterval: Number(minInterval) },
    depositable: { zc, ok },
    bands,
  };
}

/** ETH (wei) that `zc` (wei) is worth at the pool's spot price. The pool prices ZC per ETH as (sqrtPriceX96 / 2^96)^2. */
export function zcValueInEth(zc: bigint, sqrtPriceX96: bigint): bigint {
  if (sqrtPriceX96 === 0n) return 0n;
  return (zc << 192n) / (sqrtPriceX96 * sqrtPriceX96);
}

/**
 * Whether a call is worth its gas: the ZC (at spot, which only decides whether to spend the gas, never how much is
 * deposited) plus the ETH must be worth at least `mult` times the gas cost. Used for deposit() (ZC only), collect()
 * (fees in both assets) and forwardEth() (ETH only).
 */
export function bandsDepositWorthIt(a: { zc: bigint; eth: bigint; sqrtPriceX96: bigint; gas: bigint; gasPrice: bigint; mult: bigint }): boolean {
  return zcValueInEth(a.zc, a.sqrtPriceX96) + a.eth >= a.mult * a.gas * a.gasPrice;
}
