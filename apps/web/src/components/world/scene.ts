/**
 * Veridia's geography and its static painting. Everything here is drawn once into an offscreen canvas; the living
 * layer (residents, lights, snow) is drawn over it every frame by sim.ts.
 *
 * World units: a 1600 × 900 map. Places follow the novel: Meldan's stone houses and Kalimar forest paths, the sky
 * bridge and tunnel into the mountain with the archive node, Sadzu Du's food courts on Len Su street, Dzego's food
 * trucks, Freetown's shelters and toll roads, and Greater Plum Harbor by the water.
 */

export const W = 1600;
export const H = 900;

export type Pt = { x: number; y: number };

export const COLORS = {
  snow: "#ECF0EC",
  drift: "#E1E7E2",
  pine: "#18241F",
  lichen: "#6E7A70",
  frost: "#C9D3CB",
  pad: "#22A866",
  candle: "#D6A01E",
  slate: "#496789",
  stone: "#B9C2BA",
  stoneDark: "#8E998F",
  roof: "#5B6B61",
  water: "#C3D2D6",
  waterDeep: "#A9BFC5",
  road: "#D5DCD6",
};

/** City centers, used to seat homes and label places. */
export const CITY: Record<string, Pt & { label: string }> = {
  Meldan: { x: 430, y: 390, label: "Meldan" },
  "Sadzu Du": { x: 1090, y: 250, label: "Sadzu Du" },
  Dzego: { x: 1345, y: 455, label: "Dzego" },
  Freetown: { x: 1050, y: 655, label: "Freetown" },
  "Greater Plum Harbor": { x: 255, y: 735, label: "Greater Plum Harbor" },
};

/** Named spots where things happen. */
export const SPOT = {
  archive: { x: 620, y: 205 },
  tunnel: { x: 575, y: 232 },
  board: { x: 350, y: 322 },
  square: { x: 975, y: 590 },
  toll: { x: 820, y: 590 },
  /** The couriers' post: sealed proofs are carried here and held a while before they are sent */
  couriers: { x: 885, y: 548 },
  silverchat: { x: 1232, y: 628 },
  school: { x: 195, y: 745 },
  lessons: { x: 150, y: 706 },
  pier: { x: 262, y: 792 },
  skyBridge: { x: 505, y: 268 },
  lenSu: { x: 1060, y: 282 },
  ballot: { x: 1006, y: 584 },
} satisfies Record<string, Pt>;

/** Shops, keyed by the resident id that runs them and matched to the shop name the story uses. */
export const SHOP: Record<string, Pt & { name: string; kind: "court" | "kitchen" | "truck" | "store" }> = {
  "beautiful-plants": { x: 1115, y: 262, name: "Beautiful Plants food court", kind: "court" },
  "kalimar-kitchen": { x: 505, y: 432, name: "Kalimar Kitchen", kind: "kitchen" },
  hydrafill: { x: 1142, y: 680, name: "Hydrafill", kind: "store" },
};

/** Dzego's food trucks (Number Ten), decorative stops where Zei hangs around. */
export const TRUCKS: Pt[] = [
  { x: 1300, y: 470 },
  { x: 1360, y: 492 },
  { x: 1402, y: 448 },
];

/** The forest path through Kalimar, sampled from the painted curve so walkers can follow it. */
export const FOREST_PATH: Pt[] = Array.from({ length: 9 }, (_, i) => {
  const t = i / 8;
  const u = 1 - t;
  return {
    x: u * u * u * 430 + 3 * u * u * t * 400 + 3 * u * t * t * 520 + t * t * t * 480,
    y: u * u * u * 440 + 3 * u * u * t * 500 + 3 * u * t * t * 520 + t * t * t * 585,
  };
});

/** Lamps and lanterns that glow from dusk to dawn: the forest path, Len Su street, the pier, the couriers' post. */
export const LAMPS: Pt[] = [
  ...[2, 4, 6].map((i) => ({ x: FOREST_PATH[i].x + 7, y: FOREST_PATH[i].y - 12 })),
  ...[0, 1, 2, 3].map((i) => ({ x: 1022 + i * 48, y: 268 - i * 14 })),
  { x: 314, y: 808 },
  { x: SPOT.couriers.x + 19, y: SPOT.couriers.y - 12 },
];

