#!/usr/bin/env bash
# Thin wrapper: defer to SeeWhatISee.py in single-shot --watch mode.
#
# Blocks until the next capture, emits one record, then exits. The
# polling loop in see-what-i-see-watch re-invokes this with
# --after <last timestamp> to catch up on captures that landed while
# the previous one was being processed. Use watch.sh for the streaming
# background path instead.
#
# --pid-lockfile for the same reason watch.sh uses it: while this run
# is blocked waiting — which is nearly all of a watch loop's life — the
# watch is visible to the extension's Capture page and stoppable from
# there or from /see-what-i-see-stop. Stopped that way, the run exits
# non-zero, which is the loop's signal not to run again.
#
# SeeWhatISee.py lives in the see-what-i-see skill's scripts/ dir;
# reach across sibling-relative.
exec "$(dirname "${BASH_SOURCE[0]}")/../../see-what-i-see/scripts/SeeWhatISee.py" --watch --catch-up-one --pid-lockfile "$@"
