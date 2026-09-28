/**
 * The living layer of Veridia: residents walking, lights and signs where things happen, snow, and night.
 *
 * Driven only by the public story feed. The animation never shows more than the story says: anonymous posts and
 * poll answers appear without anyone walking to them, and private payments light a shop's pad, not an amount.
 */
import type { Resident, WorldEvent } from "@/lib/veridia";

import { along, CITY, COLORS, hash01, homeOf, SHOP, SPOT, TRUCKS, W, H, windowsOf, type Pt } from "./scene";

type Walker = {
  id: string;
  name: string;
  shop: boolean;
  home: Pt;
  pos: Pt;
  from: Pt;
  to: Pt | null;
  t: number;
  dur: number;
  bend: number;
  onArrive: (() => void) | null;
  dwellUntil: number;
  nextWander: number;
  tint: string;
  speaking: { text: string; until: number } | null;
  away: boolean;
};

type Effect =
  | { kind: "pad"; at: Pt; start: number; dur: number }
  | { kind: "sparks"; at: Pt; start: number; dur: number; seeds: number[] }
  | { kind: "lantern"; at: Pt; start: number; dur: number; drift: number }
  | { kind: "light"; from: Pt; to: Pt; start: number; dur: number; bend: number }
  | { kind: "shimmer"; at: Pt; start: number; dur: number }
  | { kind: "pulse"; at: Pt; start: number; dur: number; color: string };

type Figure = { from: Pt; to: Pt; start: number; dur: number; leaveAt: number; out: Pt; seed: number };

const TINTS = [COLORS.slate, COLORS.pad, "#7A5C8E", COLORS.candle, "#9A5B4A", COLORS.lichen];
const HEAD = "#E8DCCB";

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** How dark it is, from the viewer's local time: 0 at midday, ~0.55 in the small hours. */
export function darkness(d = new Date()) {
  const h = d.getHours() + d.getMinutes() / 60;
  const night = h < 6 || h >= 21 ? 1 : h < 8 ? 1 - (h - 6) / 2 : h >= 18.5 ? (h - 18.5) / 2.5 : 0;
  return Math.max(0, Math.min(1, night)) * 0.55;
}