/** Places a visitor can hover or tap for a word about what happens there. */
export const LANDMARKS: { id: string; at: Pt; r: number; name: string; note: string }[] = [
  { id: "archive", at: SPOT.archive, r: 24, name: "The archive node", note: "A digital archive inside the mountain. People burn zipcoins to point each other to what is kept here." },
  { id: "board", at: { x: SPOT.board.x + 19, y: SPOT.board.y - 14 }, r: 26, name: "The board", note: "Badge holders post here without signing. The proof says a member wrote it, never which one." },
  { id: "square", at: SPOT.square, r: 34, name: "Freetown's square", note: "Where a poll gathers people. Everyone with a badge can answer once, and nobody learns who answered what." },
  {
    id: "couriers",
    at: { x: SPOT.couriers.x, y: SPOT.couriers.y - 12 },
    r: 22,
    name: "The couriers' post",
    note: "Couriers carry sealed proofs and hold each one a while before sending it, so the timing gives nobody away. Part of every sales tax pays them.",
  },
  { id: "toll", at: { x: SPOT.toll.x, y: SPOT.toll.y - 12 }, r: 18, name: "Freetown's toll road", note: "The busiest road on the map, with its toll gate." },
  { id: "skyBridge", at: SPOT.skyBridge, r: 24, name: "The sky bridge", note: "From Meldan up to the mountain shoulder and the tunnel to the archive." },
  { id: "forest", at: FOREST_PATH[4], r: 40, name: "Kalimar forest", note: "Pine paths south of Meldan. Gladias walks them most evenings." },
  { id: "lenSu", at: SPOT.lenSu, r: 22, name: "Len Su street", note: "Sadzu Du's street of food courts. Pay at the green circle; only you and the court know what you ordered." },
  { id: "trucks", at: { x: 1350, y: 470 }, r: 40, name: "Dzego's food trucks", note: "Where Number Ten comes from, if you ask Zei." },
  { id: "school", at: { x: SPOT.school.x, y: SPOT.school.y - 10 }, r: 24, name: "The harbor school", note: "The schools are full, so the kids of Greater Plum Harbor take informal lessons together." },
  { id: "silverchat", at: { x: SPOT.silverchat.x, y: SPOT.silverchat.y - 14 }, r: 22, name: "Silverchat", note: "Evelor's company, which publishes a proof of every algorithm change." },
];

/** Roads between places: polylines in world units, also the paths light and walkers follow. */
export const ROADS: Pt[][] = [
  [CITY.Meldan, { x: 620, y: 330 }, { x: 860, y: 260 }, CITY["Sadzu Du"]],
  [CITY["Sadzu Du"], { x: 1240, y: 330 }, CITY.Dzego],
  [CITY.Meldan, { x: 560, y: 520 }, SPOT.toll, { x: 920, y: 620 }, CITY.Freetown],
  [CITY.Freetown, { x: 1210, y: 560 }, CITY.Dzego],
  [CITY.Meldan, { x: 330, y: 560 }, CITY["Greater Plum Harbor"]],
  [CITY["Greater Plum Harbor"], { x: 560, y: 760 }, { x: 860, y: 700 }, CITY.Freetown],
];

/** Deterministic 0..1 from a string, so the same resident always lives in the same house. */
export function hash01(s: string, salt = 0) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}

/** Where a resident lives: a house near their city's center, or their shop. */
export function homeOf(id: string, city: string): Pt {
  if (SHOP[id]) return { x: SHOP[id].x, y: SHOP[id].y + 18 };
  const c = CITY[city] ?? CITY.Meldan;
  const a = hash01(id) * Math.PI * 2;
  const r = 34 + hash01(id, 7) * 38;
  return { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r * 0.7 };
}

