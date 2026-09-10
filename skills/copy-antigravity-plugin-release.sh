#!/usr/bin/env bash
# Publish skills/release-antigravity/ to ../SeeWhatISee-antigravity
# (the Google Antigravity plugin repo).
#
# Thin wrapper around skills/copy-release.sh — see that script for the
# layout mapping and what it will and won't delete.
#
# Usage:
#   skills/copy-antigravity-plugin-release.sh [--dry-run]

set -euo pipefail

DIR="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

case "${1-}" in
  --help|-h)
    sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0 ;;
esac

exec "$DIR/copy-release.sh" antigravity "$@"
