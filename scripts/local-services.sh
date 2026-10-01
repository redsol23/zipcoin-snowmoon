#!/usr/bin/env bash
# Starts the off-chain services against the local stack (run local-up.sh first), or stops them.
#
#   ./scripts/local-services.sh [up]     postman :8710, courier :8720, Veridia :8730, archive :8740, stats :8750, web :3100
#   COURIER2=1 ./scripts/local-services.sh
#                                        also a second bonded courier on :8722
#   ./scripts/local-services.sh status   what is running
#   ./scripts/local-services.sh stop [name...]
#                                        stops what this script started (whole process trees), or just the named
#                                        services; running up again starts whatever is stopped
#   ./scripts/local-services.sh clean    stop, then delete the services' state and logs (keys and the chain stay).
#                                        Do this after a fresh local-up.sh: saved jobs and notes point at the old chain.
#
# Logs in .local/*.log, pids in .local/pids/. Short epochs and busy cover traffic, so everything shows within a minute.
# Ports: POSTMAN_PORT COURIER_PORT COURIER2_PORT VERIDIA_PORT ARCHIVE_PORT STATS_PORT WEB_PORT. Skip parts with NO_WEB=1,
# NO_ARCHIVE=1, NO_VERIDIA=1, NO_STATS=1. EMERALD_SESSION_SECRET is passed to the web app when set.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))"
L="$ROOT/.local"
PIDS="$L/pids"
CMD="${1:-up}"

POSTMAN_PORT="${POSTMAN_PORT:-8710}"
COURIER_PORT="${COURIER_PORT:-8720}"
COURIER2_PORT="${COURIER2_PORT:-8722}"
VERIDIA_PORT="${VERIDIA_PORT:-8730}"
ARCHIVE_PORT="${ARCHIVE_PORT:-8740}"
STATS_PORT="${STATS_PORT:-8750}"
WEB_PORT="${WEB_PORT:-3100}"
SERVICES="postman courier courier2 veridia archive stats web"

# ---------------------------------------------------------------------------------------------------------------
# process bookkeeping
# ---------------------------------------------------------------------------------------------------------------

alive() { [ -f "$PIDS/$1.pid" ] && kill -0 "$(cat "$PIDS/$1.pid")" 2>/dev/null; }

# Kills a process and everything it started (next dev forks workers; tsx runs node as a child)
kill_tree() {
  local pid="$1"
  if [ -r "/proc/$pid/winpid" ]; then
    # Git Bash on Windows: the node processes are native, so ask Windows to end the whole tree
    taskkill //F //T //PID "$(cat "/proc/$pid/winpid")" >/dev/null 2>&1 || true
  else
    local child
    for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
    kill "$pid" 2>/dev/null || true
  fi
}

stop_all() {
  local s pid
  for s in ${1:-$SERVICES}; do
    [ -f "$PIDS/$s.pid" ] || continue
    pid="$(cat "$PIDS/$s.pid")"
    if kill -0 "$pid" 2>/dev/null; then kill_tree "$pid"; echo "stopped $s"; fi
    rm -f "$PIDS/$s.pid"
  done
}

status() {
  local s
  for s in $SERVICES; do
    if alive "$s"; then echo "$s: running (pid $(cat "$PIDS/$s.pid"))"; else echo "$s: stopped"; fi
  done
}

case "$CMD" in
  stop) shift; stop_all "$*"; exit 0 ;;
  status) status; exit 0 ;;
  clean)
    stop_all
    rm -rf "$L/courier" "$L/courier2" "$L/veridia" "$L/archive" "$L/postman.json" "$L"/{postman,courier,courier2,veridia,archive,stats,web}.log
    echo "service state and logs removed"
    exit 0
    ;;
  up) ;;
  *) echo "usage: $0 [up|status|stop|clean]" >&2; exit 2 ;;
esac

# ---------------------------------------------------------------------------------------------------------------
# up
# ---------------------------------------------------------------------------------------------------------------

