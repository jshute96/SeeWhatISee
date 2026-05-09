#!/bin/bash

# Install the Gemini commands into $HOME/.gemini

set -e

# Source dir under this repo and the matching path under $HOME/.gemini.
# Each entry is "<src>:<dst-relative-to-$HOME/.gemini>".
SRC_ROOT="skills/dot-gemini"
FILES=(
  "commands/see-what-i-see.toml"
  "commands/see-what-i-see-watch.toml"
  "scripts/see-what-i-see_common.sh"
  "scripts/copy-last-snapshot.sh"
  "scripts/watch-and-copy.sh"
)
for f in "${FILES[@]}"; do
  if [ ! -f "$SRC_ROOT/$f" ]; then
    echo "Required file $SRC_ROOT/$f not found. Are you in the wrong directory?"
    exit 1
  fi
done

if [ -z "$GEMINI_CLI" ]; then
  GEMINI_PATH="$(type -P gemini 2>/dev/null)" || true
  if [ -z "$GEMINI_PATH" ]; then
    echo "Error: gemini not found. Please install Gemini CLI first." >&2
    exit 1
  fi
  if [[ "$GEMINI_PATH" == /snap/* ]]; then
    echo "Error: Gemini is installed via snap ($GEMINI_PATH)." >&2
    echo "Run the install from inside Gemini so it will install into Gemini's sandbox dir." >&2
    echo "Use this gemini command: !$0" >&2
    exit 1
  fi
fi

mkdir -p "$HOME"/.gemini/commands
mkdir -p "$HOME"/.gemini/scripts

for f in "${FILES[@]}"; do
  cp -af "$SRC_ROOT/$f" "$HOME"/.gemini/"$f"
done

echo "Copied /see-what-i-see and /see-what-i-see-watch commands into $HOME/.gemini"
