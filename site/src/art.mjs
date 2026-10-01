// The site's illustrations, drawn as inline SVG in the same snowy style as the Veridia world in apps/web.
// Every fill is a CSS class, so the page's stylesheet can turn day into night (prefers-color-scheme) without a
// second copy of the art. Seeded, so the output is identical on every build.

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x6d2b79f5) >>> 0;
    return s / 4294967296;
  };
}

const n = (v) => Math.round(v * 10) / 10;

// Shared shapes, defined once in the hero and reused by the other inline drawings on the page. A pine is a dark cone with a snowy tip; its body takes the fill of the <use> that places it.
const DEFS = `
<symbol id="pine" viewBox="-8 -17 16 17" overflow="visible"><path d="M0-16 7 0H-7Z"/><path class="a-snow" d="M0-16 2.5-10h-5Z"/><rect class="a-pine" x="-1.6" y="-1" width="3.2" height="2"/></symbol>
<symbol id="house" viewBox="-12 -20 24 20" overflow="visible"><rect class="a-stone" x="-10" y="-12" width="20" height="12"/><path class="a-brick" d="M-10-4h20M-10-8h20M-4-8v4M4-8v4M0-12v4M0-4v4"/><path class="a-roof" d="M-12.5-12 0-19l12.5 7Z"/><path class="a-snow" d="M-12.5-12 0-19l12.5 7-2.2-.6L0-17.2-10.3-12.6Z"/><rect class="a-win" x="-6.5" y="-9.5" width="3.4" height="3.4"/><rect class="a-win" x="3.1" y="-9.5" width="3.4" height="3.4"/><rect class="a-pine" x="-1.6" y="-5" width="3.2" height="5"/></symbol>
`;

function pines(r, count, x0, x1, yAt, sMin, sMax, cls) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const x = x0 + r() * (x1 - x0);
    out.push({ x, y: yAt(x) + r() * 14, s: sMin + r() * (sMax - sMin), cls });
  }
  return out.sort((a, b) => a.y - b.y).map((p) => `<use href="#pine" class="${p.cls}" x="${n(p.x)}" y="${n(p.y)}" width="${n(16 * p.s)}" height="${n(17 * p.s)}" transform="translate(${n(-8 * p.s)} ${n(-17 * p.s)})"/>`);
}

