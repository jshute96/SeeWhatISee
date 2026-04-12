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

# Extract filenames (they are in the same dir as latest.json)
CONTENTS=$(grep -oP '"contents":\s*"\K[^"]+' "$LATEST_JSON" || true)
SCREENSHOT=$(grep -oP '"screenshot":\s*"\K[^"]+' "$LATEST_JSON" || true)

# Copy and rewrite paths if fields exist
if [ -n "$CONTENTS" ] && [ -f "$DIR/$CONTENTS" ]; then
    cp "$DIR/$CONTENTS" "$TARGET_DIR/"
    sed -i "s|\"contents\": *\"$CONTENTS\"|\"contents\": \"$TARGET_DIR/$CONTENTS\"|g" "$TARGET_LATEST_JSON"
fi

if [ -n "$SCREENSHOT" ] && [ -f "$DIR/$SCREENSHOT" ]; then
    cp "$DIR/$SCREENSHOT" "$TARGET_DIR/"
    sed -i "s|\"screenshot\": *\"$SCREENSHOT\"|\"screenshot\": \"$TARGET_DIR/$SCREENSHOT\"|g" "$TARGET_LATEST_JSON"
fi

# Output the modified JSON file content
cat "$TARGET_LATEST_JSON"