export class Veridia {
  walkers = new Map<string, Walker>();
  effects: Effect[] = [];
  notes: { x: number; y: number; rot: number; born: number }[] = [];
  poll: { question: string; since: number; figures: Figure[] } | null = null;
  snow: { x: number; y: number; r: number; v: number; sway: number }[] = [];
  byName = new Map<string, string>();

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
        onArrive: null,
        dwellUntil: 0,
        nextWander: 2000 + hash01(r.id, 3) * 6000,
        tint: TINTS[Math.floor(hash01(r.id, 11) * TINTS.length)],
        speaking: null,
        away: false,
      });
    }
    for (let i = 0; i < (reduced ? 0 : 260); i++) {
      this.snow.push({ x: Math.random() * W, y: Math.random() * H, r: 0.6 + Math.random() * 1.6, v: 8 + Math.random() * 18, sway: Math.random() * Math.PI * 2 });
    }
  }

  private walk(w: Walker, to: Pt, now: number, onArrive: (() => void) | null = null) {
    w.from = { ...w.pos };
    w.to = to;
    w.t = 0;
    // Crossing the map takes ~12s: long enough to follow, short enough to keep up with the story
    w.dur = this.reduced ? 1 : Math.max(1500, dist(w.pos, to) * 9);
    w.bend = (hash01(w.id + now, 5) - 0.5) * 0.3;
    w.onArrive = onArrive;
    w.away = true;
  }

  private shopByName(name: unknown) {
    const n = String(name ?? "").toLowerCase();
    return Object.entries(SHOP).find(([, s]) => s.name.toLowerCase() === n || n.includes(s.name.toLowerCase().split(" ")[0]))?.[0];
  }

  private say(w: Walker, text: string, now: number) {
    w.speaking = { text: text.length > 90 ? `${text.slice(0, 88)}…` : text, until: now + 6000 };
  }

  /**
   * Turns one story event into motion. `replay` events (the backlog on first load) only restore lasting state, so
   * the page doesn't open with every past event firing at once.
   */
  ingest(e: WorldEvent, now: number, replay: boolean) {
    const w = this.walkers.get(e.who);
    const d = e.detail ?? {};
    if (d.why) return; // the resident thought better of it; nothing happened
    if (e.action === "post") {
      this.notes.push({ x: SPOT.board.x - 1 + (this.notes.length % 4) * 10, y: SPOT.board.y - 25 + Math.floor((this.notes.length % 8) / 4) * 11, rot: (hash01(String(e.at)) - 0.5) * 0.5, born: replay ? 0 : now });
      if (this.notes.length > 8) this.notes.shift();
      if (!replay) this.effects.push({ kind: "pulse", at: { x: SPOT.board.x + 19, y: SPOT.board.y - 15 }, start: now, dur: 2500, color: COLORS.slate });
      return;
    }
    if (e.action === "poll") {
      this.startPoll(String(d.question ?? e.line), now, replay);
      return;
    }
    if (e.action === "vote") {
      if (!replay) this.effects.push({ kind: "pulse", at: SPOT.square, start: now, dur: 2200, color: COLORS.slate });
      return;
    }
    if (replay || !w) return;

    switch (e.action) {
      case "eat": {
        const shopId = this.shopByName(d.shop);
        if (!shopId) return;
        const shop = SHOP[shopId];
        const door = { x: shop.x + (hash01(e.who) - 0.5) * 14, y: shop.y + 16 };
        this.say(w, e.line, now);
        this.walk(w, door, now, () => {
          this.effects.push({ kind: "pad", at: { x: shop.x, y: shop.y - 8 }, start: performance.now(), dur: 3500 });
          w.dwellUntil = performance.now() + 4500;
        });
        break;
      }
      case "knock": {
        const target = this.walkers.get(this.byName.get(String(d.door ?? "").toLowerCase()) ?? "");
        if (!target) return;
        this.say(w, e.line, now);
        this.walk(w, { x: target.home.x + 9, y: target.home.y + 4 }, now, () => {
          this.effects.push({ kind: "sparks", at: { x: target.home.x, y: target.home.y - 4 }, start: performance.now(), dur: 4200, seeds: Array.from({ length: 18 }, () => Math.random()) });
          w.dwellUntil = performance.now() + 3500;
        });
        break;
      }
      case "speak":
        this.say(w, e.line, now);
        this.effects.push({ kind: "lantern", at: { ...w.pos }, start: now, dur: 7000, drift: (Math.random() - 0.5) * 40 });
        break;
      case "allowance": {
        const to = this.walkers.get(this.byName.get(String(d.to ?? "").toLowerCase()) ?? "");
        if (!to) return;
        this.say(w, e.line, now);
        this.effects.push({ kind: "light", from: { ...w.home }, to: { ...to.home }, start: now, dur: this.reduced ? 1 : Math.max(2000, dist(w.home, to.home) * 5), bend: 0.2 });
        break;
      }
      case "zip":
        this.effects.push({ kind: "shimmer", at: { ...w.home }, start: now, dur: 3000 });
        break;
      case "rest":
        if (/kalimar|walk/i.test(e.line) && !w.shop) {
          this.say(w, e.line, now);
          this.walk(w, { x: 400 + hash01(e.who + now) * 180, y: 500 + hash01(e.who, now) * 60 }, now, () => (w.dwellUntil = performance.now() + 5000));
        }
        break;
    }
  }

  private startPoll(question: string, now: number, replay: boolean) {
    const entries = Object.values(CITY);
    const figures: Figure[] = Array.from({ length: 7 }, (_, i) => {
      const from = entries[i % entries.length];
      const a = (i / 7) * Math.PI * 2;
      const to = { x: SPOT.square.x + Math.cos(a) * 30, y: SPOT.square.y + Math.sin(a) * 12 };
      return { from, to, start: now + i * 400, dur: replay ? 1 : 5000 + Math.random() * 3000, leaveAt: now + 60_000, out: entries[(i + 2) % entries.length], seed: Math.random() };
    });
    this.poll = { question: question.split("\n")[0], since: now, figures };
  }

  update(dt: number, now: number) {
    for (const w of this.walkers.values()) {
      if (w.to) {
        w.t = Math.min(1, w.t + dt / w.dur);
        const p = along(w.from, w.to, ease(w.t), w.bend);
        w.pos = p;
        if (w.t >= 1) {
          const done = w.onArrive;
          const reachedHome = dist(w.to, w.home) < 2;
          w.to = null;
          w.onArrive = null;
          if (reachedHome) w.away = false;
          done?.();
        }
      } else if (w.away && now > w.dwellUntil) {
        this.walk(w, w.home, now);
      } else if (!w.away && !w.shop && now > w.nextWander && !this.reduced) {
        // Idle life: a few steps around the house
        const a = Math.random() * Math.PI * 2;
        w.from = { ...w.pos };
        w.to = { x: w.home.x + Math.cos(a) * 14, y: w.home.y + Math.sin(a) * 8 + 6 };
        w.t = 0;
        w.dur = 2600;
        w.bend = 0;
        w.onArrive = () => (w.nextWander = performance.now() + 5000 + Math.random() * 9000);
        w.nextWander = Infinity;
      }
      if (w.speaking && now > w.speaking.until) w.speaking = null;
    }
    this.effects = this.effects.filter((f) => now - f.start < f.dur);
    if (this.poll && now - this.poll.since > 70_000) this.poll = null;
    for (const s of this.snow) {
      s.y += (s.v * dt) / 1000;
      s.sway += dt / 1400;
      if (s.y > H) {
        s.y = -4;
        s.x = Math.random() * W;
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // drawing (world units; the caller has applied the camera)
  // -------------------------------------------------------------------------------------------------------------

  /** Screen-constant scale for figures and text: stays readable however far the camera zooms out. */
  private k = 1;

  draw(ctx: CanvasRenderingContext2D, now: number, dark: number, hover: string | null, zoom = 1) {
    this.k = Math.max(1.3, 1.25 / zoom);
    if (!this.reduced) this.drawAmbient(ctx, now);
    this.drawNotes(ctx, now);
    this.drawPoll(ctx, now);

    const walkers = [...this.walkers.values()].filter((w) => !w.shop).sort((a, b) => a.pos.y - b.pos.y);
    for (const w of walkers) this.drawWalker(ctx, w, now, hover === w.id);

    // Night falls over the land, then the lights shine through it
    if (dark > 0) {
      ctx.fillStyle = `rgba(20, 32, 44, ${dark})`;
      ctx.fillRect(0, 0, W, H);
      this.drawLights(ctx, now, dark);
    }
    for (const f of this.effects) this.drawEffect(ctx, f, now);
    for (const w of walkers) if (w.speaking || hover === w.id) this.drawLabel(ctx, w, hover === w.id);
    for (const [id, s] of Object.entries(SHOP)) if (hover === id) this.drawTag(ctx, s.name, s.x, s.y - 26 * this.k);
    this.drawSnow(ctx);
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

  private drawLabel(ctx: CanvasRenderingContext2D, w: Walker, hovered: boolean) {
    const text = hovered && !w.speaking ? w.name : w.speaking ? `${w.name}: ${w.speaking.text}` : w.name;
    this.drawTag(ctx, text, w.pos.x, w.pos.y - 22 * this.k);
  }

  private drawTag(ctx: CanvasRenderingContext2D, text: string, x: number, y: number) {
    // Drawn in screen-sized units so tags stay legible at any zoom
    const u = this.k / 1.3;
    ctx.save();
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
    const g = ctx.createRadialGradient(at.x, at.y, 0, at.x, at.y, r);
    g.addColorStop(0, hexA(color, alpha));
    g.addColorStop(1, hexA(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawLights(ctx: CanvasRenderingContext2D, now: number, dark: number) {
    const strength = Math.min(1, dark / 0.4);
    for (const w of this.walkers.values()) {
      if (w.shop) {
        const s = SHOP[w.id];
        this.glow(ctx, { x: s.x, y: s.y - 10 }, 22, COLORS.candle, 0.35 * strength);
        continue;
      }
      // Windows glow when someone is home
      if (!w.away) for (const p of windowsOf(w.home)) this.glow(ctx, p, 9, COLORS.candle, 0.55 * strength);
    }
    for (const t of TRUCKS) this.glow(ctx, { x: t.x - 6, y: t.y - 9 }, 14, COLORS.candle, 0.4 * strength);
    this.glow(ctx, SPOT.archive, 26, COLORS.slate, 0.35 * strength);
    this.glow(ctx, SPOT.toll, 12, COLORS.candle, 0.4 * strength);
  }

  private drawEffect(ctx: CanvasRenderingContext2D, f: Effect, now: number) {
    const t = (now - f.start) / f.dur;
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
        // Coins burned at a door: a small flame and gold sparks
        const a = 1 - t;
        this.glow(ctx, f.at, 18, COLORS.candle, 0.6 * a);
        ctx.fillStyle = hexA(COLORS.candle, a);
        ctx.beginPath();
        const flick = Math.sin(now / 60) * 1.5;
        ctx.moveTo(f.at.x - 3, f.at.y);
        ctx.quadraticCurveTo(f.at.x + flick, f.at.y - 14, f.at.x + 3, f.at.y);
        ctx.fill();
        for (const s of f.seeds) {
          const ang = -Math.PI / 2 + (s - 0.5) * 2.2;
          const d = 4 + t * 26 * (0.5 + s);
          ctx.fillStyle = hexA("#F2C84B", a * (0.4 + s * 0.6));
          ctx.fillRect(f.at.x + Math.cos(ang) * d, f.at.y + Math.sin(ang) * d + t * t * 10, 1.6, 1.6);
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
        // A private allowance: light travelling home to home, never touching the road's wallets
        const p = along(f.from, f.to, ease(t), f.bend);
        for (let k = 0; k < 6; k++) {
          const q = along(f.from, f.to, ease(Math.max(0, t - k * 0.02)), f.bend);
          this.glow(ctx, q, 7 - k, COLORS.pad, 0.35 - k * 0.05);
        }
        this.glow(ctx, p, 14, COLORS.pad, 0.6);
        if (t > 0.92) this.glow(ctx, f.to, 24, COLORS.pad, (1 - t) / 0.08 * 0.5);
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
    }
  }

  /** Small signs of life: smoke from lived-in chimneys, light on the sea, birds over the mountain. */
  private drawAmbient(ctx: CanvasRenderingContext2D, now: number) {
    for (const w of this.walkers.values()) {
      if (w.shop || w.away) continue;
      for (let i = 0; i < 4; i++) {
        const t = ((now / 2600 + i / 4 + hash01(w.id)) % 1);
        const x = w.home.x + 6 + Math.sin(t * 5 + i) * 3 + t * 8;
        const y = w.home.y - 22 - t * 26;
        ctx.fillStyle = `rgba(142,153,143,${(0.28 * (1 - t)).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(x, y, 2 + t * 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
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

  private drawSnow(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    for (const s of this.snow) {
      ctx.beginPath();
      ctx.arc(s.x + Math.sin(s.sway) * 6, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** The resident (or shop) under a world point, for hover and clicks. */
  hit(p: Pt): string | null {
    let best: string | null = null;
    let bestD = 16;
    for (const w of this.walkers.values()) {
      const at = w.shop ? { x: SHOP[w.id]?.x ?? w.home.x, y: (SHOP[w.id]?.y ?? w.home.y) - 8 } : { x: w.pos.x, y: w.pos.y - 8 };
      const d = dist(at, p);
      if (d < (w.shop ? 22 : bestD)) {
        best = w.id;
        bestD = d;
      }
    }
    return best;
  }
}

function hexA(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, a))})`;
}

export { lerp };
