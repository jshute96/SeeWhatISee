#!/usr/bin/env bash
# Thin wrapper: defer to SeeWhatISee.sh in single-shot --watch mode.
#
# Blocks until the next capture, emits one record, then exits. The
# polling loop in see-what-i-see-watch re-invokes this with
# --after <last timestamp> to catch up on captures that landed while
# the previous one was being processed. Use watch.sh for the streaming
# background path instead.
#
# SeeWhatISee.sh lives in the see-what-i-see skill's scripts/ dir;
# reach across sibling-relative.
exec "$(dirname "${BASH_SOURCE[0]}")/../../see-what-i-see/scripts/SeeWhatISee.sh" --watch --catch-up-one "$@"
