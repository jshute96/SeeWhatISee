#!/usr/bin/env bash
# Stop any running SeeWhatISee watcher on a directory.
#
# Looks up the watcher's PID from $DIR/.watch.pid (where $DIR is
# resolved the same way watch.sh resolves it: --directory flag, then
# .SeeWhatISee config file in . or $HOME, then $HOME/Downloads/SeeWhatISee).
# Sends SIGTERM and removes the pidfile.
#
# This is the same effect as `watch.sh --stop`. We split it out so the
# /see-what-i-see-stop skill has a small dedicated script that doesn't
# need to bundle (or know about) the watcher loop.

set -euo pipefail

# _common.sh lives at skills/claude-plugin/scripts/_common.sh; this
# script is at skills/claude-plugin/skills/see-what-i-see-stop/scripts/stop.sh,
# so we walk up to the plugin root and back into scripts/.
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../../scripts/_common.sh"

DIR=""

usage() {
  cat <<'EOF'
Usage: stop.sh [OPTIONS]

Stop any existing SeeWhatISee watcher.

Options:
  --directory DIR   Directory whose watcher should be stopped
                    (default: ~/Downloads/SeeWhatISee).
  --help            Show this help and exit.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help)      usage; exit 0 ;;
    --directory) DIR="$2"; shift 2 ;;
    *)           echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

resolve_dir

PIDFILE="$DIR/.watch.pid"

if kill_existing "$PIDFILE"; then
  echo "Stopping existing watcher on $DIR"
else
  echo "No existing watcher to stop"
fi
