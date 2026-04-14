#!/bin/bash

# Install the Gemini commands into $HOME/.gemini

set -e

FILES=".gemini/commands/see-what-i-see.toml .gemini/scripts/copy-last-snapshot.sh"
for f in $FILES; do
  if [ ! -f "$f" ]; then
    echo "Required file $f not found. Are you in the wrong directory?"
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

for f in $FILES; do
  cp -af "$f" "$HOME"/"$f"
done

echo "Copied /see-what-i-see command into $HOME/.gemini"
