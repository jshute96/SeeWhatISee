#!/usr/bin/env bash
# SeeWhatISee.sh — single backend script for all see-what-i-see skills.
#
# All actions a skill can take collapse to flags on this one script:
#   --stop                   Kill any existing watcher (implies --pid-lockfile).
#   --get-latest (default)   Emit the current last record from log.json.
#   --all / --limit N        Emit records from the whole capture history.
#   --watch                  Watch log.json and emit new records.
#
# Multiple actions combine and run in that order.
#
# History spans more than log.json: the extension keeps only the most
# recent captures there and flushes older ones to `history-*.json`
# archive files beside it (see src/capture/log-store.ts). --all /
# --limit read the archives oldest-first and then log.json, so the
# emitted stream is the full history in capture order. --search /
# --filter_site narrow it. They narrow only that listing — records
# --watch emits later are never filtered.
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
DO_LIST=false
DO_WATCH=false
DO_STOP=false
ANY_ACTION=false

ALL=false
LIMIT=""
SEARCH=""
FILTER_SITE=""
# Tracked separately from the values so an empty `--search ""` is a
# rejected mistake rather than a filter that quietly matches everything.
SEARCH_GIVEN=false
FILTER_SITE_GIVEN=false

# How many records --search / --filter_site emit when neither --all nor
# --limit says otherwise. Keep in sync with the usage text below and
# with docs/cli_commands.md, which can't interpolate it.
SEARCH_DEFAULT_LIMIT=10

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
  --get-latest         Emit the current last record (default if no action
                       given). Cannot be combined with the history actions
                       below.
  --all                Emit every record in the capture history, oldest first.
  --limit N            Emit up to the N most recent records, oldest first.
  --watch              Watch log.json and emit new records as they arrive.

History covers the archived `history-*.json` files beside log.json as
well as log.json itself. Unlike --get-latest, --all / --limit treat an
empty history as "no records" (no output, exit 0) rather than an error.

Options for --all / --limit:
  --search "words"     Keep only records where every whitespace-separated
                       word appears in the url, title, or prompt
                       (case-insensitive), the same rule as the History
                       page's search box.
  --filter_site "str"  Keep only records whose url is http(s) and whose
                       host contains this substring (case-insensitive).

Either filter with neither --all nor --limit means --limit 10; an empty
or whitespace-only value is rejected. Both filter the history listing
only: with --watch, every record that arrives later is emitted
regardless of them.

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
    --all)               ALL=true; DO_LIST=true; ANY_ACTION=true; shift ;;
    --limit)             LIMIT="$2"; DO_LIST=true; ANY_ACTION=true; shift 2 ;;
    --search)            SEARCH="$2"; SEARCH_GIVEN=true; ANY_ACTION=true; shift 2 ;;
    --filter_site)       FILTER_SITE="$2"; FILTER_SITE_GIVEN=true; ANY_ACTION=true; shift 2 ;;
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

# --search / --filter_site are filters on a history listing, so on their
# own they mean "list the history, filtered". They default to the most
# recent 10 matches rather than --all: a bare search is an interactive
# "what did I capture about X" question, and dumping a whole history of
# matches at an agent is rarely what was wanted. Ask for --all to get
# the rest.
if { $SEARCH_GIVEN || $FILTER_SITE_GIVEN; } && ! $DO_LIST; then
  LIMIT=$SEARCH_DEFAULT_LIMIT
  DO_LIST=true
fi

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
# "everything" and "at most N" are contradictory asks.
if $ALL && [[ -n "$LIMIT" ]]; then
  echo "Error: --all and --limit are mutually exclusive" >&2
  exit 2
fi
# --get-latest is "the one newest record" — already what a listing of
# the newest record(s) gives, and with different empty-history
# behavior. Combining them would emit the newest record twice, so make
# it an error and let the caller pick which semantics it wants.
if $DO_GET_LATEST && $DO_LIST; then
  echo "Error: --get-latest cannot be combined with --all / --limit / --search / --filter_site" >&2
  exit 2
