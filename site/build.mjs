// Builds the static site into site/public. Zero dependencies: Node's standard library only.
//
//   node site/build.mjs              the live site, into site/public
//
// Pages: the homepage (src/index.html), the /learn/ hub and its topic pages (src/learn/), the 404, and the Veridia
// residents' pages, which are generated from src/veridia.mjs. It fills in the shared header and footer from
// src/partials, inlines the illustrations from src/art.mjs (so one stylesheet can color them for day and night),
// adds share links and a preview card to each page, and copies src/static as-is. The preview cards are written as
// HTML to .local/site/cards/ and rendered to src/static/og/*.png separately; see site/README.md.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as art from "./src/art.mjs";
import { writeCards } from "./src/cards.mjs";
import { RESIDENTS, hubBody, portrait, residentBody } from "./src/veridia.mjs";
import { contractsHtml } from "./src/ledger.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "src");
const out = path.join(here, "public");
const srcPath = (file) => path.join(src, file);

const slots = {
  mark: art.MARK,
  moon: art.moon(),
  land: art.heroLand(),
  "step-zip": art.STEP.zip,
  "step-crowd": art.STEP.crowd,
  "step-prove": art.STEP.prove,
  "step-paid": art.STEP.paid,
  courier: art.courierArt(),
  veridia: art.veridia(),
  pool: art.poolArt(),
  cover: art.coverArt(),
  bands: art.bandsArt(),
  "icon-emerald": art.ICON_EMERALD,
  "icon-agent": art.ICON_AGENT,
  "icon-quiet": art.ICON_QUIET,
  "icon-veridia": art.ICON_VERIDIA,
  "icon-novel": art.ICON_NOVEL,
  "icon-faq": art.ICON_FAQ,
  defs: art.defsSvg(),
  // the ledger's static half: roles and controllers from the stats allowlist (apps/stats/public-contracts.json)
  "ledger-contracts": contractsHtml(),
};

const topics = ["privacy", "tax", "couriers", "veridia", "agents", "novel", "faq"];
// The transparency pages read live numbers from api.zipcoin.org (static/data.js)
const data = ["ledger", "privacy-meter", "status"];
const pages = ["index.html", "learn/index.html", ...topics.map((t) => `learn/${t}/index.html`), ...data.map((d) => `${d}/index.html`), "404.html"];
// Each page's footer opens with a link onward: from the homepage to the details, and back again.
const cta = {
  "index.html": '<a href="/learn/">Learn how it works →</a>',
  "learn/index.html": '<a href="/">Back to the homepage</a>',
  // topic and resident pages end with their own pager, so their footers need no extra link
};

// The preview card for each page: its name under /og/, and what it shows. Titles and lines default to the page's
// own og:title and og:description.
const cardArt = {
  "learn/privacy/index.html": art.STEP.crowd,
  "learn/tax/index.html": art.bandsArt(),
  "learn/couriers/index.html": art.courierArt(),
  "learn/veridia/index.html": art.ICON_VERIDIA,
  "learn/agents/index.html": art.ICON_AGENT,
  "learn/novel/index.html": art.ICON_NOVEL,
  "learn/faq/index.html": art.ICON_FAQ,
};
const cardOverride = {
  "index.html": { title: "The private money of <cite>Snowmoon</cite>, made real on Ethereum.", line: "Private by default, with sales tax paid in real time. A fan project." },
  "learn/index.html": { title: "How zipcoin works", line: "Seven short pages: privacy, sales tax, couriers, Veridia, agents, the novel, and questions." },
};

/** The site path a source page is served at, e.g. "learn/faq/index.html" -> "/learn/faq/". */
const urlOf = (file) => "/" + file.replace(/index\.html$/, "");
const cardName = (file) => (file === "index.html" ? "home" : file.replace(/\/index\.html$/, "").replaceAll("/", "-"));
const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const text = (html) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const meta = (html, attr) => html.match(new RegExp(`<meta (?:property|name)="${attr}" content="([^"]*)">`))?.[1] ?? "";

