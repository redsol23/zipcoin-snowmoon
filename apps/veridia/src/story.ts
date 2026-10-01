/**
 * The public story, told late and loosely.
 *
 * Every action a resident takes is recorded privately with full detail (world.jsonl in DATA_DIR, never served). What
 * the world publishes is a coarsened retelling, released after an independent random delay per event
 * (VERIDIA_STORY_DELAY_MIN..MAX minutes), so the story comes out of chain order and a little behind it:
 *
 *   - no job ids, transaction hashes, addresses, amounts or any other on-chain identifier;
 *   - no shop, item or on-chain text (post bodies, poll questions, memos, messages): a purchase is "something at one
 *     of Veridia's shops", a post is "a note on the board";
 *   - no exact time: a part of the day ("this afternoon"), computed from when it happened and when it is told;
 *   - no digits or hex at all in what is published (a model-written line that has them is replaced by a plain one).
 *
 * That way a published event can't be matched to the transaction it describes, and residents' spends stay part of
 * the crowd real users hide in. Every line stays true: it only leaves things out.
 */
import fs from "node:fs";
import path from "node:path";

/** What the world records privately about one action (full detail; local state only). */
export type Happened = { at: number; who: string; action: string; line: string; detail?: Record<string, unknown>; tx?: string; job?: string };

/** What the world publishes: `at` is when it was told, `when` roughly when it happened. */
export type Told = { at: number; who: string; action: string; line: string; when: string; detail?: { to?: string } };

type Pending = { happenedAt: number; publishAt: number; who: string; action: string; line: string; detail?: { to?: string } };

/** Anything that looks like a hash, address, key or proof, and any number: none of it is ever published. */
export const HEX = /0x[0-9a-f]{2,}/i;
const DIGITS = /\d/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export type Rng = () => number;
const pick = <T>(rng: Rng, xs: readonly T[]) => xs[Math.min(xs.length - 1, Math.floor(rng() * xs.length))];

// ---------------------------------------------------------------------------------------------------------------
// coarsening
// ---------------------------------------------------------------------------------------------------------------

type Line = (n: string, to: string) => string;
/**
 * Plain, true retellings per action. They name the resident (the story is about them) and, for a private send, whom
 * it went to (a rezip's recipient isn't visible on-chain). Never the shop, the item, the amount, the door or the words.
 */
const LINES: Record<string, readonly Line[]> = {
  eat: [
    (n) => `${n} paid for something at one of Veridia's shops. What it was stays between ${n} and the till.`,
    (n) => `${n} stopped at a counter and paid from the pool. The shop knows it was paid; nobody knows by whom.`,
    (n) => `${n} treated themselves to a little something, tax included, nobody else the wiser.`,
    (n) => `${n} tapped a watch on a green circle somewhere in Veridia and went on with the day.`,
  ],
  allowance: [
    (n, to) => `${n} sent ${to} a little money, privately, the way people do here.`,
    (n, to) => `${n} slipped ${to} an allowance through the pool; the coins never touched a wallet.`,
    (n, to) => `${n} made sure ${to} wouldn't go short this week.`,
  ],
  knock: [
    (n) => `${n} burned a few zipcoins at a neighbour's door rather than wait for a second knock.`,
    (n) => `${n} knocked, the zipcoin way, at someone's door.`,
  ],
  speak: [
    (n) => `${n} burned a few zipcoins to be heard across Veridia.`,
    (n) => `${n} paid to say something out loud, to anyone listening.`,
  ],
  message: [
    (n) => `${n} burned a few zipcoins to send someone a note in public.`,
    (n) => `${n} sent a message to a neighbour, and burned a little to send it.`,
  ],
  post: [
    (n) => `${n} pinned an unsigned note to the board. On-chain it's just some badge holder.`,
    (n) => `${n} posted something anonymously; the proof only says a badge holder wrote it.`,
  ],
  poll: [(n) => `${n} paid to put a question to everyone with a badge.`],
  ask: [(n) => `${n} asked the badge holders something, without signing it.`],
  vote: [(n) => `${n} answered a poll anonymously. One answer per member, no names.`, (n) => `${n} dropped an answer into a poll, unsigned.`],
  zip: [(n) => `${n} zipped some savings into the pool.`, (n) => `${n} put a little aside; the coins disappeared into the crowd.`],
};

const QUIET: readonly Line[] = [(n) => `${n} stayed in for a while.`, (n) => `${n} took it slow for a while.`, (n) => `${n} went about the day.`];

/** A line is publishable only if it can't carry an identifier or an amount. */
export const publishable = (s: string) => !HEX.test(s) && !DIGITS.test(s) && !UUID.test(s);

/**
 * Turns a private record into what may be told, or null if it shouldn't be told at all. `names` maps resident ids to
 * display names. Lines for chain actions are always templated; a resting resident's own line (it touched no chain)
 * is kept when it carries no number or hex.
 */
