#!/usr/bin/env bash
# Shared helpers for SeeWhatISee plugin scripts.
# Source this file; do not execute it directly.

DEFAULT_DIR="$HOME/Downloads/SeeWhatISee"

parse_config() {
  local file="$1"
  local line_no=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line_no=$((line_no + 1))
    # Skip blank lines and comments.
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    # Strip leading/trailing whitespace.
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    case "$line" in
      directory=*)
        DIR="${line#directory=}"
        case "$DIR" in
          \"*\") DIR="${DIR#\"}" ; DIR="${DIR%\"}" ;;
          \'*\') DIR="${DIR#\'}" ; DIR="${DIR%\'}" ;;
        esac
        ;;
      *)
        echo "Error: unrecognized option in $file line $line_no: $line" >&2
        exit 1
        ;;
    esac
  done < "$file"
}

# Resolve DIR from config files if not already set (e.g. by --directory flag).
resolve_dir() {
  if [[ -z "$DIR" ]]; then
    if [[ -f ".SeeWhatISee" ]]; then
      parse_config ".SeeWhatISee"
    elif [[ -f "$HOME/.SeeWhatISee" ]]; then
      parse_config "$HOME/.SeeWhatISee"
    fi
    [[ -z "$DIR" ]] && DIR="$DEFAULT_DIR" || true
  fi
}

# Pipe JSON through this to replace bare filenames with absolute paths.
# Only rewrites values that don't already start with /.
#
# `screenshot`, `contents`, and `selection` are all artifact
# objects with `filename` as a nested field.
absolutize_paths() {
  sed -e "s|\"screenshot\": *{\"filename\": *\"\\([^/][^\"]*\\)\"|\"screenshot\":{\"filename\":\"$DIR/\\1\"|" \
      -e "s|\"contents\": *{\"filename\": *\"\\([^/][^\"]*\\)\"|\"contents\":{\"filename\":\"$DIR/\\1\"|" \
      -e "s|\"selection\": *{\"filename\": *\"\\([^/][^\"]*\\)\"|\"selection\":{\"filename\":\"$DIR/\\1\"|"
}