// Every link that leaves the site sends no referrer and gives the new page no handle on this one.
const external = (html) =>
  html.replace(/<a\b[^>]*\bhref="https?:\/\/[^>]*>/g, (tag) => (/\brel=/.test(tag) ? tag : tag.replace(/>$/, ' rel="noreferrer noopener">')));

const partial = (name) => fs.readFileSync(srcPath(`partials/${name}.html`), "utf8").trimEnd();

/** Plain share links: nothing loads from X or Farcaster until someone clicks. */
function shareRow(url, message) {
  const u = encodeURIComponent(`https://zipcoin.org${url}`);
  const t = encodeURIComponent(message);
  return `<p class="share wrap"><span class="share-label">Share</span> <a href="https://x.com/intent/post?text=${t}&amp;url=${u}" aria-label="Share on X">X</a> <a href="https://warpcast.com/~/compose?text=${t}&amp;embeds%5B%5D=${u}" aria-label="Share on Farcaster">Farcaster</a></p>\n`;
}

function renderText(source, file, { share } = {}) {
  let html = source
    .replace(/<!--part:([a-z]+)-->/g, (_, k) =>
      // mark the current page in the nav
      partial(k).replaceAll(`<a href="${urlOf(file)}">`, `<a href="${urlOf(file)}" aria-current="page">`),
    )
    .replace("<!--slot:cta-->", cta[file] ?? "")
    .replace(/<!--art:([a-z-]+)-->/g, (_, k) => {
      if (!(k in slots)) throw new Error(`${file}: unknown art slot ${k}`);
      return slots[k];
    });
  if (share) {
    const row = shareRow(urlOf(file), share);
    html = html.includes("<!--slot:share-->") ? html.replace("<!--slot:share-->", row) : html.replace('<nav class="pager wrap"', row + '<nav class="pager wrap"');
  }
  return external(html);
}

/** The generated pages' <head>, from src/partials/head.html. */
const headFor = ({ title, description, url }) =>
  partial("head").replaceAll("{{title}}", esc(title)).replaceAll("{{description}}", esc(description)).replaceAll("{{url}}", url) + "\n";

const bodyShell = (main) => `<body class="page-learn">
<a class="skip" href="#main">Skip to content</a>
<!--art:defs-->

<!--part:header-->

${main}

<!--part:footer-->
</body>
</html>
`;

// ---------------------------------------------------------------- pages

const built = []; // { file, html }
const cards = [];

function addPage(file, source, { share, card } = {}) {
  let html = renderText(source, file, { share });
  if (card) {
    const name = cardName(file);
    const title = card.title ?? meta(html, "og:title");
    const line = card.line ?? meta(html, "og:description");
    const alt = `${text(title)}: ${text(line)}`;
    const image = `https://zipcoin.org/og/${name}.png`;
    html = html
      .replace(/(<meta (?:property="og:image"|name="twitter:image") content=")[^"]*(">)/g, `$1${image}$2`)
      .replace(/(<meta (?:property="og:image:alt"|name="twitter:image:alt") content=")[^"]*(">)/g, `$1${esc(alt)}$2`);
    cards.push({ name, title, line: esc(line), url: urlOf(file), layout: card.layout, artHtml: card.art });
    if (!fs.existsSync(path.join(src, "static", "og", `${name}.png`))) console.warn(`card og/${name}.png not rendered yet`);
  }
  built.push({ file, html });
}

for (const file of pages) {
  const source = fs.readFileSync(srcPath(file), "utf8");
  if (file === "404.html") { addPage(file, source); continue; }
  const topic = /^learn\/[a-z]+\/index\.html$/.test(file);
  const art_ = cardArt[file];
  const withShare = topic ? `${meta(source, "og:title")}: ${meta(source, "og:description")}` : undefined;
  addPage(file, source, {
    share: withShare && text(withShare),
    card: { ...(cardOverride[file] ?? {}), layout: art_ ? "icon" : "scene", art: art_ },
  });
}

// Veridia: a hub and one page per resident
const hubSummary = "Seven residents and three shops from Snowmoon, living on zipcoin as AI agents.";
addPage("veridia/index.html", headFor({ title: "The people of Veridia", description: hubSummary, url: "/veridia/" }) + bodyShell(hubBody()), {
  share: "The people of Veridia: a city from Snowmoon, living on zipcoin.",
  card: { title: "The people of Veridia", line: hubSummary, layout: "icon", art: `<div class="og-faces">${RESIDENTS.slice(0, 8).map((r) => portrait(r)).join("")}</div>` },
});
RESIDENTS.forEach((r, i) => {
  const file = `veridia/${r.slug}/index.html`;
  const description = `${r.line} ${r.shop ? "A shop" : "A resident"} of ${r.city}, in Veridia: a city from Snowmoon, living on zipcoin.`;
  addPage(file, headFor({ title: r.name, description, url: `/veridia/${r.slug}/` }) + bodyShell(residentBody(r, i)), {
    share: `${r.name}, of ${r.city} in Veridia: a city from Snowmoon, living on zipcoin.`,
    card: { title: r.name, line: esc(r.line), layout: "icon", art: `${portrait(r, "portrait")}<p class="og-where">${r.city}, Veridia</p>` },
  });
});

// ---------------------------------------------------------------- write

// Sync rather than wipe and recopy: on Windows a file a local server still has open can't be deleted.
const written = new Set();
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else {
      fs.copyFileSync(a, b);
      written.add(b);
    }
  }
}
function prune(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      prune(p);
      if (fs.readdirSync(p).length === 0) fs.rmdirSync(p);
    } else if (!written.has(p)) fs.rmSync(p);
  }
}

copyDir(path.join(src, "static"), out);
for (const { file, html } of built) {
  fs.mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
  fs.writeFileSync(path.join(out, file), html);
  written.add(path.join(out, file));
}
prune(out);

writeCards(cards, {
  dir: path.join(here, "..", ".local", "site", "cards"),
  stylesheetPath: path.join(src, "static", "styles.css"),
  fontsDir: "../../../site/src/static/fonts",
});

let bytes = 0;
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else bytes += fs.statSync(p).size;
  }
};
walk(out);
console.log(`built site/public: ${built.length} pages, ${cards.length} preview cards, ${(bytes / 1024).toFixed(0)} KB total`);
