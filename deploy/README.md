# One-box deployment

The whole off-chain stack on one Ubuntu 24.04 VPS, reachable only through a Cloudflare Tunnel: no inbound port is
open on the server. This is the owner's runbook from a fresh server to a running stack, plus day-2 operations. The
contracts, keys and settings themselves are described in [docs/DEPLOY.md](../docs/DEPLOY.md); this file is about where
and how the services run.

```
Internet ──TLS──▶ Cloudflare ──tunnel (outbound from the box)──▶ cloudflared ─┬─▶ edge (Caddy) ─▶ web      app.
                                                                              ├─▶ stats                   api.
                                                                              ├─▶ postman                 postman.
                                                                              ├─▶ courier1..N             courierN.
                                                                              ├─▶ veridia                 veridia.
                                                                              └─▶ archive                 archive.
Admin: SSH over Tailscale (or the provider console). Nothing else listens on the public IP.
```

| File | What |
|---|---|
| [`bootstrap.sh`](bootstrap.sh) | Hardens a fresh Ubuntu 24.04 box and installs Docker (idempotent) |
| [`compose/docker-compose.yml`](compose/docker-compose.yml) | Every service: images, limits, healthchecks, volumes, secrets |
| [`compose/.env.example`](compose/.env.example), [`compose/env/*.env.example`](compose/env) | Compose settings; per-service settings |
| [`compose/Caddyfile`](compose/Caddyfile) | Edge proxy for the web app: framing headers, internal routes blocked |
| [`compose/couriers.override.example.yml`](compose/couriers.override.example.yml) | Courier 2..N |
| [`cloudflared/config.yml.example`](cloudflared/config.yml.example), [`cloudflared/ROUTES.md`](cloudflared/ROUTES.md) | Tunnel ingress; DNS, Access and header checklist |
| [`../docker/`](../docker) | Image recipes, entrypoint (Docker secrets → env), healthcheck probe |
| [`backup.sh`](backup.sh), [`RESTORE.md`](RESTORE.md) | Encrypted (age) backups with rotation; restore procedure |
| [`ops/healthcheck.sh`](ops/healthcheck.sh), [`ops/crontab.example`](ops/crontab.example) | Uptime check with webhook alerts; the cron table |
| [`ops/release.sh`](ops/release.sh) | Upgrade and rollback by git-SHA image tag |
| [`sepolia.env.example`](sepolia.env.example), [`../scripts/deploy-sepolia.sh`](../scripts/deploy-sepolia.sh) | Sepolia rehearsal of the contract deploy |

## Sizing

Memory limits per container (hard caps; typical use is lower). CPU limits are fractions of a core.

| Service | Memory limit | Node heap | CPU | Notes |
|---|---|---|---|---|
| postman | 256 MB | 192 MB | 0.5 | Rescans pool events on start |
| courier (each) | 512 MB | 384 MB | 1.0 | |
| veridia | 768 MB | 640 MB | 1.0 | Makes Semaphore proofs in Node (the heaviest job on the box) |
| stats | 384 MB | 288 MB | 0.5 | In-memory cache, rebuilt from `deployBlock` on start (about 100 MB in use) |
| web | 1 GB | 768 MB | 1.5 | Next.js server; proving happens in visitors' browsers |
| archive | 256 MB | 192 MB | 0.25 | |
| edge (Caddy) | 128 MB | | 0.5 | |
| cloudflared | 128 MB | | 0.5 | |
| **Total** | **about 3.4 GB** with one courier, +512 MB per extra courier | | | |

- **8 GB / 4 vCPU (recommended)**: everything, two or three couriers, room to build
  images on the box. No swap is created (RAM ≥ 8 GB).
- **4 GB / 2-3 vCPU (minimum)**: runs the stack (the limits add up to about 3.4 GB, and use is
  well below the limits), with the 4 GB swap `bootstrap.sh` adds. Build the **web** image elsewhere, or stop `web`
  while building: `next build` wants 2-3 GB. Consider leaving Veridia off (`COMPOSE_PROFILES=archive`).
- Disk: 40 GB is plenty for images (about 1 GB per service image, shared layers) and backups.
- Bandwidth is small: JSON, proofs, and a few MB of proving artifacts per new visitor (only the depths they need;
  Cloudflare caches them).

## From a fresh VPS to running

Commands marked **laptop** run on your machine; **root** and **zipnet** on the server. `zipcoin.org` stands for your
domain everywhere.

### 1. Before you start