/** A seeded random stream, so the painted world is identical on every load. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x6d2b79f5) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// painting
// ---------------------------------------------------------------------------------------------------------------

function tree(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, shade: string) {
  ctx.fillStyle = shade;
  ctx.beginPath();
  ctx.moveTo(x, y - 16 * s);
  ctx.lineTo(x + 7 * s, y);
  ctx.lineTo(x - 7 * s, y);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = COLORS.snow;
  ctx.beginPath();
  ctx.moveTo(x, y - 16 * s);
  ctx.lineTo(x + 2.5 * s, y - 10 * s);
  ctx.lineTo(x - 2.5 * s, y - 10 * s);
  ctx.closePath();
  ctx.fill();
}

/** A stone-brick house with a snowy roof; `lit` windows are drawn by the living layer at night. */
function house(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.fillStyle = COLORS.stone;
  ctx.fillRect(x - w / 2, y - h, w, h);
  ctx.strokeStyle = COLORS.stoneDark;
  ctx.lineWidth = 0.6;
  for (let row = 1; row < h / 5; row++) {
    const yy = y - row * 5;
    ctx.beginPath();
    ctx.moveTo(x - w / 2, yy);
    ctx.lineTo(x + w / 2, yy);
    ctx.stroke();
    for (let col = (row % 2) * 4; col < w; col += 8) {
      ctx.beginPath();
      ctx.moveTo(x - w / 2 + col, yy);
      ctx.lineTo(x - w / 2 + col, yy + 5);
      ctx.stroke();
    }
  }
  ctx.fillStyle = COLORS.roof;
  ctx.beginPath();
  ctx.moveTo(x - w / 2 - 3, y - h);
  ctx.lineTo(x, y - h - h * 0.55);
  ctx.lineTo(x + w / 2 + 3, y - h);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = COLORS.snow;
  ctx.beginPath();
  ctx.moveTo(x - w / 2 - 3, y - h);
  ctx.lineTo(x, y - h - h * 0.55);
  ctx.lineTo(x + w / 2 + 3, y - h);
  ctx.lineTo(x + w / 2 - 2, y - h - 2);
  ctx.lineTo(x, y - h - h * 0.4);
  ctx.lineTo(x - w / 2 + 2, y - h - 2);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = COLORS.pine;
  ctx.fillRect(x - 2, y - 7, 4, 7);
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size = 15) {
  ctx.font = `italic ${size}px Newsreader, Georgia, serif`;
  ctx.textAlign = "center";
  ctx.fillStyle = COLORS.lichen;
  ctx.fillText(text, x, y);
}

function roadPath(ctx: CanvasRenderingContext2D, pts: Pt[]) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x, last.y);
}

