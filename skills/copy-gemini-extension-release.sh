#!/usr/bin/env bash
# Mirror the dev-repo Gemini extension sources into the release repo.
#
# Layout mapping (source -> dest):
#   skills/dot-gemini/<sub>/   -> <release>/<sub>/        (rsync -a --delete)
#   skills/dot-gemini/<file>   -> <release>/<file>        (rsync -a)
#
# i.e. each top-level entry in skills/dot-gemini/ lands as a sibling
# at the release-repo root. Subdirs (commands/, scripts/, skills/)
# get `rsync -a --delete` so files removed from the dev side
# disappear on the release side too. Top-level files (e.g.
# gemini-extension.json) are copied without --delete because the
# release-repo root also holds files we don't manage (README, LICENSE,
# .git, the release repo's own install script, etc.) — we can't
# safely delete at that scope. If you remove a top-level file from
# the dev tree, also delete it from the release repo by hand.
#
# The release repo is expected to live as a peer of this repo at
# ../SeeWhatISee-gemini. We do NOT create it — if it isn't there
# already, bail.
#
# Usage:
#   skills/copy-gemini-extension-release.sh [--dry-run]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
SRC_ROOT="$REPO_ROOT/skills/dot-gemini"
RELEASE_DIR="$(cd "$REPO_ROOT/.." && pwd)/SeeWhatISee-gemini"

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
  echo "Clone https://github.com/jshute96/SeeWhatISee-gemini.git as a peer of this repo first." >&2
  exit 1
fi

# Iterate top-level entries of skills/dot-gemini/ so newly-added
# subtrees and files are picked up without editing this script.
shopt -s nullglob
entries=("$SRC_ROOT"/*)
shopt -u nullglob
if [[ ${#entries[@]} -eq 0 ]]; then
  echo "Error: nothing to mirror under $SRC_ROOT" >&2
  exit 1
fi

for entry in "${entries[@]}"; do
  name=$(basename "$entry")
  if [[ -d "$entry" ]]; then
    rsync -a --delete "${DRY_RUN[@]}" "$entry/" "$RELEASE_DIR/$name/"
    echo "Mirrored skills/dot-gemini/$name/  -> $RELEASE_DIR/$name/"
  else
    rsync -a "${DRY_RUN[@]}" "$entry" "$RELEASE_DIR/$name"
    echo "Copied   skills/dot-gemini/$name   -> $RELEASE_DIR/$name"
  fi
done
