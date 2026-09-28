// Copies the ceremony artifacts into public/ so the browser can prove (served at /artifacts/*).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const from = path.resolve(here, "../../../packages/sdk/artifacts/artifacts");
const to = path.resolve(here, "../public/artifacts");
fs.mkdirSync(to, { recursive: true });
for (const f of fs.readdirSync(from)) fs.copyFileSync(path.join(from, f), path.join(to, f));
console.log(`artifacts -> ${to}`);
