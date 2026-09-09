#!/bin/bash

# Start diffs in `meld` of the corresponding skills for claude and gemini.
#
# Shorthand for the generic script; use that directly for other pairs
# (e.g. `diff-skills-templates.sh generic antigravity`).

exec "$(dirname "$0")/diff-skills-templates.sh" claude gemini
