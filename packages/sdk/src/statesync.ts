import type { PoolState } from "./indexer";
import { fromJson, toJson } from "./json";

/**
 * Private reads from a courier.
 *
 * A wallet must never ask a courier for "my notes": the question itself would link the wallet to them. So clients
 * only ever fetch pool state wholesale, in one of two shapes that look the same for every client:
 *
 * - Cold start: every fixed-size chunk of every collection, in order (GET /state/meta, then /state/chunk?kind&i for
 *   all i). Every client requests exactly the same chunks.
 * - Warm: the tails after the counts the client already holds (GET /state/delta?l&d&w&r&z). This reveals only how far
 *   the client had synced, never what it is looking for.
 *
 * Everything is checked against the chain afterwards (the rebuilt tree root must be one of the pool's roots), so a
 * courier can withhold or lie only in ways the client notices.
 */

export const STATE_CHUNK = 2048;

export type StateKind = "leaves" | "deposits" | "withdrawals" | "ragequits" | "rezips";
export const STATE_KINDS: StateKind[] = ["leaves", "deposits", "withdrawals", "ragequits", "rezips"];

export type StateCounts = Record<StateKind, number>;
export type StateMeta = { head: bigint; counts: StateCounts; chunk: number; etag: string };
export type StateDelta = { head: bigint; from: StateCounts; tails: { [K in StateKind]: PoolState[K] }; reset?: boolean };

const BIG_KEYS = ["leaves", "commitment", "label", "value", "precommitment", "block", "spentNullifier", "newCommitment", "fee", "head"];
const parse = <T>(s: string) => fromJson<T>(s, BIG_KEYS);

export const countsOf = (s: PoolState): StateCounts => ({
  leaves: s.leaves.length,
  deposits: s.deposits.length,
  withdrawals: s.withdrawals.length,
  ragequits: s.ragequits.length,
  rezips: s.rezips.length,
});

/** A cheap fingerprint of a state's size and head, for ETag/If-None-Match. */
export const etagOf = (s: PoolState) => `"${s.head}-${STATE_KINDS.map((k) => s[k].length).join("-")}"`;

// ---------------------------------------------------------------------------------------------------------------
// server side (couriers)
// ---------------------------------------------------------------------------------------------------------------

export const stateMeta = (s: PoolState): StateMeta => ({ head: s.head, counts: countsOf(s), chunk: STATE_CHUNK, etag: etagOf(s) });

export function stateChunk(s: PoolState, kind: StateKind, i: number) {
  if (!STATE_KINDS.includes(kind) || !Number.isInteger(i) || i < 0) throw new Error("bad chunk request");
  return s[kind].slice(i * STATE_CHUNK, (i + 1) * STATE_CHUNK);
}

/** Tails after `from`; `reset` when the client claims more than the courier has (it resynced), so start over. */
export function stateDelta(s: PoolState, from: StateCounts): StateDelta {
  const now = countsOf(s);
  const reset = STATE_KINDS.some((k) => from[k] > now[k]);
  const tails = Object.fromEntries(STATE_KINDS.map((k) => [k, reset ? [] : s[k].slice(from[k])])) as StateDelta["tails"];
  return { head: s.head, from, tails, reset: reset || undefined };
}

// ---------------------------------------------------------------------------------------------------------------
// client side (wallets, agents)
// ---------------------------------------------------------------------------------------------------------------

const get = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`courier ${r.status} for ${url}`);
  return r.text();
};

async function coldSync(base: string): Promise<PoolState> {
  const meta = parse<StateMeta>(await get(`${base}/state/meta`));
  const state: PoolState = { leaves: [], deposits: [], withdrawals: [], ragequits: [], rezips: [], head: meta.head };
  for (const k of STATE_KINDS) {
    const chunks = Math.ceil(meta.counts[k] / meta.chunk);
    for (let i = 0; i < chunks; i++) (state[k] as unknown[]).push(...parse<unknown[]>(await get(`${base}/state/chunk?kind=${k}&i=${i}`)));
  }
  return state;
}

/**
 * The pool state from a courier: warm (delta after `prev`) when possible, cold (every chunk) otherwise. Callers must
 * still verify the result against the chain before using it.
 */
export async function syncFromCourier(courierUrl: string, prev?: PoolState): Promise<PoolState> {
  const base = courierUrl.replace(/\/$/, "");
  if (!prev) return coldSync(base);
  const c = countsOf(prev);
  const d = parse<StateDelta>(await get(`${base}/state/delta?l=${c.leaves}&d=${c.deposits}&w=${c.withdrawals}&r=${c.ragequits}&z=${c.rezips}`));
  if (d.reset) return coldSync(base);
  return {
    leaves: [...prev.leaves, ...d.tails.leaves],
    deposits: [...prev.deposits, ...d.tails.deposits],
    withdrawals: [...prev.withdrawals, ...d.tails.withdrawals],
    ragequits: [...prev.ragequits, ...d.tails.ragequits],
    rezips: [...prev.rezips, ...d.tails.rezips],
    head: d.head,
  };
}

export const encodeState = toJson;
