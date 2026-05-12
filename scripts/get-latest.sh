#!/bin/bash
# Dev convenience: forward to the real script under skills/.
#
# Used to be a symlink, but the shipped scripts now use plain
# $(dirname ...) (no readlink -f, for BSD readlink portability),
# and dirname of a symlink doesn't follow the symlink. An exec
# wrapper sidesteps that: dirname of the wrapper's own path gives
# the wrapper's dir, and we hand a working path to the real script.
exec "$(dirname "${BASH_SOURCE[0]}")/../skills/claude-plugin/skills/see-what-i-see/scripts/get-latest.sh" "$@"
