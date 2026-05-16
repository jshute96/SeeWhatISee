#!/usr/bin/env bash
# Thin wrapper: defer to SeeWhatISee.sh in --watch mode with a pidfile
# (so the watcher is killable via stop.sh / `--stop`).
#
# All the watcher flags (--after, --print_selection, --stop,
# --directory, --help) are forwarded straight through to the master.
exec "$(dirname "${BASH_SOURCE[0]}")/../../see-what-i-see/scripts/SeeWhatISee.sh" --watch --loop --pid-lockfile "$@"