[ -f "$L/dev.env" ] || { echo "no .local/dev.env: run ./scripts/local-up.sh first" >&2; exit 1; }
set -a; . "$L/dev.env"; set +a
DEP="$ROOT/contracts/deployments/local.json"
ZC="$(node -e "console.log(require(process.argv[1]).zc)" "$DEP")"
mkdir -p "$PIDS"

# A key kept in .local/<name>.key (gitignored), funded with ETH and ZC from the dev account on first use
funded_key() {
  local f="$L/$1.key" addr
  if [ ! -f "$f" ]; then
    cast wallet new --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s)[0].private_key))" > "$f"
  fi
  addr="$(cast wallet address --private-key "$(cat "$f")")"
  cast rpc anvil_setBalance "$addr" 0x3635C9ADC5DEA00000 --rpc-url "$RPC_URL" >/dev/null
  if [ "$(cast call "$ZC" "balanceOf(address)(uint256)" "$addr" --rpc-url "$RPC_URL" | cut -d' ' -f1)" = "0" ]; then
    cast send "$ZC" "transfer(address,uint256)" "$addr" 100000ether --private-key "$DEV_PRIVATE_KEY" --rpc-url "$RPC_URL" >/dev/null
  fi
  cat "$f"
}

# start <name> <app dir> <command...>: runs in the background with its env, pid in .local/pids, log in .local/<name>.log
start() {
  local name="$1" dir="$2"
  shift 2
  if alive "$name"; then echo "$name already running (pid $(cat "$PIDS/$name.pid"))"; return 0; fi
  (cd "$ROOT/$dir" && exec "$@") > "$L/$name.log" 2>&1 &
  echo $! > "$PIDS/$name.pid"
}

# Waits for an HTTP endpoint so later services (and the caller) find it up; warns rather than failing
wait_http() {
  local name="$1" url="$2" tries="${3:-60}"
  for _ in $(seq "$tries"); do
    curl -fsS -o /dev/null "$url" 2>/dev/null && return 0
    alive "$name" || { echo "$name exited; see .local/$name.log" >&2; return 1; }
    sleep 1
  done
  echo "$name not answering at $url yet; see .local/$name.log" >&2
}

TSX="node node_modules/tsx/dist/cli.mjs src/main.ts"
POSTMAN_URL="http://127.0.0.1:$POSTMAN_PORT"
COURIER_URL="http://127.0.0.1:$COURIER_PORT"
MNEMONIC_DEFAULT="abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

start postman apps/postman env DEPLOYMENT="$DEP" POSTMAN_KEY="$DEV_PRIVATE_KEY" PORT="$POSTMAN_PORT" EPOCH_SEC="${EPOCH_SEC:-60}" \
  VET_DELAY_SEC=0 TICK_MS=3000 STATE_FILE="$L/postman.json" $TSX
wait_http postman "$POSTMAN_URL/asp" || true

CKEY="$(funded_key courier)"
start courier apps/courier env DEPLOYMENT="$DEP" COURIER_KEY="$CKEY" PORT="$COURIER_PORT" POSTMAN_URL="$POSTMAN_URL" \
  DATA_DIR="$L/courier" BOND_WEI=5000000000000000000000 EPOCH_MARGIN_SEC=10 \
  COVER_PER_HOUR="${COVER_PER_HOUR:-120}" COVER_MNEMONIC="${COVER_MNEMONIC:-$MNEMONIC_DEFAULT}" $TSX
echo "postman :$POSTMAN_PORT, courier $(cast wallet address --private-key "$CKEY") :$COURIER_PORT"