/** The hero: a winter valley with Meldan's stone houses, under a separate moon the page positions itself. */
export function heroLand() {
  const r = rng(3724);
  const W = 1600;
  const parts = [];
  // far ridge, with the tallest mountain on the right
  parts.push(`<path class="a-ridge" d="M0 318 140 262 262 292 420 214 560 276 700 236 830 286 980 188 1080 126 1142 170 1208 104 1332 236 1462 206 1600 262V560H0Z"/>`);
  parts.push(`<path class="a-cap" d="M1080 126 1052 160 1086 150 1116 168 1142 170 1208 104 1238 146 1204 136 1176 158 1142 170 1116 150ZM420 214 398 236 424 230 446 240ZM980 188 962 210 984 204 1004 214Z"/>`);
  // middle hills
  const mid = (x) => 352 + Math.sin(x / 190) * 18 + Math.sin(x / 67) * 6;
  parts.push(`<path class="a-drift" d="M0 ${n(mid(0))} ${Array.from({ length: 33 }, (_, i) => `L${i * 50} ${n(mid(i * 50))}`).join(" ")} L1600 ${n(mid(1600))} V560 H0Z"/>`);
  parts.push(...pines(r, 70, 0, W, (x) => mid(x) - 4, 0.8, 1.3, "a-p3"));
  // near slope and snowfield
  const near = (x) => 432 + Math.sin(x / 260 + 1.2) * 16 + Math.sin(x / 90) * 4;
  parts.push(`<path class="a-snowfield" d="M0 ${n(near(0))} ${Array.from({ length: 33 }, (_, i) => `L${i * 50} ${n(near(i * 50))}`).join(" ")} L1600 ${n(near(1600))} V560 H0Z"/>`);
  // Kalimar forest on the left
  parts.push(...pines(r, 60, 20, 560, (x) => near(x) - 18, 1.5, 2.6, "a-p2"));
  // road winding up to Meldan
  const road = "M180 560C360 520 520 540 700 506S930 470 1030 466";
  parts.push(`<path class="a-road" d="${road}" fill="none" stroke-width="18" stroke-linecap="round"/>`);
  parts.push(`<path class="a-dash" d="${road}" fill="none" stroke-width="2" stroke-dasharray="7 11"/>`);
  // Meldan
  const houses = [];
  for (let i = 0; i < 11; i++) houses.push({ x: 930 + r() * 420, y: 446 + r() * 44, s: 1.8 + r() * 1.1 });
  houses.push({ x: 1170, y: 500, s: 3.1 });
  houses.sort((a, b) => a.y - b.y);
  const glow = [];
  houses.forEach((h, i) => {
    parts.push(`<use href="#house" x="${n(h.x - 12 * h.s)}" y="${n(h.y - 20 * h.s)}" width="${n(24 * h.s)}" height="${n(20 * h.s)}"/>`);
    glow.push(`<circle class="a-glow" cx="${n(h.x)}" cy="${n(h.y - 8 * h.s)}" r="${n(16 * h.s)}"/>`);
    if (i % 3 === 1 || h.s > 3) {
      // a chimney on the right slope
      const cx = h.x + 5 * h.s;
      const cy = h.y - 16.5 * h.s;
      parts.push(`<rect class="a-roof" x="${n(cx - 1.3 * h.s)}" y="${n(cy - 3 * h.s)}" width="${n(2.6 * h.s)}" height="${n(4 * h.s)}"/>`);
    }
  });
  parts.push(`<g class="glows">${glow.join("")}</g>`);
  // lantern by the road
  parts.push(`<rect class="a-roof" x="728" y="470" width="3" height="30"/><rect class="a-lamp" x="724" y="462" width="11" height="10" rx="1"/><circle class="a-glow" cx="729.5" cy="467" r="26"/>`);
  // foreground framing pines and drifts
  parts.push(...pines(r, 9, 1380, 1600, () => 512, 3.2, 5, "a-p1"));
  parts.push(...pines(r, 6, 0, 150, () => 520, 3.4, 5.2, "a-p1"));
  for (let i = 0; i < 7; i++) parts.push(`<ellipse class="a-drift2" cx="${n(r() * W)}" cy="${n(530 + r() * 26)}" rx="${n(80 + r() * 140)}" ry="${n(6 + r() * 8)}"/>`);
  return `<svg class="land" viewBox="0 0 1600 560" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false"><defs>${DEFS}<radialGradient id="glow"><stop offset="0" class="g-in"/><stop offset="1" class="g-out"/></radialGradient></defs>${parts.join("")}</svg>`;
}

/** The moon, on its own so it can sit wherever the layout needs it. */
export function moon() {
  return `<svg class="moon" viewBox="0 0 200 200" aria-hidden="true" focusable="false"><defs><radialGradient id="halo"><stop offset=".42" class="h-in"/><stop offset="1" class="h-out"/></radialGradient></defs><circle class="m-halo" cx="100" cy="100" r="100" fill="url(#halo)"/><circle class="m-disc" cx="100" cy="100" r="42"/><path class="m-sea" d="M78 84c4-9 17-11 22-4 4 6-3 12-10 13-8 1-15-2-12-9Z"/><path class="m-sea" d="M104 102c6-5 18-3 20 5 2 9-7 15-15 13-7-2-11-12-5-18Z"/><ellipse class="m-sea" cx="90" cy="119" rx="5" ry="3.5"/><ellipse class="m-sea" cx="117" cy="82" rx="3.5" ry="2.6"/></svg>`;
}

