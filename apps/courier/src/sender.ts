import { keccak256, type Hex } from "viem";

/**
 * The courier's one way to send a transaction. Real jobs, cover traffic, harvests and reward claims all sign with the
 * same key, so every send goes through this queue, which owns the key's nonces.
 *
 * Why it doesn't ask the node for the pending nonce: couriers send through a private relay (SEND_RPC_URL, e.g.
 * Flashbots Protect or MEV Blocker) so relayed proofs can't be copied and front-run. A private relay doesn't show its
 * pending transactions to the read node (RPC_URL), and doesn't reliably answer eth_getTransactionCount("pending")
 * itself. So the queue keeps its own book:
 *
 * - Every transaction it sends is "in flight" under its nonce, with every version (hash) it signed for that nonce,
 *   until the read node's LATEST count passes the nonce. The book is saved to disk, so a restart knows what may still
 *   land.
 * - The next nonce is max(read node's latest count, highest in-flight nonce + 1, floor), where the floor moves past
 *   nonces the send endpoint says are taken by something we didn't send.
 * - "already known": the endpoint already has this exact signed transaction; that is a successful send.
 * - "nonce too low" / "replacement underpriced" on a new send: something else holds that nonce; move the floor past
 *   it and send at the next one. On a resend of our own transaction, "nonce too low" means one version landed.
 * - Underpriced for the network: same nonce, fees raised.
 * - Dropped by the relay (Flashbots Protect stops trying after 25 blocks; a relay can also just lose it): if a nonce
 *   hasn't landed `resendAfterMs` after its last send, the SAME call is re-simulated and re-signed at the SAME nonce
 *   with higher fees, and sent again. Only one version can ever land, since they share the nonce.
 * - If the re-simulation fails (the call can no longer succeed) the nonce is left alone while a sent version might
 *   still land. Only once `abandonAfterMs` has passed since the last send (longer than the relay keeps trying) is the
 *   nonce filled with a 0-value transfer to ourselves, so the nonces after it can land. A nonce is never given to a
 *   different job while a version of the first might still land.
 * - Lanes: a user's job goes ahead of queued cover and harvest sends (only the send is serialized; receipts are
 *   awaited separately, via waitForReceipt, which follows resends).
 */

export type Lane = "user" | "background";
export type Fees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
/** writeContract-style arguments (address, abi, functionName, args, value?); the queue sets nonce and fees */
export type TxArgs = Record<string, unknown>;
export type SentReceipt = { transactionHash: Hex; status: "success" | "reverted" };

/** Chain access, injected so the queue can be tested against a fake relay. */
export type SenderIo<R extends SentReceipt = SentReceipt> = {
  /** Mined transaction count of our address on the read node (blockTag "latest") */
  latestNonce(): Promise<number>;
  /** Current network fees (read node) */
  fees(): Promise<Fees>;
  /** Estimates gas (a simulation: throws if the call would revert) and signs. Returns the serialized transaction. */
  sign(args: TxArgs, nonce: number, fees: Fees): Promise<Hex>;
  /** A 0-value transfer to ourselves at `nonce`, to fill a nonce whose transaction can no longer land */
  signCancel(nonce: number, fees: Fees): Promise<Hex>;
  /** eth_sendRawTransaction on the send endpoint (SEND_RPC_URL, or RPC_URL) */
  sendRaw(raw: Hex): Promise<Hex>;
  /** Receipt from the read node, or null if it has none */
  receipt(hash: Hex): Promise<R | null>;
};

/** Where the in-flight book is kept between restarts */
export type SenderStore = { load(): string | null; save(data: string): void };

export type SenderOptions<R extends SentReceipt = SentReceipt> = {
  io: SenderIo<R>;
  store?: SenderStore;
  /** Tries per new send, counting nonce and fee retries */
  maxAttempts?: number;
  /** Resend (re-simulated, same nonce, higher fees) when a nonce hasn't landed this long after its last send */
  resendAfterMs?: number;
  /** Give up on a nonce whose call no longer simulates this long after its last send, and fill it with a cancel */
  abandonAfterMs?: number;
  /** Fee raise per resend, in percent (the node's replacement rule needs at least 10) */
  bumpPercent?: bigint;
  /** Stop raising fees after this many resends (later resends repeat the last fees) */
  maxBumps?: number;
  /** How often start() runs tick() */
  pollMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
};

/** The transaction didn't land: its nonce was used by another transaction (ours, a cancel, or someone else's). */
export class TxDropped extends Error {}

