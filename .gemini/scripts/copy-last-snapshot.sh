#!/bin/bash

# This script copies the latest snapshot/screenshot metadata (latest.json) and
# its referenced files from ~/Downloads/SeeWhatISee to a readable tmp dir.
# It updates the file paths inside the copied latest.json to point to that dir
# and then prints the modified JSON content to stdout.

set -e

# Gemini CLI is only willing to read files out of the current project dir.
# Try to detect we're in that, and use .gemini/tmp/.
if [ "$GEMINI_CLI" = "1" ]; then
  if [ ! -d ".gemini" ]; then
    echo "Error: .gemini/ not found in $(pwd)." >&2
    exit 1
  fi
  TARGET_DIR=".gemini/tmp"
fi
TARGET_DIR="${TARGET_DIR:-/tmp}"
TARGET_DIR="$TARGET_DIR/SeeWhatISee"
mkdir -p "$TARGET_DIR"

# Default DIR to $HOME, override with $SNAP_REAL_HOME if set.
# With Gemini CLI installed by snap, $HOME is an internal gemini dir, and
# $SNAP_REAL_HOME is the real home directory.
BASE_DIR="${SNAP_REAL_HOME:-$HOME}"
DIR="$BASE_DIR/Downloads/SeeWhatISee"
LATEST_JSON="$DIR/latest.json"

# Fail if latest.json is not found
if [ ! -f "$LATEST_JSON" ]; then
    echo "Error: $LATEST_JSON not found. No screenshots yet?" >&2
    exit 1
fi

# Create a local copy of latest.json in TARGET_DIR
TARGET_LATEST_JSON="$TARGET_DIR/latest.json"
cp "$LATEST_JSON" "$TARGET_LATEST_JSON"

# Copy referenced files into TARGET_DIR
CONTENTS=$(grep -oP '"contents":\s*"\K[^"]+' "$LATEST_JSON" || true)
SCREENSHOT=$(grep -oP '"screenshot":\s*"\K[^"]+' "$LATEST_JSON" || true)
[ -n "$CONTENTS" ] && [ -f "$DIR/$CONTENTS" ] && cp "$DIR/$CONTENTS" "$TARGET_DIR/"
[ -n "$SCREENSHOT" ] && [ -f "$DIR/$SCREENSHOT" ] && cp "$DIR/$SCREENSHOT" "$TARGET_DIR/"

# Output JSON with bare filenames replaced by absolute paths into TARGET_DIR.
# Same approach as absolutize_paths in plugin/scripts/_common.sh, but
# rewriting to TARGET_DIR (the copy destination) rather than DIR (the source).
sed -e "s|\"screenshot\": *\"\\([^/][^\"]*\\)\"|\"screenshot\": \"$TARGET_DIR/\\1\"|" \
    -e "s|\"contents\": *\"\\([^/][^\"]*\\)\"|\"contents\": \"$TARGET_DIR/\\1\"|" \
    "$TARGET_LATEST_JSON"
