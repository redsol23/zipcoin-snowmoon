#!/usr/bin/env node
/**
 * Fetches the Semaphore v4 proving artifacts we serve ourselves and verifies them against the pinned SHA-256 hashes
 * in packages/sdk/artifacts/semaphore/manifest.json. Files are ~2-3.5 MB each (70 MB for depths 1-16), so they are
 * gitignored and fetched on setup instead of committed.
 *
 *   node scripts/fetch-semaphore-artifacts.mjs                 download missing files, verify all (fails on mismatch)
 *   node scripts/fetch-semaphore-artifacts.mjs --pin 1-16      (maintainers) download depths and rewrite the manifest
 *
 * Why depths 1-16: a group of up to 65,536 members needs at most depth 16, which covers every badge tier and merchant
 * payer group for launch. The contract accepts up to 32; add depths with --pin when a group grows past that.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "packages/sdk/artifacts/semaphore");
const manifestPath = path.join(dir, "manifest.json");
fs.mkdirSync(dir, { recursive: true });

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function download(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (attempt === 3) throw new Error(`could not download ${url}: ${e.message}`);
    }
  }
}

const args = process.argv.slice(2);
const pinAt = args.indexOf("--pin");

if (pinAt >= 0) {
  const [lo, hi] = (args[pinAt + 1] ?? "1-16").split("-").map(Number);
  const version = "4.13.0";
  const source = `https://snark-artifacts.pse.dev/semaphore/${version}`;
  const files = {};
  for (let d = lo; d <= hi; d++) {
    for (const ext of ["wasm", "zkey"]) {
      const name = `semaphore-${d}.${ext}`;
      const buf = await download(`${source}/${name}`);
      fs.writeFileSync(path.join(dir, name), buf);
      files[name] = `sha256:${sha256(buf)}`;
      console.log(`pinned ${name} ${files[name]}`);
    }
  }
  fs.writeFileSync(manifestPath, JSON.stringify({ project: "semaphore", version, source, depths: [lo, hi], files }, null, 2) + "\n");
  console.log(`wrote ${path.relative(root, manifestPath)}`);
  process.exit(0);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
let fetched = 0;
for (const [name, want] of Object.entries(manifest.files)) {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, await download(`${manifest.source}/${name}`));
    fetched++;
  }
  const got = `sha256:${sha256(fs.readFileSync(file))}`;
  if (got !== want) {
    fs.rmSync(file);
    console.error(`${name}: hash mismatch (expected ${want}, got ${got}); deleted it. Refusing to continue.`);
    process.exit(1);
  }
}
console.log(`semaphore artifacts: ${Object.keys(manifest.files).length} verified (${fetched} downloaded)`);
