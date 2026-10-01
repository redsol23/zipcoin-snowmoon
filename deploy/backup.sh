#!/usr/bin/env bash
# Encrypted backup of everything that can't be rebuilt from the chain or the repo: postman state, courier jobs,
# Veridia state, the web app's stores (Emerald's budget), the archive's ledger, every key and secret, the env files,
# config and deployment JSONs. Encrypted with age to PUBLIC recipients only: the private identity that can decrypt
# stays off the server (a hardware key or an offline machine).
#
#   deploy/backup.sh                     back up to $ZIPNET_ROOT/backups, keep the newest $KEEP (default 14)
#   deploy/backup.sh --no-pause          don't pause the stateful containers while copying (default: pause for the few
#                                        seconds the copy takes, so no JSON file is caught half-written)
#
# Env: ZIPNET_ROOT (/srv/zipnet), KEEP (14), BACKUP_DIR ($ZIPNET_ROOT/backups),
#      AGE_RECIPIENTS_FILE ($ZIPNET_ROOT/config/backup-recipients.txt: one age1... or ssh-ed25519 public key per line),
#      COMPOSE_DIR ($ZIPNET_ROOT/src/deploy/compose).
# Cron (as the zipnet user, daily 03:15 UTC):
#   15 3 * * * /srv/zipnet/src/deploy/backup.sh >> /var/log/zipnet/backup.log 2>&1
# Restore: deploy/RESTORE.md.
set -euo pipefail
umask 077

ZIPNET_ROOT="${ZIPNET_ROOT:-/srv/zipnet}"
BACKUP_DIR="${BACKUP_DIR:-$ZIPNET_ROOT/backups}"
KEEP="${KEEP:-14}"
AGE_RECIPIENTS_FILE="${AGE_RECIPIENTS_FILE:-$ZIPNET_ROOT/config/backup-recipients.txt}"
COMPOSE_DIR="${COMPOSE_DIR:-$ZIPNET_ROOT/src/deploy/compose}"
PAUSE=1
for a in "$@"; do
  case "$a" in
    --no-pause) PAUSE=0 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

die() { echo "backup: $*" >&2; exit 1; }
command -v age >/dev/null || die "age is not installed (apt-get install age)"
[ -s "$AGE_RECIPIENTS_FILE" ] || die "no recipients in $AGE_RECIPIENTS_FILE (add your age1... public key; see deploy/RESTORE.md)"
if grep -q 'AGE-SECRET-KEY' "$AGE_RECIPIENTS_FILE"; then die "$AGE_RECIPIENTS_FILE contains a PRIVATE key; only public keys belong on the server"; fi
grep -qE '^[[:space:]]*(age1|ssh-)' "$AGE_RECIPIENTS_FILE" || die "$AGE_RECIPIENTS_FILE has no age1.../ssh- public key"
[ -d "$ZIPNET_ROOT/data" ] || die "no $ZIPNET_ROOT/data"
mkdir -p "$BACKUP_DIR"

# What goes in, relative to ZIPNET_ROOT. Missing paths (e.g. veridia not enabled) are skipped.
PATHS=()
for p in data/postman data/veridia data/web data/archive secrets env config deployments; do
  [ -e "$ZIPNET_ROOT/$p" ] && PATHS+=("$p")
done
for d in "$ZIPNET_ROOT"/data/courier*; do
  [ -d "$d" ] && PATHS+=("data/$(basename "$d")")
done

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/zipnet-$STAMP.tar.gz.age"
TMP="$OUT.partial"

# Pause (freeze, not stop) the services that write state, so the copy is consistent. Unpause on any exit.
PAUSED=()
unpause() {
  if [ "${#PAUSED[@]}" -gt 0 ]; then
    (cd "$COMPOSE_DIR" && docker compose unpause "${PAUSED[@]}" >/dev/null 2>&1) || true
  fi
  PAUSED=()
}
trap 'unpause; rm -f "$TMP"' EXIT
if [ "$PAUSE" = "1" ] && [ -f "$COMPOSE_DIR/docker-compose.yml" ] && command -v docker >/dev/null; then
  mapfile -t RUNNING < <(cd "$COMPOSE_DIR" && docker compose ps --status running --services 2>/dev/null || true)
  for s in "${RUNNING[@]}"; do
    case "$s" in postman|courier*|veridia|web|archive) PAUSED+=("$s") ;; esac
  done
  if [ "${#PAUSED[@]}" -gt 0 ]; then (cd "$COMPOSE_DIR" && docker compose pause "${PAUSED[@]}" >/dev/null); fi
fi

# The compose .env (image tag, uid, domain) rides along as a separate file inside the archive
EXTRA=()
if [ -f "$COMPOSE_DIR/.env" ]; then EXTRA=(-C "$COMPOSE_DIR" .env); fi

tar -C "$ZIPNET_ROOT" -czf - "${PATHS[@]}" "${EXTRA[@]}" | age -R "$AGE_RECIPIENTS_FILE" -o "$TMP"
unpause
mv "$TMP" "$OUT"
trap - EXIT

SIZE="$(du -h "$OUT" | cut -f1)"
SUM="$(sha256sum "$OUT" | cut -d' ' -f1)"
echo "$(date -u +%FT%TZ) backup $OUT ($SIZE) sha256 $SUM: ${PATHS[*]}"

# Rotation: keep the newest $KEEP (the UTC timestamp in the name sorts by age)
mapfile -t OLD < <(find "$BACKUP_DIR" -maxdepth 1 -name 'zipnet-*.tar.gz.age' | sort -r | tail -n +"$((KEEP + 1))")
for f in "${OLD[@]}"; do rm -f -- "$f" && echo "rotated out $(basename "$f")"; done
