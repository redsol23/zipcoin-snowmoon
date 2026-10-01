// Renders the still poster of the living Veridia scene (the image shown before /veridia-scene.js loads, and without
// JavaScript) by running the scene itself in poster mode: a fixed seed, fixed light, one frame. No npm packages.
//
//   node site/tools/render-poster.mjs && python site/tools/images.py poster
//
// Output: .local/site/poster/veridia-scene.png (1600 × 820), which images.py turns into site/src/static/img/
// veridia-scene-{800,1600}.{avif,webp}. Set CHROME=/path/to/chrome if the browser isn't found.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..", "src", "static");
const dir = path.resolve(here, "..", "..", ".local", "site", "poster");
fs.mkdirSync(dir, { recursive: true });
const url = (f) => pathToFileURL(path.join(src, f)).href;

fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: "Newsreader"; src: url("${url("fonts/newsreader-text-italic.woff2")}"); font-style: italic; }
@font-face { font-family: "IBM Plex Sans"; src: url("${url("fonts/ibm-plex-sans-500.woff2")}"); font-weight: 500 700; }
:root { --ink: #18241f; --paper: #fbf8ef; color-scheme: light; }
html, body { margin: 0; background: #eef2ef; }
.v-stage { position: relative; width: 1600px; height: 820px; }
canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
</style>
<div class="v-live" data-poster><div class="v-stage"><canvas class="v-canvas"></canvas><p class="v-tip" hidden></p></div></div>
<p style="font: italic 1px Newsreader">.</p><p style="font: 500 1px 'IBM Plex Sans'">.</p>
<script src="${url("veridia-scene.js")}"></script>`);

const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
const browser = process.env.CHROME ?? [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
  path.join(local, "Chromium", "Application", "chrome.exe"),
].find((c) => fs.existsSync(c));
if (!browser) throw new Error("no Chromium-family browser found; set CHROME");

const png = path.join(dir, "veridia-scene.png");
fs.rmSync(png, { force: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "poster-"));
const r = spawnSync(browser, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
  "--force-device-scale-factor=1", "--allow-file-access-from-files", `--user-data-dir=${profile}`,
  "--virtual-time-budget=4000", "--window-size=1600,820", `--screenshot=${png}`,
  pathToFileURL(path.join(dir, "index.html")).href,
], { encoding: "utf8", timeout: 60_000 });
fs.rmSync(profile, { recursive: true, force: true });
if (!fs.existsSync(png)) throw new Error(`no screenshot\n${r.stderr}`);
console.log(`rendered ${path.relative(process.cwd(), png)}`);
