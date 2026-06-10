#!/usr/bin/env bash
# Thin wrapper: defer to SeeWhatISee.sh in --stop mode.
#
# SeeWhatISee.sh lives in the see-what-i-see skill's scripts/ dir;
# reach across sibling-relative.
exec "$(dirname "${BASH_SOURCE[0]}")/../../see-what-i-see/scripts/SeeWhatISee.sh" --stop "$@"
