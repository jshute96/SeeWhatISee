#!/bin/bash
# Dev convenience: forward to the real script. See get-latest.sh for
# why this is a wrapper, not a symlink.
exec "$(dirname "${BASH_SOURCE[0]}")/../skills/dot-gemini/skills/see-what-i-see/scripts/copy-last-snapshot.sh" "$@"
