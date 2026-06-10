#!/usr/bin/env bash
# SeeWhatISee.sh — single backend script for all see-what-i-see skills.
#
# All actions a skill can take collapse to flags on this one script:
#   --stop                   Kill any existing watcher (implies --pid-lockfile).
#   --get-latest (default)   Emit the current last record from log.json.
#   --watch                  Watch log.json and emit new records.
#
# Multiple actions combine and run in that order.
#
# Source-dir resolution (used for both reading log.json and writing
# the pidfile) is the same regardless of action:
#   --directory DIR         explicit override, used as-is.
#   else .SeeWhatISee in .  parsed for `directory=...`.
#   else $HOME/.SeeWhatISee same.
#   else default            $HOME/Downloads/SeeWhatISee.
# $SNAP_REAL_HOME is used instead of $HOME if set (snap installs of
# Gemini CLI mangle $HOME).
#
# Output: each emitted record is the original log.json JSON line with
# `screenshot` / `contents` / `selection` filenames rewritten to
# absolute paths. Records are emitted as JSONL — one per line — with a
# trailing blank line only after a multi-line `Selection:` block
# (--print_selection). With --copy-to-dir, the
# referenced files are first copied into that dir and the absolute
# paths point there instead of the source dir; this lets
# Gemini CLI (which can only read its own workspace tmp dir) consume
# captures the extension wrote into ~/Downloads/SeeWhatISee.
#
# Wrappers under each skill customized for each AI tool just `exec` this
# script with the right defaults.
# See skills/*/skills/*/scripts/*.sh for the wrappers.

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

REAL_HOME="${SNAP_REAL_HOME:-$HOME}"

DO_GET_LATEST=false
DO_WATCH=false
DO_STOP=false
ANY_ACTION=false

DIR=""
COPY_TO_DIR=""
PID_LOCKFILE=false
LOOP=false
AFTER=""
CATCH_UP_ONE=false
PRINT_SELECTION=false

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

usage() {
  cat <<'EOF'
Usage: SeeWhatISee.sh [ACTIONS] [OPTIONS]

Actions (combinable; run in this order):
  --stop               Kill any existing watcher (implies --pid-lockfile).
  --get-latest         Emit the current last record (default if no action given).
  --watch              Watch log.json and emit new records as they arrive.

General options:
  --directory DIR      Source dir to read log.json from. If unset, read
                       .SeeWhatISee config file (in . then $HOME) with a
                       `directory=...` line; otherwise defaults to
                       $HOME/Downloads/SeeWhatISee.
  --copy-to-dir DIR    Copy each emitted record's referenced files into DIR
                       before emitting, and rewrite paths to point under DIR.
                       Default is to emit absolute paths under the source dir.
  --print_selection    For records with a `selection` artifact, append its
                       file contents after the JSON line.
  --help               Show this help and exit.

Options for --watch:
  --pid-lockfile       Write $SOURCE_DIR/.watch.pid so --stop or a subsequent
                       --watch can find and replace this watcher.
  --loop               Keep polling after each emission; default is to exit
                       after the first.
  --after TIMESTAMP    Before polling, emit any record(s) in log.json whose
                       timestamp is strictly after TIMESTAMP. TIMESTAMP must
                       match an existing record's `timestamp` field exactly.
  --catch-up-one       Constrain --after to emit just the single record
                       immediately after TIMESTAMP, not all newer ones.
                       Mutually exclusive with --loop.
EOF
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help)              usage; exit 0 ;;
    --get-latest)        DO_GET_LATEST=true; ANY_ACTION=true; shift ;;
    --watch)             DO_WATCH=true;      ANY_ACTION=true; shift ;;
    --stop)              DO_STOP=true; PID_LOCKFILE=true; ANY_ACTION=true; shift ;;
    --directory)         DIR="$2"; shift 2 ;;
    --copy-to-dir)       COPY_TO_DIR="$2"; shift 2 ;;
    --pid-lockfile)      PID_LOCKFILE=true; shift ;;
    --loop)              LOOP=true; shift ;;
    --after)             AFTER="$2"; shift 2 ;;
    --catch-up-one)      CATCH_UP_ONE=true; shift ;;
    --print_selection)   PRINT_SELECTION=true; shift ;;
    *)                   echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

