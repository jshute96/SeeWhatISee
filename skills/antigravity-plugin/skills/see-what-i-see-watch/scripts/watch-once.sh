#!/usr/bin/env bash
# Thin wrapper: defer to SeeWhatISee.py in single-shot --watch mode.
#
# Waits for the next capture, emits one record, then exits. The loop
# in see-what-i-see-watch re-invokes this with --after <last timestamp>
# to catch up on captures that landed while the previous one was being
# processed.
#
# The streaming alternative is watch.sh — one long-lived process
# emitting a line per capture. A bundle ships whichever of the two its
# client can drive; some ship only one. Whether waiting here parks the
# conversation is up to the client: Gemini CLI blocks on it,
# Antigravity backgrounds the run.
#
# Like watch.sh, this publishes the watch session, so the watch is
# visible to the extension's Capture page and stoppable from there or
# from /see-what-i-see-stop — between two runs of the loop as well as
# during one. Stopped that way, the run exits non-zero, which is the
# loop's signal not to run again.
#
# SeeWhatISee.py lives in the see-what-i-see skill's scripts/ dir;
# reach across sibling-relative.
exec "$(dirname "${BASH_SOURCE[0]}")/../../see-what-i-see/scripts/SeeWhatISee.py" --watch --catch-up-one "$@"