fi
if [[ -n "$LIMIT" ]] && ! [[ "$LIMIT" =~ ^[1-9][0-9]*$ ]]; then
  echo "Error: --limit takes a positive integer, got '$LIMIT'" >&2
  exit 2
fi
# A filter with nothing in it is a caller bug — an agent interpolating
# an empty query string, most likely. Matching everything (or nothing)
# and exiting 0 would look like a real answer, so say so instead.
if $SEARCH_GIVEN && [[ -z "${SEARCH//[[:space:]]/}" ]]; then
  echo "Error: --search needs at least one non-whitespace character" >&2
  exit 2
fi
if $FILTER_SITE_GIVEN && [[ -z "${FILTER_SITE//[[:space:]]/}" ]]; then
  echo "Error: --filter_site needs at least one non-whitespace character" >&2
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

# Pre-escape OUT_DIR for safe interpolation into the sed *replacement*
# strings in process_record (s|...|...$OUT_DIR_SED...|). A path
# containing `&` (sed inserts the matched text), `\`, or `|` (our `s`
# delimiter) would otherwise corrupt the rewritten JSON or make sed
# error out — e.g. a real dir like `~/Downloads/Screens & Shots`.
# Order matters: escape backslashes first, so the backslashes we add
# for `&` and `|` aren't themselves re-escaped.
OUT_DIR_SED=${OUT_DIR//\\/\\\\}
OUT_DIR_SED=${OUT_DIR_SED//&/\\&}
OUT_DIR_SED=${OUT_DIR_SED//|/\\|}

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

# Rewrite `screenshot` / `contents` / `selection` filenames to absolute
# paths under OUT_DIR, for every JSON line on stdin. Already-absolute
# paths (those starting with `/`) are left alone.
#
# Stream-shaped (any number of lines) rather than per-record, so a
# history listing pays one `sed` for the whole run instead of one per
# record. `process_record` runs single records through the same
# expressions, so the two paths can't drift.
rewrite_paths() {
  sed -e "s|\"screenshot\": *{\"filename\": *\"\\([^/][^\"]*\\)\"|\"screenshot\":{\"filename\":\"$OUT_DIR_SED/\\1\"|" \
      -e "s|\"contents\": *{\"filename\": *\"\\([^/][^\"]*\\)\"|\"contents\":{\"filename\":\"$OUT_DIR_SED/\\1\"|" \
      -e "s|\"selection\": *{\"filename\": *\"\\([^/][^\"]*\\)\"|\"selection\":{\"filename\":\"$OUT_DIR_SED/\\1\"|"
}

# Read a single JSON record from stdin. If --copy-to-dir is set, copy
# its referenced files into OUT_DIR. Print the record to stdout with
# its artifact filenames absolutized by `rewrite_paths`.
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
  printf '%s' "$line" | rewrite_paths
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

# Print the files holding the capture history, one per line, in capture
# order: the `history-*.json` archives oldest first, then log.json.
#
# Each archive is named for the *newest* record it holds, using the
# same zero-padded `YYYYMMDD-HHMMSS-mmm` stamp as capture filenames, so
# sorting the names is chronological.
#
# The `.json` suffix is stripped before sorting and put back after,
# which is what keeps a disambiguated `history-<stamp>-1.json` (written
# after `history-<stamp>.json`, and holding the newer batch) sorted
# after its base name. Sorting the names as-is puts it *before*: the
# byte following the stamp is `-` (0x2D) in one and `.` (0x2E) in the
# other. Suffix-stripped, the base name is a prefix of the other and so
# sorts first, which is the order they were written in.
history_files() {
  local archives=() had_nullglob=false
  shopt -q nullglob && had_nullglob=true
  shopt -s nullglob
  archives=("$DIR"/history-*.json)
  $had_nullglob || shopt -u nullglob
  if [[ ${#archives[@]} -gt 0 ]]; then
    printf '%s\n' "${archives[@]}" \
      | sed 's|\.json$||' | LC_ALL=C sort | sed 's|$|.json|'
  fi
  [[ -f "$LOG" ]] && printf '%s\n' "$LOG"
  return 0
}

# Print the records matching --search / --filter_site from the history
# files named as arguments. With no filters, everything passes through
# (minus blank / malformed lines). Output is always oldest-first.
#
# Two modes, because "the N newest matches" wants to read backwards:
#   $1 == 0  — no limit. awk streams the files in argument order and
#              prints each matching line as it reads it.
#   $1 == N  — awk walks the file list from the newest end, reading
#              each file with `getline` and scanning it back-to-front,
#              and stops the moment N matches are in hand. A
#              `--limit 10` on a long history therefore opens one file,
#              not all of them. Driving the reads by hand (rather than
#              letting awk consume its arguments) is what makes the
#              "stop now" decision land *between* files: `nextfile` and
#              `ENDFILE` are gawk extensions, and detecting a file
#              boundary via `FNR == 1` means already having opened and
#              read from the file you wanted to skip.
#
# Either way awk opens the files itself rather than taking a `cat` of
# them on stdin, so that a file missing its trailing newline
# (hand-edited, or truncated mid-write) can't glue its last record onto
# the first record of the next file.
#
# The search text, the site filter, and the file list travel through the
# environment rather than `-v`, which would expand backslash escapes in
# them.
#
# The fields are pulled out of the raw JSON text with a small scanner
# rather than a real parser, so the script keeps its "bash + coreutils
# only" dependency footprint (no jq / python). Two consequences worth
# knowing:
#   - Matching runs against the JSON-escaped text with the backslashes
#     removed, so a search term containing a character JSON escapes (a
#     literal `"` or `\`, or a control character written as `\n` /
#     `\uXXXX`) can fail to match. Terms users actually type — words
#     from a title, url, or prompt — are unaffected.
#   - `tolower` is byte-wise on mawk and BSD awk, so a non-ASCII search
#     term is case-sensitive there, unlike the History page's
#     Unicode-aware `toLowerCase()`.
# `read -r -d ''` rather than `$(cat <<'…')`: same quoted-heredoc text,
# without forking a process to read it. It returns non-zero at EOF,
# which `set -e` would otherwise treat as fatal.
IFS= read -r -d '' SELECT_AWK <<'SELECT_AWK_PROGRAM' || true
    # Value of top-level string field `key`, unescaped enough to match
    # against (a backslash escape yields the character it precedes).
    # Empty string if the key is missing or its value is not a string.
    function jsonstr(line, key,    i, s, out, c, esc, n) {
      i = index(line, "\"" key "\":")
      if (i == 0) return ""
      s = substr(line, i + length(key) + 3)
      sub(/^[ \t]*/, "", s)
      if (substr(s, 1, 1) != "\"") return ""
      s = substr(s, 2)
      out = ""; esc = 0; n = length(s)
      for (i = 1; i <= n; i++) {
        c = substr(s, i, 1)
        if (esc) { out = out c; esc = 0; continue }
        if (c == "\\") { esc = 1; continue }
        if (c == "\"") break
        out = out c
      }
      return out
    }
    # Host part of an http(s) url, lowercased; empty for anything else
    # (file://, chrome://, a missing url), which therefore never
    # matches --filter_site.
    function urlsite(u,    s, p) {
      s = tolower(u)
      if (s !~ /^https?:\/\//) return ""
      sub(/^https?:\/\//, "", s)
      p = index(s, "/"); if (p > 0) s = substr(s, 1, p - 1)
      p = index(s, "?"); if (p > 0) s = substr(s, 1, p - 1)
      p = index(s, "#"); if (p > 0) s = substr(s, 1, p - 1)
      p = index(s, "@"); if (p > 0) s = substr(s, p + 1)   # drop userinfo
      return s
    }
    # Whether one line should be emitted: a plausible record that
    # passes both filters.
    #
    # These files live in the user's Downloads folder and can be
    # hand-edited or truncated mid-write, so lines that are not a whole
    # JSON object are dropped rather than handed to a downstream JSONL
    # consumer that would choke on them. Cheaper and less strict than
    # parseLogText on the extension side, which really parses: a line
    # that starts `{` and ends `}` but is malformed in between still
    # gets through here.
    function keep(line,    i, hay) {
      if (line !~ /^\{/ || line !~ /\}$/) return 0
      if (site != "" && index(urlsite(jsonstr(line, "url")), site) == 0) return 0
      if (nkeep > 0) {
        hay = tolower(jsonstr(line, "url") "\n" jsonstr(line, "title") "\n" \
                      jsonstr(line, "prompt"))
        for (i = 1; i <= nkeep; i++) if (index(hay, terms[i]) == 0) return 0
      }
      return 1
    }
    # Leading / trailing whitespace (a CR from a hand-edit on Windows,
    # say) is trimmed rather than being allowed to fail keep()'s shape
    # test or ride along into the emitted JSON.
    function trim(s) {
      sub(/^[[:space:]]+/, "", s)
      sub(/[[:space:]]+$/, "", s)
      return s
    }
    # Read one file and collect its matches newest-first, up to the
    # limit. `buf` entries past `nbuf` are stale leftovers from a
    # previous, longer file and are never read.
    function scanback(f,    nbuf, i, r, line) {
      nbuf = 0
      while ((r = (getline line < f)) > 0) buf[++nbuf] = trim(line)
      close(f)
      if (r < 0) {
        print "Error: cannot read " f > "/dev/stderr"
        readerr = 1
        return
      }
      for (i = nbuf; i >= 1 && nout < limit; i--) {
        if (keep(buf[i])) out[++nout] = buf[i]
      }
    }
    BEGIN {
      site = tolower(ENVIRON["SWIS_SITE"])
      nterms = split(tolower(ENVIRON["SWIS_SEARCH"]), raw, /[ \t]+/)
      nkeep = 0
      for (i = 1; i <= nterms; i++) if (raw[i] != "") terms[++nkeep] = raw[i]
      if (limit > 0) {
        # Newest file first, stopping as soon as we have enough. The
        # collected matches are newest-first, so print them backwards.
        nfiles = split(ENVIRON["SWIS_FILES"], files, "\n")
        for (fi = nfiles; fi >= 1 && nout < limit && !readerr; fi--) {
          if (files[fi] != "") scanback(files[fi])
        }
        if (!readerr) for (i = nout; i >= 1; i--) print out[i]
        # Exits before awk reads any input, so the streaming rule below
        # never runs in this mode.
        exit readerr ? 2 : 0
      }
    }
    { line = trim($0); if (keep(line)) print line }
SELECT_AWK_PROGRAM

select_records() {
  local limit="$1"; shift
  if [[ "$limit" == 0 ]]; then
    SWIS_SEARCH="$SEARCH" SWIS_SITE="$FILTER_SITE" \
      awk -v limit=0 "$SELECT_AWK" "$@"
  else
    SWIS_SEARCH="$SEARCH" SWIS_SITE="$FILTER_SITE" \
      SWIS_FILES="$(printf '%s\n' "$@")" \
      awk -v limit="$limit" "$SELECT_AWK" </dev/null
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
# Action: --all / --limit (with --search / --filter_site)
# ---------------------------------------------------------------------------

if $DO_LIST; then
  history_paths=()
  while IFS= read -r history_path; do
    history_paths+=("$history_path")
  done < <(history_files)

  # No log and no archives is not an error here: unlike --get-latest,
  # which exists to hand the agent one specific capture, a listing of
  # an empty history is legitimately empty.
  if [[ ${#history_paths[@]} -gt 0 ]]; then
    if [[ -n "$COPY_TO_DIR" ]] || $PRINT_SELECTION; then
      # Per-record work (copying artifacts, reading a selection file
      # back) needs a shell loop, and that costs several processes per
      # record.
      while IFS= read -r record; do
        printf '%s\n' "$record" | emit_record
      done < <(select_records "${LIMIT:-0}" "${history_paths[@]}")
    else
      # The common case is pure text transformation, so the whole
      # listing is two processes rather than ~8 per record.
      select_records "${LIMIT:-0}" "${history_paths[@]}" | rewrite_paths
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Action: --watch
# ---------------------------------------------------------------------------
#
# Deliberately unfiltered: --search / --filter_site scope the history
# listing above, not the live stream. A watcher that silently dropped
# captures the user just took would look broken, and the point of
# watching is to see what happens next.

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
