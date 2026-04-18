#!/bin/bash
# Shared helpers for the Gemini SeeWhatISee scripts.
# Source this file; do not execute it directly.

# Compute $SRC_DIR (where the Chrome extension writes captures),
# overriding $HOME with $SNAP_REAL_HOME if set. With Gemini CLI
# installed via snap, $HOME is mangled garbage and $SNAP_REAL_HOME is
# the real home directory.
REAL_HOME="${SNAP_REAL_HOME:-$HOME}"
SRC_DIR="$REAL_HOME/Downloads/SeeWhatISee"
LOG_JSON="$SRC_DIR/log.json"

# Resolve $TARGET_DIR — the Gemini tmp dir we copy capture files into.
# Gemini CLI restricts file reads to a workspace-named tmp dir;
# ${WORKSPACE,,} lowercases it (Gemini lowercases the workspace name
# it resolves to on its side too). Honors $TARGET_DIR from the
# environment when set, for tests.
resolve_target_dir() {
  if [ -z "${TARGET_DIR:-}" ]; then
    WORKSPACE="$(basename "$(pwd)")"
    TARGET_DIR="$HOME/.gemini/tmp/${WORKSPACE,,}"
  fi
  TARGET_DIR="$TARGET_DIR/SeeWhatISee"
  mkdir -p "$TARGET_DIR"
}

# Print the mtime of log.json as a Unix timestamp, or the empty string
# if log.json doesn't exist yet. `stat -c %Y || stat -f %m` covers GNU
# stat (Linux) vs BSD stat (macOS).
mtime_log() {
  [[ -f "$LOG_JSON" ]] || { echo ""; return; }
  stat -c %Y "$LOG_JSON" 2>/dev/null || stat -f %m "$LOG_JSON"
}

# Given a single log.json record line (one NDJSON line) on $1, copy
# its referenced files from $SRC_DIR into $TARGET_DIR and print the
# line to stdout with `screenshot` / `contents` / `selection` paths
# rewritten to absolute paths under $TARGET_DIR.
#
# Callers must `resolve_target_dir` first so $TARGET_DIR is set.
emit_record() {
  local line="$1"
  local contents screenshot selection
  contents=$(echo "$line" | grep -oP '"contents":\s*"\K[^"]+' || true)
  screenshot=$(echo "$line" | grep -oP '"screenshot":\s*"\K[^"]+' || true)
  selection=$(echo "$line" | grep -oP '"selection":\s*"\K[^"]+' || true)
  [ -n "$contents" ] && [ -f "$SRC_DIR/$contents" ] && cp "$SRC_DIR/$contents" "$TARGET_DIR/"
  [ -n "$screenshot" ] && [ -f "$SRC_DIR/$screenshot" ] && cp "$SRC_DIR/$screenshot" "$TARGET_DIR/"
  [ -n "$selection" ] && [ -f "$SRC_DIR/$selection" ] && cp "$SRC_DIR/$selection" "$TARGET_DIR/"

  echo "$line" | \
    sed -e "s|\"screenshot\": *\"\\([^/][^\"]*\\)\"|\"screenshot\": \"$TARGET_DIR/\\1\"|" \
        -e "s|\"contents\": *\"\\([^/][^\"]*\\)\"|\"contents\": \"$TARGET_DIR/\\1\"|" \
        -e "s|\"selection\": *\"\\([^/][^\"]*\\)\"|\"selection\": \"$TARGET_DIR/\\1\"|"
}
