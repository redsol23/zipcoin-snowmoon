// Copies the proving artifacts into public/ so the browser proves from our own origin (served at /artifacts/*):
// the Privacy Pools ceremony files, and the Semaphore files whose hashes are pinned in
// packages/sdk/artifacts/semaphore/manifest.json (fetched by scripts/fetch-semaphore-artifacts.mjs).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sdk = path.resolve(here, "../../../packages/sdk/artifacts");
const pub = path.resolve(here, "../public/artifacts");

fs.mkdirSync(pub, { recursive: true });
for (const f of fs.readdirSync(path.join(sdk, "artifacts"))) fs.copyFileSync(path.join(sdk, "artifacts", f), path.join(pub, f));

const semDir = path.join(sdk, "semaphore");
const manifest = JSON.parse(fs.readFileSync(path.join(semDir, "manifest.json"), "utf8"));
const missing = Object.keys(manifest.files).filter((f) => !fs.existsSync(path.join(semDir, f)));
if (missing.length) {
  console.error(`Semaphore artifacts missing (${missing.length}); run: node scripts/fetch-semaphore-artifacts.mjs`);
  process.exit(1);
}
fs.mkdirSync(path.join(pub, "semaphore"), { recursive: true });
for (const [f, want] of Object.entries(manifest.files)) {
  const buf = fs.readFileSync(path.join(semDir, f));
  if (`sha256:${createHash("sha256").update(buf).digest("hex")}` !== want) {
    console.error(`${f} doesn't match its pinned hash; refusing to serve it`);
    process.exit(1);
  }
  fs.writeFileSync(path.join(pub, "semaphore", f), buf);
}
console.log(`artifacts -> ${pub} (Semaphore depths ${manifest.depths.join("-")} verified)`);
