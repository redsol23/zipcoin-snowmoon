/**
 * The free-relay budget (review 2 M-3, anon A-2). Free jobs (Semaphore posts and votes, unlocks, payout recovery,
 * ...) carry no fee, so the courier pays their gas and caps how many it pays for per UTC day. The cap must
 * not be something anyone can use up for free:
 *
 * - A job counts only once it has simulated successfully (`spend` after the simulation): junk costs nothing.
 * - The courier's own jobs (harvest, bands, its own payout calls) never count and are never
 *   refused: they aren't relays for anyone.
 * - Time-critical kinds (parked-payout recovery) have a reserved share of the day that the other kinds can't touch,
 *   so a flood of votes can't block an owner from recovering a parked payout.
 * - No single non-critical kind may take more than `kindShare` of the day.
 * - Each client (IP, or the first hop for sealed jobs) may make `perClientPerHour` free-job attempts per rolling hour,
 *   counted before simulation, since a failed simulation still costs us an RPC call.
 *
 * Pure apart from the clock, so it can be tested alone.
 */

const PRIVATE = /^(::1$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fc|fd|::ffff:(127|10|192\.168|172\.(1[6-9]|2\d|3[01]))\.)/i;

/**
 * Who a request is from, for the per-client limit. Behind a proxy or tunnel (`trustProxy`), the last X-Forwarded-For
 * entry. Otherwise the socket's address, unless that is loopback or private: then it is the proxy's, shared by every
 * client, and limiting it would limit everyone (null = don't limit per client).
 */
export function clientKey(remote: string | undefined, xff: string | string[] | undefined, trustProxy: boolean): string | null {
  if (trustProxy) {
    const last = (Array.isArray(xff) ? xff.join(",") : (xff ?? "")).split(",").map((s) => s.trim()).filter(Boolean).at(-1);
    if (last) return last;
  }
  if (!remote || PRIVATE.test(remote)) return null;
  return remote;
}

export type BudgetOpts = {
  /** Free jobs paid for per UTC day (FREE_RELAYS_PER_DAY) */
  perDay: number;
  /** Share of the day kept for `critical` kinds (FREE_RESERVED_SHARE, 0..1) */
  reservedShare: number;
  /** Most of the day one non-critical kind may use (FREE_KIND_SHARE, 0..1) */
  kindShare: number;
  /** Free-job attempts per client per rolling hour (FREE_PER_CLIENT_PER_HOUR; 0 = no limit) */
  perClientPerHour: number;
  critical: ReadonlySet<string>;
  now?: () => number;
};

export class FreeBudget {
  private day = -1;
  private used = 0;
  private usedGeneral = 0;
  private readonly byKind = new Map<string, number>();
  private readonly attempts = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(private readonly o: BudgetOpts) {
    this.now = o.now ?? Date.now;
  }

  private roll() {
    const day = Math.floor(this.now() / 86_400_000);
    if (day === this.day) return;
    this.day = day;
    this.used = 0;
    this.usedGeneral = 0;
    this.byKind.clear();
  }

  /**
   * Called before the simulation: records the attempt against the client and says why the job can't be taken, or
   * null. `client` null = not rate-limited per client (the courier's own jobs, or no trustworthy client address).
   */
  admit(kind: string, client: string | null): string | null {
    this.roll();
    if (client && this.o.perClientPerHour > 0) {
      const t = this.now();
      const recent = (this.attempts.get(client) ?? []).filter((x) => t - x < 3_600_000);
      if (recent.length >= this.o.perClientPerHour) {
        this.attempts.set(client, recent);
        return "too many free jobs from this client; try again later";
      }
      recent.push(t);
      this.attempts.set(client, recent);
      if (this.attempts.size > 50_000) this.sweep();
    }
    return this.room(kind);
  }

  /** Why a job of this kind can't be paid for now, or null */
  room(kind: string): string | null {
    this.roll();
    if (this.used >= this.o.perDay) return "free relay budget used up for today";
    if (this.o.critical.has(kind)) return null;
    if (this.usedGeneral >= Math.floor(this.o.perDay * (1 - this.o.reservedShare))) return "free relay budget used up for today (the rest is kept for payout recovery)";
    if ((this.byKind.get(kind) ?? 0) >= Math.max(1, Math.floor(this.o.perDay * this.o.kindShare))) return `today's free ${kind} jobs are used up`;
    return null;
  }

  /** Called after a successful simulation: this job is paid for */
  spend(kind: string) {
    this.roll();
    this.used++;
    if (!this.o.critical.has(kind)) {
      this.usedGeneral++;
      this.byKind.set(kind, (this.byKind.get(kind) ?? 0) + 1);
    }
  }

  get usedToday() {
    this.roll();
    return this.used;
  }

  private sweep() {
    const t = this.now();
    for (const [k, v] of this.attempts) if (!v.some((x) => t - x < 3_600_000)) this.attempts.delete(k);
  }
}
