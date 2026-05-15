#!/usr/bin/env bash
# Thin wrapper: compute the Gemini-readable tmp dir and defer to
# SeeWhatISee.sh in single-shot --watch mode.
#
# Gemini CLI has no async background worker with a completion
# callback, so its /see-what-i-see-watch command runs as a series of
# blocking single-shot calls — one per iteration, with the agent
# passing --after between iterations to catch up on captures that
# landed while it was processing the previous one.
#
# That's exactly --watch --catch-up-one without --loop. The wrapper
# adds --copy-to-dir so the captured files land somewhere Gemini can
# read (see ../../see-what-i-see/scripts/copy-last-snapshot.sh for
# the why).

set -euo pipefail

if [[ -z "${TARGET_DIR:-}" ]]; then
  WORKSPACE=$(basename "$(pwd)")
  WORKSPACE="${WORKSPACE//./-}"
  WORKSPACE="${WORKSPACE,,}"
  TARGET_DIR="$HOME/.gemini/tmp/$WORKSPACE"
fi
TARGET_DIR="$TARGET_DIR/SeeWhatISee"

# SeeWhatISee.sh lives in the see-what-i-see skill's scripts/ dir;
# reach across sibling-relative.
exec "$(dirname "${BASH_SOURCE[0]}")/../../see-what-i-see/scripts/SeeWhatISee.sh" \
  --watch --catch-up-one --copy-to-dir "$TARGET_DIR" "$@"
