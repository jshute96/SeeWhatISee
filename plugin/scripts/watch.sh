#!/usr/bin/env bash
# Watch ~/Downloads/SeeWhatISee/latest.json and emit its contents each
# time the SeeWhatISee Chrome extension rewrites it.
#
# Default mode: wait for the next change, emit, and exit.
# --loop: keep watching and emitting until killed.
# --after TIMESTAMP: check log.json for captures newer than the record
#   whose timestamp matches TIMESTAMP, and emit them immediately before
#   watching. TIMESTAMP is the `timestamp` field (ISO 8601) from a
#   previous capture, which uniquely identifies it.
# --stop: kill any existing watcher on this directory and exit.
#
# If --directory is not given, looks for a .SeeWhatISee config file
# (in . then $HOME) with a directory=<path> setting.
#
# Detects changes by polling mtime every 0.5s.

set -euo pipefail

# ---- Defaults ---------------------------------------------------------------

source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/_common.sh"

DIR=""
LOOP=false
STOP=false
AFTER=""

# ---- Argument parsing -------------------------------------------------------

usage() {
  cat <<'EOF'
Usage: watch.sh [OPTIONS]

Watch for new screenshots from the SeeWhatISee Chrome extension.

Options:
  --directory DIR   Directory to watch (default: ~/Downloads/SeeWhatISee)
  --loop            Keep watching after each emission (default: exit after one)
  --after TIMESTAMP Check log.json for captures newer than TIMESTAMP and emit
                    them immediately. TIMESTAMP is the `timestamp` field from a
                    previous capture (e.g. 2026-04-08T23:45:18.224Z).
  --stop            Stop any existing watcher on this directory and exit.
  --help            Show this help and exit.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help)      usage; exit 0 ;;
    --loop)      LOOP=true; shift ;;
    --stop)      STOP=true; shift ;;
    --directory) DIR="$2"; shift 2 ;;
    --after)     AFTER="$2"; shift 2 ;;
    *)           echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

resolve_dir

FILE="$DIR/latest.json"
LOG="$DIR/log.json"
PIDFILE="$DIR/.watch.pid"

# ---- PID-file helpers -------------------------------------------------------

kill_existing() {
  # Returns 0 if a watcher was found and killed, 1 otherwise.
  if [[ -f "$PIDFILE" ]]; then
    local old_pid
    old_pid=$(<"$PIDFILE")
    if kill -0 "$old_pid" 2>/dev/null; then
      kill "$old_pid" 2>/dev/null || true
      # Wait briefly to confirm the old process has exited.
      local i
      for i in 1 2 3 4 5; do
        kill -0 "$old_pid" 2>/dev/null || break
        sleep 0.1
      done
      return 0
    fi
    # Stale pidfile — process already gone.
    rm -f "$PIDFILE"
  fi
  return 1
}

write_pidfile() {
  echo $$ > "$PIDFILE"
}

cleanup() {
  # Only remove the pidfile if it still points at us (another instance
  # may have overwritten it).
  if [[ -f "$PIDFILE" ]] && [[ "$(<"$PIDFILE")" == "$$" ]]; then
    rm -f "$PIDFILE"
  fi
}
trap cleanup EXIT
trap 'exit 143' TERM INT

# ---- --stop mode ------------------------------------------------------------

if $STOP; then
  if kill_existing; then
    echo "Stopping existing watcher on $DIR"
  else
    echo "No existing watcher to stop"
  fi
  exit 0
fi

# ---- Validate directory -----------------------------------------------------

if [[ ! -d "$DIR" ]]; then
  echo "Error: directory does not exist: $DIR" >&2
  echo "Has the SeeWhatISee extension taken any screenshots yet?" >&2
  exit 1
fi
if [[ ! -f "$FILE" ]]; then
  echo "Error: $FILE does not exist" >&2
  echo "Has the SeeWhatISee extension taken any screenshots yet?" >&2
  exit 1
fi

# ---- Kill any previous watcher, write our pidfile ---------------------------

kill_existing || true  # don't care whether one was running
write_pidfile

# ---- Core helpers -----------------------------------------------------------

mtime() {
  [[ -f "$FILE" ]] || { echo ""; return; }
  stat -c %Y "$FILE" 2>/dev/null || stat -f %m "$FILE"
}

# Emit the current contents of latest.json if the mtime has advanced since
# the last emission. Returns 0 if it actually printed, 1 if it skipped
# (used to debounce rapid polls that land in the same mtime second).
last_mtime=""
emit() {
  local cur
  cur=$(mtime)
  [[ -n "$cur" && "$cur" != "$last_mtime" ]] || return 1
  last_mtime="$cur"
  absolutize_paths < "$FILE"
  printf '\n'
}

# ---- --after: check log.json for pending captures ---------------------------

if [[ -n "$AFTER" ]]; then
  if [[ ! -f "$LOG" ]]; then
    echo "Warning: $LOG not found; ignoring --after and watching as usual" >&2
  else
    # Grep for the line containing the --after timestamp. -n gives us
    # the line number so we can tail everything after it. Anchor to
    # the "timestamp" field so we don't false-match the same string
    # appearing in a url value. `|| true` because grep exits 1 on
    # no-match, which `set -eo pipefail` would otherwise promote to
    # a script-terminating error.
    line_num=$(grep -n "\"timestamp\":[[:space:]]*\"$AFTER\"" "$LOG" | head -1 | cut -d: -f1 || true)
    if [[ -z "$line_num" ]]; then
      echo "Warning: '$AFTER' not found in $LOG; ignoring --after and watching as usual" >&2
    else
      total=$(wc -l < "$LOG")
      remaining=$((total - line_num))
      # Guard: wc -l counts newlines, so a file missing its final \n
      # can undercount by 1, making remaining negative. Clamp to 0.
      [[ $remaining -lt 0 ]] && remaining=0
      if [[ $remaining -gt 0 ]]; then
        # There are captures after the --after line. Emit them.
        pending=$(tail -n "$remaining" "$LOG" | absolutize_paths)
        count=$(echo "$pending" | wc -l)
        label="captures"
        [[ "$count" -eq 1 ]] && label="capture"
        echo "$count pending $label:" >&2
        echo "$pending"
        # We've caught up. If not looping, we're done.
        if ! $LOOP; then
          exit 0
        fi
      fi
      # remaining == 0: nothing pending, fall through to normal watch.
    fi
  fi
fi

# ---- Seed baseline mtime ---------------------------------------------------

# Don't emit the current contents on startup — only changes after this point.
last_mtime=$(mtime)

# ---- Watch loop -------------------------------------------------------------

while :; do
  if emit; then
    $LOOP || exit 0
  fi
  sleep 0.5
done
