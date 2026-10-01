#!/usr/bin/env bash
# Sepolia rehearsal of contracts/script/Deploy.s.sol (chain id 11155111).
#
#   ./scripts/deploy-sepolia.sh [--env-file <file>]                  SIMULATION (default): forge script without
#                                                                    --broadcast; nothing is signed or sent
#   ./scripts/deploy-sepolia.sh [--env-file <file>] --broadcast      sends the transactions. For the OWNER only, by
#                                                                    hand, after reading a simulation; asks to confirm
#   ./scripts/deploy-sepolia.sh [--env-file <file>] --owners [--broadcast]
#                                                                    runs contracts/script/Owners.s.sol instead: the
#                                                                    owner Safe, treasury Safe (canonical Safe v1.4.1,
#                                                                    at the same addresses as mainnet) and timelock.
#                                                                    Needs SAFE_OWNERS; prints OWNER / OWNER_SAFE /
#                                                                    TREASURY for the env file
#
# Env (see deploy/sepolia.env.example): SEPOLIA_RPC_URL (required), PRIVATE_KEY (required for --broadcast; a
# simulation without it uses a random throwaway address), DEPLOYMENT (default "sepolia"), SEMAPHORE_ADDRESS (default
# the canonical Sepolia Semaphore v4), plus any Deploy.s.sol variable. ETHERSCAN_API_KEY adds --verify on broadcast.
#
# Guards: refuses any chain but 11155111, the mainnet ZC address, a Semaphore address without the canonical verifier,
# and BANDS_* (ZC's v4 pool is mainnet-only). A simulation writes contracts/deployments/<DEPLOYMENT>-sim-local.json
# (gitignored), never <DEPLOYMENT>.json. Non-interactive broadcasts need CONFIRM_BROADCAST=sepolia.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

SEPOLIA_CHAIN_ID=11155111
MAINNET_ZC=0x2CA7B61B23b15e75aC7AB60Dd6f627895d64a46E
CANONICAL_SEMAPHORE=0x8A1fd199516489B0Fb7153EB5f075cDAC83c693D
CANONICAL_SEMAPHORE_VERIFIER=0x4DeC9E3784EcC1eE002001BfE91deEf4A48931f8

BROADCAST=0
OWNERS=0
ENV_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --broadcast) BROADCAST=1 ;;
    --owners) OWNERS=1 ;;
    --env-file) ENV_FILE="${2:?--env-file needs a path}"; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

