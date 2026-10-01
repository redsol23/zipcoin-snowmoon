import fs from "node:fs";
import path from "node:path";

/**
 * Veridia's daily gas cap (VERIDIA_DAILY_GAS_WEI, 0 = no cap). It counts the gas of every transaction the world causes:
 * the residents' own wallet transactions at their receipt's actual cost, and the jobs they hand a courier at the
 * courier's gas estimate for that job kind times the gas price when handed over (the courier pays that gas).
 * Once today's spend reaches the cap, residents only say scripted lines that touch no chain, until the next UTC day.
 * The running total is kept on disk so a restart doesn't reset it.
 */

/** Gas per courier job kind, mirroring apps/courier's table (measured in the Foundry suite, plus headroom) */
export const JOB_GAS: Record<string, bigint> = {
  speak: 700_000n,
  knock: 720_000n,
  rezip: 900_000n,
  pay: 900_000n,
  poll: 800_000n,
  post: 350_000n,
  vote: 400_000n,
};

export class OverBudget extends Error {}

const utcDay = (now = Date.now()) => Math.floor(now / 86_400_000);

export class GasBudget {
  private s: { day: number; wei: bigint };
  constructor(
    readonly capWei: bigint,
    private readonly file?: string,
    private readonly now: () => number = Date.now,
  ) {
    let saved: { day: number; wei: string } | null = null;
    try {
      if (file && fs.existsSync(file)) saved = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      saved = null;
    }
    this.s = saved && saved.day === utcDay(now()) ? { day: saved.day, wei: BigInt(saved.wei) } : { day: utcDay(now()), wei: 0n };
  }

  private roll() {
    const d = utcDay(this.now());
    if (d !== this.s.day) this.s = { day: d, wei: 0n };
  }

  spent() {
    this.roll();
    return this.s.wei;
  }

  /** True once today's spend has reached the cap */
  exhausted() {
    return this.capWei > 0n && this.spent() >= this.capWei;
  }

  /** Throws OverBudget if spending `wei` more would pass today's cap */
  check(wei: bigint) {
    if (this.capWei > 0n && this.spent() + wei > this.capWei) throw new OverBudget("today's gas budget is spent");
  }

  charge(wei: bigint) {
    this.roll();
    this.s.wei += wei;
    if (this.file) fs.writeFileSync(this.file, JSON.stringify({ day: this.s.day, wei: this.s.wei.toString() }));
  }

  /** ms until the next UTC day, when the budget refills */
  msToReset() {
    return (utcDay(this.now()) + 1) * 86_400_000 - this.now();
  }
}

export const budgetFile = (dataDir: string) => path.join(dataDir, "gas-budget.json");