type Version = { hash: Hex; cancel?: boolean };
type Entry = {
  nonce: number;
  lane: Lane;
  args: TxArgs;
  versions: Version[];
  fees: Fees;
  lastSentAt: number;
  resends: number;
  /** When a resend's re-simulation first failed */
  simFailedAt?: number;
  /** Ticks in which the nonce was used but none of our versions had a receipt */
  missing?: number;
};
type Outcome<R> = { receipt: R } | { error: Error };
type Item = { lane: Lane; args: TxArgs; resolve: (h: Hex) => void; reject: (e: unknown) => void };

/** Every message and error name on the error and its causes, so viem's wrapped node errors can be matched. */
export function errorText(e: unknown): string {
  const parts: string[] = [];
  let c = e as { name?: string; message?: string; details?: string; shortMessage?: string; cause?: unknown } | undefined;
  for (let i = 0; c && typeof c === "object" && i < 8; c = c.cause as typeof c, i++) {
    parts.push(String(c.name ?? ""), String(c.shortMessage ?? ""), String(c.details ?? ""), String(c.message ?? ""));
  }
  if (typeof e === "string") parts.push(e);
  return parts.join(" | ");
}

const KNOWN = /already known|known transaction|already imported|AlreadyKnown/i;
const NONCE_LOW = /nonce too low|NonceTooLowError|nonce has already been used|lower than the current nonce/i;
const NONCE_HIGH = /nonce too high|NonceTooHighError|higher than the next one expected/i;
const SLOT_TAKEN = /replacement transaction underpriced|replacement fee too low|could not replace existing tx|ReplacementUnderpriced/i;
const UNDERPRICED = /transaction underpriced|FeeCapTooLowError|fee cap less than block base fee|max fee per gas less than block base fee|cannot be lower than the block base fee/i;
/** No answer at all: the transaction may or may not have reached the endpoint */
const TRANSPORT = /HttpRequestError|TimeoutError|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|network error|took too long/i;

export type ErrorKind = "known" | "nonceLow" | "nonceHigh" | "slotTaken" | "underpriced" | "transport" | "other";
export const classify = (e: unknown): ErrorKind => {
  const t = errorText(e);
  if (KNOWN.test(t)) return "known";
  if (SLOT_TAKEN.test(t)) return "slotTaken";
  if (NONCE_LOW.test(t)) return "nonceLow";
  if (NONCE_HIGH.test(t)) return "nonceHigh";
  if (UNDERPRICED.test(t)) return "underpriced";
  if (TRANSPORT.test(t)) return "transport";
  return "other";
};

const big = (_k: string, v: unknown) => (typeof v === "bigint" ? `${v}n` : v);
const unbig = (_k: string, v: unknown) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);

