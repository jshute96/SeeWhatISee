#!/usr/bin/env bash
# Thin wrapper: defer to SeeWhatISee.py in --get-latest mode.
exec "$(dirname "${BASH_SOURCE[0]}")/SeeWhatISee.py" --get-latest "$@"
