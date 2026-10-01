/**
 * Deposit caps for the first weeks after launch, while the contracts are new: limit how much any one deposit, and any
 * one depositor per rolling 24 hours, can bring into the pool. Pure, so it can be tested without a chain.
 *
 * - Over the per-deposit cap: rejected. The owner can always ragequit and deposit smaller amounts.
 * - Over the depositor's daily cap: waits. It is approved once enough of the depositor's earlier deposits have aged
 *   out of the 24-hour window.
 * A cap of 0 turns that limit off (the default locally).
 */

export type Caps = { maxDeposit: bigint; maxDepositorDaily: bigint };
export type ApprovedDeposit = { depositor: string; value: bigint; at: number };
export type CapDecision = { verdict: "ok" } | { verdict: "reject"; reason: string } | { verdict: "wait"; reason: string };

export const DAY_SEC = 86_400;

export function checkCaps(
  caps: Caps,
  deposit: { depositor: string; value: bigint },
  approvedSoFar: ApprovedDeposit[],
  now: number,
): CapDecision {
  if (caps.maxDeposit > 0n && deposit.value > caps.maxDeposit) {
    return { verdict: "reject", reason: `over the ${caps.maxDeposit} per-deposit cap` };
  }
  if (caps.maxDepositorDaily > 0n) {
    const who = deposit.depositor.toLowerCase();
    const today = approvedSoFar
      .filter((d) => d.depositor.toLowerCase() === who && now - d.at < DAY_SEC)
      .reduce((a, d) => a + d.value, 0n);
    if (today + deposit.value > caps.maxDepositorDaily) {
      return { verdict: "wait", reason: `would bring this depositor to ${today + deposit.value} of a ${caps.maxDepositorDaily} daily cap` };
    }
  }
  return { verdict: "ok" };
}
