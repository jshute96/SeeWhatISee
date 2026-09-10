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
# disappear on the release side too — dotted ones like `.claude/`
# included, so local scratch under them is protected by name (see
# KEEP below). A top-level `.git` is never mirrored at all. Top-level
# files are copied without --delete because the release-repo root also
# holds things we don't manage — we can't safely delete at that scope.
# If you remove a top-level file from the dev tree, also delete it
# from the release repo by hand.
#
# Usage:
#   skills/copy-release.sh <client> [--dry-run]
#
# <client> is the suffix of skills/release-<client>/, which is also
# the suffix of the ../SeeWhatISee-<client> release repo.

set -euo pipefail

usage() { echo "Usage: skills/copy-release.sh <client> [--dry-run]"; }

CLIENT=""
DRY_RUN=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=(--dry-run --itemize-changes) ;;
    --help|-h) usage; exit 0 ;;
    -*)        echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
    *)
      if [[ -n "$CLIENT" ]]; then
        echo "Unexpected argument: $arg" >&2; usage >&2; exit 2
      fi
      CLIENT="$arg" ;;
  esac
done

if [[ -z "$CLIENT" ]]; then
  usage >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
SRC_ROOT="$REPO_ROOT/skills/release-$CLIENT"
RELEASE_DIR="$(cd "$REPO_ROOT/.." && pwd)/SeeWhatISee-$CLIENT"

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

  # Never mirror a VCS directory. If a clone ever lands inside an image
  # (someone comparing against the release repo, say), `--delete` would
  # otherwise overwrite the release repo's own .git and destroy its
  # history.
  if [[ "$name" == ".git" ]]; then
    echo "Skipped  skills/release-$CLIENT/$name (never mirrored)"
    continue
  fi

  # Directories the release repo also writes to itself need their local
  # scratch protected from --delete. `.claude/` is the case today: a
  # clone of the release repo accumulates Claude session state there,
  # which its own .gitignore anticipates.
  KEEP=()
  if [[ "$name" == ".claude" ]]; then
    KEEP=(--exclude=/projects/ --exclude=/worktrees/ --exclude='*.lock')
  fi

  # -d follows symlinks, so a top-level symlink *to* a directory would
  # be materialized as a real directory in the release repo. There is
  # no such entry today; -L keeps it a symlink if one ever appears.
  if [[ -d "$entry" && ! -L "$entry" ]]; then
    rsync -a --delete "${KEEP[@]}" "${DRY_RUN[@]}" "$entry/" "$RELEASE_DIR/$name/"
    echo "Mirrored skills/release-$CLIENT/$name/  -> $RELEASE_DIR/$name/"
  else
    rsync -a "${DRY_RUN[@]}" "$entry" "$RELEASE_DIR/$name"
    echo "Copied   skills/release-$CLIENT/$name   -> $RELEASE_DIR/$name"
  fi
done
