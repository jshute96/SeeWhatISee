#!/usr/bin/env bash
# Thin wrapper: defer to SeeWhatISee.py in streaming --watch mode.
#
# Long-running: emits one capture record per line as captures arrive,
# until killed. Writes a pidfile so /see-what-i-see-stop (or a later
# watcher) can replace it. Meant to be run backgrounded, with the
# client reading each line as it is printed.
#
# The single-shot alternative is watch-once.sh — one record per run,
# for clients that can't stream. A bundle ships whichever of the two
# its client can drive; some ship only one.
#
# SeeWhatISee.py lives in the see-what-i-see skill's scripts/ dir;
# reach across sibling-relative.
exec "$(dirname "${BASH_SOURCE[0]}")/../../see-what-i-see/scripts/SeeWhatISee.py" --watch --loop --pid-lockfile "$@"
