#!/usr/bin/env bash
# Thin wrapper: defer to SeeWhatISee.py in --stop mode.
#
# SeeWhatISee.py lives in the see-what-i-see skill's scripts/ dir;
# reach across sibling-relative.
exec "$(dirname "${BASH_SOURCE[0]}")/../../see-what-i-see/scripts/SeeWhatISee.py" --stop "$@"
