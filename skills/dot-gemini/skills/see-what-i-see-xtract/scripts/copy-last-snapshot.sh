#!/bin/bash

# Thin wrapper: the xtract skill is just an alias for see-what-i-see,
# so defer to its copy-last-snapshot.sh rather than duplicating here.
# Plain $(dirname ...) — install layouts never invoke us via a symlink,
# so we don't need readlink -f.

exec "$(dirname "${BASH_SOURCE[0]}")/../../see-what-i-see/scripts/copy-last-snapshot.sh" "$@"
