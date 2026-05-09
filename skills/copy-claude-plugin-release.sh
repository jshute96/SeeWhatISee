#!/usr/bin/env bash
# Mirror the dev-repo Claude plugin sources into the release repo.
#
# Layout mapping (source -> dest):
#   skills/claude-plugin/      -> <release>/plugin/
#   skills/dot-claude-plugin/  -> <release>/.claude-plugin/
#
# The release repo is expected to live as a peer of this repo at
# ../SeeWhatISee-claude. We do NOT create it — if it isn't there
# already, bail. The release repo is what users install from via
# `/plugin marketplace add jshute96/SeeWhatISee-claude`, and its
# `.claude-plugin/marketplace.json` `source` field is `./plugin`.
#
# Each subtree is mirrored with `rsync -a --delete` so files removed
# from the dev side disappear on the release side too. Anything else
# in the release repo (README, LICENSE, .git, etc.) is untouched.
#
# Usage:
#   skills/copy-claude-plugin-release.sh [--dry-run]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
RELEASE_DIR="$(cd "$REPO_ROOT/.." && pwd)/SeeWhatISee-claude"

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
  echo "Clone https://github.com/jshute96/SeeWhatISee-claude.git as a peer of this repo first." >&2
  exit 1
fi

# Trailing slashes matter: rsync src/ dst/ copies *contents* of src
# into dst, which is exactly what we want here (mirror).
rsync -a --delete "${DRY_RUN[@]}" \
  "$REPO_ROOT/skills/claude-plugin/" \
  "$RELEASE_DIR/plugin/"

rsync -a --delete "${DRY_RUN[@]}" \
  "$REPO_ROOT/skills/dot-claude-plugin/" \
  "$RELEASE_DIR/.claude-plugin/"

echo "Mirrored skills/claude-plugin/      -> $RELEASE_DIR/plugin/"
echo "Mirrored skills/dot-claude-plugin/  -> $RELEASE_DIR/.claude-plugin/"
