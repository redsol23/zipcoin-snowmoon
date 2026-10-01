import { entrypointAbi, poolAbi, type Note } from "@zipnet/sdk";
import { decodeErrorResult, formatEther, type Hex } from "viem";

/**
 * Parked payouts: the pure part (no network), so it can be tested on its own. `parked-scan.ts` reads the chain and
 * submits recoveries.
 *
 * ZipBadges pays a badge lock's stake back into the pool at unlock, under a precommitment chosen when it was locked. If
 * that deposit fails (someone used the precommitment first, the pool was removed or wound down, the amount is under the
 * pool's minimum) the stake is parked under the lock's id instead of being lost (C-1). The owner can then send it back
 * into the pool under a fresh precommitment (redirect) or to an address (release). A stake that did reach the pool is a
 * note whose depositor is ZipBadges, so if the ASP never approves it only ZipBadges can ragequit it, for the owner
 * (M-12). The owner is the lock's Semaphore identity (a proof over the one-member group {identity}).
 */

export type PayoutSource = "badge";

export type PayoutAuth = { kind: "identity"; commitment: bigint };

/** PayoutParked(id, amount, precommitment, reason) */
export type ParkLog = { source: PayoutSource; id: bigint; amount: bigint; precommitment: bigint; reason: Hex; block: bigint };
/** PayoutDeposited(id, amount, precommitment, commitment, label) */
export type DepositLog = { source: PayoutSource; id: bigint; amount: bigint; precommitment: bigint; commitment: bigint; label: bigint; block: bigint };

export type PoolStatus = { exists: boolean; dead: boolean; minDeposit: bigint };

export type ParkWhy = "precommitment-used" | "pool-removed" | "pool-dead" | "below-minimum" | "other";

type Base = { key: string; source: PayoutSource; id: bigint; auth: PayoutAuth; title: string; explanation: string };
export type ParkedPayout =
  | (Base & { state: "parked"; amount: bigint; why: ParkWhy; canRedirect: boolean })
  | (Base & { state: "unapproved"; amount: bigint; note: Note; since: number });

/** How long a payout note may wait for the ASP before the wallet offers the public exit */
export const UNAPPROVED_AFTER_SEC = 86_400;

export const payoutKey = (source: PayoutSource, id: bigint) => `${source}:${id}`;

const zc = (v: bigint) => Number(formatEther(v)).toLocaleString("en-US", { maximumFractionDigits: 4 });

const ERRORS = [...entrypointAbi, ...poolAbi].filter((x) => x.type === "error");

/**
 * Why a deposit failed, from PayoutParked's `reason` (the Entrypoint's or pool's revert data; empty when the contract
 * didn't try because the pool was missing or the amount under its minimum) and the pool as it is now.
 */
export function parkWhy(reason: Hex, amount: bigint, pool: PoolStatus): ParkWhy {
  if (!reason || reason === "0x") {
    if (!pool.exists) return "pool-removed";
    return amount < pool.minDeposit ? "below-minimum" : "pool-removed";
  }
  try {
    const { errorName } = decodeErrorResult({ abi: ERRORS, data: reason });
    if (errorName === "PrecommitmentAlreadyUsed") return "precommitment-used";
    if (errorName === "PoolNotFound") return "pool-removed";
    if (errorName === "PoolIsDead") return "pool-dead";
    if (errorName === "MinimumDepositAmount") return "below-minimum";
  } catch {
    /* not one of the pool's errors */
  }
  return "other";
}

const WHAT: Record<PayoutSource, string> = { badge: "your badge stake" };

/** One or two plain sentences: why it's parked, and what can be done now */
export function explainPark(why: ParkWhy, source: PayoutSource, pool: PoolStatus, amount: bigint): string {
  const it = WHAT[source];
  const now = !pool.exists
    ? " The pool is still gone, so for now it can only go to an address."
    : pool.dead
      ? " The pool is closed for good, so it can only go to an address."
      : amount < pool.minDeposit
        ? ` It's under the pool's minimum deposit (${zc(pool.minDeposit)} ZC), so it can only go to an address.`
        : " You can send it back into the pool under a fresh code.";
  switch (why) {
    case "precommitment-used":
      return `Someone deposited under the one-time code ${it} was meant to come back to, before it could. That blocks the deposit but can't touch the coins.${now}`;
    case "pool-removed":
      return `The privacy pool wasn't accepting ZC when ${it} came due.${now}`;
    case "pool-dead":
      return `The privacy pool was wound down before ${it} came due.${now}`;
    case "below-minimum":
      return `${it[0].toUpperCase()}${it.slice(1)} was smaller than the pool's minimum deposit.${now}`;
    default:
      return `The pool refused the deposit of ${it}.${now}`;
  }
}

