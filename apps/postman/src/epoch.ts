/**
 * Publishing the approved set's root once per epoch, and what /health says about it. Chain access is injected so both
 * run in tests without a chain.
 */

export type PublishDeps = {
  now: () => number;
  epochSec: number;
  /** The approved set's root now, or null when nothing is approved yet */
  root: () => bigint | null;
  /** entrypoint.latestRoot(); throws if the RPC fails (never read a failure as "no root") */
  latestRoot: () => Promise<bigint>;
  /** Sends updateRoot and resolves once it is mined; throws if it reverts or isn't mined in time */
  updateRoot: (root: bigint) => Promise<{ hash: string }>;
  /** The saved epoch state, updated in place and persisted by `persist` */
  saved: { lastEpoch: number; rootFreshAt?: number };
  persist: () => void;
  log?: (m: string) => void;
};

export type PublishResult = "not-due" | "empty" | "unchanged" | "published";

/**
 * Publishes this epoch's root if it isn't done yet. The epoch is recorded as done only after the chain holds the root
 * (updateRoot mined successfully, or the root was already there). Any failure throws with nothing recorded, so the
 * next tick tries again.
 */
export async function publishEpoch(d: PublishDeps): Promise<PublishResult> {
  const now = d.now();
  const epoch = Math.floor(now / d.epochSec);
  if (epoch === d.saved.lastEpoch) return "not-due";
  const root = d.root();
  if (root === null) return "empty";
  const latest = await d.latestRoot();
  if (latest !== root) {
    const { hash } = await d.updateRoot(root);
    d.log?.(`epoch ${epoch}: root ${root} confirmed in ${hash}`);
  }
  d.saved.lastEpoch = epoch;
  d.saved.rootFreshAt = now;
  d.persist();
  return latest === root ? "unchanged" : "published";
}

/**
 * Milliseconds to the next tick: `tickMs`, or less when an epoch turns first, so the tick runs `afterMs` past the turn.
 * Pool proofs must name the latest root, so between the turn and the publish landing couriers refuse held pool proofs
 * (the root is about to change) and proofs made on the old root fail: with ticks on their own clock that window was
 * up to a whole TICK_MS (15 s by default) longer than the publish itself, a tick's work and a block.
 */
export function nextTickMs(nowMs: number, tickMs: number, epochSec: number, afterMs = 250): number {
  const turn = (Math.floor(nowMs / 1000 / epochSec) + 1) * epochSec * 1000 + afterMs;
  return Math.max(0, Math.min(tickMs, turn - nowMs));
}

export type HealthInput = {
  now: number;
  epochSec: number;
  startedAt: number;
  /** When the on-chain root was last confirmed to be ours */
  rootFreshAt?: number;
  /** Whether a live RPC call just succeeded */
  rpcOk: boolean;
  lastError?: { at: number; message: string };
  /** When a whole tick last succeeded */
  lastTickOkAt?: number;
};

/**
 * ok only when all hold:
 * - the RPC answers (a live call);
 * - the root is fresh: confirmed on-chain within the last 2 epochs (counted from start-up until the first
 *   confirmation). Every epoch the postman either publishes or confirms the chain already has its root, so an older
 *   confirmation means publishing has been failing;
 * - the last tick didn't fail (the error stays in lastError after recovery, with its time).
 */
export function healthStatus(h: HealthInput) {
  const rootAgeSec = h.now - (h.rootFreshAt ?? h.startedAt);
  const staleRoot = rootAgeSec > 2 * h.epochSec;
  const failing = h.lastError !== undefined && (h.lastTickOkAt === undefined || h.lastError.at > h.lastTickOkAt);
  const problems = [
    !h.rpcOk && "rpc unreachable",
    staleRoot && `root not confirmed on-chain for ${rootAgeSec}s (over 2 epochs)`,
    failing && `last tick failed: ${h.lastError!.message}`,
  ].filter((p): p is string => typeof p === "string");
  return {
    ok: problems.length === 0,
    problems,
    rpcOk: h.rpcOk,
    staleRoot,
    rootFreshAt: h.rootFreshAt ?? null,
    rootAgeSec,
    lastTickOkAt: h.lastTickOkAt ?? null,
    lastError: h.lastError ?? null,
  };
}
