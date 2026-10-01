#!/bin/sh
# Container entrypoint for the zipnet services.
#
# Secrets arrive as Docker secrets (files under /run/secrets/), never as image layers or plain env. For every
# variable NAME__FILE=<path> (double underscore) in the environment, this exports NAME=<contents of path> (trailing
# newline stripped; an empty file leaves NAME unset), then execs the command. Example: COURIER_KEY__FILE=/run/secrets/courier1_key sets COURIER_KEY.
# The double underscore keeps ordinary path settings such as STATE_FILE or EXCLUDE_FILE untouched.
set -eu

for name in $(env | sed -n 's/^\([A-Z][A-Z0-9_]*[A-Z0-9]\)__FILE=.*/\1/p'); do
  file="$(printenv "${name}__FILE")"
  if [ ! -r "$file" ]; then
    echo "entrypoint: ${name}__FILE points at $file, which is missing or unreadable" >&2
    exit 1
  fi
  value="$(cat "$file")"
  unset "${name}__FILE"
  # An empty file means "not configured" (e.g. no DeepSeek key yet): leave the variable unset, as the apps expect
  if [ -n "$value" ]; then export "$name=$value"; fi
done

exec "$@"