$ANY_ACTION || DO_GET_LATEST=true

# ---------------------------------------------------------------------------
# Reject nonsense flag combinations
# ---------------------------------------------------------------------------
# These three modify watch behavior only — passing them without --watch
# would silently do nothing, which is the kind of "looks like it
# worked" failure that wastes debugging time. Make it an error instead.
if ! $DO_WATCH; then
  if [[ -n "$AFTER" ]]; then
    echo "Error: --after only applies with --watch" >&2
    exit 2
  fi
  if $LOOP; then
    echo "Error: --loop only applies with --watch" >&2
    exit 2
  fi
  if $CATCH_UP_ONE; then
    echo "Error: --catch-up-one only applies with --watch" >&2
    exit 2
  fi
fi
# --catch-up-one is the Gemini single-shot pattern ("emit at most one
# then exit"); --loop says "keep polling forever". Asking for both is
# contradictory.
if $CATCH_UP_ONE && $LOOP; then
  echo "Error: --catch-up-one and --loop are mutually exclusive" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Resolve source dir
# ---------------------------------------------------------------------------

parse_config() {
  local file="$1" line line_no=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line_no=$((line_no + 1))
    # Skip blank lines and comments.
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    # Strip leading/trailing whitespace.
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    case "$line" in
      directory=*)
        DIR="${line#directory=}"
        case "$DIR" in
          \"*\") DIR="${DIR#\"}" ; DIR="${DIR%\"}" ;;
          \'*\') DIR="${DIR#\'}" ; DIR="${DIR%\'}" ;;
        esac
        ;;
      *)
        echo "Error: unrecognized option in $file line $line_no: $line" >&2
        exit 1
        ;;
    esac
  done < "$file"
}

if [[ -z "$DIR" ]]; then
  if [[ -f ".SeeWhatISee" ]]; then
    parse_config ".SeeWhatISee"
  elif [[ -f "$REAL_HOME/.SeeWhatISee" ]]; then
    parse_config "$REAL_HOME/.SeeWhatISee"
  fi
  [[ -z "$DIR" ]] && DIR="$REAL_HOME/Downloads/SeeWhatISee"
fi

LOG="$DIR/log.json"
PIDFILE="$DIR/.watch.pid"

# OUT_DIR: where emitted JSON paths point. Equals DIR unless --copy-to-dir
# is set, in which case we also copy the referenced files into it.
if [[ -n "$COPY_TO_DIR" ]]; then
  OUT_DIR="$COPY_TO_DIR"
  mkdir -p "$OUT_DIR"
else
  OUT_DIR="$DIR"
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Print mtime of $LOG as a Unix timestamp, or empty if the file doesn't
# exist yet. `stat -c %Y || stat -f %m` covers GNU stat (Linux) vs BSD
# stat (macOS).
mtime() {
  [[ -f "$LOG" ]] || { echo ""; return; }
  stat -c %Y "$LOG" 2>/dev/null || stat -f %m "$LOG"
}

