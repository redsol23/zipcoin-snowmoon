import { decodeEventLog, parseAbi, type Address, type Hex } from "viem";

/**
 * When a deposit made by one of our own contracts may skip vetting (review 2 H-3).
 *
 * Our processooor contracts (rezip, pay, badges) deposit into the pool on a user's behalf. A deposit is only as clean
 * as the ZC behind it, and those contracts take ZC from wallets too (ZipRezip.zipTo, ZipPay.pay with a payee
 * precommitment, ZipBadges.lock). So "the depositor is one of ours" proves nothing by itself.
 *
 * The rule: a deposit by our contract C is note-funded, and approved at once, only when the ZC behind it provably came
 * out of an already-approved note:
 *   - in the funding transaction the pool emitted `Withdrawn(processooor = C)` (a withdrawal proof names the latest
 *     ASP root, so the spent note was approved), for at least as much as C deposited in that transaction, and
 *   - no ZC reached C in that transaction from anywhere but the pool (a wallet's transferFrom into C, as zipTo, pay
 *     and lock do, shows up as a Transfer into C from someone else).
 * The funding transaction is the deposit's own, except for a badge unlock, whose ZC arrived when the lock was made:
 * there it is the transaction that emitted the lock's `Locked` event (lockAnon is note-funded, lock is a wallet).
 *
 * Everything else is treated like any public deposit: vetting delay, denylist and sanctions screening, and the caps,
 * applied to the funding ORIGIN (the wallet that sent the funding transaction) rather than to our contract.
 * No contract change is needed: the pool's Withdrawn event and the token's Transfer events are the "funded from the
 * pool" marker.
 */

export type TxLog = { address: Address; topics: readonly Hex[]; data: Hex };
/** What the postman needs of a mined transaction: who sent it and its logs (from its receipt) */
export type TxView = { hash: Hex; from: Address; logs: readonly TxLog[] };
export type TrustCtx = { pool: Address; zc: Address; badges?: Address };
export type Funding = { noteFunded: true } | { noteFunded: false; origin: Address; reason: string };

const ABI = parseAbi([
  "event Withdrawn(address indexed _processooor, uint256 _value, uint256 _spentNullifier, uint256 _newCommitment)",
  "event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Unlocked(uint256 indexed lockId, uint256 commitment)",
]);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

type Decoded = { address: Address; name: string; args: Record<string, unknown> };
function decode(logs: readonly TxLog[]): Decoded[] {
  const out: Decoded[] = [];
  for (const l of logs) {
    try {
      const d = decodeEventLog({ abi: ABI, topics: l.topics as [Hex, ...Hex[]], data: l.data, strict: true });
      out.push({ address: l.address, name: d.eventName, args: d.args as Record<string, unknown> });
    } catch {
      /* not one of ours */
    }
  }
  return out;
}

/** Whether every ZC contract `c` took in during this transaction came out of notes spent into it (see the rule above) */
export function noteFundedIn(tx: TxView, c: Address, ctx: TrustCtx): { ok: true } | { ok: false; reason: string } {
  let withdrawn = 0n;
  let deposited = 0n;
  let spends = 0;
  for (const e of decode(tx.logs)) {
    if (same(e.address, ctx.pool) && e.name === "Withdrawn" && same(e.args._processooor as string, c)) {
      withdrawn += e.args._value as bigint;
      spends++;
    } else if (same(e.address, ctx.pool) && e.name === "Deposited" && same(e.args._depositor as string, c)) {
      deposited += e.args._value as bigint;
    } else if (same(e.address, ctx.zc) && e.name === "Transfer" && same(e.args.to as string, c) && !same(e.args.from as string, ctx.pool)) {
      return { ok: false, reason: `ZC reached ${c} from ${e.args.from as string}, not from a note` };
    }
  }
  if (spends === 0) return { ok: false, reason: "no note was spent into the depositing contract in its funding transaction" };
  if (deposited > withdrawn) return { ok: false, reason: `deposited ${deposited} but only ${withdrawn} came out of notes` };
  return { ok: true };
}

export type FundingIo = {
  /** The mined transaction (sender and receipt logs) */
  tx(hash: Hex): Promise<TxView>;
  /** The transaction that emitted ZipBadges' Locked event for this lock, if any */
  lockTx(lockId: bigint): Promise<Hex | null>;
};

/**
 * Classifies a deposit made by one of our contracts: note-funded (approve at once) or public, with the wallet whose
 * transaction funded it (screen it, and apply the caps to it).
 */
export async function fundingOf(d: { depositor: Address; tx: Hex; commitment: bigint }, ctx: TrustCtx, io: FundingIo): Promise<Funding> {
  const tx = await io.tx(d.tx);
  const here = noteFundedIn(tx, d.depositor, ctx);
  if (here.ok) return { noteFunded: true };
  if (ctx.badges && same(d.depositor, ctx.badges)) {
    // The unlock that made this very deposit (one transaction could unlock several locks)
    const unlocked = decode(tx.logs).find((e) => same(e.address, ctx.badges!) && e.name === "Unlocked" && e.args.commitment === d.commitment);
    const lockHash = unlocked ? await io.lockTx(unlocked.args.lockId as bigint) : null;
    if (lockHash) {
      const lockTx = await io.tx(lockHash);
      const atLock = noteFundedIn(lockTx, d.depositor, ctx);
      if (atLock.ok) return { noteFunded: true };
      return { noteFunded: false, origin: lockTx.from, reason: `the badge lock was funded by a wallet (${atLock.reason})` };
    }
  }
  return { noteFunded: false, origin: tx.from, reason: here.reason };
}
