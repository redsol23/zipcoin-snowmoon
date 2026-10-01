#!/usr/bin/env bash
# One-command mainnet deploy of contracts/script/Owners.s.sol + Deploy.s.sol (chain id 1). docs/DEPLOY.md step 3.
#
#   ./scripts/deploy-mainnet.sh fork      --env-file <file>   REHEARSAL: anvil forks mainnet, then Owners (test signer),
#                                                             Deploy with the file's launch config, check(), and a
#                                                             gas/ETH estimate
#   ./scripts/deploy-mainnet.sh owners    --env-file <file>   the owner Safe, treasury Safe and timelock on mainnet:
#                                                             a simulation, or sent with CONFIRM_BROADCAST=mainnet
#   ./scripts/deploy-mainnet.sh dry       --env-file <file>   Deploy against the real mainnet RPC, nothing sent
#   ./scripts/deploy-mainnet.sh broadcast --env-file <file>   Deploy for real (--slow), then check(). Needs
#                                                             CONFIRM_BROADCAST=mainnet
#
# Order on launch day: fork, owners (simulate, then send), put its OWNER / OWNER_SAFE / TREASURY in the env file,
# dry, broadcast. Env (deploy/mainnet.env.example): ETHEREUM_MAINNET_RPC, PRIVATE_KEY (the throwaway deployer),
# SAFE_OWNERS, SAFE_THRESHOLD and every Deploy.s.sol variable. The process environment wins over the file.
# FORK_RPC_URL (default ETHEREUM_MAINNET_RPC, else a public node) and FORK_PORT (8601) for fork. ETHERSCAN_API_KEY adds
# --verify on broadcast.
#
# Guards: refuses any chain but 1 and any Deploy variable still a <placeholder> or unset. Never prints a key or an
# RPC URL. Outputs: fork and dry write contracts/deployments/mainnet-{fork,sim}-local*.json (gitignored); owners
# broadcast writes mainnet-owners.json; broadcast writes mainnet.json.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

MAINNET_CHAIN_ID=1
PUBLIC_RPC=https://ethereum-rpc.publicnode.com
# anvil's well-known dev accounts 0-2 (fork only): deployer, test Safe signer, test postman
ANVIL_KEY0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 # guard:allow (anvil dev account 0, public)
ANVIL_ADDR1=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
ANVIL_ADDR2=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC

# Everything Deploy.s.sol needs on chain 1 for the launch config (bands on)
REQUIRED=(ZC_ADDRESS WITHDRAWAL_VERIFIER RAGEQUIT_VERIFIER ENTRYPOINT_IMPL SEMAPHORE_ADDRESS
  OWNER OWNER_SAFE TREASURY POSTMAN POSTMAN_CAPS_ACK SAFE_MIN_THRESHOLD SAFE_MIN_OWNERS OWNER_MIN_DELAY
  BANDS_POSITION_MANAGER BANDS_HOOK BANDS_MAX_DAY_ZC TAX_TREASURY HARVEST_TREASURY
  MIN_DEPOSIT MAX_RELAY_BPS TAX_BPS BURN_SHARE_BPS COURIER_SHARE_BPS MIN_BURN MERCHANT_MIN_STAKE COURIER_MIN_STAKE
  PAYER_GROUP_MIN_BASE)
# Read by Deploy when set: never a placeholder
OPTIONAL=(SAFE_ALLOWED_MODULES SAFE_SINGLETONS_EXTRA DEPLOY_BATCH_RELAYER ALLOW_FRESH_VERIFIERS)

MODE="${1:-}"
[ $# -gt 0 ] && shift
ENV_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="${2:?--env-file needs a path}"; shift ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done
case "$MODE" in
  fork|owners|dry|broadcast) ;;
  -h|--help|"") sed -n '2,21p' "$0"; exit 0 ;;
  *) echo "unknown mode: $MODE (fork, owners, dry, broadcast)" >&2; exit 2 ;;
esac