/** Icons for the four steps of zipping. */
export const STEP = {
  zip: `<svg class="st-zip" viewBox="0 0 120 90" aria-hidden="true" focusable="false"><path class="i-line" d="M60 8v40" stroke-width="2" stroke-dasharray="4 6"/><circle class="i-ring" cx="60" cy="14" r="9" stroke-width="4"/><path class="i-pool-edge" d="M14 66c0-10 20-16 46-16s46 6 46 16-20 16-46 16-46-6-46-16Z"/><circle class="i-dot" cx="36" cy="66" r="3.5"/><circle class="i-dot" cx="52" cy="72" r="3.5"/><circle class="i-dot" cx="70" cy="62" r="3.5"/><circle class="i-dot" cx="84" cy="71" r="3.5"/><circle class="i-dot" cx="60" cy="60" r="3.5"/></svg>`,
  crowd: (() => {
    const r = rng(77);
    const dots = [];
    const pts = [];
    for (let tries = 0; pts.length < 40 && tries < 4000; tries++) {
      const a = r() * Math.PI * 2;
      const d = Math.sqrt(r()) * 35;
      const q = { x: 60 + Math.cos(a) * d, y: 45 + Math.sin(a) * d };
      if (pts.every((o) => Math.hypot(o.x - q.x, o.y - q.y) > 8.4)) pts.push(q);
    }
    for (const q of pts) dots.push(`<circle class="i-dot" cx="${n(q.x)}" cy="${n(q.y)}" r="3"/>`);
    return `<svg class="st-crowd" viewBox="0 0 120 90" aria-hidden="true" focusable="false"><circle class="i-pool" cx="60" cy="45" r="42"/>${dots.join("")}</svg>`;
  })(),
  prove: `<svg class="st-prove" viewBox="0 0 120 90" aria-hidden="true" focusable="false"><g class="st-env"><rect class="i-paper" x="30" y="24" width="60" height="40" rx="2"/><path class="i-edge" d="M30 24h60v40H30ZM30 24l30 22 30-22" fill="none" stroke-width="2"/><circle class="i-seal" cx="60" cy="46" r="7"/></g><path class="i-line" d="M8 44h14M98 44h14" stroke-width="2" stroke-dasharray="4 6"/></svg>`,
  paid: `<svg class="st-paid" viewBox="0 0 120 90" aria-hidden="true" focusable="false"><path class="i-line" d="M20 45h18M38 45 60 18h18M38 45l22 27h18" fill="none" stroke-width="2"/><circle class="i-ring" cx="92" cy="18" r="10" stroke-width="4"/><rect class="i-tax" x="80" y="62" width="24" height="20" rx="2"/><path class="i-flame" d="M10 45c-5-4-4-9 0-14 1 4 5 5 5 9s-2 5-5 5Z"/></svg>`,
};

/** The courier's post: a proof held a while, then sent at a random moment. */
export function courierArt() {
  const env = (x, y, s = 1) =>
    `<g transform="translate(${x} ${y}) scale(${s})"><rect class="i-paper" x="-12" y="-8" width="24" height="16" rx="1"/><path class="i-edge" d="M-12-8h24v16h-24ZM-12-8 0 1l12-9" fill="none" stroke-width="1.2"/><circle class="i-seal" cx="0" cy="1.5" r="3"/></g>`;
  return `<svg class="courier-art" viewBox="0 0 640 180" role="img" aria-labelledby="courier-art-t"><title id="courier-art-t">A sealed proof travels from a person to a courier, waits there a while, and goes on to the chain at a random moment.</title>
<path class="a-road" d="M20 130H620" stroke-width="16" stroke-linecap="round"/><path class="a-dash" d="M20 130H620" stroke-width="2" stroke-dasharray="7 11"/>
<g transform="translate(70 130)"><circle class="c-person" cx="0" cy="-44" r="9"/><path class="c-person" d="M-12-4c0-18 5-28 12-28s12 10 12 28Z"/></g>
${env(160, 96)}
<g transform="translate(320 130)"><rect class="a-stone" x="-54" y="-50" width="108" height="50"/><path class="a-brick" d="M-54-17h108M-54-34h108M-20-34v17M20-34v17M0-50v16M0-17v17" stroke-width="1"/><path class="c-slate" d="M-64-50 0-88l64 38Z"/><path class="a-snow" d="M-64-50 0-88l64 38-6-1L0-83l-58 34Z"/><rect class="a-pine" x="-9" y="-24" width="18" height="24"/></g>
${env(320, 30, 1.1)}${env(288, 58, 0.9)}${env(352, 58, 0.9)}
<text class="c-label" x="320" y="168" text-anchor="middle">a courier</text>
${env(470, 96)}
<g transform="translate(575 130)"><path class="c-chain" d="M-34-66h68v66h-68Z"/><path class="c-chain-l" d="M-34-44h68M-34-22h68M-12-66v22M12-44v22M-12-22v22" stroke-width="1.4"/></g>
<text class="c-label" x="70" y="168" text-anchor="middle">you</text><text class="c-label" x="575" y="168" text-anchor="middle">the chain</text></svg>`;
}

/** Veridia, as a painted map of the novel's places, in the style of the app's living world. */
/**
 * Veridia's map. With { live: true } it's the stage for the living scene (veridia-scene.js): no painted residents
 * (the scene draws them), the roads tagged with the towns they join, and the board and Kalimar Kitchen drawn in.
 */
