import type { RawLog } from "./chain";

/**
 * The privacy meter: how big is the crowd a deposit hides in? Counted from the pool's own Deposited events, leaving out
 * every address the project controls, and served only as counts. No address is ever listed or labelled.
 */

const ZC = 10n ** 18n;
/** Coarse note-size buckets, in whole ZC: [lower bound, upper bound) */
export const BUCKETS: [bigint, bigint | null][] = [
  [0n, 100n],
  [100n, 1_000n],
  [1_000n, 10_000n],
  [10_000n, 100_000n],
  [100_000n, null],
];

const WINDOW_NAMES = ["24h", "7d", "all"] as const;
type W = (typeof WINDOW_NAMES)[number];

export type PrivacyInput = {
  deposits: RawLog[];
  withdrawals: number;
  ragequits: number;
  windows: Record<W, bigint>;
  since: Record<W, number>;
  excluded: { set: Set<string>; counts: Record<string, number> };
  poolShown: boolean;
  head: bigint;
  now: number;
  chainId: number;
};

export const METHOD = {
  summary:
    "We count the different addresses that put ZC into the privacy pool, leaving out every address the project itself controls. Those are the outside depositors: the crowd a deposit disappears into.",
  steps: [
    "Read every Deposited event the privacy pool has emitted. Each one is a public fact on Ethereum: the depositing address and the amount.",
    "Leave out the project's own addresses: every zipcoin contract (private sends and shop revenue go back into the pool through them), the treasury Safe, the Entrypoint's owner and postman, every address that has bonded as a courier (couriers make cover traffic from their own wallets), wallets the operators list as their own (Veridia's residents and treasury, couriers' cover wallets), and any wallet a project funding wallet sent ZC to.",
    "Count what is left in each window: deposits, the different addresses that made them, and the deposits by size, in five wide buckets.",
  ],
  caveats: [
    "One person can use many addresses, and a project wallet we don't know about counts as outside, so the number of people may be lower than shown.",
    "A deposit from a smart wallet or an exchange can stand for several people, so it may also be higher.",
    "Addresses aren't people, and we never label any address as a user. We only publish counts; every deposit behind them is already public on-chain.",
    "Privacy also depends on timing and amounts: a crowd of any size helps less if you deposit and withdraw the same odd amount a minute apart.",
  ],
};

export type PrivacyReport = ReturnType<typeof privacyReport>;

export function privacyReport(i: PrivacyInput) {
  const windows = {} as Record<W, unknown>;
  for (const w of WINDOW_NAMES) {
    let deposits = 0;
    let outside = 0;
    let outsideValue = 0n;
    const who = new Set<string>();
    const buckets = BUCKETS.map(() => 0);
    for (const d of i.deposits) {
      if (d.block < i.windows[w]) continue;
      deposits++;
      const depositor = String(d.args._depositor ?? "").toLowerCase();
      if (!depositor || i.excluded.set.has(depositor)) continue;
      outside++;
      const value = typeof d.args._value === "bigint" ? d.args._value : 0n;
      outsideValue += value;
      who.add(depositor);
      const whole = value / ZC;
      const b = BUCKETS.findIndex(([lo, hi]) => whole >= lo && (hi === null || whole < hi));
      buckets[b === -1 ? BUCKETS.length - 1 : b]++;
    }
    windows[w] = {
      since: i.since[w],
      fromBlock: i.windows[w].toString(),
      deposits,
      projectDeposits: deposits - outside,
      outsideDeposits: outside,
      outsideDepositors: who.size,
      outsideValue: outsideValue.toString(),
      buckets: BUCKETS.map(([lo, hi], k) => ({ minZc: Number(lo), maxZc: hi === null ? null : Number(hi), deposits: buckets[k] })),
    };
  }
  return {
    ok: true,
    enabled: i.poolShown,
    updatedAt: i.now,
    chainId: i.chainId,
    block: i.head.toString(),
    windows: i.poolShown ? windows : {},
    pool: i.poolShown ? { depositsEver: i.deposits.length, withdrawalsEver: i.withdrawals, ragequitsEver: i.ragequits } : null,
    // How many addresses were left out is not served: the count of project contracts would hint at unreleased ones.
    method: METHOD,
  };
}
