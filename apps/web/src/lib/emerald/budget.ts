// Emerald's daily DeepSeek budget and per-session rate limits. Server-only.
//
// Every model call first reserves its worst case (the prompt's size, estimated generously, plus max_tokens of output)
// against the day's cap; once DeepSeek answers, the reservation is replaced by the real cost from the response's
// `usage` fields. When the next call wouldn't fit, Emerald rests until 00:00 UTC: the route answers without calling
// the model and before anyone is charged. Concurrent calls can't overshoot, since each holds its reservation.
//
// The cap is EMERALD_DAILY_USD_CAP (default 10; "none" turns it off) and/or EMERALD_DAILY_TOKEN_CAP. Cost uses
// DeepSeek's published per-token prices (https://api-docs.deepseek.com/quick_start/pricing, September 2026, peak
// rates, so off-peak use is over-counted, never under): override with EMERALD_USD_PER_M_INPUT (cache miss),
// EMERALD_USD_PER_M_CACHED (cache hit) and EMERALD_USD_PER_M_OUTPUT. A model not listed is priced as the dearest one.
// The day's spend is kept in memory, and in EMERALD_BUDGET_FILE when set, so a restart doesn't reset it.
import fs from "node:fs";
import path from "node:path";

type Env = Record<string, string | undefined>;

/** USD per million tokens */
export type Prices = { miss: number; hit: number; out: number };
export const MODEL_PRICES: Record<string, Prices> = {
  "deepseek-flash": { hit: 0.006, miss: 0.3, out: 1.2 },
  "deepseek-v4-pro": { hit: 0.044, miss: 1.32, out: 3.96 },
};
const DEAREST: Prices = MODEL_PRICES["deepseek-v4-pro"];

/** The usage block of a chat-completions response (DeepSeek adds the cache split) */
export type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number };

export function pricesFor(model: string, env: Env): Prices {
  const base = MODEL_PRICES[model] ?? DEAREST;
  const num = (k: string, d: number) => {
    const v = Number(env[k]);
    return env[k] !== undefined && env[k] !== "" && Number.isFinite(v) && v >= 0 ? v : d;
  };
  return { miss: num("EMERALD_USD_PER_M_INPUT", base.miss), hit: num("EMERALD_USD_PER_M_CACHED", base.hit), out: num("EMERALD_USD_PER_M_OUTPUT", base.out) };
}

export function costUsd(u: Usage, p: Prices): number {
  const prompt = u.prompt_tokens ?? 0;
  const hit = u.prompt_cache_hit_tokens ?? 0;
  const miss = u.prompt_cache_miss_tokens ?? Math.max(0, prompt - hit);
  return (hit * p.hit + miss * p.miss + (u.completion_tokens ?? 0) * p.out) / 1e6;
}

export const tokensOf = (u: Usage) => u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0);

/** A generous token estimate for a prompt of `chars` characters (real text runs about 3.5-4 characters a token) */
export const estimatePromptTokens = (chars: number) => Math.ceil(chars / 2.5);

export type CapConfig = { usdCap: number | null; tokenCap: number | null; file?: string };

export function capConfig(env: Env): CapConfig {
  const usd = (env.EMERALD_DAILY_USD_CAP ?? "").trim();
  const tok = (env.EMERALD_DAILY_TOKEN_CAP ?? "").trim();
  const usdCap = usd.toLowerCase() === "none" ? null : usd === "" ? 10 : Math.max(0, Number(usd) || 0);
  const tokenCap = tok === "" || tok.toLowerCase() === "none" ? null : Math.max(0, Math.floor(Number(tok) || 0));
  return { usdCap, tokenCap, file: env.EMERALD_BUDGET_FILE || undefined };
}

type Day = { day: string; usd: number; tokens: number };
export type Reservation = { id: number; usd: number; tokens: number };

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Next 00:00 UTC after `ms`, in unix seconds */
export const nextUtcMidnight = (ms: number) => Math.floor(Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), new Date(ms).getUTCDate() + 1) / 1000);

export class SpendCap {
  private spent: Day;
  private held = new Map<number, Reservation>();
  private seq = 0;