# Read a single JSON record from stdin. If --copy-to-dir is set, copy
# its referenced files into OUT_DIR. Print the record to stdout with
# the `screenshot` / `contents` / `selection` filenames rewritten to
# absolute paths under OUT_DIR. Already-absolute paths (those starting
# with `/`) are left alone.
process_record() {
  local line
  line=$(cat)
  if [[ -n "$COPY_TO_DIR" ]]; then
    # Pull each artifact's filename out and copy if it's a bare name
    # (extension always writes bare names; absolute means we already
    # rewrote it on a previous pass — don't re-copy).
    local key f
    for key in screenshot contents selection; do
      f=$(printf '%s' "$line" \
        | sed -n "s|.*\"$key\": *{\"filename\": *\"\\([^\"]*\\)\".*|\\1|p")
      [[ -z "$f" ]] && continue
      case "$f" in /*) continue ;; esac
      [[ -f "$DIR/$f" ]] && cp "$DIR/$f" "$OUT_DIR/"
    done
  fi
  printf '%s' "$line" \
    | sed -e "s|\"screenshot\": *{\"filename\": *\"\\([^/][^\"]*\\)\"|\"screenshot\":{\"filename\":\"$OUT_DIR/\\1\"|" \
          -e "s|\"contents\": *{\"filename\": *\"\\([^/][^\"]*\\)\"|\"contents\":{\"filename\":\"$OUT_DIR/\\1\"|" \
          -e "s|\"selection\": *{\"filename\": *\"\\([^/][^\"]*\\)\"|\"selection\":{\"filename\":\"$OUT_DIR/\\1\"|"
}

# Read a single JSON record from stdin and emit it with framing:
# the JSON line, then (if --print_selection and the record has a
# selection artifact) "Selection:" + the selection file's contents.
#
# Records are emitted as JSONL — one JSON object per line — in every
# mode, which is what both the single-shot and streaming skills consume.
# The only trailing blank line we add is to terminate a multi-line
# "Selection:" block, so the next record's JSON stays on its own line
# (the selection contents may not end in a newline).
emit_record() {
  local line printed_selection=false
  line=$(cat | process_record)
  printf '%s\n' "$line"
  if $PRINT_SELECTION; then
    # After process_record, selection.filename is absolute. The regex
    # stops at the first `"` after `"filename":"`, which is the
    # correct end of the value.
    local sel_file
    sel_file=$(printf '%s' "$line" \
      | sed -n 's|.*"selection":{"filename":"\([^"]*\)".*|\1|p')
    if [[ -n "$sel_file" && -f "$sel_file" ]]; then
      printf '\nSelection:\n'
      cat "$sel_file"
      printed_selection=true
    fi
  fi
  # Use an `if` (not `cond && printf`): under `set -e`, a bare
  # `$printed_selection && printf` would make the function return the
  # non-zero status of the false test when there's no selection, which
  # the `... | emit_record` pipelines would propagate as a fatal error.
  if $printed_selection; then
    printf '\n'
  fi
}

# Kill any running watcher recorded in $PIDFILE; remove the pidfile.
# Returns 0 if a live watcher was found and signalled, 1 if not.
kill_existing() {
  [[ -f "$PIDFILE" ]] || return 1
  local old_pid
  old_pid=$(<"$PIDFILE")
  if kill -0 "$old_pid" 2>/dev/null; then
    kill "$old_pid" 2>/dev/null || true
    # Wait briefly for the EXIT trap to clear the pidfile.
    local i
    for i in 1 2 3 4 5; do
      kill -0 "$old_pid" 2>/dev/null || break
      sleep 0.1
    done
    # Belt-and-braces: only remove if the file still names old_pid.
    # A racing fresh watcher may have already claimed the slot.
    if [[ -f "$PIDFILE" ]] && [[ "$(<"$PIDFILE" 2>/dev/null)" == "$old_pid" ]]; then
      rm -f "$PIDFILE"
    fi
    return 0
  fi
  # Stale pidfile.
  rm -f "$PIDFILE"
  return 1
}

# ---------------------------------------------------------------------------
# Action: --stop
# ---------------------------------------------------------------------------

if $DO_STOP; then
  if kill_existing; then
    echo "Stopping existing watcher on $DIR"
  else
    echo "No existing watcher to stop"
  fi
fi

# ---------------------------------------------------------------------------
# Action: --get-latest
# ---------------------------------------------------------------------------

if $DO_GET_LATEST; then
  if [[ ! -f "$LOG" ]]; then
    if $DO_WATCH; then
      :  # Combined with --watch: missing log is OK, fall through.
    else
      echo "Error: $LOG not found. No captures yet?" >&2
      exit 1
    fi
  elif [[ ! -s "$LOG" ]]; then
    if $DO_WATCH; then
      :  # Combined with --watch: empty log is OK, fall through.
    else
      echo "Error: $LOG is empty. No captures yet." >&2
      exit 1
    fi
  else
    tail -1 "$LOG" | emit_record
  fi
fi

# ---------------------------------------------------------------------------
# Action: --watch
# ---------------------------------------------------------------------------

$DO_WATCH || exit 0

# Chrome only creates the source dir on the first download. Watching
# can legitimately start before that, so create it now (we need
# somewhere for the pidfile to land and a target for the mtime poll).
if ! mkdir -p "$DIR" 2>/dev/null; then
  echo "Error: cannot create watch directory: $DIR" >&2
  exit 1
fi

if $PID_LOCKFILE; then
  # Whether or not a previous watcher was running, claim the slot.
  # kill_existing's 0/1 return is only meaningful for the --stop
  # message above; here it's just "make sure no other watcher is in
  # the slot", so discard the result.
  kill_existing || true
  echo $$ > "$PIDFILE"
  cleanup() {
    # Only remove if it still names us; another instance may have
    # overwritten it in a race.
    if [[ -f "$PIDFILE" ]] && [[ "$(<"$PIDFILE")" == "$$" ]]; then
      rm -f "$PIDFILE"
    fi
  }
  trap cleanup EXIT
  trap 'exit 143' TERM INT
fi

# --after catch-up. With --catch-up-one, emit at most one record
# (Gemini single-shot mode); otherwise emit all records strictly
# newer than $AFTER. If $AFTER doesn't appear in the log, warn and
# fall through to the normal poll.
if [[ -n "$AFTER" ]]; then
  if [[ ! -f "$LOG" ]]; then
    echo "Warning: $LOG not found; ignoring --after and watching as usual" >&2
  else
    # Anchor on the "timestamp" field so we don't false-match the
    # same string in a url value. `|| true` because grep exits 1 on
    # no-match, and `set -eo pipefail` would turn that into a fatal.
    # Edge case: a free-form `prompt` field whose user-typed body
    # literally contained `"timestamp":"<X>"` would slip through,
    # since the regex matches anywhere on the line. The extension
    # never builds such a prompt itself; if it ever becomes a real
    # problem, anchor at a JSON-key boundary or switch to a per-line
    # JSON parse (jq / python).
    line_num=$(grep -n "\"timestamp\":[[:space:]]*\"$AFTER\"" "$LOG" | head -1 | cut -d: -f1 || true)
    if [[ -z "$line_num" ]]; then
      echo "Warning: '$AFTER' not found in $LOG; ignoring --after and watching as usual" >&2
    else
      total=$(wc -l < "$LOG")
      remaining=$((total - line_num))
      # wc -l counts newlines, so a missing trailing \n can undercount
      # by 1 and make remaining negative. Clamp.
      [[ $remaining -lt 0 ]] && remaining=0
      if $CATCH_UP_ONE; then
        if [[ $remaining -ge 1 ]]; then
          sed -n "$((line_num + 1))p" "$LOG" | emit_record
          # `--catch-up-one` and `--loop` are mutually exclusive
          # (rejected up top), so $LOOP is always false here. Kept
          # in this exit path defensively against future relaxation
          # of that validation.
          $LOOP || exit 0
        fi
      elif [[ $remaining -gt 0 ]]; then
        # `total` is captured before `tail -n "$remaining"` reads
        # the file, so a fresh capture appended in between will:
        # (a) make the announced "$count pending" undercount by 1,
        # and (b) cause `tail` to slide its window past the older
        # record and include the new one (tail counts from EOF).
        # Net effect: we still emit the new record (one iteration
        # early, not skipped) and the count message is best-effort
        # under contention. A racy hot-loop only matters in tests.
        count=$remaining
        label="captures"
        [[ "$count" -eq 1 ]] && label="capture"
        echo "$count pending $label:" >&2
        while IFS= read -r record; do
          printf '%s\n' "$record" | emit_record
        done < <(tail -n "$remaining" "$LOG")
        $LOOP || exit 0
      fi
      # remaining == 0: nothing pending, fall through to poll loop.
    fi
  fi
fi

# Don't emit the current contents on poll-loop entry — only changes
# from this point. (--get-latest already handled "current".)
last_mtime=$(mtime)

while :; do
  cur=$(mtime)
  if [[ -n "$cur" && "$cur" != "$last_mtime" ]]; then
    last_mtime="$cur"
    # An empty log.json (user just cleared history via More → Clear log
    # history) bumps mtime without producing a new record. Skip.
    if [[ -s "$LOG" ]]; then
      tail -1 "$LOG" | emit_record
      $LOOP || exit 0
    fi
  fi
  sleep 0.5
done
