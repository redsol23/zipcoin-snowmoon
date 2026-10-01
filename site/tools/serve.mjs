// A local preview server for site/public that applies the "/*" block of _headers, so the Content-Security-Policy
// is enforced in the browser the same way Cloudflare Pages will enforce it. Zero dependencies.
//
//   node site/tools/serve.mjs [port] [dir]  then open http://localhost:4317/ (dir defaults to public)
//
// It also serves the repository root under /_repo/, which is handy for looking at the preview-card pages in
// .local/site/cards/ (build.mjs writes them).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", process.argv[3] || "public");
const repo = path.resolve(here, "..", "..");
const port = Number(process.argv[2] || 4317);
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".webmanifest": "application/manifest+json" };

const headers = {};
let inAll = false;
for (const line of fs.readFileSync(path.join(root, "_headers"), "utf8").split("\n")) {
  if (!line.startsWith(" ")) inAll = line.trim() === "/*";
  else if (inAll && line.includes(":")) {
    const i = line.indexOf(":");
    // no HTTPS locally, so leave out the upgrade and HSTS
    if (!/Strict-Transport/.test(line)) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace("; upgrade-insecure-requests", "");
  }
}

// Previewing the ledger against a local stats service: DEV_CONNECT_SRC=http://127.0.0.1:8750 adds it to connect-src
// (then open /ledger/?api=http://127.0.0.1:8750). Local only; the published _headers never change.
if (process.env.DEV_CONNECT_SRC && headers["Content-Security-Policy"])
  headers["Content-Security-Policy"] = headers["Content-Security-Policy"].replace(/connect-src ([^;]*)/, `connect-src $1 ${process.env.DEV_CONNECT_SRC}`);

http
  .createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    let base = root;
    if (p.startsWith("/_repo/")) {
      base = repo;
      p = p.slice("/_repo".length);
    }
    if (p.endsWith("/")) p += "index.html";
    let f = path.join(base, p);
    let status = 200;
    if (!f.startsWith(base) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      f = path.join(root, "404.html");
      status = 404;
    }
    const body = fs.readFileSync(f);
    res.writeHead(status, { "Content-Type": types[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-store", ...(base === root ? headers : {}) });
    res.end(body);
  })
  .listen(port, () => console.log(`site/public on http://localhost:${port}/ with ${Object.keys(headers).length} headers from _headers`));