export function veridia({ live = false } = {}) {
  const r = rng(3724);
  const W = 1600;
  const H = 820;
  const p = [];
  p.push(`<rect class="a-snowfield" width="${W}" height="${H}"/>`);
  for (let i = 0; i < 40; i++) p.push(`<ellipse class="a-drift2" cx="${n(r() * W)}" cy="${n(r() * H)}" rx="${n(40 + r() * 110)}" ry="${n(8 + r() * 16)}"/>`);
  // the sea at Greater Plum Harbor
  p.push(`<path class="a-water" d="M0 700C120 670 230 740 380 725 470 715 520 770 560 820H0Z"/>`);
  for (let i = 0; i < 7; i++) p.push(`<path class="a-wave" d="M${20 + i * 12} ${730 + i * 12}q60-4 120 0" fill="none" stroke-width="1.4"/>`);
  // roads
  const roads = [
    ["M430 330Q620 290 740 275T1090 210", "Meldan", "Sadzu Du"],
    ["M1090 210Q1240 290 1345 395", "Sadzu Du", "Dzego"],
    ["M430 330Q560 460 700 530T1050 595", "Meldan", "Freetown"],
    ["M1050 595Q1210 510 1345 395", "Freetown", "Dzego"],
    ["M430 330Q330 500 255 660", "Meldan", "Greater Plum Harbor"],
    ["M255 660Q560 680 860 640T1050 595", "Greater Plum Harbor", "Freetown"],
  ];
  for (const [d, a, b] of roads) p.push(`<path class="a-road" d="${d}" fill="none" stroke-width="12" stroke-linecap="round"${live ? ` data-from="${a}" data-to="${b}"` : ""}/><path class="a-dash" d="${d}" fill="none" stroke-width="1.5" stroke-dasharray="5 8"/>`);
  // the mountain
  p.push(`<path class="a-ridge" d="M400 252 550 40 600 90 660 30 830 252Z"/><path class="a-shade" d="M660 30 830 252H706Q700 140 660 30Z"/><path class="a-shade" d="M550 40 600 90 612 252H586Q584 130 550 40Z"/><path class="a-cap" d="M550 40 520 82 558 70 600 90 660 30 692 74 650 64Z"/>`);
  // Kalimar forest and scattered pines
  const forest = [];
  for (let i = 0; i < 170; i++) forest.push({ x: 320 + r() * 300, y: 420 + r() * 110 });
  forest.sort((a, b) => a.y - b.y);
  for (const f of forest) {
    const s = 1.1 + r() * 0.8;
    p.push(`<use href="#pine" class="${r() > 0.5 ? "a-p2" : "a-p1"}" x="${n(f.x - 8 * s)}" y="${n(f.y - 17 * s)}" width="${n(16 * s)}" height="${n(17 * s)}"/>`);
  }
  const towns = [
    [430, 330],
    [1090, 210],
    [1345, 395],
    [1050, 595],
    [255, 660],
  ];
  const labels = [
    [300, 350, 90],
    [1100, 124, 90],
    [1420, 330, 70],
    [1080, 770, 90],
    [250, 610, 150],
    [470, 568, 80],
    [1352, 470, 70],
    [1223, 712, 60],
  ];
  // groves of pines between the towns, like the app's world
  const scattered = [];
  const clear = (x, y) =>
    !towns.some(([tx, ty]) => Math.hypot(tx - x, ty - y) < 115) && !(x > 300 && x < 650 && y > 400 && y < 560) && !(x > 400 && x < 830 && y < 265) && y < 690 && y > 40 && !labels.some(([lx, ly, lw]) => Math.abs(x - lx) < lw && y > ly - 34 && y < ly + 22);
  for (let g = 0, made = 0; made < 17 && g < 400; g++) {
    const gx = 40 + r() * (W - 80);
    const gy = 60 + r() * (H - 180);
    if (!clear(gx, gy)) continue;
    made++;
    const k = 5 + Math.floor(r() * 9);
    for (let i = 0; i < k; i++) {
      const x = gx + (r() - 0.5) * 110;
      const y = gy + (r() - 0.5) * 50;
      if (clear(x, y)) scattered.push({ x, y, s: 0.9 + r() * 0.6, c: r() > 0.55 ? "a-p2" : "a-p3" });
    }
  }
  scattered.sort((a, b) => a.y - b.y);
  for (const t of scattered) p.push(`<use href="#pine" class="${t.c}" x="${n(t.x - 8 * t.s)}" y="${n(t.y - 17 * t.s)}" width="${n(16 * t.s)}" height="${n(17 * t.s)}"/>`);
  const house = (x, y, s) => `<use href="#house" x="${n(x - 12 * s)}" y="${n(y - 20 * s)}" width="${n(24 * s)}" height="${n(20 * s)}"/>`;
  // Meldan
  const meldan = [];
  for (let i = 0; i < 16; i++) {
    const a = r() * Math.PI * 2;
    const d = 30 + r() * 70;
    meldan.push({ x: 430 + Math.cos(a) * d * 1.2, y: 330 + Math.sin(a) * d * 0.6 });
  }
  meldan.sort((a, b) => a.y - b.y);
  for (const h of meldan) p.push(house(h.x, h.y, 1.1 + r() * 0.3));
  // Sadzu Du: food courts along Len Su street, Beautiful Plants in green
  const court = (x, y, cls, big) => {
    const w = big ? 40 : 28;
    let tri = "";
    for (let i = 0; i < w; i += 7) tri += `M${n(x - w / 2 + i)} ${y - 18}h7l-3.5 6Z`;
    return `<rect class="a-stone" x="${x - w / 2}" y="${y - 18}" width="${w}" height="18"/><rect class="${cls}" x="${x - w / 2}" y="${y - 23}" width="${w}" height="5"/><path class="${cls}" d="${tri}"/>`;
  };
  for (let i = 0; i < 6; i++) p.push(court(1010 + i * 36, 232 - i * 10, i % 2 ? "c-slate" : "c-candle", false));
  p.push(court(1130, 262, "c-pad", true));
  const extra = [];
  for (const [cx, cy, k] of [
    [1100, 190, 7],
    [1360, 380, 6],
    [1120, 620, 3],
  ])
    for (let i = 0; i < k; i++) extra.push({ x: cx - 70 + r() * 140, y: cy - 30 + r() * 30 });
  extra.sort((a, b) => a.y - b.y);
  for (const h of extra) p.push(house(h.x, h.y, 0.95 + r() * 0.3));
  // Dzego: food trucks
  for (const [x, y] of [
    [1300, 410],
    [1362, 432],
    [1404, 388],
  ])
    p.push(`<rect class="c-candle" x="${x - 18}" y="${y - 15}" width="28" height="13"/><rect class="a-roof" x="${x + 10}" y="${y - 11}" width="9" height="9"/><rect class="a-snow" x="${x - 13}" y="${y - 12}" width="11" height="5"/><circle class="a-pine" cx="${x - 10}" cy="${y}" r="3.2"/><circle class="a-pine" cx="${x + 13}" cy="${y}" r="3.2"/>`);
  // Freetown: shelters, the square, Hydrafill
  for (let i = 0; i < 12; i++) {
    const x = 1000 + (i % 4) * 46 + r() * 10;
    const y = 640 + Math.floor(i / 4) * 34 + r() * 8;
    p.push(`<path class="a-stoneDark" d="M${n(x - 16)} ${n(y)}a16 11 0 0 1 32 0Z"/><path class="a-snow" d="M${n(x - 11)} ${n(y - 7)}a11 4 0 0 1 22 0Z"/><rect class="a-pine" x="${n(x - 3)}" y="${n(y - 6)}" width="6" height="6"/>`);
  }
  p.push(`<ellipse class="a-ring" cx="985" cy="560" rx="40" ry="17" fill="none" stroke-width="2"/>`);
  p.push(`<rect class="c-slate" x="1206" y="672" width="34" height="19"/><rect class="a-snow" x="1206" y="669" width="34" height="4"/>`);
  // the archive node: a pyramid door set into the mountain
  p.push(`<path class="a-stoneDark" d="M588 214 610 184l22 30Z"/><rect class="a-pine" x="605" y="200" width="10" height="14"/>`);
  // Greater Plum Harbor: school, houses, pier, boats
  p.push(house(195, 668, 1.9));
  for (let i = 0; i < 6; i++) p.push(house(275 + (i % 3) * 28, 640 + Math.floor(i / 3) * 34, 0.85));
  p.push(`<rect class="a-stoneDark" x="250" y="690" width="10" height="46"/><rect class="a-stoneDark" x="250" y="732" width="72" height="6"/>`);
  for (const [bx, by] of [
    [300, 758],
    [170, 776],
  ])
    p.push(`<path class="a-roof" d="M${bx - 16} ${by}h32l-5 7h-22Z"/><path class="a-snow" d="M${bx} ${by - 18}l10 16h-10Z"/>`);
  // residents: small figures out and about
  const folk = [
    [470, 360, "c-pad"],
    [1178, 258, "c-pad"],
    [700, 520, "c-slate"],
    [980, 548, "c-slate"],
    [1000, 575, "c-slate"],
    [1398, 412, "c-candle"],
    [240, 700, "c-candle"],
    [395, 355, "c-folk"],
    [912, 552, "c-folk"],
    [520, 470, "c-folk"],
  ];
  if (live) {
    // the board where anonymous notes are pinned, and Kalimar Kitchen with its green-circle tables
    p.push(`<rect class="a-roof" x="338" y="286" width="3" height="22"/><rect class="a-roof" x="377" y="286" width="3" height="22"/><rect class="v-board" x="334" y="264" width="50" height="28"/>`);
    p.push(court(560, 382, "c-pad", true));
  } else for (const [x, y, c] of folk) p.push(`<circle class="${c}" cx="${x}" cy="${y}" r="5"/><circle class="a-ring-halo" cx="${x}" cy="${y}" r="9" fill="none" stroke-width="1.5"/>`);
  // place names
  const label = (t, x, y, big) => `<text class="v-label${big ? " v-town" : ""}" x="${x}" y="${y}" text-anchor="middle">${t}</text>`;
  if (live) p.push(label("the board", 359, 256), label("Kalimar Kitchen", 560, 406));
  p.push(label("Meldan", 300, 350, true), label("Sadzu Du", 1100, 124, true), label("Dzego", 1420, 330, true), label("Freetown", 1080, 770, true), label("Greater Plum Harbor", 250, 610, true));
  p.push(label("Kalimar forest", 470, 568), label("Len Su street", 950, 258), label("Beautiful Plants", 1130, 290), label("the square", 985, 604), label("archive node", 690, 214), label("Hydrafill", 1223, 712), label("food trucks", 1352, 470), label("school", 195, 694));
  return `<svg class="veridia-art" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="veridia-art-t" preserveAspectRatio="xMidYMid slice"><title id="veridia-art-t">A snowy map of Veridia: Meldan's stone houses and Kalimar forest below the mountain, the food courts of Sadzu Du, Dzego's food trucks, Freetown with its square, the archive node in the mountain, and Greater Plum Harbor by the sea, with residents out and about.</title>${p.join("")}</svg>`;
}

