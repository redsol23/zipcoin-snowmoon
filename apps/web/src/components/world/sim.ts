/**
 * The living layer of Veridia: residents going about their day, couriers carrying sealed proofs, lights and signs
 * where things happen, weather, and night.
 *
 * Driven only by the public story feed (or, offline, a scripted day). The animation never shows more than the story
 * says: anonymous posts and poll answers arrive by courier, never from the person who sent them, and private payments
 * light a pad and split its tax, never a balance. The live story arrives delayed and coarsened (no shop, door or
 * amount), so the animation plays each moment when it is told, not when it happened, and at no particular shop or door.
 */
import { viaCourier as carried, type Resident, type WorldEvent } from "@/lib/veridia";

import { along, CITY, COLORS, envelope, FOREST_PATH, hash01, homeOf, LAMPS, LANDMARKS, SHOP, SPOT, TRUCKS, W, H, windowsOf, type Pt } from "./scene";
import { darkness, skyAt, type Sky } from "./sky";

export { darkness };

type Leg = { to: Pt; then?: () => void; pace?: number };

type Mover = {
  pos: Pt;
  from: Pt;
  to: Pt | null;
  t: number;
  dur: number;
  bend: number;
  legs: Leg[];
  multi: boolean;
  then: (() => void) | null;
};

type Walker = Mover & {
  id: string;
  name: string;
  shop: boolean;
  home: Pt;
  dwellUntil: number;
  nextWander: number;
  nextErrand: number;
  tint: string;
  speaking: { text: string; until: number } | null;
  away: boolean;
  /** What they are up to right now, in a few words */
  doing: string | null;
  /** The last thing the story says they did in the open */
  last: { line: string; gist: string; action: string; at: number; when?: string } | null;
};

type Courier = Mover & { n: number; carry: boolean; done: boolean };

type Effect =
  | { kind: "pad"; at: Pt; start: number; dur: number }
  | { kind: "sparks"; at: Pt; start: number; dur: number; seeds: number[]; size: number }
  | { kind: "lantern"; at: Pt; start: number; dur: number; drift: number }
  | { kind: "light"; from: Pt; to: Pt; start: number; dur: number; bend: number; color: string; r: number }
  | { kind: "shimmer"; at: Pt; start: number; dur: number }
  | { kind: "pulse"; at: Pt; start: number; dur: number; color: string }
  | { kind: "chip"; at: Pt; start: number; dur: number; text: string }
  | { kind: "door"; at: Pt; start: number; dur: number }
  | { kind: "send"; at: Pt; start: number; dur: number };

type Figure = { from: Pt; to: Pt; start: number; dur: number; leaveAt: number; out: Pt; seed: number };

/** What the pointer is over. */
export type Hit = { kind: "resident" | "shop"; id: string } | { kind: "place"; id: string } | { kind: "courier"; id: string };

export const COURIER_NOTE = "Couriers carry sealed proofs for residents and hold each one a while before sending it, so the timing gives nobody away. They never see what's inside.";

const TINTS = [COLORS.slate, COLORS.pad, "#7A5C8E", COLORS.candle, "#9A5B4A", COLORS.lichen];
const HEAD = "#E8DCCB";
const POST_DOOR: Pt = { x: SPOT.couriers.x, y: SPOT.couriers.y + 6 };
const MAX_COURIERS = 6;

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const near = (p: Pt, rx: number, ry = rx * 0.5): Pt => ({ x: p.x + (Math.random() - 0.5) * 2 * rx, y: p.y + (Math.random() - 0.5) * 2 * ry });

/**
 * Where each resident likes to be, and when (local hours). Outside these hours they stay home, windows lit after
 * dark. Places come from the novel as the code already draws it; activities stay ordinary.
 */
type Haunt = { at: Pt | "forest"; from: number; to: number; doing: string };
const HAUNTS: Record<string, Haunt[]> = {
  gladias: [
    { at: "forest", from: 16, to: 21, doing: "walking the Kalimar paths" },
    { at: SPOT.board, from: 8, to: 16, doing: "reading the board" },
    { at: SPOT.skyBridge, from: 7, to: 19, doing: "crossing the sky bridge" },
  ],
  seila: [
    { at: SPOT.board, from: 8, to: 20, doing: "reading the board" },
    { at: SPOT.skyBridge, from: 7, to: 19, doing: "looking out from the sky bridge" },
    { at: SHOP["kalimar-kitchen"], from: 11, to: 21, doing: "chatting outside Kalimar Kitchen" },
  ],
  febric: [
    { at: SPOT.lessons, from: 8, to: 15, doing: "at an informal math lesson" },
    { at: SPOT.pier, from: 14, to: 20, doing: "watching the boats from the pier" },
  ],
  hreda: [
    { at: SPOT.lessons, from: 8, to: 15, doing: "at an informal math lesson" },
    { at: SPOT.pier, from: 15, to: 20, doing: "watching the boats from the pier" },
  ],
  zei: [
    { at: { x: 1352, y: 505 }, from: 10, to: 23, doing: "hanging around the food trucks" },
    { at: { x: SPOT.archive.x + 12, y: SPOT.archive.y + 22 }, from: 9, to: 18, doing: "studying near the archive node" },
  ],
  mov: [
    { at: { x: SPOT.toll.x, y: SPOT.toll.y + 10 }, from: 7, to: 20, doing: "watching the toll road" },
    { at: SPOT.skyBridge, from: 7, to: 21, doing: "pacing the sky bridge" },
  ],
  evelor: [
    { at: { x: SPOT.silverchat.x, y: SPOT.silverchat.y + 8 }, from: 8, to: 19, doing: "working at Silverchat" },
    { at: { x: SPOT.square.x - 20, y: SPOT.square.y + 6 }, from: 9, to: 20, doing: "walking through the square" },
  ],
};

