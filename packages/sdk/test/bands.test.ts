import { describe, expect, it } from "vitest";

import { zipLiquidityBandsAbi } from "../src/abi";
import { BAND_NAMES, BAND_TICKS, BANDS_LAUNCH_LOWER, BANDS_LAUNCH_UPPER, bandsDepositWorthIt, fdvAtTick, zcValueInEth } from "../src/bands";

describe("liquidity bands: above the launch range only", () => {
  it("has three ZC bands, all above the launch position's sell-out point", () => {
    expect(BAND_NAMES).toEqual(["U1", "U2", "U3"]);
    expect(BAND_TICKS).toHaveLength(3);
    for (const [lower, upper] of BAND_TICKS) {
      expect(lower).toBeLessThan(upper);
      expect(upper).toBeLessThanOrEqual(BANDS_LAUNCH_LOWER);
      expect(upper).toBeLessThan(BANDS_LAUNCH_UPPER);
      // above the range: every FDV in the band is at or beyond the sell-out FDV
      expect(fdvAtTick(upper)).toBeGreaterThanOrEqual(fdvAtTick(BANDS_LAUNCH_LOWER) - 1e-6);
    }
  });

  it("the ABI has no ETH bands, no ETH split and no ETH caps; ETH is forwarded", () => {
    const names = zipLiquidityBandsAbi.map((i) => ("name" in i ? i.name : ""));
    for (const gone of ["D1", "D2", "ethToSafeBps", "setEthToSafeBps", "MAX_DAY_ETH", "usedEth", "ethBooked"]) expect(names).not.toContain(gone);
    expect(names).toContain("forwardEth");
    expect(names).toContain("EthToSafe");
  });
});

// sqrtPriceX96 at tick 165,930: about 1.607e7 ZC per ETH (FDV about 62 ETH)
const SQRT = 317_562_884_112_765_502_424_763_899_389_167n;

describe("liquidity bands maths", () => {
  it("values ZC at the pool's spot price", () => {
    const perZc = Number(zcValueInEth(10n ** 18n, SQRT)) / 1e18;
    expect(perZc).toBeGreaterThan(6.1e-8);
    expect(perZc).toBeLessThan(6.3e-8);
    expect(zcValueInEth(10n ** 18n, 0n)).toBe(0n);
  });

  it("puts the band edges at the FDVs the contract documents", () => {
    expect(fdvAtTick(127_600)).toBeGreaterThan(2_800);
    expect(fdvAtTick(127_600)).toBeLessThan(2_950);
    expect(fdvAtTick(196_600)).toBeGreaterThan(2.8);
    expect(fdvAtTick(196_600)).toBeLessThan(3.0);
    expect(fdvAtTick(115_200) / fdvAtTick(127_600)).toBeCloseTo(3.456, 2);
  });

  it("deposits only when the value is at least 20x the gas", () => {
    const base = { eth: 0n, sqrtPriceX96: SQRT, gas: 1_000_000n, gasPrice: 10n ** 9n, mult: 20n }; // needs 0.02 ETH
    expect(bandsDepositWorthIt({ ...base, zc: 300_000n * 10n ** 18n })).toBe(false); // about 0.019 ETH
    expect(bandsDepositWorthIt({ ...base, zc: 350_000n * 10n ** 18n })).toBe(true); // about 0.022 ETH
    expect(bandsDepositWorthIt({ ...base, zc: 0n, eth: 2n * 10n ** 16n })).toBe(true);
    expect(bandsDepositWorthIt({ ...base, zc: 0n, eth: 2n * 10n ** 16n - 1n })).toBe(false);
  });
});