/** The mark: the green circle a table pad shows when you pay, which is also the pool. */
// The zipcoin logo, concept D "Zipper Z": a Z whose diagonal is a closed zipper, on a night coin with a green rim.
// This is the small drawing (site/brand/zipcoin-small.svg), for 48 px and below. The rim takes the page's green
// through currentColor (.mark sets color: var(--pad)); the zipper is drawn before the bars so they trim its ends,
// which keeps the mark free of ids when it appears twice on a page.
export const MARK = `<svg class="mark" viewBox="0 0 512 512" aria-hidden="true" focusable="false"><circle cx="256" cy="256" r="256" fill="#101b1a"/><circle cx="256" cy="256" r="236" fill="none" stroke="currentColor" stroke-width="40"/><path fill="#f4f0e1" d="M268 190H384L244 322H128Z"/><path d="M323.7 158 290.9 191.6 319.5 219.6 286.7 253.2 258.1 225.2 225.3 258.8 253.9 286.8 221.1 320.4 192.5 292.4 159.7 326" fill="none" stroke="#101b1a" stroke-width="16"/><path fill="#f4f0e1" d="M136 118H376A8 8 0 0 1 384 126V184A8 8 0 0 1 376 192H136A8 8 0 0 1 128 184V126A8 8 0 0 1 136 118ZM136 320H376A8 8 0 0 1 384 328V386A8 8 0 0 1 376 394H136A8 8 0 0 1 128 386V328A8 8 0 0 1 136 320Z"/></svg>`;