/** A short phrase for what an event shows someone doing, for hover tags and the card. */
export function gist(e: WorldEvent): string {
  const d = e.detail ?? {};
  switch (e.action) {
    case "eat":
      return d.shop ? `paid for ${d.item ? String(d.item) : "a meal"} at ${d.shop}` : "paid for something at one of the shops";
    case "allowance":
      return `sent ${d.to ?? "someone close"} an allowance, privately`;
    case "knock":
      return d.door ? `burned zipcoins at ${d.door}'s door` : "burned zipcoins at someone's door";
    case "speak":
      return "burned zipcoins to be heard";
    case "poll":
      return "paid to ask Veridia a question";
    case "zip":
      return "zipped some savings into the pool";
    default:
      return e.line;
  }
}

// Soft round glows are drawn from one cached sprite per color instead of a fresh gradient each frame
const sprites = new Map<string, HTMLCanvasElement>();
function sprite(color: string) {
  let s = sprites.get(color);
  if (!s) {
    s = document.createElement("canvas");
    s.width = s.height = 64;
    const c = s.getContext("2d")!;
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, hexA(color, 1));
    g.addColorStop(0.45, hexA(color, 0.45));
    g.addColorStop(1, hexA(color, 0));
    c.fillStyle = g;
    c.fillRect(0, 0, 64, 64);
    sprites.set(color, s);
  }
  return s;
}

export class Veridia {
  walkers = new Map<string, Walker>();
  couriers: Courier[] = [];
  held: { releaseAt: number }[] = [];
  effects: Effect[] = [];
  notes: { x: number; y: number; rot: number; born: number }[] = [];
  poll: { question: string; since: number; figures: Figure[] } | null = null;
  snow: { x: number; y: number; r: number; v: number; sway: number }[] = [];
  byName = new Map<string, string>();
  private now = 0;
  private sky: Sky = skyAt();
  private courierN = 0;

