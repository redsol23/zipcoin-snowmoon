#!/usr/bin/env bash
# Starts a local chain and deploys the whole zipnet stack to it.
#   ./scripts/local-up.sh            -> anvil on :8546, contracts/deployments/local.json, .local/dev.env
# The dev key is generated once and kept in .local/ (gitignored); it is funded with anvil_setBalance.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))"
RPC="${RPC:-http://127.0.0.1:8546}"
mkdir -p "$ROOT/.local"

if ! cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  anvil --port "${RPC##*:}" --silent > "$ROOT/.local/anvil.log" 2>&1 &
  for _ in $(seq 20); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done
fi

if [ ! -f "$ROOT/.local/dev.key" ]; then
  cast wallet new --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s)[0].private_key))" > "$ROOT/.local/dev.key"
fi
KEY="$(cat "$ROOT/.local/dev.key")"
ADDR="$(cast wallet address --private-key "$KEY")"
cast rpc anvil_setBalance "$ADDR" 0x3635C9ADC5DEA00000 --rpc-url "$RPC" >/dev/null

cd "$ROOT/contracts"
PRIVATE_KEY="$KEY" DEPLOYMENT=local forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC" --broadcast --private-key "$KEY" --sender "$ADDR" | grep -E "wrote|ONCHAIN"

cat > "$ROOT/.local/dev.env" <<ENV
RPC_URL=$RPC
DEPLOYMENT=contracts/deployments/local.json
DEV_PRIVATE_KEY=$KEY
DEV_ADDRESS=$ADDR
ENV
echo "dev account $ADDR (holds all local ZC); env in .local/dev.env"
