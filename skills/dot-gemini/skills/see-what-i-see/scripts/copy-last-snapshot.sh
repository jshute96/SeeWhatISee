#!/usr/bin/env bash
# Thin wrapper: compute the Gemini-readable tmp dir and defer to
# SeeWhatISee.sh in --get-latest --copy-to-dir mode.
#
# Gemini CLI restricts tool file reads to a workspace-named tmp dir
# under $HOME/.gemini/tmp/. The Chrome extension writes captures into
# $HOME/Downloads/SeeWhatISee/, which Gemini can't see directly — so
# we copy the latest record's referenced files into the workspace tmp
# dir and rewrite the JSON paths to point there.
#
# Honors $TARGET_DIR from the environment when set (used by tests).
# In that case, the destination is $TARGET_DIR/SeeWhatISee — matching
# the historical behavior of this script.

set -euo pipefail

if [[ -z "${TARGET_DIR:-}" ]]; then
  WORKSPACE=$(basename "$(pwd)")
  # Match Gemini's workspace-dir munging: `.` -> `-`, then lowercase.
  WORKSPACE="${WORKSPACE//./-}"
  WORKSPACE="${WORKSPACE,,}"
  # Gemini-side path computation deliberately uses $HOME (Gemini's own
  # view of home), not SNAP_REAL_HOME — the .gemini/tmp dir lives
  # wherever Gemini puts it.
  TARGET_DIR="$HOME/.gemini/tmp/$WORKSPACE"
fi
TARGET_DIR="$TARGET_DIR/SeeWhatISee"

exec "$(dirname "${BASH_SOURCE[0]}")/SeeWhatISee.sh" \
  --get-latest --copy-to-dir "$TARGET_DIR" "$@"
