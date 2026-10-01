/**
 * Courier fees: what a job must pay the courier, in ZC wei.
 *
 *   fee = max(MIN_FEE_WEI, gas × gasPrice × (1 + FEE_MARGIN_BPS / 10 000) × zcPerEth)
 *
 * gas is the job's measured gas (GAS in jobs.ts), gasPrice the read node's current price. There is no ZC/ETH oracle,
 * so zcPerEth comes from one of:
 *
 * - ZC_PER_ETH_WAD, if set: a fixed price the operator keeps up to date. It overrides the pool.
 * - Otherwise ZC's own Uniswap v4 pool, read through ZipLiquidityBands.slot0() (which reads the PoolManager with
 *   extsload, like the bands job does). The courier samples the spot price every FEE_SAMPLE_SEC and prices fees at
 *   the MEDIAN of its samples over the last FEE_TWAP_SEC (30 min by default). A spot price is cheap to move for one
 *   block; the median only moves if the pool is held off-market for over half the window, which arbitrage makes
 *   expensive. Until it has FEE_MIN_SAMPLES samples (after a fresh start with no saved samples) it uses the highest
 *   sampled ZC-per-ETH, i.e. the highest fee, so a warm-up can only overcharge. Samples are saved, so restarts keep
 *   their history.
 * - MIN_FEE_WEI is a floor under every quote, whatever the price says. On a real chain the courier refuses to start
 *   without a floor and a price source (config.ts).
 *
 * Quotes are stable: a snapshot (gas price and ZC price) is taken at most every QUOTE_REFRESH_SEC and a quote from any
 * snapshot of the last QUOTE_VALID_SEC is honoured, so a job built against a quote isn't refused because gas moved
 * while the proof was being made. /quote says until when its fees are honoured.
 */

export type Snapshot = { at: number; gasPrice: bigint; zcPerEthWad: bigint };

export type FeeOptions = {
  /** Read node's gas price, wei */
  gasPrice: () => Promise<bigint>;
  /** ZC per ETH at the pool's spot price (wad), or null when there is no pool to read */
  spotZcPerEthWad?: () => Promise<bigint | null>;
  /** Fixed ZC per ETH (wad); 0 = use the pool */
  fixedZcPerEthWad: bigint;
  minFeeWei: bigint;
  marginBps: bigint;
  /** unix seconds */
  now?: () => number;
  sampleSec?: number;
  twapSec?: number;
  minSamples?: number;
  refreshSec?: number;
  validSec?: number;
  /** Saved price samples: [unix sec, ZC per ETH wad] */
  store?: { load(): string | null; save(data: string): void };
  log?: (m: string) => void;
};

const WAD = 10n ** 18n;

/** ZC per ETH (wad) from a v4 sqrtPriceX96 where currency0 is ETH and currency1 is ZC: (sqrtP / 2^96)^2 */
export const zcPerEthFromSqrt = (sqrtPriceX96: bigint) => (sqrtPriceX96 * sqrtPriceX96 * WAD) >> 192n;

export const median = (xs: bigint[]) => {
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2n;
};

export class Fees {
  private samples: { at: number; p: bigint }[] = [];
  private snaps: Snapshot[] = [];
  private lastSampleAt = 0;
  private readonly now: () => number;
  private readonly sampleSec: number;
  private readonly twapSec: number;
  private readonly minSamples: number;
  private readonly refreshSec: number;
  readonly validSec: number;

  constructor(private readonly o: FeeOptions) {
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
    this.sampleSec = o.sampleSec ?? 60;
    this.twapSec = o.twapSec ?? 1800;
    this.minSamples = o.minSamples ?? 5;
    this.refreshSec = o.refreshSec ?? 60;
    this.validSec = o.validSec ?? 600;
    try {
      const raw = o.store?.load();
      if (raw) this.samples = (JSON.parse(raw) as [number, string][]).map(([at, p]) => ({ at, p: BigInt(p) }));
    } catch {
      this.samples = [];
    }
  }

  /** Takes a spot sample if one is due (main.ts calls this every FEE_SAMPLE_SEC; quotes call it too). */
  async sample() {
    if (this.o.fixedZcPerEthWad > 0n || !this.o.spotZcPerEthWad) return;
    const now = this.now();
    if (now - this.lastSampleAt < this.sampleSec) return;
    const p = await this.o.spotZcPerEthWad();
    if (p === null || p <= 0n) return;
    this.lastSampleAt = now;
    this.samples = [...this.samples.filter((s) => now - s.at <= this.twapSec), { at: now, p }];
    this.o.store?.save(JSON.stringify(this.samples.map((s) => [s.at, s.p.toString()])));
  }

  /** The ZC-per-ETH price fees use now (see the top of the file), or null when there is none */
  price(): bigint | null {
    if (this.o.fixedZcPerEthWad > 0n) return this.o.fixedZcPerEthWad;
    const now = this.now();
    const recent = this.samples.filter((s) => now - s.at <= this.twapSec).map((s) => s.p);
    if (recent.length === 0) return null;
    if (recent.length < this.minSamples) return recent.reduce((a, b) => (a > b ? a : b));
    return median(recent);
  }

  /** The current snapshot, taking a new one if the last is older than refreshSec */
  async current(): Promise<Snapshot> {
    const now = this.now();
    const last = this.snaps.at(-1);
    if (last && now - last.at < this.refreshSec) return last;
    await this.sample().catch((e) => this.o.log?.(`price sample failed: ${(e as Error).message.split("\n")[0]}`));
    const snap = { at: now, gasPrice: await this.o.gasPrice(), zcPerEthWad: this.price() ?? 0n };
    if (snap.zcPerEthWad === 0n) this.o.log?.("no ZC price yet: quoting MIN_FEE_WEI only");
    this.snaps = [...this.snaps.filter((s) => now - s.at <= this.validSec), snap];
    return snap;
  }

  /** Fee for `gas` at a snapshot */
  feeAt(snap: Snapshot, gas: bigint): bigint {
    const costWei = (gas * snap.gasPrice * (10_000n + this.o.marginBps)) / 10_000n;
    const fromGas = (costWei * snap.zcPerEthWad) / WAD;
    return fromGas > this.o.minFeeWei ? fromGas : this.o.minFeeWei;
  }

  /** The fee to quote now for `gas`, and until when it is honoured (unix sec) */
  async quote(gas: bigint): Promise<{ fee: bigint; validUntil: number }> {
    const snap = await this.current();
    return { fee: this.feeAt(snap, gas), validUntil: snap.at + this.validSec };
  }

  /** The least fee accepted for `gas` now: the lowest quote any still-valid snapshot gave */
  async minAccepted(gas: bigint): Promise<bigint> {
    await this.current();
    const now = this.now();
    const valid = this.snaps.filter((s) => now - s.at <= this.validSec);
    return valid.map((s) => this.feeAt(s, gas)).reduce((a, b) => (a < b ? a : b));
  }
}
