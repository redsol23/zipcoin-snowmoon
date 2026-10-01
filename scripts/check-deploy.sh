#!/usr/bin/env bash
# Static checks for the one-box deployment files (deploy/, docker/). Starts no service and builds no image.
#
#   ./scripts/check-deploy.sh
#
# - shellcheck on every deploy script (native shellcheck, else the koalaman/shellcheck image, else skipped)
# - `docker compose config` on deploy/compose with a throwaway ZIPNET_ROOT filled from the env templates, with and
#   without the extra-couriers override
# - Caddyfile validation and the tunnel ingress rules, in their pinned images (needs Docker; skipped without it)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
HOSTROOT="$(pwd -W 2>/dev/null || pwd)"   # Docker Desktop on Windows wants C:/... paths for bind mounts
export MSYS_NO_PATHCONV=1

SCRIPTS=(deploy/bootstrap.sh deploy/backup.sh deploy/ops/healthcheck.sh deploy/ops/release.sh
  scripts/deploy-sepolia.sh scripts/deploy-mainnet.sh scripts/check-deploy.sh docker/entrypoint.sh)
HAVE_DOCKER=0
docker info >/dev/null 2>&1 && HAVE_DOCKER=1

echo "== shellcheck"
if command -v shellcheck >/dev/null; then
  shellcheck -x "${SCRIPTS[@]}"
elif [ "$HAVE_DOCKER" = 1 ]; then
  docker run --rm -v "$HOSTROOT:/mnt:ro" -w /mnt koalaman/shellcheck:stable -x "${SCRIPTS[@]}"
else
  echo "skipped (no shellcheck, no Docker)"; for s in "${SCRIPTS[@]}"; do bash -n "$s"; done
fi

if [ "$HAVE_DOCKER" != 1 ]; then echo "Docker not available: compose, Caddyfile and tunnel checks skipped"; exit 0; fi

echo "== docker compose config"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/env" "$TMP/secrets" "$TMP/config" "$TMP/deployments"
for s in common postman stats web veridia archive; do cp "deploy/compose/env/$s.env.example" "$TMP/env/$s.env"; done
cp deploy/compose/env/courier.env.example "$TMP/env/courier1.env"
cp deploy/compose/env/courier.env.example "$TMP/env/courier2.env"
TMPROOT="$(cd "$TMP" && (pwd -W 2>/dev/null || pwd))"
(
  cd deploy/compose
  export ZIPNET_ROOT="$TMPROOT" ZIPNET_TAG=check CLOUDFLARED_VERSION=check COMPOSE_PROFILES=veridia,archive
  docker compose -f docker-compose.yml config -q
  docker compose -f docker-compose.yml -f couriers.override.example.yml config -q
)
echo "ok"

echo "== Caddyfile"
CADDY_IMAGE="$(sed -n 's/^CADDY_IMAGE=//p' deploy/compose/.env.example)"
docker run --rm -e ZIPNET_DOMAIN=example.org -v "$HOSTROOT/deploy/compose/Caddyfile:/etc/caddy/Caddyfile:ro" \
  "$CADDY_IMAGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -1

echo "== tunnel ingress"
CF_VERSION="$(sed -n 's/^CLOUDFLARED_VERSION=//p' deploy/compose/.env.example)"
docker run --rm -v "$HOSTROOT/deploy/cloudflared/config.yml.example:/etc/cloudflared/config.yml:ro" \
  "cloudflare/cloudflared:$CF_VERSION" tunnel --config /etc/cloudflared/config.yml ingress validate 2>&1 | tail -1
