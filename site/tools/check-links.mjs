// Checks every internal link and asset reference in site/public: the file must exist (a directory means its
// index.html) and a #fragment must match an id on the target page. Also flags localhost and non-absolute
// canonical/OG URLs. Zero dependencies.
//
//   node site/tools/check-links.mjs                 checks site/public
//   node site/tools/check-links.mjs --dir <dir>     checks another output directory under site/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirArg = process.argv.indexOf("--dir");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", dirArg > -1 ? process.argv[dirArg + 1] : "public");
const pages = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".html")) pages.push(p);
  }
};
walk(root);

const ids = new Map();
const idsOf = (file) => {
  if (!ids.has(file)) ids.set(file, new Set([...fs.readFileSync(file, "utf8").matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  return ids.get(file);
};
const fileFor = (urlPath) => {
  let f = path.join(root, decodeURIComponent(urlPath));
  if (urlPath.endsWith("/")) f = path.join(f, "index.html");
  else if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
  return f;
};

const problems = [];
let checked = 0;
for (const page of pages) {
  const html = fs.readFileSync(page, "utf8");
  const rel = "/" + path.relative(root, page).split(path.sep).join("/");
  const pageUrl = rel.replace(/index\.html$/, "");
  const refs = [...html.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
  for (const m of html.matchAll(/\ssrcset="([^"]+)"/g)) refs.push(...m[1].split(",").map((s) => s.trim().split(/\s+/)[0]));
  for (const ref of refs) {
    if (/^(https?:|mailto:)/.test(ref)) continue;
    checked++;
    const [p, frag] = ref.split("#");
    const target = p === "" ? page : fileFor(p.startsWith("/") ? p : path.posix.join(path.posix.dirname(pageUrl + "x"), p));
    if (!fs.existsSync(target)) { problems.push(`${rel}: ${ref} -> missing`); continue; }
    if (frag && target.endsWith(".html") && !idsOf(target).has(frag)) problems.push(`${rel}: ${ref} -> no id "${frag}"`);
  }
  if (/localhost|127\.0\.0\.1/.test(html)) problems.push(`${rel}: mentions localhost`);
  // the only address on the site is the ZC token contract
  for (const m of html.matchAll(/0x[0-9a-fA-F]{40}/g)) if (m[0].toLowerCase() !== "0x2ca7b61b23b15e75ac7ab60dd6f627895d64a46e") problems.push(`${rel}: address ${m[0]}`); // guard:allow
  for (const m of html.matchAll(/<(?:link rel="canonical" href|meta property="og:(?:url|image)" content|meta name="twitter:image" content)="([^"]+)"/g)) {
    if (!m[1].startsWith("https://zipcoin.org/")) problems.push(`${rel}: not absolute: ${m[1]}`);
    else if (/\.(png|jpe?g|webp)$/.test(m[1]) && !fs.existsSync(path.join(root, new URL(m[1]).pathname))) problems.push(`${rel}: card image missing: ${m[1]}`);
  }
}

// the sitemap lists every page that has a canonical URL
const sitemap = fs.readFileSync(path.join(root, "sitemap.xml"), "utf8");
const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
for (const page of pages) {
  const canon = fs.readFileSync(page, "utf8").match(/<link rel="canonical" href="([^"]+)"/)?.[1];
  if (canon && !listed.includes(canon)) problems.push(`sitemap: missing ${canon}`);
}
for (const u of listed) if (!u.startsWith("https://zipcoin.org/") || !fs.existsSync(fileFor(new URL(u).pathname))) problems.push(`sitemap: bad ${u}`);
if (!/Sitemap: https:\/\/zipcoin\.org\/sitemap\.xml/.test(fs.readFileSync(path.join(root, "robots.txt"), "utf8"))) problems.push("robots.txt: no sitemap line");

console.log(`${pages.length} pages, ${checked} internal references, ${listed.length} sitemap URLs`);
console.log(problems.length ? problems.join("\n") : "all internal links resolve; no localhost; canonical/OG URLs absolute; sitemap and robots OK");
process.exit(problems.length ? 1 : 0);