if [ "${COURIER2:-0}" = "1" ]; then
  C2KEY="$(funded_key courier2)"
  start courier2 apps/courier env DEPLOYMENT="$DEP" COURIER_KEY="$C2KEY" PORT="$COURIER2_PORT" POSTMAN_URL="$POSTMAN_URL" \
    DATA_DIR="$L/courier2" BOND_WEI=5000000000000000000000 EPOCH_MARGIN_SEC=10 $TSX
  echo "courier2 $(cast wallet address --private-key "$C2KEY") :$COURIER2_PORT"
fi
wait_http courier "$COURIER_URL/health" || true

# Veridia: the Snowmoon residents (scripted mind unless VERIDIA_LLM=auto and DEEPSEEK_API_KEY is set)
if [ "${NO_VERIDIA:-0}" != "1" ]; then
  start veridia apps/veridia env DEPLOYMENT="$DEP" TREASURY_KEY="$DEV_PRIVATE_KEY" PORT="$VERIDIA_PORT" COURIER_URL="$COURIER_URL" \
    VERIDIA_SEED="${VERIDIA_SEED:-veridia-local}" DATA_DIR="$L/veridia" VERIDIA_LLM="${VERIDIA_LLM:-off}" \
    ACTIONS_PER_HOUR="${ACTIONS_PER_HOUR:-360}" MAX_HOLD_SEC="${MAX_HOLD_SEC:-30}" VERIDIA_DAILY_GAS_WEI="${VERIDIA_DAILY_GAS_WEI:-0}" $TSX
  echo "veridia feed :$VERIDIA_PORT"
fi

# The Mountain Archive: the demo x402 merchant (lists itself on first start)
if [ "${NO_ARCHIVE:-0}" != "1" ]; then
  AKEY="$(funded_key archive)"
  start archive apps/archive env DEPLOYMENT="$DEP" ARCHIVE_KEY="$AKEY" PORT="$ARCHIVE_PORT" DATA_DIR="$L/archive" $TSX
  echo "archive $(cast wallet address --private-key "$AKEY") :$ARCHIVE_PORT"
fi

# The stats API behind zipcoin.org/ledger, /privacy-meter and /status (read-only). Locally it answers localhost pages,
# probes http couriers on this machine, and counts no confirmations. STATS_FUNDERS: wallets whose ZC recipients count
# as the project's own (on mainnet, Veridia's treasury); locally the dev account funds everyone, so it is unset.
if [ "${NO_STATS:-0}" != "1" ]; then
  start stats apps/stats env DEPLOYMENT="$DEP" PORT="$STATS_PORT" POSTMAN_URL="$POSTMAN_URL" EPOCH_SEC="${EPOCH_SEC:-60}" \
    DEV_ORIGINS=1 ALLOW_PRIVATE_ENDPOINTS=1 CONFIRMATIONS=0 REFRESH_MS="${STATS_REFRESH_MS:-15000}" PROBE_TIMEOUT_MS=2000 \
    PROJECT_FUNDERS="${STATS_FUNDERS:-}" $TSX
  echo "stats http://127.0.0.1:$STATS_PORT/v1/ledger"
fi

# The web app. `pnpm dev` would copy the proving artifacts in its predev step; starting next directly, we do it here.
if [ "${NO_WEB:-0}" != "1" ]; then
  (cd "$ROOT" && node scripts/fetch-semaphore-artifacts.mjs >/dev/null && node apps/web/scripts/copy-artifacts.mjs)
  start web apps/web env DEPLOYMENT="$DEP" DEV_FAUCET_KEY="$DEV_PRIVATE_KEY" PUBLIC_RPC_URL="$RPC_URL" COURIER_URL="$COURIER_URL" POSTMAN_URL="$POSTMAN_URL" \
    VERIDIA_URL="http://127.0.0.1:$VERIDIA_PORT" EMERALD_SESSION_SECRET="${EMERALD_SESSION_SECRET:-}" \
    node node_modules/next/dist/bin/next dev --port "$WEB_PORT"
  echo "web http://localhost:$WEB_PORT"
fi

echo "logs in .local/*.log; stop with: ./scripts/local-services.sh stop"
