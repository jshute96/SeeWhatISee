#!/bin/bash

# This script reads the latest capture record from log.json and copies
# its referenced files from ~/Downloads/SeeWhatISee to a readable tmp dir.
# It updates the file paths inside the copied record to point to that dir
# and then prints the modified JSON content to stdout.

set -e

# Gemini CLI is only willing to read files out this tmp dir, with a workspace
# name matching the current dir's basename.  ${WORKSPACE,,} lowercases the name.
# Respect TARGET_DIR from the environment if set (used by tests).
if [ -z "${TARGET_DIR:-}" ]; then
  WORKSPACE="$(basename "$(pwd)")"
  TARGET_DIR="$HOME/.gemini/tmp/${WORKSPACE,,}"
fi
TARGET_DIR="$TARGET_DIR/SeeWhatISee"
mkdir -p "$TARGET_DIR"

# Compute $SRC_DIR, overriding $HOME with $SNAP_REAL_HOME if set.
# With Gemini CLI installed by snap, $HOME is mangled garbage, and
# $SNAP_REAL_HOME is the real home directory.
REAL_HOME="${SNAP_REAL_HOME:-$HOME}"
SRC_DIR="$REAL_HOME/Downloads/SeeWhatISee"
LOG_JSON="$SRC_DIR/log.json"

# Fail if log.json is not found
if [ ! -f "$LOG_JSON" ]; then
    echo "Error: $LOG_JSON not found. No screenshots yet?" >&2
    exit 1
fi
# Check for empty log.
if [ ! -s "$LOG_JSON" ]; then
    echo "Error: $LOG_JSON is empty. No screenshots yet." >&2
    exit 1
fi

# Extract the latest record (last line of the NDJSON log).
LATEST_LINE=$(tail -1 "$LOG_JSON")

# Copy referenced files into TARGET_DIR
CONTENTS=$(echo "$LATEST_LINE" | grep -oP '"contents":\s*"\K[^"]+' || true)
SCREENSHOT=$(echo "$LATEST_LINE" | grep -oP '"screenshot":\s*"\K[^"]+' || true)
SELECTION=$(echo "$LATEST_LINE" | grep -oP '"selection":\s*"\K[^"]+' || true)
[ -n "$CONTENTS" ] && [ -f "$SRC_DIR/$CONTENTS" ] && cp "$SRC_DIR/$CONTENTS" "$TARGET_DIR/"
[ -n "$SCREENSHOT" ] && [ -f "$SRC_DIR/$SCREENSHOT" ] && cp "$SRC_DIR/$SCREENSHOT" "$TARGET_DIR/"
[ -n "$SELECTION" ] && [ -f "$SRC_DIR/$SELECTION" ] && cp "$SRC_DIR/$SELECTION" "$TARGET_DIR/"

# Output JSON with bare filenames replaced by absolute paths into TARGET_DIR.
# Same approach as absolutize_paths in plugin/scripts/_common.sh, but
# rewriting to TARGET_DIR (the copy destination) rather than SRC_DIR (the source).
echo "$LATEST_LINE" | \
  sed -e "s|\"screenshot\": *\"\\([^/][^\"]*\\)\"|\"screenshot\": \"$TARGET_DIR/\\1\"|" \
      -e "s|\"contents\": *\"\\([^/][^\"]*\\)\"|\"contents\": \"$TARGET_DIR/\\1\"|" \
      -e "s|\"selection\": *\"\\([^/][^\"]*\\)\"|\"selection\": \"$TARGET_DIR/\\1\"|"
