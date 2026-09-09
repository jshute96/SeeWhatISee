#!/usr/bin/env bash
# Mirror the dev-repo Antigravity plugin sources into the release repo.
#
# Layout mapping (source -> dest):
#   skills/antigravity-plugin/  -> <release>/plugin/
#
# The release repo is expected to live as a peer of this repo at
# ../SeeWhatISee-antigravity. We do NOT create it — if it isn't there
# already, bail. Users install from it by pointing Antigravity at the
# cloned repo's `plugin/` dir — copying or symlinking it to
# ~/.gemini/config/plugins/see-what-i-see (global), or to
# <workspace>/.agents/plugins/see-what-i-see (one workspace), or via
# `agy plugin install <clone>/plugin` for the CLI.
#
# The subtree is mirrored with `rsync -a --delete` so files removed
# from the dev side disappear on the release side too. Anything else
# in the release repo (README, LICENSE, .git, etc.) is untouched.
#
# Usage:
#   skills/copy-antigravity-plugin-release.sh [--dry-run]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
RELEASE_DIR="$(cd "$REPO_ROOT/.." && pwd)/SeeWhatISee-antigravity"

DRY_RUN=()
case "${1-}" in
  "")        ;;
  --dry-run) DRY_RUN=(--dry-run --itemize-changes) ;;
  --help|-h)
    sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0 ;;
  *) echo "Unknown option: $1" >&2; exit 2 ;;
esac

if [[ ! -d "$RELEASE_DIR" ]]; then
  echo "Error: release repo not found at $RELEASE_DIR" >&2
  echo "Clone https://github.com/jshute96/SeeWhatISee-antigravity.git as a peer of this repo first." >&2
  exit 1
fi

# Trailing slashes matter: rsync src/ dst/ copies *contents* of src
# into dst, which is exactly what we want here (mirror).
rsync -a --delete "${DRY_RUN[@]}" \
  "$REPO_ROOT/skills/antigravity-plugin/" \
  "$RELEASE_DIR/plugin/"

echo "Mirrored skills/antigravity-plugin/  -> $RELEASE_DIR/plugin/"