die() { echo "deploy-mainnet: $*" >&2; exit 1; }
is_placeholder() { case "${1:-}" in '<'*'>') return 0 ;; *) return 1 ;; esac; }
is_set() { [ -n "${1:-}" ] && ! is_placeholder "$1"; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# KEY=VALUE lines; a value is either a whole <placeholder> (spaces allowed) or text up to an inline " # comment".
# Not sourced: mainnet.env.example's placeholders are not shell. Variables already in the environment win.
load_env() {
  local _line _k _v
  while IFS= read -r _line || [ -n "$_line" ]; do
    _line="${_line%$'\r'}"
    [[ "$_line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    _k="${BASH_REMATCH[1]}"
    _v="${BASH_REMATCH[2]}"
    if [[ "$_v" =~ ^(\<[^>]*\>) ]]; then
      _v="${BASH_REMATCH[1]}"
    else
      _v="${_v%%[[:space:]]#*}"
      _v="${_v%"${_v##*[![:space:]]}"}"
      _v="${_v#\"}"; _v="${_v%\"}"; _v="${_v#\'}"; _v="${_v%\'}"
    fi
    [ -n "${!_k+x}" ] && continue
    export "$_k=$_v"
  done < "$1"
}

# Refuses unset or <placeholder> Deploy variables (names only, never values)
need_deploy_vars() {
  local _bad=() _v
  for _v in "${REQUIRED[@]}"; do
    if [ -z "${!_v:-}" ] || is_placeholder "${!_v}"; then _bad+=("$_v"); fi
  done
  for _v in "${OPTIONAL[@]}"; do
    if is_placeholder "${!_v:-}"; then _bad+=("$_v"); fi
  done
  [ ${#_bad[@]} -eq 0 ] || die "unset or <placeholder>: ${_bad[*]}"
}

chain_ok() {
  local _chain
  _chain="$(cast chain-id --rpc-url "$1" 2>/dev/null)" || die "RPC not reachable ($2)"
  [ "$_chain" = "$MAINNET_CHAIN_ID" ] || die "$2 is chain $_chain, not mainnet ($MAINNET_CHAIN_ID); refusing"
}

# Reads one key of a JSON file (node: jq is not assumed)
json_get() { node -e 'const j=require(process.argv[1]);const v=j[process.argv[2]];process.stdout.write(v===undefined?"":String(v))' "$1" "$2"; }

run_owners() { # <rpc> <deployment name> <broadcast 0|1>
  local _args=(script/Owners.s.sol:Owners --rpc-url "$1" --private-key "$PRIVATE_KEY")
  [ "$3" = "1" ] && _args+=(--broadcast --slow)
  (cd "$ROOT/contracts" && DEPLOYMENT="$2" forge script "${_args[@]}")
  OWNERS_JSON="$ROOT/contracts/deployments/$2-owners.json"
  [ -f "$OWNERS_JSON" ] || die "Owners wrote no $OWNERS_JSON"
}

run_deploy() { # <rpc> <deployment name> <broadcast 0|1>
  local _args=(script/Deploy.s.sol:Deploy --rpc-url "$1" --sender "$DEPLOYER" --private-key "$PRIVATE_KEY")
  if [ "$3" = "1" ]; then
    _args+=(--broadcast --slow)
    if [ -n "${ETHERSCAN_API_KEY:-}" ] && [ "$MODE" = "broadcast" ]; then _args+=(--verify --etherscan-api-key "$ETHERSCAN_API_KEY"); fi
  fi
  (cd "$ROOT/contracts" && DEPLOYMENT="$2" forge script "${_args[@]}")
}

run_check() { # <rpc> <deployment name>
  (cd "$ROOT/contracts" && DEPLOYMENT="$2" forge script script/Deploy.s.sol:Deploy --sig 'check()' --rpc-url "$1")
}

print_addresses() {
  node -e 'const j=require(process.argv[1]);for(const[k,v]of Object.entries(j))console.log("  "+k.padEnd(18)+" "+v)' "$1"
}

[ -n "$ENV_FILE" ] || die "--env-file <file> is required (copy deploy/mainnet.env.example, keep it outside git)"
[ -f "$ENV_FILE" ] || die "no such env file: $ENV_FILE"
load_env "$ENV_FILE"
command -v forge >/dev/null || die "forge not found (install Foundry: https://book.getfoundry.sh)"
command -v cast >/dev/null || die "cast not found"
command -v node >/dev/null || die "node not found (reads the deployment JSON)"
mkdir -p "$ROOT/contracts/deployments"

# ---------------------------------------------------------------------------------------------------------------------
if [ "$MODE" = "fork" ]; then
  command -v anvil >/dev/null || die "anvil not found"
  FORK_RPC="${FORK_RPC_URL:-}"
  if [ -z "$FORK_RPC" ]; then
    if [ -n "${ETHEREUM_MAINNET_RPC:-}" ] && ! is_placeholder "$ETHEREUM_MAINNET_RPC"; then FORK_RPC="$ETHEREUM_MAINNET_RPC"; else FORK_RPC="$PUBLIC_RPC"; fi
  fi
  chain_ok "$FORK_RPC" "fork RPC"
  FPORT="${FORK_PORT:-8601}"
  LOCAL="http://127.0.0.1:$FPORT"
  if cast chain-id --rpc-url "$LOCAL" >/dev/null 2>&1; then die "something already answers on $LOCAL; stop it or set FORK_PORT"; fi
  LOG="$(mktemp)"
  anvil --fork-url "$FORK_RPC" --port "$FPORT" --retries 10 --fork-retry-backoff 2000 --timeout 60000 >"$LOG" 2>&1 &
  ANVIL_PID=$!
  trap 'kill "$ANVIL_PID" 2>/dev/null || true; rm -f "$LOG"' EXIT
  for _ in $(seq 1 60); do cast chain-id --rpc-url "$LOCAL" >/dev/null 2>&1 && break; sleep 1; done
  cast chain-id --rpc-url "$LOCAL" >/dev/null 2>&1 || { tail -5 "$LOG" >&2; die "anvil did not start"; }
  echo "anvil forked mainnet at block $(cast block-number --rpc-url "$LOCAL") on $LOCAL"

  # The rehearsal's stand-ins: anvil's deployer, a test signer for 1-of-N Safes, a test postman when unset
  export PRIVATE_KEY="$ANVIL_KEY0" SAFE_OWNERS="$ANVIL_ADDR1" ETHEREUM_MAINNET_RPC="$FORK_RPC"
  export FOUNDRY_BROADCAST=broadcast/fork   # keeps the rehearsal's receipts apart from the real run's
  if [ -z "${POSTMAN:-}" ] || is_placeholder "$POSTMAN"; then export POSTMAN="$ANVIL_ADDR2"; fi
  DEPLOYER="$(cast wallet address --private-key "$PRIVATE_KEY")"
  export DEPLOYER
  NAME=mainnet-fork-local

  echo; echo "== 1/3 Owners (Safe v1.4.1 x2 + timelock), signer $SAFE_OWNERS, threshold ${SAFE_THRESHOLD:-2}"
  run_owners "$LOCAL" "$NAME" 1
  OWNER_SAFE="$(json_get "$OWNERS_JSON" ownerSafe)"; TREASURY="$(json_get "$OWNERS_JSON" treasury)"
  OWNER="$(json_get "$OWNERS_JSON" timelock)"
  export OWNER_SAFE TREASURY OWNER

  echo; echo "== 2/3 Deploy"
  need_deploy_vars
  run_deploy "$LOCAL" "$NAME" 1

  echo; echo "== 3/3 check()"
  run_check "$LOCAL" "$NAME"

  DEP="$ROOT/contracts/deployments/$NAME.json"
  echo; echo "Deployment ($DEP):"
  print_addresses "$DEP"
  echo "  (owners: OWNER_SAFE $OWNER_SAFE, TREASURY $TREASURY, OWNER timelock $OWNER)"
  # Gas the deployer pays on mainnet: Owners + Deploy receipts
  GAS="$(node -e '
    const fs=require("fs");let g=0n,n=0;
    for(const f of process.argv.slice(1)){const r=JSON.parse(fs.readFileSync(f)).receipts||[];for(const x of r){g+=BigInt(x.gasUsed);n++}}
    process.stdout.write(g+" "+n)' \
    "$ROOT/contracts/broadcast/fork/Owners.s.sol/1/run-latest.json" "$ROOT/contracts/broadcast/fork/Deploy.s.sol/1/run-latest.json")"
  read -r GAS_TOTAL TX_COUNT <<<"$GAS"
  GWEI="$(cast gas-price --rpc-url "$FORK_RPC")"
  echo
  echo "Gas: $GAS_TOTAL over $TX_COUNT transactions (Owners + Deploy)."
  node -e '
    const g=BigInt(process.argv[1]), p=BigInt(process.argv[2]);
    const eth=(x)=>(Number(x)/1e18).toFixed(4);
    console.log("At the current mainnet gas price "+(Number(p)/1e9).toFixed(3)+" gwei: "+eth(g*p)+" ETH; at 2x: "+eth(g*p*2n)+" ETH; at 10 gwei: "+eth(g*10n**10n)+" ETH.");
  ' "$GAS_TOTAL" "$GWEI"
  echo "rehearsal passed: nothing was sent to mainnet."
  exit 0
fi

# ---------------------------------------------------------------------------------------------------------------------
RPC="${ETHEREUM_MAINNET_RPC:-}"
is_set "$RPC" || die "set ETHEREUM_MAINNET_RPC (the owner's own node)"
chain_ok "$RPC" "ETHEREUM_MAINNET_RPC"

BROADCAST=0
if [ "$MODE" = "broadcast" ] || { [ "$MODE" = "owners" ] && [ "${CONFIRM_BROADCAST:-}" = "mainnet" ]; }; then BROADCAST=1; fi
if [ "$BROADCAST" = "1" ]; then
  [ "${CONFIRM_BROADCAST:-}" = "mainnet" ] || die "broadcast needs CONFIRM_BROADCAST=mainnet (after a fork rehearsal and a dry run)"
  is_set "${PRIVATE_KEY:-}" || die "broadcast needs PRIVATE_KEY (the throwaway deployer)"
elif [ -z "${PRIVATE_KEY:-}" ] || is_placeholder "$PRIVATE_KEY"; then
  # A random key that exists only for this run: the simulation needs a sender, and this one can never broadcast
  PRIVATE_KEY="$(cast wallet new | sed -n 's/^Private key: *//p')"
  [ -n "$PRIVATE_KEY" ] || die "could not generate a throwaway key with cast wallet new"
  echo "no PRIVATE_KEY: simulating from a random throwaway address"
fi
export PRIVATE_KEY
DEPLOYER="$(cast wallet address --private-key "$PRIVATE_KEY")"
export DEPLOYER
echo "deployer $DEPLOYER, balance $(cast balance "$DEPLOYER" --rpc-url "$RPC" --ether) ETH"

if [ "$MODE" = "owners" ]; then
  is_set "${SAFE_OWNERS:-}" || die "set SAFE_OWNERS (the Safe signer addresses)"
  NAME=mainnet; [ "$BROADCAST" = "1" ] || NAME=mainnet-sim-local
  if [ "$BROADCAST" = "1" ] && [ -f "$ROOT/contracts/deployments/$NAME-owners.json" ]; then
    die "contracts/deployments/$NAME-owners.json exists: the owners were already created"
  fi
  run_owners "$RPC" "$NAME" "$BROADCAST"
  echo
  echo "Put these in the env file (and keep SAFE_MIN_THRESHOLD / SAFE_MIN_OWNERS as printed above):"
  echo "OWNER_SAFE=$(json_get "$OWNERS_JSON" ownerSafe)"
  echo "TREASURY=$(json_get "$OWNERS_JSON" treasury)"
  echo "OWNER=$(json_get "$OWNERS_JSON" timelock)"
  [ "$BROADCAST" = "1" ] || echo "simulation only: nothing was sent (a real run gets other addresses). CONFIRM_BROADCAST=mainnet sends it."
  exit 0
fi

need_deploy_vars
if [ "$MODE" = "dry" ]; then
  run_deploy "$RPC" mainnet-sim-local 0
  echo "simulation only: nothing was sent. Addresses in contracts/deployments/mainnet-sim-local.json are predictions for this sender and nonce."
  exit 0
fi

[ -f "$ROOT/contracts/deployments/mainnet.json" ] && die "contracts/deployments/mainnet.json exists: already deployed? move it aside first"
echo
echo "About to BROADCAST the full zipnet stack to Ethereum mainnet from $DEPLOYER (--slow). Send nothing else from it."
run_deploy "$RPC" mainnet 1
echo; echo "== check()"
run_check "$RPC" mainnet
print_addresses "$ROOT/contracts/deployments/mainnet.json"
echo "done: commit contracts/deployments/mainnet.json."
