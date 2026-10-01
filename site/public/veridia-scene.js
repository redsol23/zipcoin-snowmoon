// zipcoin.org: a living Veridia. An illustration of a day in the city, played from a small local script: the novel's
// residents walk the roads, pay at shops (the tax split off, a little burned), send, knock, speak, post and poll, and
// couriers carry sealed envelopes. It makes no requests and shows only public kinds of action.
//
// Loaded by main.js when the scene nears the viewport, over a still poster image. One canvas; the town is painted
// once into an offscreen layer (with its lights on a second one), characters and effects are cached sprites, the
// simulation ticks at 20 Hz and draws at the display rate (30 fps on phones). It stops off screen and in hidden tabs,
// and is a still frame under reduced motion.
"use strict";

(function () {
  const W = 1600;
  const H = 820;
  const TICK = 0.05;
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  const phone = matchMedia("(max-width: 699px)");
  const darkQ = matchMedia("(prefers-color-scheme: dark)");

  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x6d2b79f5) >>> 0;
      return s / 4294967296;
    };
  }

  const C = {
    snow: "#eef2ef", drift: "#e4ebe7", shade: "#d3dddc", shade2: "#c5d1d1", road: "#dde3de", roadEdge: "#b4bfb8", roadDash: "#c6cfc9",
    pine1: "#33463e", pine2: "#475a50", pine3: "#6b7b71", pineSnow: "#f5f8f5", trunk: "#3d4e45",
    stone: "#c9d0ca", stoneDark: "#9ba69d", roof: "#5b6b61", roofBrown: "#7a5a3c", roofSlate: "#496789", window: "#4a5a52", warm: "#f2c35a",
    water: "#b3c9d0", waterDeep: "#97b3bd", mountain: "#d6dcd7", mountainShade: "#bfc9c3",
    pad: "#22a866", padDeep: "#178052", candle: "#d6a01e", slate: "#496789", slateDeep: "#354e69", lichen: "#6e7a70", pineCoat: "#3d4e45",
    ink: "#18241f", paper: "#fbf8ef", skin: "#ecd9c3", hairDark: "#2c3a33", hairBrown: "#7a5a3c", hairGrey: "#9aa59c",
  };

  // ---------------------------------------------------------------- the town
  const TOWNS = { Meldan: [430, 330], "Sadzu Du": [1090, 210], Dzego: [1345, 395], Freetown: [1050, 595], "Greater Plum Harbor": [255, 660] };
  // each road as quadratic segments [x0, y0, cx, cy, x1, y1]
  const ROADS = [
    ["Meldan", "Sadzu Du", [430, 330, 620, 290, 740, 275], [740, 275, 860, 260, 1090, 210]],
    ["Sadzu Du", "Dzego", [1090, 210, 1240, 290, 1345, 395]],
    ["Meldan", "Freetown", [430, 330, 560, 460, 700, 530], [700, 530, 840, 600, 1050, 595]],
    ["Freetown", "Dzego", [1050, 595, 1210, 510, 1345, 395]],
    ["Meldan", "Greater Plum Harbor", [430, 330, 330, 500, 255, 660]],
    ["Greater Plum Harbor", "Freetown", [255, 660, 560, 680, 860, 640], [860, 640, 1000, 622, 1050, 595]],
  ];
  const SHOPS = [
    { name: "Beautiful Plants", town: "Sadzu Du", at: [1130, 276] },
    { name: "Kalimar Kitchen", town: "Meldan", at: [560, 396] },
    { name: "the food trucks", town: "Dzego", at: [1352, 446] },
    { name: "Hydrafill", town: "Freetown", at: [1223, 700] },
  ];
  const BOARD = { town: "Meldan", at: [359, 306] };
  const SQUARE = { town: "Freetown", at: [985, 566] };
  const LABELS = [
    ["Meldan", 300, 372, 1], ["Sadzu Du", 1090, 138, 1], ["Dzego", 1452, 318, 1], ["Freetown", 1070, 764, 1], ["Greater Plum Harbor", 236, 612, 1],
    ["Kalimar forest", 470, 578, 0], ["Len Su street", 958, 262, 0], ["Beautiful Plants", 1132, 304, 0], ["the square", 985, 608, 0],
    ["Hydrafill", 1223, 720, 0], ["food trucks", 1356, 478, 0], ["the board", 359, 258, 0], ["Kalimar Kitchen", 660, 392, 0],
    ["archive node", 692, 214, 0], ["school", 195, 704, 0],
  ];

  // the public cast: home town, portrait details, habits, who they're close to, a few lines
  const CAST = [
    ["Gladias", "Meldan", "glasses", { eat: 5, post: 3, vote: 3, allowance: 2, zip: 1, rest: 3 }, ["Seila", "Febric", "Hreda"], ["Did I send myself funds before dinner?", "The forest paths are quiet tonight.", "Tea, please. The small one."]],
    ["Seila", "Meldan", "longhair", { allowance: 5, eat: 3, knock: 2, vote: 3, speak: 1, rest: 2 }, ["Febric", "Hreda", "Gladias", "Mov"], ["Eat something warm.", "I'll ask nicely first.", "Door's open, come in."]],
    ["Febric", "Greater Plum Harbor", "beanie", { eat: 4, post: 3, speak: 1, rest: 4 }, ["Hreda", "Seila"], ["Gladias forgot his zipcoins again.", "x plus one, obviously.", "Lessons by the pier today."]],
    ["Hreda", "Greater Plum Harbor", "bob", { zip: 3, eat: 2, rest: 5 }, ["Febric", "Seila"], ["Saving this one.", "Into the crowd it goes.", "Quiet day."]],
    ["Zei", "Dzego", "headphones", { eat: 4, post: 4, speak: 2, vote: 2, rest: 2 }, ["Gladias", "Mov"], ["Number Ten, please.", "Zero knowledge, full stomach.", "Ask me about proofs."]],
    ["Mov", "Meldan", "hood", { knock: 5, speak: 2, eat: 2, rest: 2 }, ["Seila", "Zei"], ["No time to knock twice.", "Found them.", "Open up."]],
    ["Evelor", "Freetown", "grey", { poll: 4, speak: 2, eat: 2, rest: 3 }, ["Seila"], ["More lanterns on the paths?", "Proof published, as always.", "Common knowledge, coming up."]],
  ];

  function darkness(d) {
    const h = d.getHours() + d.getMinutes() / 60;
    const night = h < 6 || h >= 21 ? 1 : h < 8 ? 1 - (h - 6) / 2 : h >= 17.5 ? (h - 17.5) / 3.5 : 0;
    return Math.max(0, Math.min(1, night));
  }

  function roadPoints(segs) {
    const out = [];
    for (const [x0, y0, cx, cy, x1, y1] of segs) {
      const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 14);
      for (let i = out.length ? 1 : 0; i <= n; i++) {
        const t = i / n, u = 1 - t;
        out.push(u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1);
      }
    }
    return out;
  }
  const EDGES = ROADS.map(([a, b, ...segs]) => ({ a, b, segs, pts: roadPoints(segs) }));

  // ---------------------------------------------------------------- painting the town once
  function paintTown(g, lights) {
    const r = rng(3724);
    const shadows = [];
    const things = [];
    const windows = [];
    const lamps = [];
    const chimneys = [];
    const ao = (x, y, rx, ry) => shadows.push(x, y, rx, ry);

    // ground: snowfields with cold shade and a few warm highlights
    g.fillStyle = C.snow;
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 46; i++) {
      g.fillStyle = i % 3 ? C.drift : C.shade;
      g.globalAlpha = i % 3 ? 0.7 : 0.3;
      g.beginPath();
      g.ellipse(r() * W, r() * H, 50 + r() * 140, 10 + r() * 22, 0, 0, 7);
      g.fill();
    }
    g.globalAlpha = 1;
    // the mountain, lit from the left
    g.fillStyle = C.mountain;
    g.beginPath(); g.moveTo(396, 256); g.lineTo(550, 40); g.lineTo(600, 90); g.lineTo(660, 30); g.lineTo(834, 256); g.fill();
    g.fillStyle = C.mountainShade;
    g.beginPath(); g.moveTo(660, 30); g.lineTo(834, 256); g.lineTo(706, 256); g.quadraticCurveTo(700, 140, 660, 30); g.fill();
    g.beginPath(); g.moveTo(550, 40); g.lineTo(600, 90); g.lineTo(612, 256); g.lineTo(586, 256); g.quadraticCurveTo(584, 130, 550, 40); g.fill();
    g.fillStyle = C.pineSnow;
    g.beginPath(); g.moveTo(550, 40); g.lineTo(520, 84); g.lineTo(558, 72); g.lineTo(600, 92); g.lineTo(660, 30); g.lineTo(694, 76); g.lineTo(650, 64); g.fill();
    g.fillStyle = C.stoneDark;
    g.beginPath(); g.moveTo(588, 214); g.lineTo(610, 184); g.lineTo(632, 214); g.fill();
    g.fillStyle = C.trunk; g.fillRect(605, 200, 10, 14);
    windows.push(610, 206, 1.6);
    // the sea and the harbor
    g.fillStyle = C.water;
    g.beginPath(); g.moveTo(0, 700); g.bezierCurveTo(120, 670, 230, 740, 380, 725); g.bezierCurveTo(470, 715, 520, 770, 560, 820); g.lineTo(0, 820); g.fill();
    g.strokeStyle = C.waterDeep; g.lineWidth = 1.4;
    for (let i = 0; i < 7; i++) { g.beginPath(); g.moveTo(20 + i * 12, 730 + i * 12); g.quadraticCurveTo(80 + i * 12, 726 + i * 12, 140 + i * 12, 730 + i * 12); g.stroke(); }
    g.fillStyle = C.stoneDark; g.fillRect(250, 690, 10, 46); g.fillRect(250, 732, 72, 6);
    lamps.push(318, 728);
    // roads: an edge, the packed snow, a dashed track
    const road = (w, color, dash) => {
      g.strokeStyle = color; g.lineWidth = w; g.lineCap = "round"; g.setLineDash(dash);
      for (const e of EDGES) { g.beginPath(); g.moveTo(e.segs[0][0], e.segs[0][1]); for (const s of e.segs) g.quadraticCurveTo(s[2], s[3], s[4], s[5]); g.stroke(); }
      g.setLineDash([]);
    };
    road(15, C.roadEdge, []);
    road(12, C.road, []);
    road(1.5, C.roadDash, [5, 8]);
    // street lamps along the roads
    for (const e of EDGES) for (let i = 10; i < e.pts.length / 2 - 4; i += 12) lamps.push(e.pts[i * 2] + 9, e.pts[i * 2 + 1] - 4);

    // things that stand on the ground, drawn back to front
    const pine = (x, y, s, shade) => things.push(y, () => {
      g.fillStyle = shade; g.beginPath(); g.moveTo(x, y - 17 * s); g.lineTo(x + 7.5 * s, y); g.lineTo(x - 7.5 * s, y); g.fill();
      g.fillStyle = "rgba(20,32,28,0.18)"; g.beginPath(); g.moveTo(x, y - 17 * s); g.lineTo(x + 7.5 * s, y); g.lineTo(x + 1 * s, y); g.fill();
      g.fillStyle = C.pineSnow; g.beginPath(); g.moveTo(x, y - 17 * s); g.lineTo(x + 2.8 * s, y - 10.5 * s); g.lineTo(x - 2.8 * s, y - 10.5 * s); g.fill();
      g.fillStyle = C.trunk; g.fillRect(x - 1.2 * s, y - 1, 2.4 * s, 3);
    }) && ao(x + 2 * s, y + 1, 9 * s, 2.6 * s);
    const ROOFS = [C.roof, C.roof, C.roofBrown, C.roofSlate];
    const house = (x, y, s, roofColor = ROOFS[(r() * ROOFS.length) | 0], chimney = r() < 0.35) => {
      const w = 22 * s, h = 13 * s, steep = r() < 0.4 ? 0.75 : 0.5;
      ao(x + 3 * s, y + 1, w * 0.62, 4 * s);
      windows.push(x - 5 * s, y - 7.5 * s, 2 * s, x + 5 * s, y - 7.5 * s, 2 * s);
      if (chimney) chimneys.push(x + 5 * s, y - h - h * steep * 0.55 - 2 * s);
      things.push(y, () => {
        g.fillStyle = C.stone; g.fillRect(x - w / 2, y - h, w, h);
        g.fillStyle = "rgba(20,32,28,0.12)"; g.fillRect(x + w / 6, y - h, w / 3, h);
        g.strokeStyle = C.stoneDark; g.lineWidth = 0.5;
        for (let yy = y - 4 * s; yy > y - h; yy -= 4 * s) { g.beginPath(); g.moveTo(x - w / 2, yy); g.lineTo(x + w / 2, yy); g.stroke(); }
        if (chimney) { g.fillStyle = C.roof; g.fillRect(x + 3.6 * s, y - h - h * steep * 0.6 - 2 * s, 3 * s, 7 * s); }
        g.fillStyle = roofColor; g.beginPath(); g.moveTo(x - w / 2 - 3 * s, y - h); g.lineTo(x, y - h - h * steep - 4 * s); g.lineTo(x + w / 2 + 3 * s, y - h); g.fill();
        g.fillStyle = C.pineSnow; g.beginPath(); g.moveTo(x - w / 2 - 3 * s, y - h); g.lineTo(x, y - h - h * steep - 4 * s); g.lineTo(x + w / 2 + 3 * s, y - h); g.lineTo(x + w / 2 - 1 * s, y - h - 2 * s); g.lineTo(x, y - h - h * steep - 1 * s); g.lineTo(x - w / 2 + 1 * s, y - h - 2 * s); g.fill();
        g.fillStyle = C.window; g.fillRect(x - 6 * s, y - 9 * s, 3 * s, 3 * s); g.fillRect(x + 3.5 * s, y - 9 * s, 3 * s, 3 * s);
        g.fillStyle = C.trunk; g.fillRect(x - 1.5 * s, y - 5 * s, 3 * s, 5 * s);
      });
    };
    const court = (x, y, awning, big) => {
      const w = big ? 42 : 28;
      ao(x + 3, y + 1, w * 0.6, 4);
      windows.push(x, y - 9, 3);
      things.push(y, () => {
        g.fillStyle = C.stone; g.fillRect(x - w / 2, y - 18, w, 18);
        g.fillStyle = awning; g.fillRect(x - w / 2 - 2, y - 23, w + 4, 5);
        for (let i = 0; i < w; i += 7) { g.beginPath(); g.moveTo(x - w / 2 + i, y - 18); g.lineTo(x - w / 2 + i + 7, y - 18); g.lineTo(x - w / 2 + i + 3.5, y - 13); g.fill(); }
        g.fillStyle = C.warm; g.globalAlpha = 0.55; g.fillRect(x - w / 2 + 5, y - 11, w - 10, 6); g.globalAlpha = 1;
      });
    };

    // Kalimar forest and groves
    for (let i = 0; i < 160; i++) { const x = 320 + r() * 300, y = 424 + r() * 108; if (x > 520 && y < 440) continue; pine(x, y, 1.1 + r() * 0.8, r() > 0.5 ? C.pine1 : C.pine2); }
    const clearOf = (x, y) => !Object.values(TOWNS).some(([tx, ty]) => Math.hypot(tx - x, ty - y) < 120) && !(x > 300 && x < 650 && y > 400 && y < 560) && !(x > 400 && x < 840 && y < 262) && y > 50 && y < 690
      && !LABELS.some(([, lx, ly, big]) => Math.abs(x - lx) < (big ? 150 : 80) && y > ly - 34 && y < ly + 22);
    for (let g_ = 0, made = 0; made < 18 && g_ < 500; g_++) {
      const gx = 40 + r() * (W - 80), gy = 60 + r() * (H - 180);
      if (!clearOf(gx, gy)) continue;
      made++;
      for (let i = 0, k = 5 + (r() * 9) | 0; i < k; i++) { const x = gx + (r() - 0.5) * 110, y = gy + (r() - 0.5) * 50; if (clearOf(x, y)) pine(x, y, 0.9 + r() * 0.6, r() > 0.55 ? C.pine2 : C.pine3); }
    }
    // Meldan: stone houses around the board
    for (let i = 0, n = 0; n < 16 && i < 80; i++) { const a = r() * 7, d = 30 + r() * 70, x = 430 + Math.cos(a) * d * 1.2, y = 330 + Math.sin(a) * d * 0.6; if (x < 400 && y < 318) continue; n++; house(x, y, 1.1 + r() * 0.3); }
    things.push(306, () => {
      g.fillStyle = C.roof; g.fillRect(338, 290, 3, 18); g.fillRect(377, 290, 3, 18);
      g.fillStyle = "#d8cfb8"; g.fillRect(334, 268, 50, 26); g.strokeStyle = C.roof; g.lineWidth = 1.5; g.strokeRect(334, 268, 50, 26);
    });
    ao(362, 309, 26, 4);
    court(560, 386, C.pad, true);
    // Sadzu Du: the food courts on Len Su street
    for (let i = 0; i < 6; i++) court(1010 + i * 36, 236 - i * 10, i % 2 ? C.slate : C.candle, false);
    court(1130, 266, C.pad, true);
    for (let i = 0; i < 7; i++) house(1030 + r() * 140, 160 + r() * 30, 0.95 + r() * 0.3);
    // Dzego: food trucks with string lights
    for (const [x, y] of [[1300, 414], [1362, 436], [1404, 392]]) {
      ao(x, y + 2, 22, 4);
      lamps.push(x - 10, y - 18, x + 4, y - 19);
      things.push(y, () => {
        g.fillStyle = C.candle; g.fillRect(x - 18, y - 15, 28, 13); g.fillStyle = C.roof; g.fillRect(x + 10, y - 11, 9, 9);
        g.fillStyle = C.paper; g.fillRect(x - 13, y - 12, 11, 5);
        g.fillStyle = C.pine1; g.beginPath(); g.arc(x - 10, y, 3.2, 0, 7); g.arc(x + 13, y, 3.2, 0, 7); g.fill();
      });
    }
    for (let i = 0; i < 6; i++) house(1290 + r() * 140, 350 + r() * 30, 0.95 + r() * 0.3);
    // Freetown: shelters, the square with its ballot box, Hydrafill
    for (let i = 0; i < 12; i++) {
      const x = 1000 + (i % 4) * 46 + r() * 10, y = 648 + Math.floor(i / 4) * 34 + r() * 8;
      ao(x + 2, y + 1, 16, 3.5);
      windows.push(x, y - 3, 2);
      things.push(y, () => {
        g.fillStyle = C.stoneDark; g.beginPath(); g.ellipse(x, y, 16, 11, 0, Math.PI, 0); g.fill();
        g.fillStyle = C.pineSnow; g.beginPath(); g.ellipse(x, y - 8, 11, 4, 0, Math.PI, 0); g.fill();
        g.fillStyle = C.trunk; g.fillRect(x - 3, y - 6, 6, 6);
      });
    }
    g.strokeStyle = C.roadEdge; g.lineWidth = 2; g.beginPath(); g.ellipse(985, 566, 42, 18, 0, 0, 7); g.stroke();
    things.push(575, () => { g.fillStyle = C.slate; g.fillRect(1000, 566, 11, 9); g.fillStyle = C.ink; g.fillRect(1002, 567, 7, 1.3); });
    ao(1223, 704, 22, 4);
    windows.push(1223, 694, 3);
    things.push(704, () => { g.fillStyle = C.slate; g.fillRect(1206, 684, 34, 20); g.fillStyle = C.pineSnow; g.fillRect(1204, 681, 38, 4); g.fillStyle = "#7fb3d6"; g.beginPath(); g.arc(1223, 695, 4, 0, 7); g.fill(); });
    for (let i = 0; i < 3; i++) house(1110 + r() * 80, 600 + r() * 20, 0.95);
    // Greater Plum Harbor: the school and small houses
    house(195, 680, 1.9, C.roofSlate, true);
    for (let i = 0; i < 6; i++) house(275 + (i % 3) * 28, 646 + Math.floor(i / 3) * 34, 0.85);

    // shadows first, then everything back to front
    g.fillStyle = "rgba(38,56,62,0.16)";
    for (let i = 0; i < shadows.length; i += 4) { g.beginPath(); g.ellipse(shadows[i], shadows[i + 1], shadows[i + 2], shadows[i + 3], 0, 0, 7); g.fill(); }
    const order = [];
    for (let i = 0; i < things.length; i += 2) order.push(i);
    order.sort((a, b) => things[a] - things[b]);
    for (const i of order) things[i + 1]();
    // lamp posts
    g.fillStyle = C.roof;
    for (let i = 0; i < lamps.length; i += 2) { g.fillRect(lamps[i] - 0.7, lamps[i + 1], 1.4, 9); g.fillStyle = "#e8dfc4"; g.fillRect(lamps[i] - 2, lamps[i + 1] - 3, 4, 4); g.fillStyle = C.roof; }

    // the lights layer: warm glows for every window and lamp, shown at dusk
    if (lights) {
      // one soft disc, stamped at every window
      const disc = document.createElement("canvas");
      disc.width = disc.height = 64;
      const d = disc.getContext("2d"), gr = d.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, "rgba(255,214,120,0.55)"); gr.addColorStop(1, "rgba(255,214,120,0)");
      d.fillStyle = gr; d.fillRect(0, 0, 64, 64);
      for (let i = 0; i < windows.length; i += 3) { const rad = windows[i + 2] * 5; lights.drawImage(disc, windows[i] - rad, windows[i + 1] - rad, rad * 2, rad * 2); lights.fillStyle = "#ffd98a"; lights.fillRect(windows[i] - windows[i + 2] * 0.6, windows[i + 1] - windows[i + 2] * 0.6, windows[i + 2] * 1.2, windows[i + 2] * 1.2); }
    }
    return { lamps, chimneys };
  }

  // ---------------------------------------------------------------- characters
  /** A resident, drawn on a 24 × 32 grid, facing right, feet at the bottom. */
  function drawPerson(g, look) {
    const coat = { glasses: C.slate, longhair: C.padDeep, beanie: C.slate, bob: C.lichen, headphones: C.candle, hood: C.pineCoat, grey: C.slateDeep }[look];
    if (look === "longhair") { g.fillStyle = C.hairBrown; g.beginPath(); g.ellipse(12, 12, 7, 9, 0, 0, 7); g.fill(); }
    if (look === "hood") { g.fillStyle = coat; g.beginPath(); g.ellipse(12, 10, 7.6, 8, 0, 0, 7); g.fill(); }
    g.fillStyle = C.trunk; g.fillRect(9, 26, 2.6, 6); g.fillRect(12.8, 26, 2.6, 6);
    g.fillStyle = coat; g.beginPath(); g.moveTo(6, 27); g.quadraticCurveTo(7, 15, 12, 15); g.quadraticCurveTo(17, 15, 18, 27); g.fill();
    g.fillStyle = "rgba(20,32,28,0.18)"; g.beginPath(); g.moveTo(12, 15); g.quadraticCurveTo(17, 15, 18, 27); g.lineTo(13, 27); g.fill();
    g.fillStyle = C.skin; g.beginPath(); g.arc(12, 10, 5.2, 0, 7); g.fill();
    g.fillStyle = C.ink; g.fillRect(14.2, 9.2, 1.4, 1.6);
    if (look === "glasses") {
      g.fillStyle = C.hairDark; g.beginPath(); g.arc(12, 8.4, 5.4, Math.PI, 0); g.fill();
      g.strokeStyle = C.ink; g.lineWidth = 0.9; g.beginPath(); g.arc(14.8, 10, 1.9, 0, 7); g.stroke();
      g.fillStyle = C.pad; g.fillRect(7.5, 15, 9.5, 2.6); g.fillRect(14, 16, 2.6, 6);
    } else if (look === "longhair") {
      g.fillStyle = C.hairBrown; g.beginPath(); g.arc(12, 8.6, 5.6, Math.PI, 0); g.fill();
      g.fillStyle = C.candle; g.fillRect(8, 15, 8.5, 2.2);
    } else if (look === "beanie") {
      g.fillStyle = C.pad; g.beginPath(); g.arc(12, 8.6, 5.8, Math.PI, 0); g.fill(); g.fillStyle = C.padDeep; g.fillRect(6.2, 7.6, 11.6, 2.2);
      g.fillStyle = C.candle; g.beginPath(); g.arc(12, 2.4, 1.9, 0, 7); g.fill();
    } else if (look === "bob") {
      g.fillStyle = C.hairDark; g.beginPath(); g.moveTo(6.4, 13); g.quadraticCurveTo(5.4, 3.4, 12, 3.6); g.quadraticCurveTo(18.6, 3.4, 17.6, 13); g.lineTo(16.6, 13); g.quadraticCurveTo(17, 6, 12, 6.2); g.quadraticCurveTo(7, 6, 7.4, 13); g.fill();
      g.fillStyle = C.candle; g.fillRect(8, 15, 8.5, 2);
    } else if (look === "headphones") {
      g.fillStyle = C.hairDark; g.beginPath(); g.arc(9, 6, 2.6, 0, 7); g.arc(12.4, 4.8, 2.8, 0, 7); g.arc(15.4, 6.2, 2.4, 0, 7); g.fill();
      g.strokeStyle = C.slate; g.lineWidth = 1.5; g.beginPath(); g.arc(12, 9.6, 6.2, Math.PI * 1.05, -0.05); g.stroke();
      g.fillStyle = C.slate; g.fillRect(5, 8.6, 2.6, 4); g.fillRect(16.4, 8.6, 2.6, 4);
    } else if (look === "hood") {
      g.fillStyle = C.ink; g.fillRect(12.6, 7.2, 3.6, 1);
    } else if (look === "grey") {
      g.fillStyle = C.hairGrey; g.beginPath(); g.moveTo(6.6, 10); g.quadraticCurveTo(7, 3.6, 12.6, 4); g.quadraticCurveTo(17.6, 4.4, 17.6, 8); g.quadraticCurveTo(13, 7.4, 10.6, 5.8); g.quadraticCurveTo(9, 8.6, 6.6, 10); g.fill();
      g.fillStyle = C.paper; g.beginPath(); g.moveTo(10.4, 15); g.lineTo(12, 18); g.lineTo(13.6, 15); g.fill();
    }
  }
  function drawCourier(g) {
    g.fillStyle = C.trunk; g.fillRect(9.4, 26, 2.4, 6); g.fillRect(12.6, 26, 2.4, 6);
    g.fillStyle = C.slate; g.beginPath(); g.moveTo(5, 28); g.quadraticCurveTo(12, 4, 19, 28); g.fill();
    g.fillStyle = C.slateDeep; g.beginPath(); g.ellipse(12, 10, 6.4, 6.8, 0, 0, 7); g.fill();
    g.fillStyle = C.skin; g.beginPath(); g.arc(12.8, 10.6, 3.8, 0, 7); g.fill();
    g.strokeStyle = "#7a5a3c"; g.lineWidth = 1.2; g.beginPath(); g.moveTo(8, 14); g.lineTo(16, 22); g.stroke();
    g.fillStyle = "#7a5a3c"; g.fillRect(14, 20, 6, 5);
    g.fillStyle = C.paper; g.fillRect(15, 14.4, 8.4, 6); g.strokeStyle = C.stoneDark; g.lineWidth = 0.6; g.strokeRect(15, 14.4, 8.4, 6);
    g.beginPath(); g.moveTo(15, 14.4); g.lineTo(19.2, 17.6); g.lineTo(23.4, 14.4); g.stroke();
    g.fillStyle = C.candle; g.beginPath(); g.arc(19.2, 17.6, 1.3, 0, 7); g.fill();
  }

  // ---------------------------------------------------------------- the scene
  function scene(fig) {
    const stage = fig.querySelector(".v-stage");
    const canvas = fig.querySelector("canvas.v-canvas");
    const tip = fig.querySelector(".v-tip");
    const ctx = canvas && canvas.getContext("2d");
    if (!ctx) return;
    const poster = fig.hasAttribute("data-poster");
    const rand = poster ? rng(99) : Math.random;
    const pick = (xs) => xs[(rand() * xs.length) | 0];
    function weighted(h) {
      let t = 0;
      for (const k in h) t += h[k];
      let x = rand() * t;
      for (const k in h) if ((x -= h[k]) <= 0) return k;
      return "rest";
    }

    function route(from, to) {
      const prev = { [from]: null };
      const queue = [from];
      while (queue.length) {
        const t = queue.shift();
        if (t === to) break;
        for (const e of EDGES) {
          const nx = e.a === t ? e.b : e.b === t ? e.a : null;
          if (nx && !(nx in prev)) { prev[nx] = { t, e }; queue.push(nx); }
        }
      }
      const legs = [];
      for (let t = to; prev[t]; t = prev[t].t) legs.unshift({ e: prev[t].e, fwd: prev[t].e.a === prev[t].t });
      const out = [];
      for (const { e, fwd } of legs) {
        const n = e.pts.length / 2;
        for (let i = 0; i < n; i++) { const k = fwd ? i : n - 1 - i; out.push(e.pts[k * 2], e.pts[k * 2 + 1]); }
      }
      return out;
    }
    function trip(from, fromXY, to, toXY) {
      const pts = [fromXY[0], fromXY[1]];
      if (from !== to) pts.push(...TOWNS[from], ...route(from, to), ...TOWNS[to]);
      pts.push(toXY[0], toXY[1]);
      return pts;
    }

    const people = CAST.map(([name, town, look, habits, close, lines], i) => {
      const a = (i * 2.4) % (Math.PI * 2);
      const home = [TOWNS[town][0] + Math.cos(a) * 44, TOWNS[town][1] + 16 + Math.sin(a) * 22];
      return { name, town, look, home, habits, close, lines, x: home[0], y: home[1], at: town, path: null, k: 0, speed: 30 + rand() * 12, wait: 1 + rand() * 6, then: null, did: "is out for a walk", face: 1, step: rand() * 6 };
    });
    const byName = Object.fromEntries(people.map((p) => [p.name, p]));
    const couriers = [0, 1, 2].map((i) => { const at = Object.keys(TOWNS)[i * 2 % 5]; return { x: TOWNS[at][0], y: TOWNS[at][1], at, path: null, k: 0, speed: 46, job: null, wait: rand() * 3, face: 1, step: 0 }; });

    // effects: a fixed pool, reused
    const COIN = 1, TAG = 2, FLAME = 3, SPARK = 4, LANTERN = 5, RING = 6, CHECK = 7;
    const fx = Array.from({ length: 40 }, () => ({ on: false, kind: 0, x: 0, y: 0, x0: 0, y0: 0, x1: 0, y1: 0, t: 0, life: 1, then: 0 }));
    function spawn(kind, x0, y0, x1, y1, life, then = 0) {
      for (const f of fx) if (!f.on) { f.on = true; f.kind = kind; f.x = f.x0 = x0; f.y = f.y0 = y0; f.x1 = x1; f.y1 = y1; f.t = 0; f.life = life; f.then = then; return f; }
      return null;
    }
    const BUBBLE = { pay: 1, send: 2, burn: 3, post: 4, poll: 5, say: 6 };
    const bubbles = [0, 1, 2].map(() => ({ on: false, who: null, text: "", kind: 0, t: 0, w: 0, bx: 0, by: 0 }));
    function say(p, text, kind) {
      const b = bubbles.find((x) => !x.on) ?? bubbles.reduce((a, x) => (x.t > a.t ? x : a));
      b.on = true; b.who = p; b.text = text; b.kind = kind; b.t = 0; b.w = 0;
    }
    const notes = [];
    const poll = { on: false, t: 0, bars: [0.2, 0.2, 0.2] };
    let focusX = TOWNS.Meldan[0], focusY = TOWNS.Meldan[1], quiet = 0;
    const focus = (x, y) => { focusX = x; focusY = y; quiet = 0; };

    function nearestCourier(x, y) {
      let best = null, d = 1e12;
      for (const c of couriers) if (!c.job) { const q = (c.x - x) ** 2 + (c.y - y) ** 2; if (q < d) { d = q; best = c; } }
      return best ?? couriers[0];
    }
    function sendVia(fromTown, fromXY, toTown, toXY, onArrive) {
      const c = nearestCourier(fromXY[0], fromXY[1]);
      c.job = { toTown, toXY, onArrive, picked: false, fromTown, fromXY };
      c.path = trip(c.at, [c.x, c.y], fromTown, fromXY);
      c.k = 0;
    }
    function go(p, town, xy, then) { p.path = trip(p.at, [p.x, p.y], town, xy); p.k = 0; p.at = town; p.then = then; }
    function rest(p) {
      if (p.at !== p.town || Math.hypot(p.x - p.home[0], p.y - p.home[1]) > 20) go(p, p.town, p.home, () => { p.did = "is home for a while"; });
      else p.wait = 4 + rand() * 6;
    }
    function act(p) {
      const kind = weighted(p.habits);
      const close = p.close.filter((n) => byName[n]);
      if (kind === "eat") {
        const s = pick(SHOPS);
        go(p, s.town, [s.at[0] - 14, s.at[1] + 8], () => {
          p.did = `just paid at ${s.name}`;
          p.face = 1;
          say(p, pick(p.lines), BUBBLE.pay);
          focus(s.at[0], s.at[1]);
          // the coin hops to the till; there the tax splits off: a little burned, a share to the couriers
          spawn(COIN, p.x, p.y - 20, s.at[0], s.at[1] - 16, 0.8, 1);
        });
      } else if (kind === "allowance" && close.length) {
        const to = byName[pick(close)];
        p.did = `just sent an allowance to ${to.name}`;
        say(p, "Allowance sent.", BUBBLE.send);
        focus(p.x, p.y);
        sendVia(p.at, [p.x, p.y], to.at, [to.x, to.y], () => spawn(RING, to.x, to.y - 14, 0, 0, 1.2));
        p.wait = 3 + rand() * 4;
      } else if (kind === "knock" && close.length) {
        const to = byName[pick(close)];
        go(p, to.town, [to.home[0] + 10, to.home[1]], () => {
          p.did = `just burned at ${to.name}'s door`;
          p.face = -1;
          say(p, pick(p.lines), BUBBLE.burn);
          focus(p.x, p.y);
          spawn(FLAME, p.x - 8, p.y - 4, 0, 0, 1.8);
        });
      } else if (kind === "speak") {
        p.did = "just burned to be heard";
        say(p, pick(p.lines), BUBBLE.burn);
        focus(p.x, p.y);
        spawn(LANTERN, p.x, p.y - 26, p.x + 12, p.y - 150, 4);
        p.wait = 3 + rand() * 4;
      } else if (kind === "post") {
        p.did = "just sent an anonymous note to the board";
        say(p, "A note for the board.", BUBBLE.post);
        focus(p.x, p.y);
        sendVia(p.at, [p.x, p.y], BOARD.town, BOARD.at, () => {
          notes.push(BOARD.at[0] - 20 + rand() * 32, BOARD.at[1] - 34 + rand() * 12);
          if (notes.length > 8) notes.splice(0, 2);
          focus(BOARD.at[0], BOARD.at[1]);
        });
        p.wait = 3 + rand() * 4;
      } else if (kind === "poll") {
        go(p, SQUARE.town, [SQUARE.at[0] - 18, SQUARE.at[1] + 6], () => {
          p.did = "just asked a paid poll";
          say(p, pick(p.lines), BUBBLE.poll);
          focus(SQUARE.at[0], SQUARE.at[1]);
          spawn(LANTERN, p.x, p.y - 26, p.x - 10, p.y - 150, 4);
          poll.on = true; poll.t = 0; poll.bars[0] = poll.bars[1] = poll.bars[2] = 0.15;
        });
      } else if (kind === "vote" && poll.on) {
        p.did = "just answered a poll";
        sendVia(p.at, [p.x, p.y], SQUARE.town, SQUARE.at, () => { const i = (rand() * 3) | 0; poll.bars[i] = Math.min(1, poll.bars[i] + 0.22); spawn(CHECK, SQUARE.at[0] + 32, SQUARE.at[1] - 44, 0, 0, 1); });
        p.wait = 3 + rand() * 4;
      } else if (kind === "zip") {
        p.did = "just zipped some savings";
        say(p, pick(p.lines), BUBBLE.pay);
        focus(p.x, p.y);
        spawn(RING, p.x, p.y - 14, 0, 0, 1.4);
        p.wait = 3 + rand() * 4;
      } else rest(p);
    }
    function walk(a, dt) {
      let left = a.speed * dt;
      const pts = a.path;
      while (left > 0 && a.k + 2 < pts.length) {
        const nx = pts[a.k + 2], ny = pts[a.k + 3];
        const dx = nx - a.x, dy = ny - a.y, d = Math.hypot(dx, dy);
        if (Math.abs(dx) > 0.5) a.face = dx > 0 ? 1 : -1;
        if (d <= left) { a.x = nx; a.y = ny; a.k += 2; left -= d; }
        else { a.x += (dx / d) * left; a.y += (dy / d) * left; left = 0; }
      }
      a.step += dt * 9;
      return a.k + 2 >= pts.length;
    }
    function tick(dt) {
      for (const p of people) {
        if (p.path) { if (walk(p, dt)) { p.path = null; const t = p.then; p.then = null; if (t) t(); p.wait = 3 + rand() * 5; } }
        else if ((p.wait -= dt) <= 0) act(p);
      }
      for (const c of couriers) {
        if (c.path) {
          if (walk(c, dt)) {
            c.path = null;
            const j = c.job;
            if (j && !j.picked) { j.picked = true; c.path = trip(j.fromTown, [c.x, c.y], j.toTown, j.toXY); c.k = 0; c.at = j.toTown; }
            else if (j) { j.onArrive(); c.job = null; c.wait = 1 + rand() * 2; }
          }
        } else if ((c.wait -= dt) <= 0) {
          const to = pick(Object.keys(TOWNS));
          c.path = trip(c.at, [c.x, c.y], to, TOWNS[to]); c.k = 0; c.at = to; c.wait = 2 + rand() * 4;
        }
      }
      for (const f of fx) {
        if (!f.on) continue;
        f.t += dt;
        const k = Math.min(1, f.t / f.life);
        if (f.kind === COIN || f.kind === SPARK) {
          // an arc from start to end
          f.x = f.x0 + (f.x1 - f.x0) * k;
          f.y = f.y0 + (f.y1 - f.y0) * k - Math.sin(k * Math.PI) * (f.kind === COIN ? 26 : 40);
        } else if (f.kind === LANTERN) { f.x = f.x0 + (f.x1 - f.x0) * k; f.y = f.y0 + (f.y1 - f.y0) * k; }
        else if (f.kind === TAG) f.y = f.y0 - k * 18;
        if (f.t >= f.life) {
          f.on = false;
          if (f.kind === COIN && f.then) {
            spawn(TAG, f.x1 + 10, f.y1 - 6, 0, 0, 1.6);
            spawn(FLAME, f.x1 - 8, f.y1 + 2, 0, 0, 1.6);
            const c = nearestCourier(f.x1, f.y1);
            spawn(SPARK, f.x1, f.y1, c.x, c.y - 18, 1.1);
          }
        }
      }
      for (const b of bubbles) if (b.on && (b.t += dt) > 3.4) b.on = false;
      if (poll.on && (poll.t += dt) > 45) poll.on = false;
      if ((quiet += dt) > 14) { const t = pick(Object.keys(TOWNS)); focusX = TOWNS[t][0]; focusY = TOWNS[t][1]; quiet = 0; }
    }

    // ---------------------------------------------------------------- drawing
    let w = 0, h = 0, s = 1, dpr = 1, camX = 0, camY = 0, unit = 34, base = null, town0 = null, lights = null, vignette = null;
    let town = { lamps: [], chimneys: [] };
    let tint = 0, glowA = 0, tintFill = "", ink = C.ink, paper = C.paper, labelW = [];
    const sprites = new Map();
    const labelRects = new Float32Array(LABELS.length * 4);

    function sprite(key, drawFn, gw, gh) {
      let c = sprites.get(key);
      if (!c) {
        c = document.createElement("canvas");
        const scale = (unit / 32) * dpr;
        c.width = Math.ceil(gw * scale); c.height = Math.ceil(gh * scale);
        const g = c.getContext("2d");
        if (key.endsWith("<")) { g.translate(c.width, 0); g.scale(-scale, scale); } else g.scale(scale, scale);
        drawFn(g);
        sprites.set(key, c);
      }
      return c;
    }
    function softDisc(key, rgb, a) {
      return sprite(key, (g) => { const gr = g.createRadialGradient(12, 12, 0, 12, 12, 12); gr.addColorStop(0, `rgba(${rgb},${a})`); gr.addColorStop(1, `rgba(${rgb},0)`); g.fillStyle = gr; g.fillRect(0, 0, 24, 24); }, 24, 24);
    }

    function setLight() {
      // always a winter evening at least: a little dusk, the first windows lit
      const d = poster ? 0 : darkness(new Date());
      const floor = darkQ.matches ? 0.45 : 0.2;
      const k = Math.max(d, floor);
      tint = k * 0.28;
      glowA = Math.min(1, k * 1.5);
      const fill = `rgba(28,46,86,${tint.toFixed(3)})`;
      if (fill !== tintFill) { tintFill = fill; compose(); }
    }
    // the town at this hour: the painted layer, the dusk wash and the lit windows, flattened into one image
    function compose() {
      if (!town0) return;
      const g = base.getContext("2d");
      g.globalAlpha = 1;
      g.drawImage(town0, 0, 0);
      if (tint > 0.01) { g.fillStyle = tintFill; g.fillRect(0, 0, base.width, base.height); }
      if (glowA > 0.02) { g.globalAlpha = glowA; g.drawImage(lights, 0, 0); g.globalAlpha = 1; }
    }

    function size() {
      dpr = poster ? 1 : Math.min(devicePixelRatio || 1, phone.matches ? 1 : 1.5);
      w = canvas.clientWidth; h = canvas.clientHeight;
      if (!w || !h) return;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      // desktop: the whole town; phones: two thirds of it, and the camera drifts to where things happen
      s = phone.matches && !poster ? h / H : Math.max(w / W, h / H);
      unit = phone.matches ? 34 : Math.max(30, Math.min(40, 42 * s));
      const cs = getComputedStyle(document.documentElement);
      ink = cs.getPropertyValue("--ink").trim() || C.ink;
      paper = cs.getPropertyValue("--paper").trim() || C.paper;
      sprites.clear();
      // the town, painted once at this scale
      town0 = document.createElement("canvas");
      town0.width = Math.ceil(W * s * dpr); town0.height = Math.ceil(H * s * dpr);
      lights = document.createElement("canvas");
      base = document.createElement("canvas");
      lights.width = base.width = town0.width; lights.height = base.height = town0.height;
      const g = town0.getContext("2d"), l = lights.getContext("2d");
      g.scale(s * dpr, s * dpr); l.scale(s * dpr, s * dpr);
      town = paintTown(g, l);
      tintFill = "";
      setLight();
      // a gentle vignette, cached at screen size
      vignette = document.createElement("canvas");
      vignette.width = canvas.width; vignette.height = canvas.height;
      const v = vignette.getContext("2d");
      const gr = v.createRadialGradient(vignette.width / 2, vignette.height / 2, Math.min(vignette.width, vignette.height) * 0.35, vignette.width / 2, vignette.height / 2, Math.max(vignette.width, vignette.height) * 0.72);
      gr.addColorStop(0, "rgba(24,40,52,0)"); gr.addColorStop(1, "rgba(24,40,52,0.22)");
      v.fillStyle = gr; v.fillRect(0, 0, vignette.width, vignette.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      measureLabels();
      camera(true);
    }
    const labelFont = (big) => `italic ${big ? (phone.matches ? 15 : Math.round(Math.max(15, 26 * s))) : (phone.matches ? 12 : Math.round(Math.max(12, 15 * s)))}px Newsreader, Georgia, serif`;

    // each label, set once with its snow halo
    function labelSprite(i, night) {
      const key = `L${i}${night}`;
      let c = sprites.get(key);
      if (!c) {
        const [t, , , big] = LABELS[i], lw = labelW[i], lh = big ? 24 : 17;
        c = document.createElement("canvas");
        c.width = Math.ceil((lw + 8) * dpr); c.height = Math.ceil((lh + 6) * dpr);
        const g = c.getContext("2d");
        g.scale(c.width / (lw + 8), c.height / (lh + 6));
        g.font = labelFont(big); g.lineJoin = "round"; g.textBaseline = "alphabetic";
        g.strokeStyle = night ? "rgba(22,36,48,0.6)" : "rgba(240,244,241,0.9)";
        g.lineWidth = 3.5;
        g.strokeText(t, 4, lh);
        g.fillStyle = night ? "#e6ece8" : big ? "#2f3d36" : "#4a5850";
        g.fillText(t, 4, lh);
        sprites.set(key, c);
      }
      return c;
    }
    function measureLabels() { labelW = LABELS.map(([t, , , big]) => { ctx.font = labelFont(big); return ctx.measureText(t).width; }); }

    function camera(snap) {
      const vw = w / s, vh = h / s;
      const tx = Math.max(0, Math.min(W - vw, focusX - vw / 2)), ty = Math.max(0, Math.min(H - vh, focusY - vh / 2));
      if (snap) { camX = tx; camY = ty; } else { camX += (tx - camX) * 0.02; camY += (ty - camY) * 0.02; }
    }
    const X = (x) => (x - camX) * s;
    const Y = (y) => (y - camY) * s;

    function roundRect(x, y, bw, bh, r) {
      ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + bw, y, x + bw, y + bh, r); ctx.arcTo(x + bw, y + bh, x, y + bh, r); ctx.arcTo(x, y + bh, x, y, r); ctx.arcTo(x, y, x + bw, y, r); ctx.closePath();
    }
    function coin(x, y, r) { ctx.fillStyle = "#b58412"; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); ctx.fillStyle = C.candle; ctx.beginPath(); ctx.arc(x - 0.4, y - 0.4, r * 0.72, 0, 7); ctx.fill(); }
    function flame(x, y, k, t) {
      const f = 1 + Math.sin(t * 18) * 0.08;
      ctx.fillStyle = "rgba(214,160,30,0.9)"; ctx.beginPath(); ctx.moveTo(x, y - 12 * k * f); ctx.quadraticCurveTo(x + 7 * k, y - 2 * k, x, y + 3 * k); ctx.quadraticCurveTo(x - 7 * k, y - 2 * k, x, y - 12 * k * f); ctx.fill();
      ctx.fillStyle = "#fbf1c9"; ctx.beginPath(); ctx.moveTo(x, y - 6 * k * f); ctx.quadraticCurveTo(x + 3 * k, y, x, y + 2 * k); ctx.quadraticCurveTo(x - 3 * k, y, x, y - 6 * k * f); ctx.fill();
    }
    function icon(kind, x, y) {
      if (kind === BUBBLE.pay) coin(x, y, 4.2);
      else if (kind === BUBBLE.send) { ctx.fillStyle = C.paper; ctx.strokeStyle = C.stoneDark; ctx.lineWidth = 1; ctx.fillRect(x - 5, y - 3.5, 10, 7); ctx.strokeRect(x - 5, y - 3.5, 10, 7); ctx.fillStyle = C.candle; ctx.beginPath(); ctx.arc(x, y + 0.5, 1.5, 0, 7); ctx.fill(); }
      else if (kind === BUBBLE.burn) flame(x, y + 3, 0.62, 0);
      else if (kind === BUBBLE.post) { ctx.fillStyle = "#d8cfb8"; ctx.fillRect(x - 4, y - 4, 8, 9); ctx.fillStyle = "#c0392b"; ctx.beginPath(); ctx.arc(x, y - 4, 1.8, 0, 7); ctx.fill(); }
      else if (kind === BUBBLE.poll) { ctx.fillStyle = C.pad; ctx.fillRect(x - 5, y, 3, 4); ctx.fillStyle = C.slate; ctx.fillRect(x - 1.5, y - 4, 3, 8); ctx.fillStyle = C.candle; ctx.fillRect(x + 2, y - 2, 3, 6); }
    }

    function drawAgent(a, key, draw) {
      const moving = !!a.path;
      const bob = moving ? Math.abs(Math.sin(a.step)) * 2 : 0;
      const sp = sprite(key + (a.face < 0 ? "<" : ">"), draw, 24, 32);
      const sw = sp.width / dpr, sh = sp.height / dpr;
      const x = X(a.x), y = Y(a.y);
      const sh_ = softDisc("shadow", "20,34,40", 0.35);
      ctx.drawImage(sh_, x - sw * 0.42, y - sw * 0.14, sw * 0.84, sw * 0.28);
      ctx.drawImage(sp, x - sw / 2, y - sh - bob + 1, sw, sh);
    }

    let tNow = 0;
    function draw() {
      if (!base) return;
      // the town
      ctx.drawImage(base, camX * s * dpr, camY * s * dpr, w * dpr, h * dpr, 0, 0, w, h);
      // ambient: smoke from chimneys, boats on the swell, notes and the poll
      const smoke = softDisc("smoke", "236,240,236", 0.8);
      for (let i = 0; i < town.chimneys.length; i += 2) {
        for (let j = 0; j < 3; j++) {
          const k = ((tNow * 0.18 + j / 3 + i * 0.137) % 1);
          const r = (4 + k * 10) * s * 1.2;
          ctx.globalAlpha = (1 - k) * 0.7;
          ctx.drawImage(smoke, X(town.chimneys[i] + k * 16) - r, Y(town.chimneys[i + 1] - k * 40) - r, r * 2, r * 2);
        }
      }
      ctx.globalAlpha = 1;
      for (const [bx, by, ph] of BOATS) {
        const y = Y(by + Math.sin(tNow * 1.3 + ph) * 1.6), x = X(bx);
        ctx.fillStyle = C.roof; ctx.beginPath(); ctx.moveTo(x - 16 * s, y); ctx.lineTo(x + 16 * s, y); ctx.lineTo(x + 11 * s, y + 7 * s); ctx.lineTo(x - 11 * s, y + 7 * s); ctx.fill();
        ctx.fillStyle = C.pineSnow; ctx.beginPath(); ctx.moveTo(x, y - 18 * s); ctx.lineTo(x + 10 * s, y - 2 * s); ctx.lineTo(x, y - 2 * s); ctx.fill();
      }
      ctx.fillStyle = C.paper;
      for (let i = 0; i < notes.length; i += 2) ctx.fillRect(X(notes[i]), Y(notes[i + 1]), 7 * s + 1, 8 * s + 1);
      if (poll.on) {
        const bx = X(SQUARE.at[0] + 24), by = Y(SQUARE.at[1] - 8), u = Math.max(0.8, s);
        ctx.fillStyle = paper; roundRect(bx, by - 34 * u, 38 * u, 34 * u, 3); ctx.fill();
        ctx.strokeStyle = C.stoneDark; ctx.lineWidth = 1; ctx.stroke();
        const cols = [C.pad, C.slate, C.candle];
        for (let i = 0; i < 3; i++) { ctx.fillStyle = cols[i]; const bh = 26 * u * poll.bars[i]; ctx.fillRect(bx + (5 + i * 11) * u, by - 4 * u - bh, 7 * u, bh); }
      }
      // people and couriers, back to front
      for (const c of couriers) drawAgent(c, "courier", drawCourier);
      for (const p of people) drawAgent(p, p.name, (g) => drawPerson(g, p.look));
      // effects
      for (const f of fx) {
        if (!f.on) continue;
        const a = 1 - f.t / f.life, x = X(f.x), y = Y(f.y);
        ctx.globalAlpha = Math.max(0, Math.min(1, a * 2));
        if (f.kind === COIN) coin(x, y, 4.5);
        else if (f.kind === TAG) { ctx.font = "600 10px 'IBM Plex Sans', system-ui, sans-serif"; ctx.fillStyle = "rgba(24,36,31,0.18)"; roundRect(x + 1, y - 7, 34, 15, 7); ctx.fill(); ctx.fillStyle = C.slate; roundRect(x, y - 8, 34, 15, 7); ctx.fill(); ctx.fillStyle = "#fff"; ctx.textBaseline = "middle"; ctx.fillText("+ tax", x + 5, y); }
        else if (f.kind === FLAME) { ctx.globalAlpha = Math.min(1, a * 3); flame(x, y, 1, tNow); }
        else if (f.kind === SPARK) {
          ctx.fillStyle = "#9db4cf";
          for (let i = 0; i < 4; i++) { const k = Math.max(0, f.t / f.life - i * 0.05), kx = f.x0 + (f.x1 - f.x0) * k, ky = f.y0 + (f.y1 - f.y0) * k - Math.sin(k * Math.PI) * 40; ctx.beginPath(); ctx.arc(X(kx), Y(ky), 2.4 - i * 0.5, 0, 7); ctx.fill(); }
        } else if (f.kind === LANTERN) {
          const gl = softDisc("warm", "255,214,120", 0.9);
          ctx.drawImage(gl, x - 14, y - 14, 28, 28);
          ctx.fillStyle = "#f2c35a"; roundRect(x - 4, y - 5, 8, 10, 2); ctx.fill(); ctx.fillStyle = "#b58412"; ctx.fillRect(x - 4, y - 6, 8, 1.6);
        } else if (f.kind === RING) { ctx.strokeStyle = C.pad; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(x, y, 5 + (1 - a) * 12, 0, 7); ctx.stroke(); }
        else if (f.kind === CHECK) { ctx.strokeStyle = C.pad; ctx.lineWidth = 2.2; ctx.beginPath(); ctx.moveTo(x - 4, y); ctx.lineTo(x - 1, y + 3); ctx.lineTo(x + 4.5, y - 4); ctx.stroke(); }
      }
      ctx.globalAlpha = 1;
      // evening lamps, each flickering a little
      if (glowA > 0.02) {
        const lamp = softDisc("lamp", "255,214,120", 0.85);
        for (let i = 0; i < town.lamps.length; i += 2) {
          ctx.globalAlpha = glowA * (0.8 + Math.sin(tNow * 7 + i) * 0.1 + (Math.sin(tNow * 23 + i * 3) > 0.97 ? -0.3 : 0));
          const r = 16 * s + 4;
          ctx.drawImage(lamp, X(town.lamps[i]) - r, Y(town.lamps[i + 1] - 1) - r, r * 2, r * 2);
        }
        ctx.globalAlpha = 1;
      }
      // birds, now and then
      const bt = (tNow % 38) / 14;
      if (bt < 1) {
        ctx.strokeStyle = tint > 0.2 ? "rgba(236,240,236,0.7)" : "rgba(40,56,50,0.55)"; ctx.lineWidth = 1.2;
        for (let i = 0; i < 3; i++) { const x = X(-60 + bt * 1700 + i * 18), y = Y(120 + Math.sin(bt * 9 + i) * 8 + i * 9), f = Math.sin(tNow * 12 + i) * 2; ctx.beginPath(); ctx.moveTo(x - 5, y - f); ctx.lineTo(x, y); ctx.lineTo(x + 5, y - f); ctx.stroke(); }
      }
      drawLabels();
      drawBubbles();
      drawSnow();
      ctx.drawImage(vignette, 0, 0, w, h);
    }

    function drawLabels() {
      ctx.textBaseline = "alphabetic";
      ctx.lineJoin = "round";
      const night = darkQ.matches;
      for (let i = 0; i < LABELS.length; i++) {
        const [t, lx, ly, big] = LABELS[i];
        const lw = labelW[i], lh = big ? 24 : 17;
        const cx = X(lx), y = Y(ly);
        labelRects[i * 4 + 2] = 0;
        // a label whose place is out of frame stays out; one near an edge is nudged inside it
        if (cx < 0 || cx > w || y < 14 || y > h + 2) continue;
        const x = Math.max(6, Math.min(w - lw - 6, cx - lw / 2)), ry = y - lh + 4;
        let clash = false;
        for (let j = 0; j < i && !clash; j++) if (labelRects[j * 4 + 2] && overlaps(x - 3, ry, lw + 6, lh, labelRects[j * 4], labelRects[j * 4 + 1], labelRects[j * 4 + 2], labelRects[j * 4 + 3])) clash = true;
        if (clash) continue;
        labelRects[i * 4] = x - 3; labelRects[i * 4 + 1] = ry; labelRects[i * 4 + 2] = lw + 6; labelRects[i * 4 + 3] = lh;
        ctx.drawImage(labelSprite(i, night), x - 4, y - lh, lw + 8, lh + 6);
      }
    }
    const overlaps = (ax, ay, aw, ah, bx, by, bw, bh) => ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
    function drawBubbles() {
      ctx.font = `500 ${phone.matches ? 11.5 : 12.5}px "IBM Plex Sans", system-ui, sans-serif`;
      ctx.textBaseline = "middle";
      const bh = phone.matches ? 24 : 26;
      let placed = 0;
      for (const b of bubbles) {
        if (!b.on) continue;
        if (!b.w) b.w = ctx.measureText(b.text).width + 34;
        const px = X(b.who.x), py = Y(b.who.y) - unit - 4;
        // try above, then to either side, then higher; never over a label or another bubble
        let bx = 0, by = 0, ok = false;
        for (let c = 0; c < 6 && !ok; c++) {
          bx = px - b.w / 2 + [0, -b.w / 2 - 8, b.w / 2 + 8, 0, -b.w / 2 - 8, b.w / 2 + 8][c];
          by = py - bh - 10 - (c >= 3 ? bh + 8 : 0);
          bx = Math.max(4, Math.min(w - b.w - 4, bx)); by = Math.max(4, Math.min(h - bh - 4, by));
          ok = true;
          for (let i = 0; i < LABELS.length && ok; i++) if (labelRects[i * 4 + 2] && overlaps(bx, by, b.w, bh, labelRects[i * 4], labelRects[i * 4 + 1], labelRects[i * 4 + 2], labelRects[i * 4 + 3])) ok = false;
          for (const o of bubbles) if (ok && o !== b && o.on && o.placed === placed && overlaps(bx, by, b.w, bh, o.bx, o.by, o.w, bh)) ok = false;
        }
        b.bx = bx; b.by = by; b.placed = placed;
        const inK = Math.min(1, b.t / 0.25), outK = Math.min(1, (3.4 - b.t) / 0.4);
        const sc = 0.85 + 0.15 * (1 - (1 - inK) ** 3);
        ctx.globalAlpha = Math.max(0, Math.min(inK, outK));
        ctx.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * (bx + b.w / 2) * (1 - sc), dpr * (by + bh) * (1 - sc));
        // shadow, tail, body, icon, words
        ctx.fillStyle = "rgba(24,36,31,0.16)"; roundRect(bx + 1, by + 3, b.w, bh, bh / 2); ctx.fill();
        ctx.fillStyle = paper;
        const tx = Math.max(bx + 12, Math.min(bx + b.w - 12, px));
        ctx.beginPath(); ctx.moveTo(tx - 6, by + bh - 1); ctx.lineTo(px, Math.min(py + 2, by + bh + 10)); ctx.lineTo(tx + 6, by + bh - 1); ctx.fill();
        roundRect(bx, by, b.w, bh, bh / 2); ctx.fill();
        ctx.strokeStyle = "rgba(142,153,143,0.8)"; ctx.lineWidth = 1; ctx.stroke();
        icon(b.kind, bx + 14, by + bh / 2);
        ctx.fillStyle = ink; ctx.fillText(b.text, bx + 26, by + bh / 2 + 0.5);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      ctx.globalAlpha = 1;
      placed++;
    }

    const BOATS = [[300, 758, 0], [170, 776, 2.1]];
    const flakes = new Float32Array(phone.matches ? 50 : 90);
    for (let i = 0; i < flakes.length; i++) flakes[i] = rand();
    function drawSnow() {
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.beginPath();
      for (let i = 0; i < flakes.length; i += 2) {
        const x = ((flakes[i] + Math.sin(tNow * 0.4 + i) * 0.01) % 1) * w, y = ((flakes[i + 1] + tNow * (0.025 + (i % 7) * 0.004)) % 1) * h, r = 0.7 + (i % 5) * 0.3;
        ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, 7);
      }
      ctx.fill();
    }

    // ---------------------------------------------------------------- loop
    let raf = 0, last = 0, acc = 0, lastDraw = 0, visible = false;
    function frame(t) {
      raf = 0;
      if (!visible || document.hidden || still.matches) return;
      const dt = Math.min(0.25, (t - (last || t)) / 1000);
      last = t; acc += dt; tNow += dt;
      while (acc >= TICK) { tick(TICK); acc -= TICK; }
      if (phone.matches) camera(false);
      if (!phone.matches || t - lastDraw >= 32) { draw(); lastDraw = t; }
      raf = requestAnimationFrame(frame);
    }
    function start() {
      if (still.matches || poster) { draw(); return; }
      if (!raf && visible && !document.hidden) { last = 0; raf = requestAnimationFrame(frame); }
    }

    // a lived-in start: play the first half-minute at once
    for (let i = 0; i < 500; i++) tick(TICK);
    tNow = 12;
    const ready = () => { size(); draw(); stage.classList.add("v-ready"); if (poster) document.documentElement.dataset.posterReady = "1"; };
    if (poster && document.fonts) document.fonts.ready.then(ready); else setTimeout(ready, 0);
    if (poster) return;
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; start(); }).observe(canvas);
    document.addEventListener("visibilitychange", start);
    still.addEventListener("change", start);
    let rt = 0;
    addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { if (canvas.clientWidth !== w || canvas.clientHeight !== h) { size(); draw(); } }, 150); });
    darkQ.addEventListener("change", () => { size(); draw(); });
    if (document.fonts && document.fonts.status !== "loaded") document.fonts.ready.then(() => { if (base) { measureLabels(); sprites.clear(); draw(); } });
    setInterval(setLight, 60_000);

    // who's that? hover, or tap on a phone
    function hover(e) {
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      let best = null, d = 24 * 24;
      for (const p of people) { const q = (X(p.x) - mx) ** 2 + (Y(p.y) - unit / 2 - my) ** 2; if (q < d) { d = q; best = p; } }
      if (!best) { tip.hidden = true; return; }
      tip.textContent = `${best.name} · ${best.did}`;
      tip.hidden = false;
      tip.style.left = `${Math.min(r.width - tip.offsetWidth - 6, Math.max(6, X(best.x) - tip.offsetWidth / 2))}px`;
      tip.style.top = `${Math.max(6, Y(best.y) - unit - 44)}px`;
    }
    canvas.addEventListener("pointermove", hover);
    canvas.addEventListener("pointerdown", hover);
    canvas.addEventListener("pointerleave", () => { tip.hidden = true; });
  }

  for (const fig of document.querySelectorAll(".v-live")) scene(fig);
})();
