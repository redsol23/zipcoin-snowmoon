import { hashNullifier } from "@zipnet/sdk";

/**
 * Notes this browser has just handed to a courier. Until the spend is on-chain and the pool state shows it, the
 * wallet still sees the old note as unspent, and picking it again would make a proof the pool refuses. So a note is
 * marked here when a courier accepts its spend, and left out of the notes the wallet picks from until:
 *   - the chain shows it spent (its nullifier hash appears in a withdrawal),
 *   - its courier job is confirmed failed (the note was never spent), or
 *   - a timeout passes: the courier's deadline for a held job, or a few minutes for one sent now, plus a margin.
 *
 * Kept in memory and in sessionStorage, so a reload in the same tab remembers. Keyed by the note's nullifier hash:
 * the public value the spend will show on-chain, never the secret nullifier itself.
 */

type Entry = { until: number; job?: string; courier?: string };

const KEY = "zipnet.pendingSpends";
/** How long after a job's deadline (or after sending, for one sent now) the wallet keeps waiting for the chain */
export const PENDING_GRACE_MS = 10 * 60_000;

let mem: Map<string, Entry> | null = null;

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function load(): Map<string, Entry> {
  if (mem) return mem;
  mem = new Map();
  try {
    const raw = storage()?.getItem(KEY);
    if (raw) for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, Entry>)) mem.set(k, v);
  } catch {
    /* unreadable: start empty */
  }
  return mem;
}

function save() {
  try {
    storage()?.setItem(KEY, JSON.stringify(Object.fromEntries(load())));
  } catch {
    /* storage full or blocked: memory still has it */
  }
}

const keyOf = (nullifier: bigint) => hashNullifier(nullifier).toString();

/** Marks a note as being spent by a courier job. `deadline` is the job's (unix seconds, 0 when sent at once). */
export function markPendingSpent(nullifier: bigint, job: { id?: string; deadline?: number } = {}, courier?: string, now = Date.now()) {
  const until = Math.max(now, (job.deadline ?? 0) * 1000) + PENDING_GRACE_MS;
  load().set(keyOf(nullifier), { until, job: job.id, courier });
  save();
}

export function isPendingSpent(nullifier: bigint, now = Date.now()) {
  const e = load().get(keyOf(nullifier));
  return !!e && e.until > now;
}

/** The notes that aren't waiting on a spend of their own */
export function withoutPending<T extends { nullifier: bigint }>(notes: T[], now = Date.now()): T[] {
  return notes.filter((n) => !isPendingSpent(n.nullifier, now));
}

/** Drops the entries the chain now shows spent, and the expired ones. `spent` = the pool's withdrawals' nullifier hashes. */
export function prunePendingSpends(spent: Iterable<bigint>, now = Date.now()) {
  const m = load();
  if (m.size === 0) return;
  const seen = new Set([...spent].map(String));
  let changed = false;
  for (const [k, e] of m) {
    if (seen.has(k) || e.until <= now) {
      m.delete(k);
      changed = true;
    }
  }
  if (changed) save();
}

/** Asks each entry's courier about its job, and releases the notes whose job failed (the note was never spent). */
export async function releaseFailedSpends(get: typeof fetch = fetch) {
  const m = load();
  if (m.size === 0) return;
  await Promise.all(
    [...m].map(async ([k, e]) => {
      if (!e.job || !e.courier) return;
      try {
        const r = await get(`${e.courier}/jobs/${e.job}`, { signal: AbortSignal.timeout(5_000) });
        if (!r.ok) return;
        const j = (await r.json()) as { status?: string };
        if (j.status === "failed") m.delete(k);
      } catch {
        /* courier unreachable: keep waiting, the timeout still applies */
      }
    }),
  );
  save();
}

/** Tests only: forget the in-memory copy so the next call reloads from storage */
export function resetPendingSpendsCache() {
  mem = null;
}