/** Cover traffic: couriers' pool actions at random times, and one real user's deposit and spend among them. */
export function coverArt() {
  const r = rng(515);
  const rows = [
    { y: 48, label: "zip in", cls: "cv-in" },
    { y: 96, label: "rezip", cls: "cv-re" },
    { y: 144, label: "unzip", cls: "cv-out" },
  ];
  const x0 = 150;
  const x1 = 700;
  const dots = [];
  // exponential gaps: a Poisson process, like the couriers' own timer
  for (let x = x0 + r() * 20; x < x1; x += 6 + -Math.log(1 - r()) * 16) {
    const k = r();
    const row = k < 0.2 ? rows[0] : k < 0.68 ? rows[1] : rows[2];
    dots.push(`<circle class="${row.cls}" cx="${n(x)}" cy="${row.y + n((r() - 0.5) * 10)}" r="6"/>`);
  }
  const lines = rows.map((row) => `<path class="cv-lane" d="M${x0 - 10} ${row.y}H${x1 + 10}"/><text class="cv-label" x="${x0 - 22}" y="${row.y + 7}" text-anchor="end">${row.label}</text>`).join("");
  const you = (x, y, t) => `<circle class="cv-you-halo" cx="${x}" cy="${y}" r="15"/><circle class="cv-you" cx="${x}" cy="${y}" r="8"/><text class="cv-you-label" x="${x}" y="${y - 24}" text-anchor="middle">${t}</text>`;
  return `<svg class="cover-svg" viewBox="0 0 720 200" role="img" aria-labelledby="cover-art-t"><title id="cover-art-t">A timeline of the pool: couriers' zips, rezips and unzips fall at random moments, and one person's deposit and later spend sit among them without standing out.</title>
${lines}${dots.join("")}${you(262, 48, "you zip")}${you(548, 96, "you spend")}
<path class="cv-axis" d="M${x0 - 10} 182H${x1 + 10}"/><path class="cv-axis" d="M${x1 + 2} 177l8 5-8 5"/><text class="cv-label" x="${x1 + 10}" y="200" text-anchor="end">time</text></svg>`;
}

