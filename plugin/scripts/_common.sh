#!/usr/bin/env bash
# Shared helpers for SeeWhatISee plugin scripts.
# Source this file; do not execute it directly.

DEFAULT_DIR="$HOME/Downloads/SeeWhatISee"

parse_config() {
  local file="$1"
  local line_no=0
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

# Resolve DIR from config files if not already set (e.g. by --directory flag).
resolve_dir() {
  if [[ -z "$DIR" ]]; then
    if [[ -f ".SeeWhatISee" ]]; then
      parse_config ".SeeWhatISee"
    elif [[ -f "$HOME/.SeeWhatISee" ]]; then
      parse_config "$HOME/.SeeWhatISee"
    fi
    [[ -z "$DIR" ]] && DIR="$DEFAULT_DIR" || true
  fi
}

# Pipe JSON through this to replace bare filenames with absolute paths.
# Only rewrites values that don't already start with /.
#
# `screenshot`, `contents`, and `selection` are all artifact
# objects with `filename` as a nested field.
absolutize_paths() {
  sed -e "s|\"screenshot\": *{\"filename\": *\"\\([^/][^\"]*\\)\"|\"screenshot\":{\"filename\":\"$DIR/\\1\"|" \
      -e "s|\"contents\": *{\"filename\": *\"\\([^/][^\"]*\\)\"|\"contents\":{\"filename\":\"$DIR/\\1\"|" \
      -e "s|\"selection\": *{\"filename\": *\"\\([^/][^\"]*\\)\"|\"selection\":{\"filename\":\"$DIR/\\1\"|"
}

# Kill any running watcher recorded in $1 (a pidfile path) and clean
# up the pidfile. Returns 0 if a live watcher was found and signalled,
# 1 if there was nothing live to stop. Used by both watch.sh (to evict
# a previous watcher before claiming the pidfile) and stop.sh.
kill_existing() {
  local pidfile="$1"
  if [[ -f "$pidfile" ]]; then
    local old_pid
    old_pid=$(<"$pidfile")
    if kill -0 "$old_pid" 2>/dev/null; then
      kill "$old_pid" 2>/dev/null || true
      # Wait briefly to confirm the old process has exited; its EXIT
      # trap is what normally removes the pidfile.
      local i
      for i in 1 2 3 4 5; do
        kill -0 "$old_pid" 2>/dev/null || break
        sleep 0.1
      done
      # Belt-and-braces: remove the pidfile ourselves if the killed
      # process didn't get to run its trap. We only remove it if it
      # still names old_pid — otherwise a fresh watcher has already
      # claimed the slot (e.g. watch.sh running its own kill_existing
      # then write_pidfile while we're racing here from stop.sh) and
      # we must leave that one alone.
      if [[ -f "$pidfile" ]] && [[ "$(<"$pidfile" 2>/dev/null)" == "$old_pid" ]]; then
        rm -f "$pidfile"
      fi
      return 0
    fi
    # Stale pidfile — process already gone.
    rm -f "$pidfile"
  fi
  return 1
}
