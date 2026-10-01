#!/usr/bin/env bash
# Upgrade and rollback for the one-box deployment. Images are tagged with the git commit they were built from, so a
# rollback is "run the previous tag again": no rebuild, no git needed.
#
#   deploy/ops/release.sh status               current tag, previous tags, container health
#   deploy/ops/release.sh build <git ref>      fetch, check out <ref> (detached; e.g. origin/main, a tag or a commit),
#                                              build every image as :<sha>
#   deploy/ops/release.sh up <sha>             back up, switch .env to <sha>, recreate the containers, wait for health
#   deploy/ops/release.sh deploy <git ref>     build + up
#   deploy/ops/release.sh rollback [<sha>]     up with the previous tag (or the one given); images must still exist
#   deploy/ops/release.sh prune [<n>]          delete zipnet images except the newest <n> tags (default 3)
#
# Run as the zipnet user from anywhere. Memory: building the web image needs ~2-3 GB; on a 4 GB box build elsewhere
# (`docker save zipnet/web:<sha> | ssh <box> docker load`) or stop web first (`docker compose stop web`).
# State formats: if a release changes an on-disk format, its notes say so; roll back only to a tag that reads it.
set -euo pipefail

ZIPNET_ROOT="${ZIPNET_ROOT:-/srv/zipnet}"
SRC="${SRC:-$ZIPNET_ROOT/src}"
COMPOSE_DIR="$SRC/deploy/compose"
HISTORY="$ZIPNET_ROOT/releases.log"
IMAGES="postman courier veridia stats web archive"

die() { echo "release: $*" >&2; exit 1; }
cd "$COMPOSE_DIR" || die "no $COMPOSE_DIR"
[ -f .env ] || die "no $COMPOSE_DIR/.env (copy .env.example)"

current_tag() { sed -n 's/^ZIPNET_TAG=//p' .env | tail -1; }
set_tag() {
  if grep -q '^ZIPNET_TAG=' .env; then sed -i "s/^ZIPNET_TAG=.*/ZIPNET_TAG=$1/" .env; else echo "ZIPNET_TAG=$1" >> .env; fi
}
image_exists() { docker image inspect "zipnet/$1:$2" >/dev/null 2>&1; }

build() {
  local ref="${1:?git ref (branch, tag or commit) required}" sha
  git -C "$SRC" fetch --tags origin
  git -C "$SRC" -c advice.detachedHead=false checkout --detach "$ref"
  sha="$(git -C "$SRC" rev-parse --short=12 HEAD)"
  echo "building $ref = $sha"
  ZIPNET_TAG="$sha" docker compose --profile veridia --profile archive build
  echo "built zipnet/*:$sha"
  BUILT="$sha"
}

up() {
  local sha="${1:?sha required}" prev s
  prev="$(current_tag)"
  for s in postman courier stats web; do image_exists "$s" "$sha" || die "image zipnet/$s:$sha missing; build it first"; done
  # A backup before every switch: the one thing a bad release can damage is state
  "$SRC/deploy/backup.sh" || die "backup failed; not switching (fix the backup, or run backup.sh by hand)"
  set_tag "$sha"
  echo "$(date -u +%FT%TZ) $prev -> $sha" >> "$HISTORY"
  if ! docker compose up -d --remove-orphans --wait --wait-timeout 600; then
    echo "some services did not become healthy on $sha:" >&2
    docker compose ps >&2
    echo "roll back with: $0 rollback $prev" >&2
    exit 1
  fi
  docker compose ps
  echo "running $sha (was $prev)"
}

case "${1:-status}" in
  status)
    echo "current: $(current_tag)"
    echo "history (newest last):"; tail -n 10 "$HISTORY" 2>/dev/null || echo "  none"
    echo "images:"; docker images --format '  {{.Repository}}:{{.Tag}}  {{.CreatedSince}}  {{.Size}}' 'zipnet/*'
    docker compose ps
    ;;
  build) build "${2:-}" ;;
  up) up "${2:-}" ;;
  deploy) build "${2:-}"; up "$BUILT" ;;
  rollback)
    target="${2:-}"
    if [ -z "$target" ]; then
      target="$(awk '{print $2}' "$HISTORY" 2>/dev/null | tail -1)"
      [ -n "$target" ] || die "no previous release in $HISTORY; pass a sha"
    fi
    echo "rolling back to $target"
    up "$target"
    ;;
  prune)
    keep="${2:-3}"
    for img in $IMAGES; do
      docker images --format '{{.Tag}}' "zipnet/$img" | grep -vx "$(current_tag)" | tail -n +"$keep" |
        while read -r t; do docker rmi "zipnet/$img:$t" >/dev/null && echo "removed zipnet/$img:$t"; done
    done
    docker builder prune -f --filter 'until=168h' >/dev/null
    ;;
  *) sed -n '2,16p' "$0"; exit 2 ;;
esac