/** The shared symbols on their own, for a page without the hero (whose drawing defines them otherwise). */
export function defsSvg() {
  return `<svg class="defs" width="0" height="0" aria-hidden="true" focusable="false"><defs>${DEFS}</defs></svg>`;
}

/** Homepage icon: three lanes of random pool activity, one green dot among them. */
export const ICON_QUIET = (() => {
  const r = rng(808);
  let dots = "";
  for (const y of [22, 45, 68]) for (let x = 10 + r() * 8; x < 112; x += 9 + r() * 16) dots += `<circle class="i-dot" cx="${n(x)}" cy="${n(y + (r() - 0.5) * 6)}" r="3.4"/>`;
  return `<svg class="iq" viewBox="0 0 120 90" aria-hidden="true" focusable="false"><path class="i-line" d="M4 22h112M4 45h112M4 68h112" stroke-width="1" stroke-dasharray="2 5"/>${dots}<circle class="i-you" cx="64" cy="45" r="6.5"/></svg>`;
})();

/** Topic icons for the learn hub: a house among pines, an open book, a question in a ring. */
export const ICON_VERIDIA = `<svg viewBox="0 0 120 90" aria-hidden="true" focusable="false"><use href="#pine" class="a-p2" x="14" y="34" width="26" height="28"/><use href="#pine" class="a-p1" x="84" y="30" width="30" height="32"/><use href="#house" x="36" y="20" width="50" height="42"/><path class="a-dash" d="M8 72h104" stroke-width="2" stroke-dasharray="5 7"/></svg>`;
export const ICON_NOVEL = `<svg viewBox="0 0 120 90" aria-hidden="true" focusable="false"><path class="i-paper" d="M60 22c-12-8-30-9-44-5v52c14-4 32-3 44 5 12-8 30-9 44-5V17c-14-4-32-3-44 5Z"/><path class="i-edge" d="M60 22c-12-8-30-9-44-5v52c14-4 32-3 44 5 12-8 30-9 44-5V17c-14-4-32-3-44 5ZM60 22v52" fill="none" stroke-width="2"/><path class="i-line" d="M26 32c9-2 18-1 25 2M26 42c9-2 18-1 25 2M69 34c7-3 16-4 25-2M69 44c7-3 16-4 25-2" stroke-width="1.6"/></svg>`;
export const ICON_FAQ = `<svg viewBox="0 0 120 90" aria-hidden="true" focusable="false"><circle class="i-ring" cx="60" cy="45" r="30" stroke-width="5"/><text class="i-q" x="60" y="58" text-anchor="middle">?</text></svg>`;

