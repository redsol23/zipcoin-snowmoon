#!/usr/bin/env sh
# gh for this repo: always acts as redsol23, whatever account is active globally.
GH_TOKEN="$(gh auth token --user redsol23)" exec gh "$@"