/** Paints the whole static world into `ctx` (already scaled to world units). */
export function paintStatic(ctx: CanvasRenderingContext2D, homes: { id: string; home: Pt }[]) {
  const r = rng(3724);

  // ground: snowfield with soft drifts
  ctx.fillStyle = COLORS.snow;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 70; i++) {
    ctx.fillStyle = i % 2 ? COLORS.drift : "#E6ECE7";
    ctx.beginPath();
    ctx.ellipse(r() * W, r() * H, 40 + r() * 120, 10 + r() * 26, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // the sea at Greater Plum Harbor
  ctx.fillStyle = COLORS.water;
  ctx.beginPath();
  ctx.moveTo(0, 790);
  ctx.bezierCurveTo(120, 760, 230, 830, 380, 815);
  ctx.bezierCurveTo(470, 805, 520, 860, 560, 900);
  ctx.lineTo(0, 900);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = COLORS.waterDeep;
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 9; i++) {
    const y = 820 + i * 9;
    ctx.beginPath();
    ctx.moveTo(20 + i * 12, y);
    ctx.quadraticCurveTo(80 + i * 12, y - 4, 140 + i * 12, y);
    ctx.stroke();
  }
  // harbor pier and boats
  ctx.fillStyle = COLORS.stoneDark;
  ctx.fillRect(250, 780, 10, 50);
  ctx.fillRect(250, 826, 70, 6);
  for (const [bx, by] of [
    [300, 846],
    [180, 860],
  ]) {
    ctx.fillStyle = COLORS.roof;
    ctx.beginPath();
    ctx.moveTo(bx - 16, by);
    ctx.lineTo(bx + 16, by);
    ctx.lineTo(bx + 11, by + 7);
    ctx.lineTo(bx - 11, by + 7);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = COLORS.snow;
    ctx.beginPath();
    ctx.moveTo(bx, by - 18);
    ctx.lineTo(bx + 10, by - 2);
    ctx.lineTo(bx, by - 2);
    ctx.closePath();
    ctx.fill();
  }

  // roads (Freetown's are the busiest, with toll gates)
  for (const road of ROADS) {
    ctx.strokeStyle = COLORS.road;
    ctx.lineWidth = 11;
    ctx.lineCap = "round";
    roadPath(ctx, road);
    ctx.stroke();
    ctx.strokeStyle = COLORS.frost;
    ctx.lineWidth = 1.3;
    ctx.setLineDash([5, 8]);
    roadPath(ctx, road);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // toll gate
  ctx.fillStyle = COLORS.stoneDark;
  ctx.fillRect(SPOT.toll.x - 18, SPOT.toll.y - 24, 4, 26);
  ctx.fillRect(SPOT.toll.x + 14, SPOT.toll.y - 24, 4, 26);
  ctx.fillStyle = COLORS.slate;
  ctx.fillRect(SPOT.toll.x - 18, SPOT.toll.y - 26, 36, 4);

  // the mountain with the archive node, the tunnel, the sky bridge
  const mx = 610;
  const my = 250;
  ctx.fillStyle = "#D3DAD4";
  ctx.beginPath();
  ctx.moveTo(mx - 190, my + 30);
  ctx.lineTo(mx - 60, 40);
  ctx.lineTo(mx - 10, 90);
  ctx.lineTo(mx + 50, 30);
  ctx.lineTo(mx + 200, my + 30);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = COLORS.snow;
  ctx.beginPath();
  ctx.moveTo(mx - 60, 40);
  ctx.lineTo(mx - 90, 82);
  ctx.lineTo(mx - 52, 70);
  ctx.lineTo(mx - 10, 90);
  ctx.lineTo(mx + 50, 30);
  ctx.lineTo(mx + 82, 74);
  ctx.lineTo(mx + 40, 64);
  ctx.closePath();
  ctx.fill();
  // archive door: a pyramid set into the rock
  ctx.fillStyle = COLORS.stoneDark;
  ctx.beginPath();
  ctx.moveTo(SPOT.archive.x - 22, SPOT.archive.y + 8);
  ctx.lineTo(SPOT.archive.x, SPOT.archive.y - 22);
  ctx.lineTo(SPOT.archive.x + 22, SPOT.archive.y + 8);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = COLORS.pine;
  ctx.fillRect(SPOT.archive.x - 5, SPOT.archive.y - 6, 10, 14);
  // tunnel
  ctx.fillStyle = COLORS.pine;
  ctx.beginPath();
  ctx.ellipse(SPOT.tunnel.x, SPOT.tunnel.y + 8, 13, 12, 0, Math.PI, 0);
  ctx.fill();
  // sky bridge from Meldan up to the mountain shoulder
  ctx.strokeStyle = COLORS.stoneDark;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(470, 300);
  ctx.quadraticCurveTo(505, 250, 548, 262);
  ctx.stroke();
  ctx.lineWidth = 1;
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    const x = (1 - t) * (1 - t) * 470 + 2 * (1 - t) * t * 505 + t * t * 548;
    const y = (1 - t) * (1 - t) * 300 + 2 * (1 - t) * t * 250 + t * t * 262;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + 12);
    ctx.stroke();
  }
  label(ctx, "archive node", SPOT.archive.x + 62, SPOT.archive.y + 6, 15);
  label(ctx, "sky bridge", 500, 244, 14);

  // Kalimar forest: dense pines south of Meldan
  const forest: Pt[] = [];
  for (let i = 0; i < 140; i++) forest.push({ x: 330 + r() * 300, y: 470 + r() * 110 });
  forest.sort((a, b) => a.y - b.y);
  for (const p of forest) tree(ctx, p.x, p.y, 0.8 + r() * 0.6, r() > 0.5 ? "#6E7A70" : "#5B6B61");
  // forest path
  ctx.strokeStyle = COLORS.drift;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(430, 440);
  ctx.bezierCurveTo(400, 500, 520, 520, 480, 585);
  ctx.stroke();
  label(ctx, "Kalimar forest", 480, 612, 16);

  // scattered pines everywhere else
  for (let i = 0; i < 90; i++) {
    const x = r() * W;
    const y = 60 + r() * (H - 160);
    const nearCity = Object.values(CITY).some((c) => Math.hypot(c.x - x, c.y - y) < 110);
    if (!nearCity && !(x > 330 && x < 640 && y > 460 && y < 590) && y < 780) tree(ctx, x, y, 0.7 + r() * 0.5, "#8E998F");
  }

  // Meldan: stone-brick houses around a square with the posting board
  const meldan: Pt[] = [];
  for (let i = 0; i < 16; i++) {
    const a = r() * Math.PI * 2;
    const d = 30 + r() * 70;
    meldan.push({ x: CITY.Meldan.x + Math.cos(a) * d * 1.2, y: CITY.Meldan.y + Math.sin(a) * d * 0.6 });
  }
  for (const h of [...meldan, ...homes.filter((h) => !SHOP[h.id]).map((h) => h.home)].sort((a, b) => a.y - b.y)) house(ctx, h.x, h.y, 18 + r() * 8, 13 + r() * 6);
  // board
  ctx.fillStyle = COLORS.roof;
  ctx.fillRect(SPOT.board.x - 2, SPOT.board.y - 6, 3, 22);
  ctx.fillRect(SPOT.board.x + 37, SPOT.board.y - 6, 3, 22);
  ctx.fillStyle = "#D8CFB8";
  ctx.fillRect(SPOT.board.x - 4, SPOT.board.y - 28, 46, 26);
  ctx.strokeStyle = COLORS.roof;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(SPOT.board.x - 4, SPOT.board.y - 28, 46, 26);
  label(ctx, "the board", SPOT.board.x - 34, SPOT.board.y - 10, 14);

  // Kalimar Kitchen, with a green pad on the table
  const kk = SHOP["kalimar-kitchen"];
  house(ctx, kk.x, kk.y, 34, 20);
  ctx.fillStyle = COLORS.candle;
  ctx.fillRect(kk.x - 8, kk.y - 14, 5, 5);
  ctx.fillRect(kk.x + 3, kk.y - 14, 5, 5);

  // Sadzu Du: Len Su street lined with food courts
  ctx.strokeStyle = COLORS.road;
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.moveTo(1000, 290);
  ctx.lineTo(1200, 230);
  ctx.stroke();
  label(ctx, "Len Su street", 1090, 308, 14);
  for (let i = 0; i < 6; i++) {
    const x = 1010 + i * 34;
    const y = 262 - i * 10;
    court(ctx, x, y, i % 2 ? COLORS.slate : COLORS.candle);
  }
  const bp = SHOP["beautiful-plants"];
  court(ctx, bp.x, bp.y, COLORS.pad, true);

  // Dzego: food trucks
  for (const t of TRUCKS) truck(ctx, t.x, t.y);

  // Freetown: shelters, the square where polls gather, Hydrafill
  for (let i = 0; i < 12; i++) {
    const x = 1000 + (i % 4) * 44 + r() * 10;
    const y = 640 + Math.floor(i / 4) * 34 + r() * 8;
    if (Math.hypot(x - SHOP.hydrafill.x, y - SHOP.hydrafill.y) > 30) shelter(ctx, x, y);
  }
  ctx.strokeStyle = COLORS.frost;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(SPOT.square.x, SPOT.square.y, 38, 16, 0, 0, Math.PI * 2);
  ctx.stroke();
  label(ctx, "the square", SPOT.square.x, SPOT.square.y + 36, 14);
  const hf = SHOP.hydrafill;
  ctx.fillStyle = COLORS.slate;
  ctx.fillRect(hf.x - 16, hf.y - 18, 32, 18);
  ctx.fillStyle = COLORS.snow;
  ctx.fillRect(hf.x - 16, hf.y - 21, 32, 4);
  ctx.fillStyle = COLORS.drift;
  ctx.fillRect(hf.x - 4, hf.y - 10, 8, 10);

  // Greater Plum Harbor: a school and houses by the water
  const gph = CITY["Greater Plum Harbor"];
  house(ctx, gph.x - 60, gph.y + 10, 40, 22);
  label(ctx, "school", gph.x - 60, gph.y + 32, 13);
  for (let i = 0; i < 6; i++) house(ctx, gph.x + 20 + (i % 3) * 26, gph.y - 20 + Math.floor(i / 3) * 34, 16, 12);

  // the couriers' post by the toll road: a low house under a slate roof, a sealed envelope over the door
  const cp = SPOT.couriers;
  house(ctx, cp.x, cp.y, 30, 16);
  ctx.fillStyle = COLORS.slate;
  ctx.beginPath();
  ctx.moveTo(cp.x - 18, cp.y - 16);
  ctx.lineTo(cp.x, cp.y - 27);
  ctx.lineTo(cp.x + 18, cp.y - 16);
  ctx.closePath();
  ctx.fill();
  envelope(ctx, cp.x, cp.y - 20, 1);
  label(ctx, "couriers' post", cp.x, cp.y + 16, 13);

  // Silverchat's house in Freetown: taller, with a slate band
  const sc = SPOT.silverchat;
  ctx.fillStyle = COLORS.stone;
  ctx.fillRect(sc.x - 14, sc.y - 30, 28, 30);
  ctx.fillStyle = COLORS.slate;
  ctx.fillRect(sc.x - 14, sc.y - 22, 28, 4);
  ctx.fillStyle = COLORS.snow;
  ctx.fillRect(sc.x - 16, sc.y - 33, 32, 4);
  ctx.fillStyle = COLORS.pine;
  ctx.fillRect(sc.x - 3, sc.y - 8, 6, 8);
  label(ctx, "Silverchat", sc.x, sc.y + 16, 13);

  // the ballot box in the square
  ctx.fillStyle = COLORS.slate;
  ctx.fillRect(SPOT.ballot.x - 5, SPOT.ballot.y - 9, 10, 9);
  ctx.fillStyle = COLORS.pine;
  ctx.fillRect(SPOT.ballot.x - 3, SPOT.ballot.y - 8, 6, 1.2);

  // lantern posts along the forest path, lamps on Len Su street, the pier and the couriers' door
  for (const l of LAMPS) {
    ctx.fillStyle = COLORS.roof;
    ctx.fillRect(l.x - 0.7, l.y, 1.4, 11);
    ctx.fillStyle = "#D8CFB8";
    ctx.fillRect(l.x - 2, l.y - 3, 4, 4);
  }

  // a chalkboard where the harbor kids take their lessons
  const lb = SPOT.lessons;
  ctx.fillStyle = COLORS.roof;
  ctx.fillRect(lb.x - 12, lb.y - 2, 2, 10);
  ctx.fillRect(lb.x + 10, lb.y - 2, 2, 10);
  ctx.fillStyle = "#3D4E45";
  ctx.fillRect(lb.x - 14, lb.y - 16, 28, 15);
  ctx.strokeStyle = "rgba(236,240,236,0.8)";
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(lb.x - 10, lb.y - 11);
  ctx.lineTo(lb.x - 2, lb.y - 11);
  ctx.moveTo(lb.x - 10, lb.y - 5);
  ctx.quadraticCurveTo(lb.x, lb.y - 12, lb.x + 9, lb.y - 5);
  ctx.stroke();
  label(ctx, "lessons", lb.x, lb.y + 20, 12);

  // Number Ten, chalked on the middle truck
  ctx.font = "bold 6px 'IBM Plex Sans', system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = COLORS.pine;
  ctx.fillText("No.10", TRUCKS[1].x - 3, TRUCKS[1].y - 17);
  label(ctx, "food trucks", 1352, 522, 13);

  // Hydrafill's ads really are everywhere
  for (const [ax, ay] of [
    [760, 286],
    [680, 740],
    [1262, 372],
  ]) {
    ctx.fillStyle = COLORS.roof;
    ctx.fillRect(ax - 7, ay - 2, 1.5, 10);
    ctx.fillRect(ax + 6, ay - 2, 1.5, 10);
    ctx.fillStyle = COLORS.slate;
    ctx.fillRect(ax - 9, ay - 14, 18, 12);
    ctx.fillStyle = COLORS.snow;
    ctx.fillRect(ax - 2, ay - 12, 4, 8);
    ctx.fillRect(ax - 1, ay - 13.5, 2, 2);
  }

  // place names
  // Meldan's name sits south-west of the square, clear of the bridge and the board
  for (const c of Object.values(CITY)) label(ctx, c.label, c.label === "Meldan" ? c.x - 120 : c.x, c.label === "Meldan" ? c.y + 10 : c.y - 84, 24);
}

