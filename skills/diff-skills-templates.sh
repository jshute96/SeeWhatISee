#!/bin/bash

# Start diffs in `meld` of the corresponding skill templates for two
# clients, across the standard skills (see/watch/stop/history).
#
# Usage:
#   diff-skills-templates.sh <client-a> <client-b>
#
# The client names are the template filename prefixes in this dir —
# e.g. claude, gemini, generic, antigravity, mcp-server. So
# `diff-skills-templates.sh claude gemini` diffs claude.see.md against
# gemini.see.md, and likewise for .watch/.stop/.history.
#
# Pairs where neither side exists are skipped silently. A pair where
# only one side exists is reported, since that's more often a typo in a
# client name than a deliberate gap — though a real gap reports too
# (mcp-server has no stop/history template, for instance).

set -u

SKILLS=(see watch stop history)

DIR=$(dirname "$0")

if [[ $# -ne 2 ]]; then
  echo "Usage: $(basename "$0") <client-a> <client-b>" >&2
  echo "  e.g. $(basename "$0") claude gemini" >&2
  echo "  Client names are template prefixes in $DIR:" >&2
  # List the prefixes that have at least a .see.md template.
  for f in "$DIR"/*.see.md; do
    [[ -f $f ]] || continue
    name=$(basename "$f")
    echo "    ${name%.see.md}" >&2
  done
  exit 2
fi

A=$1
B=$2

found=0
for skill in "${SKILLS[@]}"; do
  a="$DIR/$A.$skill.md"
  b="$DIR/$B.$skill.md"
  if [[ -f $a && -f $b ]]; then
    meld "$a" "$b" &
    found=$((found + 1))
  elif [[ -f $a || -f $b ]]; then
    missing=$a
    [[ -f $a ]] && missing=$b
    echo "Skipping $skill: no $(basename "$missing")" >&2
  fi
done

if [[ $found -eq 0 ]]; then
  echo "No template pairs found for '$A' and '$B'." >&2
  exit 1
fi