die() { echo "deploy-sepolia: $*" >&2; exit 1; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

if [ -n "$ENV_FILE" ]; then
  [ -f "$ENV_FILE" ] || die "no such env file: $ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

command -v forge >/dev/null || die "forge not found (install Foundry: https://book.getfoundry.sh)"
command -v cast >/dev/null || die "cast not found"
: "${SEPOLIA_RPC_URL:?set SEPOLIA_RPC_URL (see deploy/sepolia.env.example)}"
export SEMAPHORE_ADDRESS="${SEMAPHORE_ADDRESS:-$CANONICAL_SEMAPHORE}"
NAME="${DEPLOYMENT:-sepolia}"

# --- guards -----------------------------------------------------------------------------------------------------
CHAIN="$(cast chain-id --rpc-url "$SEPOLIA_RPC_URL")" || die "RPC not reachable: $SEPOLIA_RPC_URL"
[ "$CHAIN" = "$SEPOLIA_CHAIN_ID" ] || die "RPC is chain $CHAIN, not Sepolia ($SEPOLIA_CHAIN_ID); refusing"

if [ -n "${ZC_ADDRESS:-}" ] && [ "$(lower "$ZC_ADDRESS")" = "$(lower "$MAINNET_ZC")" ]; then
  die "ZC_ADDRESS is the mainnet ZC token; leave it unset on Sepolia (a test token is deployed)"
fi
if [ -n "${BANDS_POSITION_MANAGER:-}${BANDS_HOOK:-}" ]; then
  die "BANDS_POSITION_MANAGER/BANDS_HOOK are mainnet-only (ZC's Uniswap v4 pool); unset them for Sepolia"
fi

CODE="$(cast code "$SEMAPHORE_ADDRESS" --rpc-url "$SEPOLIA_RPC_URL")"
[ "${#CODE}" -gt 2 ] || die "no code at SEMAPHORE_ADDRESS $SEMAPHORE_ADDRESS on Sepolia"
VERIFIER="$(cast call "$SEMAPHORE_ADDRESS" 'verifier()(address)' --rpc-url "$SEPOLIA_RPC_URL")"
[ "$(lower "$VERIFIER")" = "$(lower "$CANONICAL_SEMAPHORE_VERIFIER")" ] ||
  die "Semaphore at $SEMAPHORE_ADDRESS reports verifier $VERIFIER, expected $CANONICAL_SEMAPHORE_VERIFIER"
echo "Semaphore v4 $SEMAPHORE_ADDRESS ok (verifier $VERIFIER)"

# --- key and mode -----------------------------------------------------------------------------------------------
if [ "$BROADCAST" = "1" ]; then
  [ -n "${PRIVATE_KEY:-}" ] || die "--broadcast needs PRIVATE_KEY (a throwaway key with Sepolia ETH)"
  OUT_NAME="$NAME"
else
  if [ -z "${PRIVATE_KEY:-}" ]; then
    # A random key that exists only for this run: the simulation needs a sender, and this one can never broadcast
    PRIVATE_KEY="$(cast wallet new | sed -n 's/^Private key: *//p')"
    [ -n "$PRIVATE_KEY" ] || die "could not generate a throwaway key with cast wallet new"
    echo "no PRIVATE_KEY: simulating from a random throwaway address"
  fi
  OUT_NAME="$NAME-sim-local"
fi
export PRIVATE_KEY
SENDER="$(cast wallet address --private-key "$PRIVATE_KEY")"
BAL="$(cast balance "$SENDER" --rpc-url "$SEPOLIA_RPC_URL" --ether)"
echo "deployer $SENDER, balance $BAL ETH, output contracts/deployments/$OUT_NAME.json"

SCRIPT=script/Deploy.s.sol:Deploy
WHAT="the full zipnet stack"
if [ "$OWNERS" = "1" ]; then
  [ -n "${SAFE_OWNERS:-}" ] || die "--owners needs SAFE_OWNERS (the Safe signer addresses, comma-separated)"
  SCRIPT=script/Owners.s.sol:Owners
  WHAT="the owner Safe, treasury Safe and timelock"
fi
ARGS=("$SCRIPT" --rpc-url "$SEPOLIA_RPC_URL" --sender "$SENDER" --private-key "$PRIVATE_KEY")
if [ "$BROADCAST" = "1" ]; then
  echo
  echo "About to BROADCAST $WHAT to Sepolia from $SENDER."
  if [ -t 0 ]; then
    read -r -p "Type 'sepolia' to continue: " ANSWER
  else
    ANSWER="${CONFIRM_BROADCAST:-}"
  fi
  [ "$ANSWER" = "sepolia" ] || die "not confirmed; nothing sent"
  ARGS+=(--broadcast --slow)
  if [ -n "${ETHERSCAN_API_KEY:-}" ]; then ARGS+=(--verify --etherscan-api-key "$ETHERSCAN_API_KEY"); fi
fi

mkdir -p "$ROOT/contracts/deployments"
cd "$ROOT/contracts"
DEPLOYMENT="$OUT_NAME" forge script "${ARGS[@]}"

if [ "$OWNERS" = "1" ]; then
  J="deployments/$OUT_NAME-owners.json"
  echo "Put these in the env file (with SAFE_MIN_THRESHOLD / SAFE_MIN_OWNERS as logged above):"
  node -e 'const j=require(require("path").resolve(process.argv[1]));for(const[k,v]of[["OWNER_SAFE","ownerSafe"],["TREASURY","treasury"],["OWNER","timelock"]])console.log(k+"="+j[v])' "$J"
  [ "$BROADCAST" = "1" ] || echo "simulation only: nothing was sent (a real run gets other addresses)."
  exit 0
fi

if [ "$BROADCAST" = "1" ]; then
  echo "done: contracts/deployments/$OUT_NAME.json. Copy it to the VPS as /srv/zipnet/deployments/$OUT_NAME.json."
else
  echo "simulation only: nothing was sent. Addresses in contracts/deployments/$OUT_NAME.json are predictions for this sender and nonce."
fi
