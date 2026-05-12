#!/bin/bash
# Dev convenience: forward to the real script. See get-latest.sh for
# why this is a wrapper, not a symlink.
exec "$(dirname "${BASH_SOURCE[0]}")/../skills/claude-plugin/skills/see-what-i-see-watch/scripts/watch.sh" "$@"
