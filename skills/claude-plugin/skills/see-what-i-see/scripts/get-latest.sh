#!/usr/bin/env bash
# Print the latest capture record as JSON with absolute file paths.
set -euo pipefail

# Plain $(dirname ...) — no readlink -f. Install layouts (Claude
# plugin cache, Gemini extension dir, repo-root scripts/ wrappers)
# never invoke us via a symlink, so $BASH_SOURCE[0] points at our
# real install path. Avoiding readlink -f keeps us portable to BSD
# readlink (macOS <= 12.2).
source "$(dirname "${BASH_SOURCE[0]}")/see-what-i-see_common.sh"

DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help)      echo "Usage: get-latest.sh [--directory DIR]"; exit 0 ;;
    --directory) DIR="$2"; shift 2 ;;
    *)           echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

resolve_dir

LOG="$DIR/log.json"
if [[ ! -f "$LOG" ]]; then
  echo "Error: $LOG not found. No captures yet?" >&2
  exit 1
fi
# Check for empty log.
if [[ ! -s "$LOG" ]]; then
  echo "Error: $LOG is empty. No captures yet." >&2
  exit 1
fi

tail -1 "$LOG" | absolutize_paths