  constructor(
    readonly cfg: CapConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.spent = { day: utcDay(now()), usd: 0, tokens: 0 };
    if (cfg.file) {
      try {
        const d = JSON.parse(fs.readFileSync(cfg.file, "utf8")) as Day;
        if (d.day === this.spent.day && Number.isFinite(d.usd) && Number.isFinite(d.tokens)) this.spent = d;
      } catch {
        // no file yet, or unreadable: start the day at zero
      }
    }
  }

  private roll() {
    const day = utcDay(this.now());
    if (day !== this.spent.day) this.spent = { day, usd: 0, tokens: 0 };
  }

  private save() {
    if (!this.cfg.file) return;
    try {
      const tmp = path.join(path.dirname(this.cfg.file), `.${path.basename(this.cfg.file)}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(this.spent));
      fs.renameSync(tmp, this.cfg.file);
    } catch (e) {
      console.error(`[emerald] couldn't save the budget file: ${(e as Error).message}`);
    }
  }

  /** Spend so far today plus what calls in flight have reserved */
  status() {
    this.roll();
    let usd = this.spent.usd;
    let tokens = this.spent.tokens;
    for (const r of this.held.values()) {
      usd += r.usd;
      tokens += r.tokens;
    }
    return { day: this.spent.day, spentUsd: this.spent.usd, spentTokens: this.spent.tokens, committedUsd: usd, committedTokens: tokens, usdCap: this.cfg.usdCap, tokenCap: this.cfg.tokenCap };
  }

  /** Reserves a call's worst case, or says Emerald is resting (with when it wakes, unix sec) */
  reserve(usd: number, tokens: number): { ok: true; r: Reservation } | { ok: false; until: number } {
    const s = this.status();
    const over = (this.cfg.usdCap !== null && s.committedUsd + usd > this.cfg.usdCap) || (this.cfg.tokenCap !== null && s.committedTokens + tokens > this.cfg.tokenCap);
    if (over) return { ok: false, until: nextUtcMidnight(this.now()) };
    const r = { id: ++this.seq, usd, tokens };
    this.held.set(r.id, r);
    return { ok: true, r };
  }

  /** Whether a call of this worst case would be refused now, without reserving */
  resting(usd: number, tokens: number) {
    const r = this.reserve(usd, tokens);
    if (r.ok) this.release(r.r);
    return !r.ok;
  }

  /** The call finished: replace its reservation with what it really cost */
  settle(r: Reservation, usd: number, tokens: number) {
    this.held.delete(r.id);
    this.roll();
    this.spent.usd += usd;
    this.spent.tokens += tokens;
    this.save();
  }

  /** The call failed before DeepSeek charged anything */
  release(r: Reservation) {
    this.held.delete(r.id);
  }
}

/** Sliding-window request limits per key (a session, an IP) */
export class RateLimit {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts a request; true when it is over the limit */
  limited(key: string): boolean {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    const over = recent.length >= this.max;
    if (!over) recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    return over;
  }
}

// ——— the process-wide instances (kept on globalThis: Next bundles each route separately) ———

type Shared = { cap?: SpendCap; perMin?: RateLimit; perDay?: RateLimit };
const shared = globalThis as { __emerald?: Shared };
const s = (): Shared => (shared.__emerald ??= {});

export function emeraldCap(): SpendCap {
  return (s().cap ??= new SpendCap(capConfig(process.env)));
}

/** Per-session limits: EMERALD_SESSION_PER_MIN (default 10) and EMERALD_SESSION_PER_DAY (default 200) requests */
export function sessionLimited(key: string): boolean {
  const n = (k: string, d: number) => Math.max(1, Math.floor(Number(process.env[k]) || d));
  const perMin = (s().perMin ??= new RateLimit(n("EMERALD_SESSION_PER_MIN", 10), 60_000));
  const perDay = (s().perDay ??= new RateLimit(n("EMERALD_SESSION_PER_DAY", 200), 86_400_000));
  return perMin.limited(key) || perDay.limited(key);
}


/** For tests: start over with this cap (or one from the environment) and fresh limits */
export function resetEmeraldBudget(cap?: SpendCap) {
  shared.__emerald = cap ? { cap } : {};
}

export const restingMessage = (until: number) =>
  `Emerald is resting until tomorrow (${new Date(until * 1000).toISOString().slice(11, 16)} UTC): today's model budget is used up. Ask again after that.`;
