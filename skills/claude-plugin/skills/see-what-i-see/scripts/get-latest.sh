#!/usr/bin/env bash
# Thin wrapper: defer to SeeWhatISee.sh in --get-latest mode.
exec "$(dirname "${BASH_SOURCE[0]}")/SeeWhatISee.sh" --get-latest "$@"
