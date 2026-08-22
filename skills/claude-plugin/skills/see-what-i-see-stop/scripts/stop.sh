#!/usr/bin/env bash
# Thin wrapper: defer to SeeWhatISee.py in --stop mode.
exec "$(dirname "${BASH_SOURCE[0]}")/../../see-what-i-see/scripts/SeeWhatISee.py" --stop "$@"