export function coarsen(e: Happened, names: ReadonlyMap<string, string>, rng: Rng): Omit<Told, "at" | "when"> | null {
  const n = names.get(e.who) ?? "Someone";
  if (e.action === "rest") {
    const own = e.line.trim();
    const line = own && own.length <= 240 && publishable(own) ? own : pick(rng, QUIET)(n, "");
    return { who: e.who, action: "rest", line };
  }
  const lines = LINES[e.action];
  if (!lines) return null;
  const to = typeof e.detail?.to === "string" && [...names.values()].includes(e.detail.to) ? e.detail.to : undefined;
  if (e.action === "allowance" && !to) return { who: e.who, action: e.action, line: `${n} sent someone close a little money, privately.` };
  return { who: e.who, action: e.action, line: pick(rng, lines)(n, to ?? ""), ...(to ? { detail: { to } } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------
// time
// ---------------------------------------------------------------------------------------------------------------

const DAY = 86_400_000;
const part = (h: number) => (h < 5 ? "small hours" : h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night");

/** Roughly when something happened, as said at `toldAt` (UTC, Veridia's clock): "this afternoon", "late last night". */
export function timeOfDay(happenedAt: number, toldAt: number): string {
  const p = part(new Date(happenedAt).getUTCHours());
  const days = Math.floor(toldAt / DAY) - Math.floor(happenedAt / DAY);
  if (days <= 0) return p === "small hours" ? "in the small hours" : p === "night" ? "tonight" : `this ${p}`;
  if (days === 1) return p === "small hours" ? "in yesterday's small hours" : p === "night" ? "late last night" : `yesterday ${p}`;
  return days < 7 ? `earlier this week, in the ${p}` : `a while ago, in the ${p}`;
}

/** An independent random delay in [minMin, maxMin] minutes. */
export const delayMs = (rng: Rng, minMin: number, maxMin: number) => {
  const lo = Math.max(0, Math.min(minMin, maxMin));
  const hi = Math.max(minMin, maxMin);
  return Math.round((lo + rng() * (hi - lo)) * 60_000);
};

// ---------------------------------------------------------------------------------------------------------------
// the storyteller
// ---------------------------------------------------------------------------------------------------------------

export type StoryOptions = {
  names: ReadonlyMap<string, string>;
  delayMinMin: number;
  delayMaxMin: number;
  now?: () => number;
  rng?: Rng;
  /** Where the pending queue (private) and the told story (public) persist; in memory when omitted */
  dir?: string;
};

export class Story {
  private pending: Pending[] = [];
  private told: Told[] = [];
  private readonly now: () => number;
  private readonly rng: Rng;
  private readonly files?: { pending: string; told: string };

  constructor(private readonly o: StoryOptions) {
    this.now = o.now ?? Date.now;
    this.rng = o.rng ?? Math.random;
    if (o.dir) {
      this.files = { pending: path.join(o.dir, "story-pending.json"), told: path.join(o.dir, "story.jsonl") };
      if (fs.existsSync(this.files.pending)) this.pending = JSON.parse(fs.readFileSync(this.files.pending, "utf8"));
      if (fs.existsSync(this.files.told))
        this.told = fs.readFileSync(this.files.told, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Told);
    }
  }

  /** Queues a private record to be told, coarsened, after its own random delay. */
  add(e: Happened) {
    const c = coarsen(e, this.o.names, this.rng);
    if (!c) return;
    this.pending.push({ ...c, happenedAt: e.at, publishAt: this.now() + delayMs(this.rng, this.o.delayMinMin, this.o.delayMaxMin) });
    this.savePending();
  }

  /** Tells everything whose delay has passed. Returns what was newly told. */
  flush(): Told[] {
    const t = this.now();
    const due = this.pending.filter((p) => p.publishAt <= t).sort((a, b) => a.publishAt - b.publishAt);
    if (!due.length) return [];
    this.pending = this.pending.filter((p) => p.publishAt > t);
    const out: Told[] = [];
    for (const p of due) {
      // `at` is the telling time, strictly increasing so `since` cursors never skip anything
      const at = Math.max(t, (this.told[this.told.length - 1]?.at ?? 0) + 1);
      const told: Told = { at, who: p.who, action: p.action, line: p.line, when: timeOfDay(p.happenedAt, at), ...(p.detail ? { detail: p.detail } : {}) };
      if (!clean(told)) continue;
      this.told.push(told);
      out.push(told);
      if (this.files) fs.appendFileSync(this.files.told, JSON.stringify(told) + "\n");
    }
    this.savePending();
    return out;
  }

  /** The told story after `since` (ms), newest 200 */
  feed(since = 0): Told[] {
    return this.told.filter((e) => e.at > since).slice(-200);
  }

  /** How many records are waiting to be told */
  get waiting() {
    return this.pending.length;
  }

  private savePending() {
    if (this.files) fs.writeFileSync(this.files.pending, JSON.stringify(this.pending));
  }
}

/** The last check before anything is told: no hex, no digits, no job-id shape, only known fields. */
export function clean(t: Told): boolean {
  const keys = Object.keys(t).sort().join(",");
  const allowed = new Set(["action,at,line,when,who", "action,at,detail,line,when,who"]);
  if (!allowed.has(keys)) return false;
  if (t.detail && Object.keys(t.detail).some((k) => k !== "to")) return false;
  const text = [t.who, t.action, t.line, t.when, t.detail?.to ?? ""].join(" ");
  return publishable(text);
}