export const canRedirect = (amount: bigint, pool: PoolStatus) => pool.exists && !pool.dead && amount >= pool.minDeposit;

export const titleOf = (_source: PayoutSource, id: bigint) => `Badge lock #${id}: the locked stake`;

/** Which payouts belong to this zip key: its badge locks once unlocked, authorised by the identity that made them. */
export function resolveOwners(o: { locks: { lockId: bigint; identityCommitment: bigint; unlocked: boolean }[] }): Map<string, PayoutAuth> {
  const owners = new Map<string, PayoutAuth>();
  // A lock's payout only exists once it is unlocked; its identity authorises the recovery
  for (const l of o.locks) if (l.unlocked) owners.set(payoutKey("badge", l.lockId), { kind: "identity", commitment: l.identityCommitment });
  return owners;
}

/**
 * The payouts that need the owner:
 * - "parked": `parkedNow` > 0 (from parkedPayout), with the reason of its latest PayoutParked;
 * - "unapproved": its latest PayoutDeposited note (or that note's change) is one of the key's notes, still not
 *   approved by the ASP more than UNAPPROVED_AFTER_SEC after the deposit: offer the ragequit.
 * @param notes every note the key controls (approved or not), from recoverNotes
 * @param depositTime block time of a deposit log (seconds), when known
 */
export function collectPayouts(o: {
  owners: Map<string, PayoutAuth>;
  parks: ParkLog[];
  deposits: DepositLog[];
  parkedNow: Map<string, bigint>;
  notes: Note[];
  approvedLabels: Set<bigint>;
  pool: PoolStatus;
  depositTime: (d: DepositLog) => number | undefined;
  now: number;
  unapprovedAfterSec?: number;
}): ParkedPayout[] {
  const after = o.unapprovedAfterSec ?? UNAPPROVED_AFTER_SEC;
  const latest = <T extends { source: PayoutSource; id: bigint; block: bigint }>(logs: T[]) => {
    const m = new Map<string, T>();
    for (const l of logs) {
      const k = payoutKey(l.source, l.id);
      const prev = m.get(k);
      if (!prev || l.block >= prev.block) m.set(k, l);
    }
    return m;
  };
  const lastPark = latest(o.parks);
  const lastDeposit = latest(o.deposits);
  const out: ParkedPayout[] = [];
  for (const [key, auth] of o.owners) {
    const park = lastPark.get(key);
    const amount = o.parkedNow.get(key) ?? 0n;
    if (park && amount > 0n) {
      const why = parkWhy(park.reason, amount, o.pool);
      out.push({
        key,
        state: "parked",
        source: park.source,
        id: park.id,
        auth,
        amount,
        why,
        canRedirect: canRedirect(amount, o.pool),
        title: titleOf(park.source, park.id),
        explanation: explainPark(why, park.source, o.pool, amount),
      });
      continue;
    }
    const dep = lastDeposit.get(key);
    if (!dep) continue;
    const note = o.notes.find((n) => n.label === dep.label && n.value > 0n);
    if (!note || o.approvedLabels.has(note.label)) continue;
    const at = o.depositTime(dep);
    if (at === undefined || o.now - at < after) continue;
    out.push({
      key,
      state: "unapproved",
      source: dep.source,
      id: dep.id,
      auth,
      amount: note.value,
      note,
      since: at,
      title: titleOf(dep.source, dep.id),
      explanation: `This stake reached the pool on ${new Date(at * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}, but the pool's approver (the ASP) still hasn't cleared it, so it can't be spent privately. If it never does, you can take it out publicly ("ragequit"): the full ${zc(note.value)} ZC goes to an address you choose, and anyone can see that address received this stake. If you can wait, the approver may still clear it.`,
    });
  }
  return out.sort((a, b) => (a.state === b.state ? (a.amount > b.amount ? -1 : 1) : a.state === "parked" ? -1 : 1));
}