function court(ctx: CanvasRenderingContext2D, x: number, y: number, awning: string, big = false) {
  const w = big ? 34 : 24;
  ctx.fillStyle = COLORS.stone;
  ctx.fillRect(x - w / 2, y - 16, w, 16);
  ctx.fillStyle = awning;
  for (let i = 0; i < w; i += 6) {
    ctx.beginPath();
    ctx.moveTo(x - w / 2 + i, y - 16);
    ctx.lineTo(x - w / 2 + i + 6, y - 16);
    ctx.lineTo(x - w / 2 + i + 3, y - 11);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillRect(x - w / 2, y - 20, w, 4);
}

/** A sealed envelope (a proof in a courier's care), centered at x, y. */
export function envelope(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.fillStyle = "#FBF8EF";
  ctx.fillRect(x - 4 * s, y - 2.6 * s, 8 * s, 5.4 * s);
  ctx.strokeStyle = COLORS.stoneDark;
  ctx.lineWidth = 0.6 * s;
  ctx.strokeRect(x - 4 * s, y - 2.6 * s, 8 * s, 5.4 * s);
  ctx.beginPath();
  ctx.moveTo(x - 4 * s, y - 2.6 * s);
  ctx.lineTo(x, y + 0.6 * s);
  ctx.lineTo(x + 4 * s, y - 2.6 * s);
  ctx.stroke();
  ctx.fillStyle = COLORS.candle;
  ctx.beginPath();
  ctx.arc(x, y + 0.6 * s, 1 * s, 0, Math.PI * 2);
  ctx.fill();
}

function truck(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.fillStyle = COLORS.candle;
  ctx.fillRect(x - 16, y - 14, 26, 12);
  ctx.fillStyle = COLORS.roof;
  ctx.fillRect(x + 10, y - 10, 8, 8);
  ctx.fillStyle = COLORS.pine;
  ctx.beginPath();
  ctx.arc(x - 9, y, 3, 0, Math.PI * 2);
  ctx.arc(x + 12, y, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = COLORS.snow;
  ctx.fillRect(x - 12, y - 11, 10, 5);
}

function shelter(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.fillStyle = COLORS.stoneDark;
  ctx.beginPath();
  ctx.ellipse(x, y, 16, 11, 0, Math.PI, 0);
  ctx.fill();
  ctx.fillStyle = COLORS.snow;
  ctx.beginPath();
  ctx.ellipse(x, y - 8, 11, 4, 0, Math.PI, 0);
  ctx.fill();
  ctx.fillStyle = COLORS.pine;
  ctx.fillRect(x - 3, y - 6, 6, 6);
}

/** Window positions per home, lit from dusk to dawn by the living layer. */
export function windowsOf(home: Pt): Pt[] {
  return [
    { x: home.x - 5, y: home.y - 10 },
    { x: home.x + 5, y: home.y - 10 },
  ];
}

/** A point along a road-like curve between two points (used for travelling light and walkers). */
export function along(a: Pt, b: Pt, t: number, bend = 0.18): Pt {
  const mx = (a.x + b.x) / 2 - (b.y - a.y) * bend;
  const my = (a.y + b.y) / 2 + (b.x - a.x) * bend;
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * mx + t * t * b.x, y: u * u * a.y + 2 * u * t * my + t * t * b.y };
}
