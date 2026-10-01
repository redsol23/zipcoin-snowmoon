// Preview cards (1200 × 630) for sharing: one per page, written by build.mjs as HTML into .local/site/cards/ and
// rendered to PNG by tools/render-cards.mjs. They reuse the site's stylesheet and drawings, always in the light theme.

import fs from "node:fs";
import path from "node:path";

import * as art from "./art.mjs";

const CARD_CSS = `
html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: var(--bg); }
.og-card { position: relative; width: 1200px; height: 630px; overflow: hidden; }
.og-card .sky { z-index: 0; }
.og-card .moon { position: absolute; z-index: 1; width: 360px; right: 70px; top: -10px; }
.og-card .land { position: absolute; z-index: 2; left: 0; right: 0; bottom: 0; height: 330px; margin: 0; }
.og-copy { position: absolute; z-index: 3; left: 72px; top: 56px; width: 640px; }
.og-scene .og-copy { width: 760px; }
.og-brand { display: flex; align-items: center; gap: 12px; font-family: var(--display); font-size: 34px; margin: 0 0 30px; color: var(--ink); }
.og-brand .mark { width: 34px; height: 34px; }
.og-card h1 { font-size: 76px; line-height: 1.02; letter-spacing: -0.02em; margin: 0 0 22px; max-width: none; }
.og-card h1.long { font-size: 62px; }
.og-line { font-family: var(--sans); font-size: 26px; line-height: 1.4; color: var(--ink-2); margin: 0; }
.og-url { position: absolute; z-index: 3; right: 72px; top: 64px; margin: 0; font-family: var(--sans); font-size: 20px; color: var(--ink-2); }
.og-art { position: absolute; z-index: 3; right: 72px; top: 140px; width: 400px; height: 400px; display: grid; place-items: center; }
.og-art svg { width: 100%; height: auto; max-height: 400px; overflow: visible; }
.og-art .portrait { width: 340px; }
.og-art .og-where { position: absolute; bottom: -8px; left: 0; right: 0; text-align: center; font-family: var(--sans); font-size: 24px; color: var(--ink-2); margin: 0; }
.og-faces { display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px; width: 100%; }
.og-faces svg { width: 100%; }
.og-icon .og-copy::after { content: ""; display: block; width: 90px; height: 6px; border-radius: 3px; background: var(--pad); margin-top: 34px; }
`;

/** The card page for one site page. `layout` is "scene" (the winter valley) or "icon" (a drawing on the right). */
export function cardHtml({ title, line, url, layout, artHtml, stylesheet, fontsDir }) {
  // always the light theme, whatever the rendering browser prefers
  const css = stylesheet.replaceAll("prefers-color-scheme: dark", "prefers-color-scheme: no-preference-here").replaceAll('url("/fonts/', `url("${fontsDir}/`) + CARD_CSS;
  const long = title.replace(/<[^>]+>/g, "").length > 34 ? ' class="long"' : "";
  const scene = layout === "scene" ? `${art.moon()}${art.heroLand()}` : `${art.defsSvg()}<div class="og-art">${artHtml}</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light"><style>${css}</style></head>
<body><div class="og-card og-${layout}"><div class="sky"></div>${scene}
<div class="og-copy"><p class="og-brand">${art.MARK}<span>zipcoin</span></p><h1${long}>${title}</h1><p class="og-line">${line}</p></div>
<p class="og-url">zipcoin.org${url === "/" ? "" : url}</p></div></body></html>`;
}

/** Writes every card as HTML; the PNGs are rendered separately (see site/README.md). */
export function writeCards(cards, { dir, stylesheetPath, fontsDir }) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".html")) fs.rmSync(path.join(dir, f));
  const stylesheet = fs.readFileSync(stylesheetPath, "utf8");
  for (const c of cards) fs.writeFileSync(path.join(dir, `${c.name}.html`), cardHtml({ ...c, stylesheet, fontsDir }));
}
