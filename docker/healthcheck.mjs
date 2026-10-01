// Docker HEALTHCHECK probe: `node healthcheck.mjs <url>` exits 0 when the URL answers 2xx within 5 seconds.
// Plain Node, no dependencies, so it works in every zipnet image (and with a read-only root filesystem).
const url = process.argv[2];
if (!url) {
  console.error("usage: node healthcheck.mjs <url>");
  process.exit(2);
}
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
