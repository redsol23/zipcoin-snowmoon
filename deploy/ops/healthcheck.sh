#!/usr/bin/env bash
# Tiny uptime check for the one-box deployment, run from cron every 5 minutes as the zipnet user:
#   */5 * * * * /srv/zipnet/src/deploy/ops/healthcheck.sh >> /var/log/zipnet/healthcheck.log 2>&1
#
# Checks, from the box:
#   - every running compose service is healthy (docker healthchecks), none restarting
#   - the public stats API answers through Cloudflare: /health ok, and /v1/status says the postman is reachable, its
#     last ASP root is younger than MAX_ROOT_EPOCHS epochs, and every active courier is reachable
#   - disk use under DISK_MAX_PCT, available memory over MEM_MIN_MB
# On a new problem it POSTs {"text": "..."} to ALERT_WEBHOOK_URL (Slack/Discord/ntfy/Telegram-bridge style; set your
# own), repeats every REALERT_MIN while it lasts, and sends one "recovered" message when it clears.
#
# Env (or $ZIPNET_ROOT/config/healthcheck.env): ALERT_WEBHOOK_URL (unset = print only), ZIPNET_DOMAIN (zipcoin.org),
# STATUS_URL (https://api.$ZIPNET_DOMAIN/v1/status), MAX_ROOT_EPOCHS (2), DISK_MAX_PCT (85), MEM_MIN_MB (200),
# REALERT_MIN (60), COMPOSE_DIR ($ZIPNET_ROOT/src/deploy/compose).
set -uo pipefail

ZIPNET_ROOT="${ZIPNET_ROOT:-/srv/zipnet}"
# shellcheck disable=SC1091
[ -f "$ZIPNET_ROOT/config/healthcheck.env" ] && . "$ZIPNET_ROOT/config/healthcheck.env"
ZIPNET_DOMAIN="${ZIPNET_DOMAIN:-zipcoin.org}"
STATUS_URL="${STATUS_URL:-https://api.$ZIPNET_DOMAIN/v1/status}"
HEALTH_URL="${HEALTH_URL:-https://api.$ZIPNET_DOMAIN/health}"
MAX_ROOT_EPOCHS="${MAX_ROOT_EPOCHS:-2}"
DISK_MAX_PCT="${DISK_MAX_PCT:-85}"
MEM_MIN_MB="${MEM_MIN_MB:-200}"
REALERT_MIN="${REALERT_MIN:-60}"
COMPOSE_DIR="${COMPOSE_DIR:-$ZIPNET_ROOT/src/deploy/compose}"
STATE="${STATE_FILE:-/var/log/zipnet/healthcheck.state}"

PROBLEMS=()
add() { PROBLEMS+=("$*"); }

# --- containers ----------------------------------------------------------------------------------------------------
if [ -f "$COMPOSE_DIR/docker-compose.yml" ]; then
  while IFS=$'\t' read -r name state health; do
    [ -z "$name" ] && continue
    if [ "$state" != "running" ]; then add "container $name is $state"
    elif [ "$health" = "unhealthy" ]; then add "container $name is unhealthy"
    fi
  done < <(cd "$COMPOSE_DIR" && docker compose ps --all --format '{{.Service}}{{"\t"}}{{.State}}{{"\t"}}{{.Health}}' 2>/dev/null)
else
  add "no compose project at $COMPOSE_DIR"
fi

# --- public endpoints (through Cloudflare, so the tunnel is checked too) ---------------------------------------------
if ! H="$(curl -fsS --max-time 15 "$HEALTH_URL" 2>&1)"; then
  add "stats /health unreachable: ${H:0:200}"
elif [ "$(printf '%s' "$H" | jq -r '.ok' 2>/dev/null)" != "true" ]; then
  add "stats /health not ok: ${H:0:200}"
fi

if S="$(curl -fsS --max-time 20 "$STATUS_URL" 2>/dev/null)"; then
  REPORT="$(printf '%s' "$S" | jq -r --argjson maxEpochs "$MAX_ROOT_EPOCHS" '
    [ (if .postman.configured != true then "postman not configured in stats"
       elif .postman.reachable != true then "postman unreachable: \(.postman.error // "no answer")"
       else empty end),
      (.postman.lastRoot as $r
       | if $r == null then "no ASP root published yet"
         elif $r.ageSec > ($r.epochSec * $maxEpochs) then "last ASP root is \($r.ageSec / 60 | floor) min old (epoch \($r.epochSec / 60 | floor) min)"
         else empty end),
      (.couriers[]? | select(.active == true and .reachable == false) | "courier \(.endpoint) unreachable: \(.error // "no answer")")
    ] | .[]' 2>&1)" || REPORT="could not parse /v1/status"
  while IFS= read -r line; do [ -n "$line" ] && add "$line"; done <<< "$REPORT"
else
  add "stats /v1/status unreachable ($STATUS_URL)"
fi

# --- host ----------------------------------------------------------------------------------------------------------
DISK="$(df --output=pcent "$ZIPNET_ROOT" 2>/dev/null | tail -1 | tr -dc '0-9')"
[ -n "$DISK" ] && [ "$DISK" -gt "$DISK_MAX_PCT" ] && add "disk ${DISK}% full on $ZIPNET_ROOT"
MEM="$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo)"
[ -n "$MEM" ] && [ "$MEM" -lt "$MEM_MIN_MB" ] && add "only ${MEM} MB memory available"

# --- alerting ------------------------------------------------------------------------------------------------------
NOW="$(date +%s)"
HOST="$(hostname)"
notify() {
  local text="$1"
  echo "$(date -u +%FT%TZ) $text"
  if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
    jq -n --arg text "$text" '{text: $text, content: $text}' |
      curl -fsS --max-time 15 -H 'content-type: application/json' --data @- "$ALERT_WEBHOOK_URL" >/dev/null ||
      echo "$(date -u +%FT%TZ) webhook failed"
  fi
}

LAST_SUM=""; LAST_AT=0
# shellcheck disable=SC1090
[ -f "$STATE" ] && . "$STATE"
if [ "${#PROBLEMS[@]}" -gt 0 ]; then
  BODY="$(printf -- '- %s\n' "${PROBLEMS[@]}")"
  SUM="$(printf '%s' "$BODY" | sha256sum | cut -c1-16)"
  if [ "$SUM" != "$LAST_SUM" ] || [ $((NOW - LAST_AT)) -ge $((REALERT_MIN * 60)) ]; then
    notify "zipnet on $HOST: ${#PROBLEMS[@]} problem(s)
$BODY"
    LAST_AT="$NOW"
  fi
  printf 'LAST_SUM=%s\nLAST_AT=%s\n' "$SUM" "$LAST_AT" > "$STATE"
  exit 1
fi
if [ -n "$LAST_SUM" ]; then notify "zipnet on $HOST: recovered, all checks pass"; fi
printf 'LAST_SUM=\nLAST_AT=0\n' > "$STATE"