  constructor(residents: Resident[], private reduced: boolean) {
    for (const r of residents) {
      const home = homeOf(r.id, r.city);
      this.byName.set(r.name.toLowerCase(), r.id);
      this.walkers.set(r.id, {
        id: r.id,
        name: r.name,
        shop: !!r.shop,
        home,
        pos: { ...home },
        from: { ...home },
        to: null,
        t: 0,
        dur: 1,
        bend: 0,
        legs: [],
        multi: false,
        then: null,
        dwellUntil: 0,
        nextWander: 2000 + hash01(r.id, 3) * 6000,
        // Someone heads out soon after the page opens, then everyone keeps their own rhythm
        nextErrand: 3000 + hash01(r.id, 9) * 40_000,
        tint: TINTS[Math.floor(hash01(r.id, 11) * TINTS.length)],
        speaking: null,
        away: false,
        doing: null,
        last: null,
      });
    }
    for (let i = 0; i < 320; i++) {
      this.snow.push({ x: Math.random() * W, y: Math.random() * H, r: 0.6 + Math.random() * 1.6, v: 8 + Math.random() * 18, sway: Math.random() * Math.PI * 2 });
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // movement
  // -------------------------------------------------------------------------------------------------------------

  private route(m: Mover, legs: Leg[]) {
    m.legs = legs;
    m.multi = legs.length > 1;
    this.nextLeg(m);
  }

  private nextLeg(m: Mover) {
    const leg = m.legs.shift();
    if (!leg) {
      m.to = null;
      return;
    }
    m.from = { ...m.pos };
    m.to = leg.to;
    m.t = 0;
    // Crossing the map takes ~12s: long enough to follow, short enough to keep up with the story
    m.dur = this.reduced ? 1 : Math.max(700, dist(m.pos, leg.to) * (leg.pace ?? 9));
    m.bend = m.multi ? 0.04 : (Math.random() - 0.5) * 0.3;
    m.then = leg.then ?? null;
  }

  private step(m: Mover, dt: number) {
    if (!m.to) return;
    m.t = Math.min(1, m.t + dt / m.dur);
    m.pos = along(m.from, m.to, m.multi ? m.t : ease(m.t), m.bend);
    if (m.t < 1) return;
    const done = m.then;
    m.then = null;
    m.to = null;
    done?.();
    if (!m.to) this.nextLeg(m);
  }

  /** Sends a resident somewhere for a story event; they come home once `dwell` has passed after arriving. */
  private walk(w: Walker, to: Pt, onArrive: (() => void) | null = null, dwell = 4000) {
    w.away = true;
    w.dwellUntil = Infinity;
    this.route(w, [
      {
        to,
        then: () => {
          w.dwellUntil = this.now + dwell;
          onArrive?.();
        },
      },
    ]);
  }

  private goHome(w: Walker) {
    this.route(w, [
      {
        to: w.home,
        then: () => {
          w.away = false;
          w.doing = null;
          w.nextErrand = this.now + 30_000 + Math.random() * 50_000;
        },
      },
    ]);
  }

  /** Idle life: off to a favourite place if it's the hour for it, otherwise stay in. */
  private errand(w: Walker) {
    w.nextErrand = this.now + 30_000 + Math.random() * 45_000;
    const hour = new Date().getHours();
    const open = (HAUNTS[w.id] ?? []).filter((h) => hour >= h.from && hour < h.to);
    if (!open.length || Math.random() < 0.3) return;
    const h = pick(open);
    const stay = () => (w.dwellUntil = this.now + 10_000 + Math.random() * 14_000);
    w.away = true;
    w.dwellUntil = Infinity;
    w.doing = h.doing;
    if (h.at === "forest") this.route(w, this.forestLegs(w.pos, stay));
    else this.route(w, [{ to: near(h.at, 10), then: stay }]);
  }

  private forestLegs(from: Pt, then: () => void): Leg[] {
    const path = dist(from, FOREST_PATH[0]) < dist(from, FOREST_PATH[FOREST_PATH.length - 1]) ? FOREST_PATH : [...FOREST_PATH].reverse();
    return path.map((p, i) => ({ to: p, pace: 16, then: i === path.length - 1 ? then : undefined }));
  }

  private say(w: Walker, text: string) {
    w.speaking = { text: text.length > 90 ? `${text.slice(0, 88)}…` : text, until: this.now + 6000 };
  }

  // -------------------------------------------------------------------------------------------------------------
  // couriers
  // -------------------------------------------------------------------------------------------------------------

  private courier(carry: boolean): Courier | null {
    if (this.couriers.length >= MAX_COURIERS) return null;
    const c: Courier = { n: ++this.courierN, pos: { ...POST_DOOR }, from: { ...POST_DOOR }, to: null, t: 0, dur: 1, bend: 0, legs: [], multi: false, then: null, carry, done: false };
    this.couriers.push(c);
    return c;
  }

  /** A courier walks out, collects a sealed proof from `at`, and brings it back to hold before sending it. */
  private collect(at: Pt) {
    const c = this.courier(false);
    if (!c) return this.hold();
    this.route(c, [
      { to: { x: at.x + 9, y: at.y + 3 }, then: () => (c.carry = true) },
      {
        to: POST_DOOR,
        then: () => {
          c.done = true;
          this.hold();
        },
      },
    ]);
  }

  /** A courier carries a sealed proof from the post to `at`: anonymous things arrive this way, from nobody in particular. */
  private deliver(at: Pt, onDrop: () => void) {
    const c = this.courier(true);
    if (!c) return onDrop();
    this.route(c, [
      {
        to: at,
        then: () => {
          c.carry = false;
          onDrop();
        },
      },
      { to: POST_DOOR, then: () => (c.done = true) },
    ]);
  }

  private hold() {
    // Real couriers hold for minutes; here it's compressed so a visitor sees the proof go out
    this.held.push({ releaseAt: this.now + 6000 + Math.random() * 18_000 });
    if (this.held.length > 8) this.held.shift();
  }

  // -------------------------------------------------------------------------------------------------------------
  // the story
  // -------------------------------------------------------------------------------------------------------------

  /**
   * Turns one story event into motion. `replay` events (the backlog on first load) only restore lasting state, so
   * the page doesn't open with every past event firing at once.
   */
  ingest(e: WorldEvent, now: number, replay: boolean) {
    this.now = Math.max(this.now, now);
    const w = this.walkers.get(e.who);
    const d = e.detail ?? {};
    if (d.why) return; // the resident thought better of it; nothing happened
    const viaCourier = carried(e.action);

    // Anonymous acts: nobody walks anywhere; a courier brings them
    if (e.action === "post") {
      const pin = () => {
        this.notes.push({
          x: SPOT.board.x - 1 + (this.notes.length % 4) * 10,
          y: SPOT.board.y - 25 + Math.floor((this.notes.length % 8) / 4) * 11,
          rot: (hash01(String(e.at)) - 0.5) * 0.5,
          born: replay ? 0 : this.now,
        });
        if (this.notes.length > 8) this.notes.shift();
        if (!replay) this.effects.push({ kind: "pulse", at: { x: SPOT.board.x + 19, y: SPOT.board.y - 15 }, start: this.now, dur: 2500, color: COLORS.slate });
      };
      if (replay || !viaCourier) pin();
      else this.deliver({ x: SPOT.board.x + 19, y: SPOT.board.y + 12 }, pin);
      return;
    }
    if (e.action === "vote") {
      if (replay) return;
      const drop = () => this.effects.push({ kind: "pulse", at: SPOT.ballot, start: this.now, dur: 2200, color: COLORS.slate });
      if (viaCourier) this.deliver({ x: SPOT.ballot.x, y: SPOT.ballot.y + 6 }, drop);
      else drop();
      return;
    }
    if (e.action === "poll") this.startPoll(String(d.question ?? e.line), now, replay);
    if (!w) return;
    if (e.action !== "rest") w.last = { line: e.line, gist: gist(e), action: e.action, at: e.at, when: e.when };
    if (replay) return;

    switch (e.action) {
      case "eat": {
        const shopId = this.shopByName(d.shop);
        if (!shopId) {
          // The live story doesn't say which shop: a pad glows where they are, and the tax share goes to the couriers
          this.say(w, e.line);
          const pad = { x: w.pos.x, y: w.pos.y - 10 };
          this.effects.push({ kind: "pad", at: pad, start: this.now, dur: 3500 });
          this.effects.push({ kind: "sparks", at: { x: pad.x + 10, y: pad.y - 8 }, start: this.now + 500, dur: 2400, seeds: seeds(8), size: 0.55 });
          this.effects.push({ kind: "light", from: pad, to: { x: SPOT.couriers.x, y: SPOT.couriers.y - 12 }, start: this.now + 700, dur: this.reduced ? 1 : Math.max(1800, dist(pad, SPOT.couriers) * 5), bend: 0.25, color: COLORS.pad, r: 7 });
          if (viaCourier) this.collect(w.pos);
          return;
        }
        const shop = SHOP[shopId];
        const door = { x: shop.x + (hash01(e.who) - 0.5) * 14, y: shop.y + 16 };
        this.say(w, e.line);
        w.doing = `on the way to ${shop.name}`;
        this.walk(
          w,
          door,
          () => {
            w.doing = `eating at ${shop.name}`;
            const pad = { x: shop.x, y: shop.y - 8 };
            this.effects.push({ kind: "pad", at: pad, start: this.now, dur: 3500 });
            if (d.base && d.tax) this.effects.push({ kind: "chip", at: { x: shop.x, y: shop.y - 30 }, start: this.now, dur: 4200, text: `${d.base} zc + ${d.tax} tax` });
            // The tax splits on the spot: a little burned, a share to the couriers who keep the network private
            this.effects.push({ kind: "sparks", at: { x: shop.x + 12, y: shop.y - 16 }, start: this.now + 500, dur: 2400, seeds: seeds(8), size: 0.55 });
            this.effects.push({ kind: "light", from: pad, to: { x: SPOT.couriers.x, y: SPOT.couriers.y - 12 }, start: this.now + 700, dur: this.reduced ? 1 : Math.max(1800, dist(pad, SPOT.couriers) * 5), bend: 0.25, color: COLORS.pad, r: 7 });
            if (viaCourier) this.collect(w.pos);
          },
          9000,
        );
        break;
      }
      case "knock": {
        const target = this.walkers.get(this.byName.get(String(d.door ?? "").toLowerCase()) ?? "");
        if (!target) {
          // Whose door isn't part of the live story: the sparks fly where the knocker is
          this.say(w, e.line);
          this.effects.push({ kind: "sparks", at: { ...w.pos }, start: this.now, dur: 4200, seeds: seeds(18), size: 1 });
          if (viaCourier) this.collect(w.pos);
          return;
        }
        this.say(w, e.line);
        w.doing = `on the way to ${target.name}'s door`;
        this.walk(w, { x: target.home.x + 9, y: target.home.y + 4 }, () => {
          w.doing = `knocking at ${target.name}'s door`;
          this.effects.push({ kind: "sparks", at: { x: target.home.x, y: target.home.y - 4 }, start: this.now, dur: 4200, seeds: seeds(18), size: 1 });
          this.effects.push({ kind: "door", at: { x: target.home.x, y: target.home.y - 3 }, start: this.now + 800, dur: 5000 });
          // Whoever is home comes to the door
          if (!target.away && !target.to && !target.shop) {
            target.away = true;
            target.doing = `answering the door to ${w.name}`;
            this.walk(target, { x: target.home.x - 4, y: target.home.y + 6 }, null, 5000);
          }
          if (viaCourier) this.collect(w.pos);
        });
        break;
      }
      case "speak":
        this.say(w, e.line);
        this.effects.push({ kind: "sparks", at: { ...w.pos }, start: this.now, dur: 2600, seeds: seeds(10), size: 0.7 });
        this.effects.push({ kind: "lantern", at: { ...w.pos }, start: this.now + 400, dur: 7000, drift: (Math.random() - 0.5) * 40 });
        if (viaCourier) this.collect(w.pos);
        break;
      case "allowance": {
        const to = this.walkers.get(this.byName.get(String(d.to ?? "").toLowerCase()) ?? "");
        if (!to) return;
        this.say(w, e.line);
        // A private allowance: light travelling home to home, never touching the road's wallets
        this.effects.push({ kind: "light", from: { ...w.home }, to: { ...to.home }, start: this.now, dur: this.reduced ? 1 : Math.max(2000, dist(w.home, to.home) * 5), bend: 0.2, color: COLORS.pad, r: 14 });
        if (viaCourier) this.collect(w.pos);
        break;
      }
      case "poll":
        this.say(w, e.line);
        w.doing = "asking Veridia a question in the square";
        this.walk(w, { x: SPOT.square.x - 8, y: SPOT.square.y + 8 }, null, 12_000);
        break;
      case "zip":
        this.effects.push({ kind: "shimmer", at: { ...w.home }, start: this.now, dur: 3000 });
        break;
      case "rest":
        if (/kalimar|walk/i.test(e.line) && !w.shop) {
          this.say(w, e.line);
          w.away = true;
          w.dwellUntil = Infinity;
          w.doing = "walking the Kalimar paths";
          this.route(w, this.forestLegs(w.pos, () => (w.dwellUntil = this.now + 5000)));
        } else if (!w.shop) {
          w.doing = e.line.replace(new RegExp(`^${w.name}\\s+`), "").replace(/\.$/, "");
        }
        break;
    }
  }

  private shopByName(name: unknown) {
    const n = String(name ?? "").toLowerCase();
    return Object.entries(SHOP).find(([, s]) => s.name.toLowerCase() === n || n.includes(s.name.toLowerCase().split(" ")[0]))?.[0];
  }

  private startPoll(question: string, now: number, replay: boolean) {
    const entries = Object.values(CITY);
    const figures: Figure[] = Array.from({ length: 7 }, (_, i) => {
      const from = entries[i % entries.length];
      const a = (i / 7) * Math.PI * 2;
      const to = { x: SPOT.square.x + Math.cos(a) * 30, y: SPOT.square.y + Math.sin(a) * 12 };
      return { from, to, start: now + i * 400, dur: replay || this.reduced ? 1 : 5000 + Math.random() * 3000, leaveAt: now + 60_000, out: entries[(i + 2) % entries.length], seed: Math.random() };
    });
    this.poll = { question: question.split("\n")[0], since: now, figures };
  }

  update(dt: number, now: number) {
    this.now = now;
    for (const w of this.walkers.values()) {
      if (w.to) this.step(w, dt);
      else if (w.away && now > w.dwellUntil) this.goHome(w);
      else if (!w.away && !w.shop && now > w.nextErrand) this.errand(w);
      else if (!w.away && !w.shop && now > w.nextWander && !this.reduced) {
        // A few steps around the house
        const a = Math.random() * Math.PI * 2;
        w.nextWander = Infinity;
        this.route(w, [{ to: { x: w.home.x + Math.cos(a) * 14, y: w.home.y + Math.sin(a) * 8 + 6 }, pace: 20, then: () => (w.nextWander = this.now + 5000 + Math.random() * 9000) }]);
      }
      if (w.speaking && now > w.speaking.until) w.speaking = null;
    }
    for (const c of this.couriers) this.step(c, dt);
    this.couriers = this.couriers.filter((c) => !c.done);
    for (const h of this.held) {
      if (now < h.releaseAt) continue;
      this.effects.push({ kind: "send", at: { x: SPOT.couriers.x, y: SPOT.couriers.y - 26 }, start: now, dur: 2200 });
    }
    this.held = this.held.filter((h) => now < h.releaseAt);
    this.effects = this.effects.filter((f) => now - f.start < f.dur);
    if (this.poll && now - this.poll.since > 70_000) this.poll = null;
    if (!this.reduced) {
      const fall = 0.6 + this.sky.snow * 0.6;
      for (const s of this.snow) {
        s.y += (s.v * fall * dt) / 1000;
        s.x += (this.sky.wind * (0.5 + s.r / 2) * dt) / 1000;
        s.sway += dt / 1400;
        if (s.y > H) {
          s.y = -4;
          s.x = Math.random() * W;
        }
        if (s.x > W + 8) s.x -= W + 16;
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // drawing (world units; the caller has applied the camera)
  // -------------------------------------------------------------------------------------------------------------

  /** Screen-constant scale for figures and text: stays readable however far the camera zooms out. */
  private k = 1;

  draw(ctx: CanvasRenderingContext2D, now: number, sky: Sky, hover: Hit | null, zoom = 1) {
    this.sky = sky;
    this.k = Math.max(1.3, 1.25 / zoom);
    if (!this.reduced) this.drawAmbient(ctx, now, sky);
    this.drawNotes(ctx, now);
    this.drawHeld(ctx);
    this.drawPoll(ctx, now);

    // Everyone on the map, back to front; two couriers wait by their door
    const walkers = [...this.walkers.values()].filter((w) => !w.shop);
    const bodies: { y: number; draw: () => void }[] = [
      ...walkers.map((w) => ({ y: w.pos.y, draw: () => this.drawWalker(ctx, w, now, hover?.kind === "resident" && hover.id === w.id) })),
      ...this.couriers.map((c) => ({ y: c.pos.y, draw: () => this.drawCourier(ctx, c.pos, c.carry, !!c.to, now, c.n) })),
      ...[-20, 22].map((dx, i) => {
        const p = { x: POST_DOOR.x + dx, y: POST_DOOR.y - 2 + i * 3 };
        return { y: p.y, draw: () => this.drawCourier(ctx, p, false, false, now, i) };
      }),
    ];
    bodies.sort((a, b) => a.y - b.y);
    for (const b of bodies) b.draw();

    // Night falls over the land, then the lights shine through it; dawn and dusk wash it warm
    if (sky.dark > 0) {
      ctx.fillStyle = `rgba(20, 32, 44, ${sky.dark})`;
      ctx.fillRect(0, 0, W, H);
      this.drawLights(ctx, now, sky.dark);
    }
    if (sky.tint) {
      ctx.fillStyle = `rgba(${sky.tint.rgb.join(",")}, ${sky.tint.a})`;
      ctx.fillRect(0, 0, W, H);
    }
    if (sky.fog > 0.02) this.drawFog(ctx, now, sky.fog);

    for (const f of this.effects) if (now >= f.start) this.drawEffect(ctx, f, now);
    for (const w of walkers) if (w.speaking || (hover?.kind === "resident" && hover.id === w.id)) this.drawLabel(ctx, w, hover?.kind === "resident" && hover.id === w.id);
    if (hover?.kind === "shop" && SHOP[hover.id]) this.drawTag(ctx, SHOP[hover.id].name, SHOP[hover.id].x, SHOP[hover.id].y - 26 * this.k);
    if (hover?.kind === "place") {
      const l = LANDMARKS.find((x) => x.id === hover.id);
      if (l) this.drawTag(ctx, l.name, l.at.x, l.at.y - l.r - 4 * this.k);
    }
    if (hover?.kind === "courier") {
      const c = this.courierAt(hover.id);
      if (c) this.drawTag(ctx, c.carry ? "A courier with a sealed proof" : "A courier", c.pos.x, c.pos.y - 22 * this.k);
    }
    this.drawSnow(ctx, sky.snow);
  }

  private drawWalker(ctx: CanvasRenderingContext2D, w: Walker, now: number, hovered: boolean) {
    const moving = !!w.to;
    const bob = moving ? Math.abs(Math.sin(now / 110 + hash01(w.id) * 6)) * 1.6 : 0;
    const { x, y } = w.pos;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(this.k, this.k);
    ctx.translate(-x, -y);
    ctx.fillStyle = "rgba(24,36,31,0.14)";
    ctx.beginPath();
    ctx.ellipse(x, y + 1, 5, 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = w.tint;
    ctx.beginPath();
    ctx.moveTo(x - 4.5, y);
    ctx.quadraticCurveTo(x - 4, y - 11 - bob, x, y - 11 - bob);
    ctx.quadraticCurveTo(x + 4, y - 11 - bob, x + 4.5, y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = HEAD;
    ctx.beginPath();
    ctx.arc(x, y - 14 - bob, 3.4, 0, Math.PI * 2);
    ctx.fill();
    if (hovered) {
      ctx.strokeStyle = COLORS.pine;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(x, y - 7, 11, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** A courier: slate cloak, a satchel strap, and the sealed envelope in hand while carrying one. */
  private drawCourier(ctx: CanvasRenderingContext2D, p: Pt, carry: boolean, moving: boolean, now: number, n: number) {
    const bob = moving ? Math.abs(Math.sin(now / 100 + n)) * 1.5 : 0;
    const k = this.k * 0.9;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(k, k);
    ctx.fillStyle = "rgba(24,36,31,0.14)";
    ctx.beginPath();
    ctx.ellipse(0, 1, 5, 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.slate;
    ctx.beginPath();
    ctx.moveTo(-4.5, 0);
    ctx.quadraticCurveTo(-4, -11 - bob, 0, -11 - bob);
    ctx.quadraticCurveTo(4, -11 - bob, 4.5, 0);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#D8CFB8";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-3, -9 - bob);
    ctx.lineTo(3.5, -2);
    ctx.stroke();
    ctx.fillStyle = HEAD;
    ctx.beginPath();
    ctx.arc(0, -14 - bob, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.pine;
    ctx.fillRect(-3.4, -17.6 - bob, 6.8, 1.8);
    if (carry) envelope(ctx, 6, -7 - bob, 0.8);
    ctx.restore();
  }

  private drawLabel(ctx: CanvasRenderingContext2D, w: Walker, hovered: boolean) {
    // A told moment happened a while ago, so only the offline scripted day says "just"
    const now = w.doing ?? (w.last && !w.last.when ? `just ${w.last.gist}` : "at home");
    const said = w.speaking?.text ?? "";
    const text = w.speaking && !hovered ? (said.startsWith(w.name) ? said : `${w.name}: ${said}`) : `${w.name} · ${now}`;
    this.drawTag(ctx, text, w.pos.x, w.pos.y - 22 * this.k);
  }

  private drawTag(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, alpha = 1) {
    // Drawn in screen-sized units so tags stay legible at any zoom
    const u = this.k / 1.3;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.scale(u, u);
    ctx.font = "12px 'IBM Plex Sans', system-ui, sans-serif";
    const width = Math.min(ctx.measureText(text).width, 280) + 14;
    ctx.fillStyle = "rgba(236,240,236,0.95)";
    ctx.strokeStyle = COLORS.frost;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(-width / 2, -16, width, 21, 5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = COLORS.pine;
    ctx.textAlign = "center";
    ctx.fillText(text, 0, -1, 278);
    ctx.restore();
  }

  private drawNotes(ctx: CanvasRenderingContext2D, now: number) {
    for (const n of this.notes) {
      const a = n.born ? Math.min(1, (now - n.born) / 800) : 1;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(n.x + 4, n.y + 4);
      ctx.rotate(n.rot);
      ctx.fillStyle = "#FBF8EF";
      ctx.fillRect(-4, -4, 9, 9);
      ctx.fillStyle = COLORS.frost;
      ctx.fillRect(-2.5, -1.5, 6, 1);
      ctx.fillRect(-2.5, 1, 4, 1);
      ctx.restore();
    }
  }

  /** Sealed proofs waiting at the couriers' post, stacked by the door. */
  private drawHeld(ctx: CanvasRenderingContext2D) {
    for (let i = 0; i < this.held.length; i++) envelope(ctx, SPOT.couriers.x - 6 + (i % 4) * 4, SPOT.couriers.y + 2 - Math.floor(i / 4) * 3, 0.55);
  }

  private drawPoll(ctx: CanvasRenderingContext2D, now: number) {
    if (!this.poll) return;
    const p = this.poll;
    // A slate standard in the square, and neighbours gathering around it
    ctx.fillStyle = COLORS.roof;
    ctx.fillRect(SPOT.square.x - 1, SPOT.square.y - 34, 2, 34);
    ctx.fillStyle = COLORS.slate;
    ctx.fillRect(SPOT.square.x + 1, SPOT.square.y - 34, 16, 10);
    for (const f of p.figures) {
      const leaving = now > f.leaveAt;
      const t = leaving ? Math.min(1, (now - f.leaveAt) / f.dur) : Math.max(0, Math.min(1, (now - f.start) / f.dur));
      const pos = leaving ? along(f.to, f.out, ease(t), 0.12) : along(f.from, f.to, ease(t), 0.12);
      if (leaving && t >= 1) continue;
      const bob = t > 0 && t < 1 ? Math.abs(Math.sin(now / 120 + f.seed * 6)) * 1.4 : 0;
      ctx.fillStyle = "#8E998F";
      ctx.beginPath();
      ctx.moveTo(pos.x - 3.5, pos.y);
      ctx.quadraticCurveTo(pos.x, pos.y - 10 - bob, pos.x + 3.5, pos.y);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(pos.x, pos.y - 12 - bob, 2.8, 0, Math.PI * 2);
      ctx.fill();
    }
    if (now - p.since < 15_000) this.drawTag(ctx, p.question, SPOT.square.x, SPOT.square.y - 44);
  }

  private glow(ctx: CanvasRenderingContext2D, at: Pt, r: number, color: string, alpha: number) {
    if (alpha <= 0.005) return;
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(sprite(color), at.x - r, at.y - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
  }

  private drawLights(ctx: CanvasRenderingContext2D, now: number, dark: number) {
    const strength = Math.min(1, dark / 0.4);
    for (const w of this.walkers.values()) {
      if (w.shop) {
        const s = SHOP[w.id];
        if (s) this.glow(ctx, { x: s.x, y: s.y - 10 }, 22, COLORS.candle, 0.35 * strength);
        continue;
      }
      // Windows glow when someone is home
      if (!w.away) for (const p of windowsOf(w.home)) this.glow(ctx, p, 9, COLORS.candle, 0.55 * strength);
    }
    for (const l of LAMPS) this.glow(ctx, { x: l.x, y: l.y - 1 }, 12, COLORS.candle, (0.5 + Math.sin(now / 900 + l.x) * 0.06) * strength);
    for (const t of TRUCKS) this.glow(ctx, { x: t.x - 6, y: t.y - 9 }, 14, COLORS.candle, 0.4 * strength);
    this.glow(ctx, SPOT.archive, 26, COLORS.slate, 0.35 * strength);
    this.glow(ctx, SPOT.toll, 12, COLORS.candle, 0.4 * strength);
    this.glow(ctx, { x: SPOT.silverchat.x, y: SPOT.silverchat.y - 20 }, 16, COLORS.candle, 0.35 * strength);
  }

  /** Mist: soft banks drifting across the valleys. */
  private drawFog(ctx: CanvasRenderingContext2D, now: number, fog: number) {
    ctx.fillStyle = `rgba(236,240,236,${(fog * 0.22).toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
    const s = sprite("#F4F6F4");
    ctx.globalAlpha = Math.min(1, fog * 0.7);
    for (let i = 0; i < 7; i++) {
      const span = W + 700;
      const x = ((i * 331 + now * 0.004 * (1 + (i % 3))) % span) - 350;
      const y = 140 + i * 105;
      ctx.drawImage(s, x - 260, y - 60, 520, 120);
    }
    ctx.globalAlpha = 1;
  }

  private drawEffect(ctx: CanvasRenderingContext2D, f: Effect, now: number) {
    const t = Math.min(1, (now - f.start) / f.dur);
    switch (f.kind) {
      case "pad": {
        // The green circle on the table lights up: payment succeeded
        const a = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
        this.glow(ctx, f.at, 26, COLORS.pad, 0.55 * a);
        ctx.strokeStyle = hexA(COLORS.pad, a);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(f.at.x, f.at.y, 5 + t * 18, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = hexA(COLORS.pad, a);
        ctx.beginPath();
        ctx.arc(f.at.x, f.at.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case "sparks": {
        // Coins burned: a small flame and gold sparks
        const a = 1 - t;
        const s = f.size;
        this.glow(ctx, f.at, 18 * s, COLORS.candle, 0.6 * a);
        ctx.fillStyle = hexA(COLORS.candle, a);
        ctx.beginPath();
        const flick = Math.sin(now / 60) * 1.5 * s;
        ctx.moveTo(f.at.x - 3 * s, f.at.y);
        ctx.quadraticCurveTo(f.at.x + flick, f.at.y - 14 * s, f.at.x + 3 * s, f.at.y);
        ctx.fill();
        for (const sd of f.seeds) {
          const ang = -Math.PI / 2 + (sd - 0.5) * 2.2;
          const d = (4 + t * 26 * (0.5 + sd)) * s;
          ctx.fillStyle = hexA("#F2C84B", a * (0.4 + sd * 0.6));
          ctx.fillRect(f.at.x + Math.cos(ang) * d, f.at.y + Math.sin(ang) * d + t * t * 10 * s, 1.6, 1.6);
        }
        break;
      }
      case "lantern": {
        // Words carried by a burn: a lantern rising over the roofs
        const y = f.at.y - 20 - ease(t) * 150;
        const x = f.at.x + Math.sin(t * 6) * 6 + f.drift * t;
        const a = t > 0.8 ? (1 - t) / 0.2 : 1;
        this.glow(ctx, { x, y }, 20, COLORS.candle, 0.5 * a);
        ctx.fillStyle = hexA("#F4D27A", a);
        ctx.beginPath();
        ctx.roundRect(x - 4, y - 6, 8, 10, 2);
        ctx.fill();
        break;
      }
      case "light": {
        // Value moving privately: a travelling light, never a coin on the road
        const p = along(f.from, f.to, ease(t), f.bend);
        const r = f.r;
        for (let k = 1; k < 6; k++) {
          const q = along(f.from, f.to, ease(Math.max(0, t - k * 0.02)), f.bend);
          this.glow(ctx, q, r * (0.5 - k * 0.06), f.color, 0.35 - k * 0.05);
        }
        this.glow(ctx, p, r, f.color, 0.6);
        if (t > 0.92) this.glow(ctx, f.to, r * 1.7, f.color, ((1 - t) / 0.08) * 0.5);
        break;
      }
      case "shimmer":
        this.glow(ctx, { x: f.at.x, y: f.at.y - 8 }, 20 + t * 10, COLORS.pad, 0.35 * (1 - t));
        break;
      case "pulse":
        ctx.strokeStyle = hexA(f.color, 1 - t);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(f.at.x, f.at.y, 10 + t * 40, 5 + t * 16, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case "chip": {
        const a = t < 0.1 ? t / 0.1 : t > 0.75 ? (1 - t) / 0.25 : 1;
        this.drawTag(ctx, f.text, f.at.x, f.at.y - ease(t) * 14, a);
        break;
      }
      case "door": {
        // The door opens a crack: warm light spilling onto the snow
        const a = t < 0.2 ? t / 0.2 : 1 - (t - 0.2) / 0.8;
        this.glow(ctx, { x: f.at.x, y: f.at.y + 4 }, 14, COLORS.candle, 0.5 * a);
        ctx.fillStyle = hexA("#F4D27A", a);
        ctx.fillRect(f.at.x - 2, f.at.y - 4, 4, 7);
        break;
      }
      case "send": {
        // A held proof goes out: a slate spark rising from the post into the sky
        const y = f.at.y - ease(t) * 70;
        this.glow(ctx, { x: f.at.x, y }, 10, COLORS.slate, 0.7 * (1 - t));
        ctx.strokeStyle = hexA(COLORS.slate, 0.5 * (1 - t));
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(f.at.x, f.at.y);
        ctx.lineTo(f.at.x, y);
        ctx.stroke();
        break;
      }
    }
  }

  /** Small signs of life: smoke from lived-in chimneys and the trucks, light on the sea, birds over the mountain. */
  private drawAmbient(ctx: CanvasRenderingContext2D, now: number, sky: Sky) {
    const lean = sky.wind * 0.9;
    const smoke = (x: number, y: number, seed: number, dense = 0.28) => {
      for (let i = 0; i < 4; i++) {
        const t = (now / 2600 + i / 4 + seed) % 1;
        const sx = x + Math.sin(t * 5 + i) * 3 + t * (8 + lean);
        const sy = y - t * 26;
        ctx.fillStyle = `rgba(142,153,143,${(dense * (1 - t)).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(sx, sy, 2 + t * 4, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    for (const w of this.walkers.values()) {
      if (w.shop) {
        const s = SHOP[w.id];
        if (s?.kind !== "store") smoke(s.x - 8, s.y - 24, hash01(w.id), 0.2);
        continue;
      }
      if (!w.away) smoke(w.home.x + 6, w.home.y - 22, hash01(w.id));
    }
    const hour = new Date().getHours();
    if (hour >= 10 && hour < 23) for (const [i, t] of TRUCKS.entries()) smoke(t.x - 4, t.y - 16, i * 0.31, 0.18);
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 7; i++) {
      const x = ((now / 90 + i * 83) % 520) - 10;
      const y = 835 + (i % 3) * 16 + Math.sin(now / 700 + i) * 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 12, y);
      ctx.stroke();
    }
    if (sky.dark > 0.3 || sky.weather === "blowing") return;
    ctx.strokeStyle = "rgba(24,36,31,0.45)";
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 4; i++) {
      const t = (now / 18000 + i * 0.23) % 1;
      const x = 380 + t * 520;
      const y = 70 + Math.sin(t * 9 + i) * 18 + i * 9;
      const flap = Math.sin(now / 160 + i * 2) * 3;
      ctx.beginPath();
      ctx.moveTo(x - 5, y - flap);
      ctx.quadraticCurveTo(x - 2, y - 2, x, y);
      ctx.quadraticCurveTo(x + 2, y - 2, x + 5, y - flap);
      ctx.stroke();
    }
  }

  private drawSnow(ctx: CanvasRenderingContext2D, amount: number) {
    const n = Math.round(this.snow.length * amount);
    if (!n) return;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const s = this.snow[i];
      const x = s.x + Math.sin(s.sway) * 6;
      ctx.moveTo(x + s.r, s.y);
      ctx.arc(x, s.y, s.r, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  // -------------------------------------------------------------------------------------------------------------
  // reading the world, for hover and the card
  // -------------------------------------------------------------------------------------------------------------

  private courierAt(id: string) {
    const [where, n] = id.split(":");
    if (where === "door") {
      const i = Number(n);
      return { pos: { x: POST_DOOR.x + (i ? 22 : -20), y: POST_DOOR.y - 2 + i * 3 }, carry: false };
    }
    return this.couriers.find((c) => String(c.n) === n) ?? null;
  }

  /** What is under a world point: a resident, a courier, a shop, or a landmark. */
  hit(p: Pt): Hit | null {
    const reach = 9 * this.k;
    let best: Hit | null = null;
    let bestD = Infinity;
    const consider = (h: Hit, at: Pt, r: number) => {
      const d = dist(at, p);
      if (d < r && d < bestD) {
        best = h;
        bestD = d;
      }
    };
    for (const w of this.walkers.values()) {
      if (w.shop) continue;
      consider({ kind: "resident", id: w.id }, { x: w.pos.x, y: w.pos.y - 7 * this.k }, reach);
    }
    for (const c of this.couriers) consider({ kind: "courier", id: `road:${c.n}` }, { x: c.pos.x, y: c.pos.y - 7 * this.k }, reach);
    for (const i of [0, 1]) {
      const c = this.courierAt(`door:${i}`)!;
      consider({ kind: "courier", id: `door:${i}` }, { x: c.pos.x, y: c.pos.y - 7 * this.k }, reach);
    }
    if (best) return best;
    for (const w of this.walkers.values()) {
      const s = SHOP[w.id];
      if (w.shop && s) consider({ kind: "shop", id: w.id }, { x: s.x, y: s.y - 8 }, 22);
    }
    if (best) return best;
    for (const l of LANDMARKS) consider({ kind: "place", id: l.id }, l.at, l.r);
    return best;
  }

  /** What a resident is up to, for the card. */
  status(id: string) {
    const w = this.walkers.get(id);
    if (!w) return null;
    return { doing: w.doing, last: w.last, speaking: w.speaking?.text ?? null, home: !w.away };
  }

  /** Where a resident is now, in world units (for following them). */
  where(id: string): Pt | null {
    return this.walkers.get(id)?.pos ?? null;
  }
}

function seeds(n: number) {
  return Array.from({ length: n }, () => Math.random());
}

function hexA(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, a))})`;
}
