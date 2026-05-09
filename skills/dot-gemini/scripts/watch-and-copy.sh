#!/bin/bash

# Emit exactly one new capture from the SeeWhatISee extension and
# exit. Blocks until there's something to emit, copies the record's
# referenced files into the Gemini tmp dir, and prints the JSON
# record (with tmp-dir-absolute paths) to stdout.
#
# Used by the /see-what-i-see-watch Gemini command, which calls this
# once per iteration in a foreground loop. Gemini CLI has no async
# background worker with a completion callback, so the "watch" is
# just a series of blocking single-shot calls — one per iteration,
# with the agent passing --after between iterations to catch up on
# any captures that landed while it was processing the previous one.

set -e

usage() {
  cat <<'EOF'
Usage: watch-and-copy.sh [--after TIMESTAMP] [--help]

Emit exactly one new capture from log.json and exit. The record's
referenced files are copied into the Gemini tmp dir first, and the
JSON line is rewritten to absolute paths under that dir (matches
copy-last-snapshot.sh's output).

- Without --after: polls log.json's mtime every 0.5s and emits the
  new last record once the file changes from a non-empty baseline.
- With --after TIMESTAMP: if log.json already contains a record
  newer than the one whose `timestamp` matches TIMESTAMP, emits the
  next one immediately without polling. Use this between iterations
  of the watch loop so captures that arrived while the agent was
  processing the previous one aren't skipped. If TIMESTAMP is the
  newest record (or isn't in the log), falls back to the normal poll.

Options:
  --after TIMESTAMP  Catch up on any record newer than TIMESTAMP first.
  --help             Show this help and exit.
EOF
}

AFTER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help)  usage; exit 0 ;;
    --after) AFTER="$2"; shift 2 ;;
    *)       echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/_common.sh"
resolve_target_dir

# The extension only creates $SRC_DIR on the first download into it,
# so we may be started before any capture has happened. Make the dir
# so the mtime poll below has somewhere to stat.
mkdir -p "$SRC_DIR"

# --after catch-up. If log.json has a record strictly after TIMESTAMP,
# emit the next one and exit. Else fall through to the poll.
if [[ -n "$AFTER" && -f "$LOG_JSON" && -s "$LOG_JSON" ]]; then
  # Anchor to the "timestamp" field so we don't match the same string
  # appearing in a url value. `|| true` because grep exits 1 on no-match,
  # which `set -e` would otherwise promote to a script-terminating error.
  line_num=$(grep -n "\"timestamp\":[[:space:]]*\"$AFTER\"" "$LOG_JSON" | head -1 | cut -d: -f1 || true)
  if [[ -n "$line_num" ]]; then
    total=$(wc -l < "$LOG_JSON")
    next=$((line_num + 1))
    if [[ $next -le $total ]]; then
      emit_record "$(sed -n "${next}p" "$LOG_JSON")"
      exit 0
    fi
  fi
fi

# Poll at 0.5s intervals until mtime advances past the baseline AND the
# file is non-empty. An empty log.json (user just cleared history via
# More → Clear log history) bumps mtime without producing a new
# capture; skip that tick and wait for the next real change.
baseline=$(mtime_log)
while :; do
  current=$(mtime_log)
  if [[ -n "$current" && "$current" != "$baseline" && -s "$LOG_JSON" ]]; then
    break
  fi
  sleep 0.5
done

emit_record "$(tail -1 "$LOG_JSON")"
