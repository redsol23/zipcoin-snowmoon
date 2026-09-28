#!/usr/bin/env bash
# Starts the postman and one courier against the local stack (run local-up.sh first).
# Logs in .local/*.log. Short epochs and busy cover traffic so everything is visible within a minute.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))"
set -a; . "$ROOT/.local/dev.env"; set +a
DEP="$ROOT/contracts/deployments/local.json"
ZC="$(node -e "console.log(require('$DEP').zc)")"

if [ ! -f "$ROOT/.local/courier.key" ]; then
  cast wallet new --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s)[0].private_key))" > "$ROOT/.local/courier.key"
fi
CKEY="$(cat "$ROOT/.local/courier.key")"
CADDR="$(cast wallet address --private-key "$CKEY")"
cast rpc anvil_setBalance "$CADDR" 0x3635C9ADC5DEA00000 --rpc-url "$RPC_URL" >/dev/null
cast send "$ZC" "transfer(address,uint256)" "$CADDR" 100000ether --private-key "$DEV_PRIVATE_KEY" --rpc-url "$RPC_URL" >/dev/null

(cd "$ROOT/apps/postman" && DEPLOYMENT="$DEP" POSTMAN_KEY="$DEV_PRIVATE_KEY" EPOCH_SEC="${EPOCH_SEC:-60}" VET_DELAY_SEC=0 TICK_MS=3000 \
  STATE_FILE="$ROOT/.local/postman.json" node node_modules/tsx/dist/cli.mjs src/main.ts > "$ROOT/.local/postman.log" 2>&1 &)
(cd "$ROOT/apps/courier" && DEPLOYMENT="$DEP" COURIER_KEY="$CKEY" DATA_DIR="$ROOT/.local/courier" BOND_WEI=5000000000000000000000 EPOCH_MARGIN_SEC=10 \
  COVER_PER_HOUR="${COVER_PER_HOUR:-120}" COVER_MNEMONIC="${COVER_MNEMONIC:-abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about}" \
  node node_modules/tsx/dist/cli.mjs src/main.ts > "$ROOT/.local/courier.log" 2>&1 &)
echo "postman :8710, courier $CADDR :8720 (logs in .local/)"

# Veridia: the Snowmoon residents (scripted mind unless VERIDIA_LLM=auto and Anthropic credentials are present)
(cd "$ROOT/apps/veridia" && DEPLOYMENT="$DEP" TREASURY_KEY="$DEV_PRIVATE_KEY" VERIDIA_SEED="${VERIDIA_SEED:-veridia-local}" DATA_DIR="$ROOT/.local/veridia" \
  VERIDIA_LLM="${VERIDIA_LLM:-off}" ACTIONS_PER_HOUR="${ACTIONS_PER_HOUR:-360}" MAX_HOLD_SEC="${MAX_HOLD_SEC:-30}" \
  node node_modules/tsx/dist/cli.mjs src/main.ts > "$ROOT/.local/veridia.log" 2>&1 &)
echo "veridia feed :8730"