export class Sender<R extends SentReceipt = SentReceipt> {
  private readonly inflight = new Map<number, Entry>();
  /** Settled hashes (bounded), so a late waitForReceipt still gets its answer */
  private readonly done = new Map<Hex, Outcome<R>>();
  private readonly waiters = new Map<Hex, { resolve: (r: R) => void; reject: (e: Error) => void }[]>();
  /** Nonces below this are held by transactions we didn't send */
  private floor = 0;
  private busy = false;
  private ticking = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly lanes: Record<Lane, Item[]> = { user: [], background: [] };
  private readonly io: SenderIo<R>;
  private readonly maxAttempts: number;
  private readonly resendAfterMs: number;
  private readonly abandonAfterMs: number;
  private readonly bumpPercent: bigint;
  private readonly maxBumps: number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(private readonly o: SenderOptions<R>) {
    this.io = o.io;
    this.maxAttempts = o.maxAttempts ?? 6;
    this.resendAfterMs = o.resendAfterMs ?? 120_000;
    this.abandonAfterMs = o.abandonAfterMs ?? 600_000;
    this.bumpPercent = o.bumpPercent ?? 25n;
    this.maxBumps = o.maxBumps ?? 12;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.warn(`[sender] ${m}`));
    const saved = o.store?.load();
    if (saved) {
      for (const e of JSON.parse(saved, unbig) as Entry[]) this.inflight.set(e.nonce, e);
      if (this.inflight.size) this.log(`${this.inflight.size} transaction(s) in flight from before the restart: ${[...this.inflight.keys()].join(", ")}`);
    }
  }

  /** Queues a call (without nonce or fees: the queue sets them) and resolves with its first hash once sent. */
  write(lane: Lane, args: TxArgs): Promise<Hex> {
    return new Promise<Hex>((resolve, reject) => {
      this.lanes[lane].push({ lane, args, resolve, reject });
      void this.pump();
    });
  }

  /** write() and then waitForReceipt() */
  async send(lane: Lane, args: TxArgs): Promise<R> {
    return this.waitForReceipt(await this.write(lane, args));
  }

  /** Whether this hash is one of ours that may still land (or has just settled) */
  tracks(hash: Hex) {
    return this.done.has(hash) || !!this.entryOf(hash);
  }

  /**
   * The receipt of whichever version of this transaction lands (resends change the hash). Rejects with TxDropped if
   * its nonce was used by something else. Needs tick() to run (start() does it on a timer).
   */
  waitForReceipt(hash: Hex): Promise<R> {
    const d = this.done.get(hash);
    if (d) return "receipt" in d ? Promise.resolve(d.receipt) : Promise.reject(d.error);
    const e = this.entryOf(hash);
    if (!e) return Promise.reject(new Error(`transaction ${hash} isn't one this courier has in flight`));
    const first = e.versions[0].hash;
    return new Promise<R>((resolve, reject) => {
      const list = this.waiters.get(first) ?? [];
      list.push({ resolve, reject });
      this.waiters.set(first, list);
    });
  }

  /** Sends waiting per lane (not counting the one being sent) */
  get queued() {
    return { user: this.lanes.user.length, background: this.lanes.background.length };
  }

  /** Nonces in flight, lowest first (for /health and tests) */
  get pendingNonces() {
    return [...this.inflight.keys()].sort((a, b) => a - b);
  }

  start(pollMs = this.o.pollMs ?? 4_000) {
    this.timer ??= setInterval(() => void this.tick().catch((e) => this.log(`tick failed: ${errorText(e).slice(0, 200)}`)), pollMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One pass over the book: settle nonces the chain has passed (receipt of whichever version landed), resend what
   * has waited too long, and fill nonces that can no longer land.
   */
  async tick() {
    if (this.ticking || this.inflight.size === 0) return;
    this.ticking = true;
    try {
      const latest = await this.io.latestNonce();
      for (const e of [...this.inflight.values()].sort((a, b) => a.nonce - b.nonce)) {
        if (e.nonce < latest) await this.settleUsed(e);
        else if (this.now() - e.lastSentAt >= this.resendAfterMs) await this.resend(e);
      }
    } finally {
      this.ticking = false;
    }
  }

  // ——— the book ———

  private entryOf(hash: Hex) {
    for (const e of this.inflight.values()) if (e.versions.some((v) => v.hash === hash)) return e;
    return undefined;
  }

  private persist() {
    this.o.store?.save(JSON.stringify([...this.inflight.values()], big));
  }

  private finish(e: Entry, outcome: Outcome<R>) {
    this.inflight.delete(e.nonce);
    this.persist();
    for (const v of e.versions) this.done.set(v.hash, outcome);
    while (this.done.size > 2_000) this.done.delete(this.done.keys().next().value as Hex);
    const first = e.versions[0].hash;
    for (const w of this.waiters.get(first) ?? []) "receipt" in outcome ? w.resolve(outcome.receipt) : w.reject(outcome.error);
    this.waiters.delete(first);
  }

  /** The chain's count has passed this nonce: find which version landed */
  private async settleUsed(e: Entry) {
    for (const v of e.versions) {
      const r = await this.io.receipt(v.hash).catch(() => null);
      if (!r) continue;
      if (v.cancel) {
        this.log(`nonce ${e.nonce}: the gap-filling cancel landed; the original call did not`);
        this.finish(e, { error: new TxDropped(`not delivered: nonce ${e.nonce} was filled by a cancel after the call stopped simulating`) });
      } else this.finish(e, { receipt: r });
      return;
    }
    // A lagging read node may count the block before it serves the receipt: give it a few ticks
    e.missing = (e.missing ?? 0) + 1;
    if (e.missing >= 3) {
      this.log(`nonce ${e.nonce} was used by a transaction that isn't ours (the key is used elsewhere?)`);
      this.finish(e, { error: new TxDropped(`not delivered: nonce ${e.nonce} was used by another transaction`) });
    }
  }

  private bump(prev: Fees, market: Fees, raise: boolean): Fees {
    const up = (x: bigint) => (raise ? (x * (100n + this.bumpPercent) + 99n) / 100n : x);
    const max = (a: bigint, b: bigint) => (a > b ? a : b);
    const maxPriorityFeePerGas = max(up(prev.maxPriorityFeePerGas), market.maxPriorityFeePerGas);
    return { maxPriorityFeePerGas, maxFeePerGas: max(max(up(prev.maxFeePerGas), market.maxFeePerGas), maxPriorityFeePerGas) };
  }

  /** Same call, same nonce, higher fees, after re-simulating; or a cancel once it can no longer land. */
  private async resend(e: Entry) {
    const market = await this.io.fees();
    const fees = this.bump(e.fees, market, e.resends < this.maxBumps);
    const cancelling = e.versions.at(-1)?.cancel === true;
    let raw: Hex;
    let cancel = cancelling;
    if (cancelling) raw = await this.io.signCancel(e.nonce, fees);
    else {
      try {
        raw = await this.io.sign(e.args, e.nonce, fees);
        e.simFailedAt = undefined;
      } catch (err) {
        e.simFailedAt ??= this.now();
        if (this.now() - e.lastSentAt < this.abandonAfterMs) {
          this.log(`nonce ${e.nonce} hasn't landed and no longer simulates (${errorText(err).slice(0, 120)}); waiting while a sent version might still land`);
          this.persist();
          return;
        }
        this.log(`nonce ${e.nonce}: nothing sent for it can land any more and the call no longer simulates; filling the nonce with a cancel`);
        raw = await this.io.signCancel(e.nonce, fees);
        cancel = true;
      }
    }
    const hash = keccak256(raw);
    try {
      await this.io.sendRaw(raw);
    } catch (err) {
      const kind = classify(err);
      if (kind === "nonceLow") return; // a version landed; the next tick settles it
      if (kind === "slotTaken" || kind === "underpriced") {
        // The endpoint still holds our previous version and wants a bigger raise: raise from here next time
        e.fees = fees;
        this.persist();
        return;
      }
      if (kind !== "known" && kind !== "transport") {
        this.log(`resend of nonce ${e.nonce} refused: ${errorText(err).slice(0, 160)}`);
        return;
      }
    }
    if (!e.versions.some((v) => v.hash === hash)) e.versions.push({ hash, ...(cancel ? { cancel: true } : {}) });
    e.fees = fees;
    e.lastSentAt = this.now();
    e.resends++;
    this.persist();
    this.log(`nonce ${e.nonce} ${cancel ? "cancel" : "resent"} at max fee ${fees.maxFeePerGas} (${hash})`);
  }

  // ——— new sends ———

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        const item = this.lanes.user.shift() ?? this.lanes.background.shift();
        if (!item) break;
        try {
          item.resolve(await this.sendNew(item));
        } catch (e) {
          item.reject(e);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async nextNonce() {
    const latest = await this.io.latestNonce();
    let n = Math.max(latest, this.floor);
    for (const k of this.inflight.keys()) if (k >= n) n = k + 1;
    return n;
  }

  private async sendNew(item: Item): Promise<Hex> {
    let fees = await this.io.fees();
    let forced: number | undefined;
    for (let attempt = 1; ; attempt++) {
      const nonce = forced ?? (await this.nextNonce());
      forced = undefined;
      // Estimation is the simulation: a call that would revert throws here and uses no nonce
      const raw = await this.io.sign(item.args, nonce, fees);
      const hash = keccak256(raw);
      let kind: ErrorKind | "ok" = "ok";
      let err: unknown;
      try {
        await this.io.sendRaw(raw);
      } catch (e) {
        kind = classify(e);
        err = e;
      }
      if (kind === "ok" || kind === "known" || kind === "transport") {
        // "transport": no answer, so it may have arrived. Book it: if it didn't, the resend path sends it again.
        if (kind === "transport") this.log(`no answer sending nonce ${nonce}; booking it as in flight (${errorText(err).slice(0, 120)})`);
        this.inflight.set(nonce, { nonce, lane: item.lane, args: item.args, versions: [{ hash }], fees, lastSentAt: this.now(), resends: 0 });
        this.persist();
        return hash;
      }
      if (kind === "other" || attempt >= this.maxAttempts) throw err;
      if (kind === "nonceLow" || kind === "slotTaken") {
        // Something we didn't send holds this nonce: never replace it (it may be someone's job), move past it
        this.floor = Math.max(this.floor, nonce + 1);
        this.log(`nonce ${nonce} ${kind === "slotTaken" ? "is taken by a pending transaction" : "is too low"}; moving past it`);
      } else if (kind === "nonceHigh") {
        // The endpoint is missing a nonce below ours: resend what we have below it, then try again
        this.floor = 0;
        for (const e of [...this.inflight.values()].filter((x) => x.nonce < nonce).sort((a, b) => a.nonce - b.nonce)) await this.resend(e);
        forced = nonce > (await this.io.latestNonce()) && [...this.inflight.keys()].some((k) => k < nonce) ? nonce : undefined;
        this.log(`nonce ${nonce} is too high for the endpoint; trying ${forced ?? "a fresh count"}`);
      } else {
        fees = this.bump(fees, await this.io.fees(), true);
        forced = nonce;
        this.log(`nonce ${nonce} underpriced; raising max fee to ${fees.maxFeePerGas}`);
      }
    }
  }
}
