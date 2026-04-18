#!/bin/bash

# This script reads the latest capture record from log.json and copies
# its referenced files from ~/Downloads/SeeWhatISee to a readable tmp dir.
# It updates the file paths inside the copied record to point to that dir
# and then prints the modified JSON content to stdout.

set -e

source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/_common.sh"
resolve_target_dir

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

# Extract the latest record (last line of the NDJSON log) and emit it.
emit_record "$(tail -1 "$LOG_JSON")"
