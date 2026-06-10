#!/usr/bin/env bash
# Thin wrapper: defer to SeeWhatISee.sh in streaming --watch mode.
#
# Long-running: emits one capture record per line as captures arrive,
# until killed. Writes a pidfile so /see-what-i-see-stop (or a later
# watcher) can replace it. Run this backgrounded if your tool supports
# it; use watch-once.sh instead for a blocking single-shot poll loop.
#
# SeeWhatISee.sh lives in the see-what-i-see skill's scripts/ dir;
# reach across sibling-relative.
exec "$(dirname "${BASH_SOURCE[0]}")/../../see-what-i-see/scripts/SeeWhatISee.sh" --watch --loop --pid-lockfile "$@"
