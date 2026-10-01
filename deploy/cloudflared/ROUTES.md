# Hostnames, DNS and access checklist

Every hostname is a proxied CNAME to the tunnel (`<TUNNEL_UUID>.cfargotunnel.com`), created with
`cloudflared tunnel route dns zipnet <hostname>`. The VPS has no open inbound port, so Cloudflare is the only way in.
Replace `zipcoin.org` if the domain differs (it is also `ZIPNET_DOMAIN` in `deploy/compose/.env`).

## Routes

| Hostname | Service (compose) | Public? | Notes |
|---|---|---|---|
| `app.zipcoin.org` | `edge:8080` → `web:3100` | Public | The wallet. Never framed: `frame-ancestors 'none'`, `X-Frame-Options: DENY` (set by the edge proxy) |
| `api.zipcoin.org` | `stats:8750` | Public | Read-only JSON; CORS limited to zipcoin.org; per-IP rate limit on the visitor address cloudflared appends to `X-Forwarded-For` |
| `postman.zipcoin.org` | `postman:8710` | Public | `/asp` and `/health` only, both read-only. Wallets and every courier (other operators' too) read `/asp`, so it cannot sit behind Access |
| `courier1.zipcoin.org` … `courierN` | `courierN:8720` | Public | Wallets post proofs here; the stats API probes `/health`. Anyone may run a courier, so these are open by design |
| `veridia.zipcoin.org` | `veridia:8730` | Public | `/feed`, `/cast`: read-only story feed |
| `archive.zipcoin.org` | `archive:8740` | Public | The x402 demo merchant |

## What needs Cloudflare Access

Nothing on the list above has an admin surface today: the postman, couriers, stats and Veridia expose only public,
read-only or proof-submission routes, and their keys never leave the box. Keep it that way:

- **Internal-only routes are blocked at the edge, not gated.** The local-chain dev pages (`/dev/*`, `/api/dev/*`)
  answer 404 from the internet.
- **Any future admin route** (for example a postman admin page, a log viewer or a metrics dashboard) goes on its own
  hostname such as `ops.zipcoin.org`, behind a Cloudflare Access application (Zero Trust → Access → Applications →
  Self-hosted; policy: allow the owner's email or a hardware-key identity provider, session 12 h). Never add admin
  paths to the public hostnames above; Access on a path prefix is easy to get wrong.
- **SSH is not on the tunnel.** Administer over Tailscale (optional, `deploy/bootstrap.sh --tailscale`) or the
  provider's console. If you ever put SSH on the tunnel, it must be an Access-protected SSH application.

## Cloudflare zone settings

- SSL/TLS mode: **Full** (the tunnel is already encrypted end to end; there is no origin certificate to check).
- Always Use HTTPS: on. HSTS is sent by the edge proxy for app; enable zone HSTS only once every subdomain is
  HTTPS-only.
- Caching: the default (static assets only) is fine. Add a Cache Rule **bypass** for `api.zipcoin.org`, `postman.*`,
  `courier*.*` and `veridia.*` so stale JSON is never served.
- WAF / Bot Fight Mode: leave Bot Fight Mode **off** for `postman.*`, `courier*.*` and `api.*`: other operators'
  couriers and wallets fetch them non-interactively and a challenge page breaks them. Use a
  rate-limiting rule instead (e.g. 300 requests / 10 s / IP on `courier*` POSTs).
- Logs: Cloudflare keeps request logs on its side per the plan; nothing on the box logs visitor addresses (the edge
  proxy keeps no access log; the stats API counts per-IP requests in memory only).

## Framing and CSP

Set by `deploy/compose/Caddyfile` on responses for `app.zipcoin.org`: `Content-Security-Policy: frame-ancestors
'none'`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`.

- The CSP only sets `frame-ancestors`. A full `default-src` policy for the web app belongs in the app (it knows its
  RPC and courier origins); don't add a stricter one at the edge without testing proving (WebAssembly needs
  `'wasm-unsafe-eval'`) and the wallet connectors.
- Do not enable Cloudflare features that inject scripts into pages (Rocket Loader, Zaraz, Web Analytics auto-inject,
  email obfuscation) on app: they break the privacy promise.

## Checklist

- [ ] Tunnel created; credentials in `$ZIPNET_ROOT/secrets/cloudflared_credentials.json` (600); UUID in
      `$ZIPNET_ROOT/config/cloudflared.yml`
- [ ] DNS routes: app, api, postman, courier1 (… courierN), veridia, archive
- [ ] `docker compose logs cloudflared` shows 4 registered connections
- [ ] `curl -sI https://app.zipcoin.org | grep -i frame` shows `frame-ancestors 'none'` and `DENY`
- [ ] `curl -s -o /dev/null -w '%{http_code}' https://app.zipcoin.org/api/dev/faucet` prints 404
- [ ] `curl -s https://api.zipcoin.org/health` and `https://postman.zipcoin.org/health` answer JSON
- [ ] SSL/TLS mode Full, Always Use HTTPS on, cache bypass for the JSON hosts, no Bot Fight Mode on them
- [ ] From outside: `nmap -Pn <server IP>` shows no open TCP port