- The domain's DNS is on Cloudflare.
- The contracts are deployed and you have `contracts/deployments/mainnet.json` (docs/DEPLOY.md step 3), or you are
  rehearsing on Sepolia (see [Sepolia rehearsal](#sepolia-rehearsal)) and have `sepolia.json`.
- The keys exist, each funded as docs/DEPLOY.md step 2 says: postman, courier1 (plus a cover-wallet phrase),
  optionally Veridia and the archive. Keep an offline copy of each.
- An RPC endpoint for the services (your own node), a private-mempool endpoint for the couriers, and a rate-limited
  public proxy for browsers.
- A webhook URL for alerts (Slack, Discord, ntfy, a Telegram bridge: anything that accepts a JSON POST).

### 2. Create the server (provider console)

Ubuntu 24.04, your SSH public key, IPv4 + IPv6. In the provider's firewall allow **only** TCP 22 from your own IP for
now (you will remove it in step 3). No other rule: the tunnel and Tailscale are outbound.

### 3. Bootstrap (root)

```sh
# laptop
scp deploy/bootstrap.sh root@<server IP>:
ssh root@<server IP>
# root, on the server: SSH over Tailscale only (recommended)
TS_AUTHKEY=<tailscale auth key> bash bootstrap.sh --admin tailscale --couriers 1
```

- Without `TS_AUTHKEY`, run `tailscale up --hostname zipnet`, log in, then run `bash bootstrap.sh --admin tailscale`
  again: public SSH stays open (rate-limited) until Tailscale is up, so you can't lock yourself out.
- `--admin console` closes SSH entirely (provider web console only); `--admin public-ssh` keeps a rate-limited port 22
  (only as a transition).
- Note the printed uid/gid of the `zipnet` user.
- **Check before closing the root session**: from your laptop, `ssh zipnet@zipnet` (the tailnet name) works. Then
  delete the port-22 rule from the provider firewall. `nmap -Pn <server IP>` from outside should show nothing open.

What it did: user `zipnet` (key-only SSH, sudo, docker group), `PermitRootLogin no`, password and keyboard-interactive
logins off, `UsePAM yes` kept (Ubuntu 24.04 needs it), ufw deny-all inbound, fail2ban, unattended security upgrades
(reboot at 04:30 UTC when needed; `--no-auto-reboot` to disable), Docker Engine + compose plugin with log rotation,
UTC + time sync, swap if RAM < 8 GB, and `/srv/zipnet/{env,secrets,config,deployments,data,backups}`.

### 4. Get the code (zipnet)

```sh
ssh zipnet@zipnet
git clone <repository URL> /srv/zipnet/src
cd /srv/zipnet/src && git checkout <release commit or tag>
```

### 5. Settings (zipnet)

```sh
cd /srv/zipnet/src/deploy/compose
for s in common postman stats web veridia archive; do cp -n env/$s.env.example /srv/zipnet/env/$s.env; done
cp -n env/courier.env.example /srv/zipnet/env/courier1.env
chmod 600 /srv/zipnet/env/*.env
nano /srv/zipnet/env/common.env      # and each other file: replace every <placeholder>
```

### 6. Secrets (zipnet)

One value per file, mode 600; `bootstrap.sh` created them empty (and filled `emerald_session_secret` with a
random value). Paste values without them landing in shell history:

```sh
cd /srv/zipnet/secrets
put() { local v; read -rs -p "$1: " v; echo; printf '%s' "$v" > "$1"; chmod 600 "$1"; }
put postman_key
put courier1_key
put courier1_cover_mnemonic      # the phrase; leave empty for no cover traffic
put veridia_key                  # if COMPOSE_PROFILES has veridia
put archive_key                  # if COMPOSE_PROFILES has archive
put deepseek_api_key             # Emerald and Veridia minds; empty = off / scripted
ls -l                            # every file -rw------- zipnet zipnet
```

Private keys are `0x`-prefixed hex. Empty files mean "not configured".

### 7. Deployment JSON and optional config (zipnet)

```sh
# laptop
scp contracts/deployments/mainnet.json zipnet@zipnet:/srv/zipnet/deployments/
# zipnet (optional files, all read-only in the containers under /etc/zipnet)
nano /srv/zipnet/config/stats-exclude.txt   # the project's own wallets, one per line (private)
nano /srv/zipnet/config/denylist.txt        # postman denylist, if used (then set DENYLIST_FILE in postman.env)
```

### 8. Cloudflare Tunnel (laptop, then zipnet)

```sh
# laptop, with cloudflared installed
cloudflared tunnel login
cloudflared tunnel create zipnet                         # note the UUID; writes ~/.cloudflared/<UUID>.json
for h in app api postman courier1 veridia archive; do cloudflared tunnel route dns zipnet $h.zipcoin.org; done
scp ~/.cloudflared/<UUID>.json zipnet@zipnet:/srv/zipnet/secrets/cloudflared_credentials.json
# zipnet
chmod 600 /srv/zipnet/secrets/cloudflared_credentials.json
cp /srv/zipnet/src/deploy/cloudflared/config.yml.example /srv/zipnet/config/cloudflared.yml
nano /srv/zipnet/config/cloudflared.yml                  # set tunnel: <UUID>; the domain; drop unused hostnames
```

Then work through the zone settings in [cloudflared/ROUTES.md](cloudflared/ROUTES.md).

### 9. Compose settings and build (zipnet)

```sh
cd /srv/zipnet/src/deploy/compose
cp -n .env.example .env
sed -i "s/^ZIPNET_TAG=.*/ZIPNET_TAG=$(git rev-parse --short=12 HEAD)/" .env
nano .env        # ZIPNET_UID/GID (from step 3), ZIPNET_DOMAIN, DEPLOYMENT_FILE, COMPOSE_PROFILES, pinned versions
docker compose config -q && echo config ok
docker compose build                  # 10-20 min the first time; on a 4 GB box see "Sizing"
```

### 10. Start (zipnet)

```sh
docker compose up -d --wait           # returns when every container is healthy (or fails and says which)
docker compose ps
docker compose logs --tail 50 postman courier1 stats web cloudflared
```

The courier bonds on its first start if `BOND_WEI` is set and its key holds the ZC. The stats API needs a few minutes
to index from `deployBlock` before `/v1/status` is complete.

### 11. Verify from outside (laptop)

```sh
curl -s https://api.zipcoin.org/health                 # {"ok":true,...}
curl -s https://api.zipcoin.org/v1/status | jq '.postman.reachable, [.couriers[].reachable]'
curl -s https://postman.zipcoin.org/health | jq .ok
curl -s https://courier1.zipcoin.org/health | jq .
curl -sI https://app.zipcoin.org | grep -iE 'frame|content-security'     # frame-ancestors 'none', DENY
```

Then the rest of the checklist in ROUTES.md and the launch checks in docs/DEPLOY.md step 9 (a small real zip →
unzip through the web app).

### 12. Backups, health checks, alerts (laptop, then zipnet)

```sh
# laptop: the backup identity stays here (and in a second offline place)
age-keygen -o zipnet-backup.key && age-keygen -y zipnet-backup.key       # prints age1...
# zipnet
echo 'age1...' > /srv/zipnet/config/backup-recipients.txt
printf 'ALERT_WEBHOOK_URL=%s\nZIPNET_DOMAIN=zipcoin.org\n' '<your webhook URL>' > /srv/zipnet/config/healthcheck.env
chmod 600 /srv/zipnet/config/healthcheck.env
/srv/zipnet/src/deploy/backup.sh && ls -l /srv/zipnet/backups
/srv/zipnet/src/deploy/ops/healthcheck.sh; echo "exit $?"                  # 0 = all good
crontab /srv/zipnet/src/deploy/ops/crontab.example && crontab -l
```

Copy one backup to your laptop and decrypt it once (RESTORE.md, "Test it"). Set up off-box copies.

## Operations

### Uptime and alerting

Three layers, cheapest first:

1. **Docker** restarts a crashed container (`restart: unless-stopped`) and marks a hung one unhealthy (every service
   has a healthcheck; `docker compose ps` shows it).
2. **On-box check** (`ops/healthcheck.sh`, every 5 min): containers healthy; through Cloudflare, `api.<domain>/health`
   ok and `/v1/status` saying the postman is reachable, the last ASP root is younger than two epochs, and every active
   courier answers; disk under 85 %, memory available. It posts to `ALERT_WEBHOOK_URL` on a new problem, repeats
   hourly while it lasts, and says when it recovers.
3. **Off-box check**, for when the whole box or the tunnel is down (the on-box check can't report that): a free
   external uptime monitor polling `https://api.zipcoin.org/health` and `https://app.zipcoin.org/api/config` every
   5 minutes, plus Cloudflare's own notification for tunnel health (Notifications → Tunnel health alert).

The public status page (zipcoin.org/status) reads the same `/v1/status`.

### Logs

| What | Where |
|---|---|
| Service output | `docker compose logs -f <service>` (from `deploy/compose`); files under `/var/lib/docker/containers/<id>/`, rotated at 10 MB × 5 per container |
| Cron jobs (backup, healthcheck) | `/var/log/zipnet/*.log`, rotated weekly × 8 |
| Docker daemon | `journalctl -u docker` |
| SSH, sudo | `journalctl -u ssh`, `/var/log/auth.log` |
| fail2ban | `/var/log/fail2ban.log`, `sudo fail2ban-client status sshd` |
| Security updates | `/var/log/unattended-upgrades/` |
| Firewall | `sudo ufw status verbose`; blocked packets in `journalctl -k --grep UFW` |

No component logs visitor IP addresses: the edge proxy has no access log, the stats API counts per-IP requests in
memory for one minute, and the services log only their own actions.

### Upgrade

Images are tagged with the git commit they were built from (`ZIPNET_TAG` in `compose/.env`).

```sh
cd /srv/zipnet/src
deploy/ops/release.sh deploy origin/main      # fetch, check out, build :<sha>, back up, switch, wait for health
deploy/ops/release.sh status
```

`deploy` = `build <ref>` then `up <sha>`; on a 4 GB box run `build` with `web` stopped, or build elsewhere and load
the images (`docker save zipnet/web:<sha> | ssh zipnet@zipnet docker load`), then `up <sha>`. Read the release notes
first: anything that changes the deployment JSON, env variables or an on-disk format says so.

### Rollback

```sh
deploy/ops/release.sh rollback                # back to the tag before the last switch
deploy/ops/release.sh rollback <sha>          # or a specific one
```

The old images are still on the box (`release.sh prune` keeps the newest three tags). A rollback also takes a backup
first. If a release migrated state to a new format, restore the pre-upgrade backup as well (RESTORE.md).

### Everyday commands (from `/srv/zipnet/src/deploy/compose`)

```sh
docker compose ps                              # health of everything
docker compose restart courier1                # restart with the same settings
docker compose up -d courier1                  # recreate with new env or secrets
docker compose stop veridia                    # pause the residents
docker stats --no-stream                       # memory and CPU against the limits
```

### More couriers

```sh
sudo bash /srv/zipnet/src/deploy/bootstrap.sh --admin tailscale --couriers 3   # dirs + empty secret files
cp couriers.override.example.yml couriers.override.yml                          # one block per extra courier
echo 'COMPOSE_FILE=docker-compose.yml:couriers.override.yml' >> .env
cp env/courier.env.example /srv/zipnet/env/courier2.env && chmod 600 /srv/zipnet/env/courier2.env
# secrets/courier2_key, courier2_cover_mnemonic; tunnel route + ingress entry for courier2.<domain>
docker compose up -d --wait
```

## Sepolia rehearsal

Real ZC exists only on mainnet, so the rehearsal deploys the deploy script's own test token (`LocalZC`: an ERC20 named
"zipcoin"/"ZC" with 1,000,000,000 minted to the deployer, no holder rewards or transfer hooks). It rehearses the
deployment, the services and the web app end to end; it does not test ZC's own behaviour, which the mainnet fork test
does. Semaphore uses the canonical Sepolia deployment (same address as mainnet, `0x8A1f…693D`; source:
https://docs.semaphore.pse.dev/deployed-contracts), which the script checks on-chain. The 0xbow verifiers and
Entrypoint implementation are deployed fresh from the same sources.

```sh
# laptop, from the repo root (Foundry installed; git submodules checked out: git submodule update --init)
cp deploy/sepolia.env.example ~/zipnet-sepolia.env && chmod 600 ~/zipnet-sepolia.env   # fill it
./scripts/deploy-sepolia.sh --env-file ~/zipnet-sepolia.env              # simulation: nothing is sent
./scripts/deploy-sepolia.sh --env-file ~/zipnet-sepolia.env --broadcast  # the owner, after reading the simulation
```

The simulation writes `contracts/deployments/sepolia-sim-local.json` (gitignored); a broadcast writes
`contracts/deployments/sepolia.json`. Then run the one-box stack against it: copy `sepolia.json` to
`/srv/zipnet/deployments/`, set `DEPLOYMENT_FILE=sepolia.json` in `compose/.env`, a Sepolia `RPC_URL` in
`common.env` and the couriers' env, and use Sepolia-only
keys and a staging domain or hostnames.
