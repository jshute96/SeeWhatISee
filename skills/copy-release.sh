#!/usr/bin/env bash
# Mirror one release-image directory in this dev repo out to its
# release repo. Shared implementation behind the per-client
# copy-*-release.sh wrappers.
#
# Layout mapping (source -> dest):
#   skills/release-<client>/<sub>/   -> <release>/<sub>/   (rsync -a --delete)
#   skills/release-<client>/<file>   -> <release>/<file>   (rsync -a)
#
# Each skills/release-<client>/ directory is a complete image of its
# release repo — the generated skill bundle *and* the hand-written
# files around it (README.md, LICENSE, .gitignore, CLAUDE.md, ...).
# Edit them here; the release repos are copy-out targets only.
#
# The release repo is expected to live as a peer of this repo. We do
# NOT create it — if it isn't there already, bail.
#
# Subdirs get `rsync -a --delete` so files removed from the dev side
# disappear on the release side too. Top-level files are copied
# without --delete because the release-repo root also holds things we
# don't manage (.git above all) — we can't safely delete at that
# scope. If you remove a top-level file from the dev tree, also delete
# it from the release repo by hand.
#
# Usage:
#   skills/copy-release.sh <client> [--dry-run]
#
# <client> is the suffix of skills/release-<client>/, which is also
# the suffix of the ../SeeWhatISee-<client> release repo.

set -euo pipefail

CLIENT="${1-}"
if [[ -z "$CLIENT" ]]; then
  echo "Usage: skills/copy-release.sh <client> [--dry-run]" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
SRC_ROOT="$REPO_ROOT/skills/release-$CLIENT"
RELEASE_DIR="$(cd "$REPO_ROOT/.." && pwd)/SeeWhatISee-$CLIENT"

DRY_RUN=()
case "${2-}" in
  "")        ;;
  --dry-run) DRY_RUN=(--dry-run --itemize-changes) ;;
  *) echo "Unknown option: $2" >&2; exit 2 ;;
esac

if [[ ! -d "$SRC_ROOT" ]]; then
  echo "Error: no release image at $SRC_ROOT" >&2
  exit 1
fi

if [[ ! -d "$RELEASE_DIR" ]]; then
  echo "Error: release repo not found at $RELEASE_DIR" >&2
  echo "Clone https://github.com/jshute96/SeeWhatISee-$CLIENT.git as a peer of this repo first." >&2
  exit 1
fi

# Iterate top-level entries (including dotfiles) so newly-added
# subtrees and files are picked up without editing this script.
shopt -s nullglob dotglob
entries=("$SRC_ROOT"/*)
shopt -u nullglob dotglob
if [[ ${#entries[@]} -eq 0 ]]; then
  echo "Error: nothing to mirror under $SRC_ROOT" >&2
  exit 1
fi

for entry in "${entries[@]}"; do
  name=$(basename "$entry")
  if [[ -d "$entry" ]]; then
    rsync -a --delete "${DRY_RUN[@]}" "$entry/" "$RELEASE_DIR/$name/"
    echo "Mirrored skills/release-$CLIENT/$name/  -> $RELEASE_DIR/$name/"
  else
    rsync -a "${DRY_RUN[@]}" "$entry" "$RELEASE_DIR/$name"
    echo "Copied   skills/release-$CLIENT/$name   -> $RELEASE_DIR/$name"
  fi
done