/**
 * The planned liquidity: the launch position covers one price range; the tax share (ZC) is planned to sit above it,
 * and nothing is added below it. Static; the labels say it's planned.
 */
export function bandsArt() {
  return `<svg class="bands" viewBox="0 0 640 190" role="img" aria-labelledby="bands-t"><title id="bands-t">A price line. The launch position covers one range in the middle; planned treasury ZC liquidity from the sales tax sits above it. Nothing is added below it.</title>
<rect class="b-planned" x="394" y="78" width="206" height="58" rx="6"/>
<rect class="b-launch" x="246" y="46" width="148" height="90" rx="6"/>
<path class="b-axis" d="M24 136H616M606 130l10 6-10 6"/>
<text class="b-label b-label-strong" x="320" y="34" text-anchor="middle">launch position</text>
<text class="b-label b-in" x="497" y="113" text-anchor="middle">treasury ZC (planned)</text>
<text class="b-label" x="40" y="166">lower prices</text><text class="b-label" x="600" y="166" text-anchor="end">higher prices</text></svg>`;
}

/** Feature card icons: a cut emerald, and a sealed note answering a 402. */
export const ICON_EMERALD = `<svg class="card-icon" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path class="e-face" d="M14 8h20l8 12-18 22L6 20Z"/><path class="e-line" d="M6 20h36M14 8l4 12 6 22 6-22 4-12M18 20l6-12 6 12" fill="none" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
export const ICON_AGENT = `<svg class="card-icon" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><rect class="a2-box" x="4" y="10" width="26" height="18" rx="3"/><text class="a2-code" x="17" y="23.5" text-anchor="middle">402</text><path class="i-line" d="M30 19h6" stroke-width="2" stroke-dasharray="3 3"/><rect class="i-paper" x="30" y="26" width="16" height="12" rx="1"/><path class="i-edge" d="M30 26h16v12H30ZM30 26l8 6 8-6" fill="none" stroke-width="1.2"/><circle class="i-seal" cx="38" cy="32.5" r="2.2"/></svg>`;

/** Our pool: notes stay put inside; the ETH that ZC pays the pool flows out to the treasury. */
export function poolArt() {
  const r = rng(91);
  const pts = [];
  for (let tries = 0; pts.length < 34 && tries < 4000; tries++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * 66;
    const q = { x: 110 + Math.cos(a) * d, y: 120 + Math.sin(a) * d };
    if (pts.every((o) => Math.hypot(o.x - q.x, o.y - q.y) > 15)) pts.push(q);
  }
  const dots = pts.map((q) => `<circle class="i-dot" cx="${n(q.x)}" cy="${n(q.y)}" r="4.5"/>`).join("");
  const eth = (x, y, k) => `<path class="p-eth p-eth-${k}" d="M${x} ${y - 11}l7 11-7 4-7-4Z M${x} ${y + 6}l7-4-7 10-7-10Z"/>`;
  return `<svg class="pool-svg" viewBox="0 0 400 240" role="img" aria-labelledby="pool-art-t"><title id="pool-art-t">The pool's notes stay where they are, while the ETH that ZC pays the pool travels out to the project treasury.</title>
<circle class="i-pool" cx="110" cy="120" r="84"/><circle class="p-ring" cx="110" cy="120" r="84" fill="none" stroke-width="3"/>${dots}
<path class="p-flow" d="M200 120H300" fill="none" stroke-width="2" stroke-dasharray="5 7"/>${eth(236, 120, 1)}${eth(270, 120, 2)}
<g transform="translate(340 150)"><path class="c-slate" d="M-36-52 0-74l36 22Z"/><rect class="p-bank" x="-32" y="-52" width="64" height="52"/><path class="p-col" d="M-22-46v40M-8-46v40M8-46v40M22-46v40" stroke-width="5"/><rect class="c-slate" x="-36" y="-4" width="72" height="6"/></g>
<text class="c-label" x="110" y="228" text-anchor="middle">the pool, unchanged</text><text class="c-label" x="340" y="178" text-anchor="middle">treasury</text><text class="c-label" x="253" y="100" text-anchor="middle">ETH</text></svg>`;
}
