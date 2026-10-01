# Restoring from a backup

`deploy/backup.sh` writes `$ZIPNET_ROOT/backups/zipnet-<UTC time>.tar.gz.age`, encrypted to the public keys in
`$ZIPNET_ROOT/config/backup-recipients.txt`. Only a holder of a matching **private** age identity can read it, and that
identity never lives on the server.

## Once, before the first backup

On your own machine (or a hardware key via `age-plugin-yubikey`):

```sh
age-keygen -o zipnet-backup.key          # private: keep offline, in two places (password manager + paper/USB)
age-keygen -y zipnet-backup.key          # prints the public key: age1...
```

On the server, as the zipnet user: put the `age1...` line (one per recipient; a second person's key is a good idea)
in `/srv/zipnet/config/backup-recipients.txt`. The script refuses to run if that file holds a private key.

Copy backups off the box as well: the local directory protects against a bad release or a deleted file, not a lost
server. For example a daily `rclone copy /srv/zipnet/backups <remote>:zipnet-backups` or `scp` from your machine.
They are encrypted, so any storage will do.

## What is in a backup

| Path in the archive | What | Losing it means |
|---|---|---|
| `data/postman/postman.json` | The ordered approved-label list | Rebuilding it from `RootUpdated` events plus deposits (slow; see docs/DEPLOY.md step 5) |
| `data/courierN/` | Jobs (`sending` markers, held proofs), stats | Held proofs are lost (users resubmit); in-flight jobs are rechecked on-chain anyway |
| `data/veridia/` | Residents' state and story | Residents start over |
| `data/web/` | `emerald-budget.json` (Emerald's daily model spend) | Today's spend restarts from zero |
| `data/archive/` | The demo merchant's x402 ledger | Prepaid archive calls are gone |
| `secrets/` | Postman, courier, Veridia and archive keys, cover mnemonics, DeepSeek key, session and notify secrets, tunnel credentials | **Keys: funds and bonds.** Keep your own offline copy of each key too |
| `env/`, `config/`, `deployments/`, `.env` | Settings, tunnel config, deployment JSON, the compose `.env` (image tag) | Re-typing settings |

## Restore on the same box (bad release, corrupted state)

```sh
cd /srv/zipnet/src/deploy/compose
docker compose stop                                   # nothing may write while you restore
scp you@laptop:zipnet-backup.key /dev/shm/k           # or type it: the identity only ever lives in RAM here
F=/srv/zipnet/backups/zipnet-<time>.tar.gz.age
mkdir -p /dev/shm/restore
age -d -i /dev/shm/k "$F" | tar -xzf - -C /dev/shm/restore
ls -R /dev/shm/restore | head                         # check it's the one you want

# put back only what you need, e.g. the postman state:
cp -a /dev/shm/restore/data/postman/. /srv/zipnet/data/postman/
# or everything:
#   cp -a /dev/shm/restore/{data,secrets,env,config,deployments} /srv/zipnet/ && cp /dev/shm/restore/.env .
chmod 600 /srv/zipnet/secrets/* /srv/zipnet/env/*

shred -u /dev/shm/k; rm -rf /dev/shm/restore
docker compose up -d --wait
```

Restoring a **courier** onto a different or older state is safe: on start it checks every `sending` job on-chain
before sending anything again (docs/DEPLOY.md step 6).

The **postman** is different: its file is the ordered approved-label list, and every published ASP root is a prefix
of it. A file older than the last published root is missing approvals the chain already committed to, and new
approvals could land in a different order. So restore the newest backup, and before starting the postman compare the
restored `approved` count with the label count behind the latest on-chain root (`/asp` on a running copy, or the
`RootUpdated` events). If the file is behind, rebuild it from `RootUpdated` events plus deposits (docs/DEPLOY.md
step 5) rather than starting from it. Never run two postmans with the same key.

## Restore onto a new box (lost server)

1. New VPS, `deploy/bootstrap.sh` as in deploy/README.md steps 1-3 (use the same `--couriers N`).
2. Clone the repo into `/srv/zipnet/src` (step 4).
3. Decrypt the newest off-box backup as above and copy `data`, `secrets`, `env`, `config`, `deployments` into
   `/srv/zipnet/`, `.env` into `/srv/zipnet/src/deploy/compose/`. Fix `ZIPNET_UID`/`ZIPNET_GID` in `.env` if the new
   user's ids differ, then `chown -R zipnet:zipnet /srv/zipnet && chmod 600 /srv/zipnet/secrets/* /srv/zipnet/env/*`.
4. `git -C /srv/zipnet/src checkout <ZIPNET_TAG from .env>`, build (step 9) and `docker compose up -d --wait`.
   The tunnel credentials came back with the secrets, so the hostnames follow the new box as soon as cloudflared
   connects; no DNS change.
5. **Make sure the old box is really gone** (delete it at the provider) before starting: two postmans or two copies
   of the same courier key would race each other on-chain.

## Test it

Once a month: decrypt the newest backup on your own machine and list it (`age -d -i key F | tar -tzf -`). A backup you
have never opened is a hope, not a backup.
