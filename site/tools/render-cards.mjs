// Renders the preview cards (1200 × 630) that build.mjs writes as HTML into .local/site/cards/, using any installed
// Chromium-family browser in headless mode. No npm packages. Output: site/src/static/og/<name>.png, which
// `python site/tools/images.py cards` then shrinks (Pillow).
//
//   node site/build.mjs && node site/tools/render-cards.mjs && python site/tools/images.py cards && node site/build.mjs
//
// Set CHROME=/path/to/chrome if the browser isn't found.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cards = path.resolve(here, "..", "..", ".local", "site", "cards");
const out = path.resolve(here, "..", "src", "static", "og");

function findBrowser() {
  if (process.env.CHROME) return process.env.CHROME;
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ];
  const pw = path.join(local, "ms-playwright");
  if (fs.existsSync(pw)) {
    for (const d of fs.readdirSync(pw).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
      candidates.push(path.join(pw, d, "chrome-win", "chrome.exe"), path.join(pw, d, "chrome-win64", "chrome.exe"));
    }
  }
  return candidates.find((c) => fs.existsSync(c));
}

const browser = findBrowser();
if (!browser) throw new Error("no Chromium-family browser found; set CHROME");
if (!fs.existsSync(cards)) throw new Error("no cards; run node site/build.mjs first");
fs.mkdirSync(out, { recursive: true });

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cards-"));
for (const file of fs.readdirSync(cards).filter((f) => f.endsWith(".html"))) {
  const png = path.join(out, file.replace(/\.html$/, ".png"));
  const r = spawnSync(browser, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
    "--force-device-scale-factor=1", "--allow-file-access-from-files", `--user-data-dir=${profile}`,
    "--virtual-time-budget=3000", "--window-size=1200,630", `--screenshot=${png}`,
    pathToFileURL(path.join(cards, file)).href,
  ], { encoding: "utf8", timeout: 60_000 });
  if (!fs.existsSync(png)) throw new Error(`${file}: no screenshot\n${r.stderr}`);
  console.log(`rendered og/${path.basename(png)}`);
}
fs.rmSync(profile, { recursive: true, force: true });
