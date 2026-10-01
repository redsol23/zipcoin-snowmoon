#!/usr/bin/env bash
# The whole story, end to end, on a fresh local chain with its own postman and courier:
#   ./scripts/e2e.sh                 (gas table to .local/GAS.md; E2E_WRITE_GAS=1 updates docs/GAS.md)
# Uses its own ports so it never touches a running dev stack: chain :8554, postman :8714, courier :8725.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))"
cd "$ROOT"
export E2E_DIR="$ROOT/.local/e2e"
rm -rf "$E2E_DIR" && mkdir -p "$E2E_DIR"

RPC="http://127.0.0.1:8554"
PIDS=()
# tsx runs the service in a child node process, so also stop whatever still listens on our own ports
# PIDs listening on a port: Windows netstat -ano, or ss on Linux
listeners() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
  else
    netstat -ano 2>/dev/null | awk -v p=":$1" '$2 ~ p"$" && /LISTEN/ {print $NF}' | sort -u
  fi
}
cleanup() {
  for p in "${PIDS[@]}"; do pkill -P "$p" 2>/dev/null || true; kill "$p" 2>/dev/null || true; done
  for port in 8554 8714 8725; do
    for w in $(listeners "$port"); do
      taskkill //PID "$w" //T //F >/dev/null 2>&1 || kill "$w" 2>/dev/null || true
    done
  done
}
for port in 8554 8714 8725; do
  if [ -n "$(listeners "$port")" ]; then echo "port $port is busy; stop what uses it first"; exit 1; fi
done
trap cleanup EXIT

anvil --port 8554 --silent > "$E2E_DIR/anvil.log" 2>&1 & PIDS+=($!)
for _ in $(seq 40); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done

KEY="$(cast wallet new --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s)[0].private_key))")"
ADDR="$(cast wallet address --private-key "$KEY")"
cast rpc anvil_setBalance "$ADDR" 0x3635C9ADC5DEA00000 --rpc-url "$RPC" >/dev/null
mkdir -p contracts/deployments
(cd contracts && PRIVATE_KEY="$KEY" DEPLOYMENT=e2e-local timeout 300 forge script script/Deploy.s.sol:Deploy --slow \
  --rpc-url "$RPC" --broadcast --private-key "$KEY" --sender "$ADDR" > "$E2E_DIR/deploy.log" 2>&1) || { echo "deploy failed; see $E2E_DIR/deploy.log"; exit 1; }
DEP="$ROOT/contracts/deployments/e2e-local.json"

CKEY="$(cast wallet new --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s)[0].private_key))")"
CADDR="$(cast wallet address --private-key "$CKEY")"
cast rpc anvil_setBalance "$CADDR" 0x3635C9ADC5DEA00000 --rpc-url "$RPC" >/dev/null
cast send "$(node -e "console.log(require('$DEP').zc)")" "transfer(address,uint256)" "$CADDR" 10000ether --private-key "$KEY" --rpc-url "$RPC" >/dev/null

(cd apps/postman && RPC_URL=$RPC DEPLOYMENT="$DEP" POSTMAN_KEY="$KEY" EPOCH_SEC=60 VET_DELAY_SEC=0 TICK_MS=1500 PORT=8714 \
  STATE_FILE="$E2E_DIR/postman.json" node node_modules/tsx/dist/cli.mjs src/main.ts > "$E2E_DIR/postman.log" 2>&1) & PIDS+=($!)
(cd apps/courier && RPC_URL=$RPC DEPLOYMENT="$DEP" COURIER_KEY="$CKEY" POSTMAN_URL=http://127.0.0.1:8714 PORT=8725 \
  DATA_DIR="$E2E_DIR/courier" BOND_WEI=5000000000000000000000 EPOCH_MARGIN_SEC=3 COVER_PER_HOUR=0 \
  node node_modules/tsx/dist/cli.mjs src/main.ts > "$E2E_DIR/courier.log" 2>&1) & PIDS+=($!)
for _ in $(seq 60); do curl -s http://127.0.0.1:8725/health >/dev/null 2>&1 && break; sleep 1; done

RPC_URL=$RPC DEPLOYMENT="$DEP" DEV_PRIVATE_KEY="$KEY" COURIER_URL=http://127.0.0.1:8725 POSTMAN_URL=http://127.0.0.1:8714 \
  node node_modules/tsx/dist/cli.mjs "${E2E_SCRIPT:-scripts/e2e.ts}"
