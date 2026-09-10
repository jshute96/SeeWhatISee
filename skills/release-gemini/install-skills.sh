#!/usr/bin/env bash
#
# install-skills.sh — Install the SeeWhatISee Gemini skills into ~/.gemini.
#
# This is a development convenience. The preferred install path for users is
#   gemini extensions install https://github.com/jshute96/SeeWhatISee-gemini

set -euo pipefail

SKILLS=(see-what-i-see see-what-i-see-watch see-what-i-see-xtract)

usage() {
  cat <<EOF
Usage: install-skills.sh [options]

Install the SeeWhatISee Gemini skills into a Gemini config directory.

Skills installed:
$(printf '  - %s\n' "${SKILLS[@]}")

Each skill is copied to <target>/skills/<skill-name>/.

By default this is a DRY RUN: it prints what would happen without touching
the filesystem. Pass --apply to actually install.

Options:
  -t, --target DIR   Gemini config directory (default: \$HOME/.gemini).
  -f, --force        Replace an existing skill directory without prompting.
      --apply        Actually perform the install. Without this, dry-run only.
  -h, --help         Show this help and exit.
EOF
}

# ---- arg parsing -----------------------------------------------------------

target="${HOME}/.gemini"
force=0
apply=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)    usage; exit 0 ;;
    -f|--force)   force=1; shift ;;
    --apply)      apply=1; shift ;;
    -t|--target)
      [[ $# -ge 2 ]] || { echo "error: Option --target requires an argument." >&2; exit 1; }
      target="$2"; shift 2 ;;
    --target=*)   target="${1#*=}"; shift ;;
    --)           shift; break ;;
    -*)           echo "error: Unknown option: $1" >&2; usage >&2; exit 1 ;;
    *)            echo "error: Unexpected positional argument: $1" >&2; exit 1 ;;
  esac
done

if (( apply )); then
  prefix=""
else
  prefix="[dry-run] "
  echo "Dry run: no files will be changed. Re-run with --apply to install."
fi

# ---- resolve source --------------------------------------------------------

# Source is the skills/ directory next to this script, regardless of where
# the user runs it from.
script_path="$(readlink -f "${BASH_SOURCE[0]}")"
repo_root="$(dirname "$script_path")"
src_root="${repo_root}/skills"

[[ -d "$src_root" ]] || {
  echo "error: Source skills directory not found: $src_root" >&2
  exit 1
}

# Validate every source skill up front so we don't install half of them.
for name in "${SKILLS[@]}"; do
  src="${src_root}/${name}"
  if [[ ! -d "$src" ]]; then
    echo "error: Missing source skill: $src" >&2
    exit 1
  fi
  if [[ ! -f "${src}/SKILL.md" ]]; then
    echo "error: $src has no SKILL.md. Cannot install a malformed skill." >&2
    exit 1
  fi
done

# ---- prepare target --------------------------------------------------------

dst_skills="${target}/skills"

# A missing target dir means Gemini probably isn't installed (or --target is
# wrong). Don't paper over that by creating it.
if [[ ! -d "$target" ]]; then
  echo "error: Target directory does not exist: $target" >&2
  echo "       Is Gemini installed? Pass --target if your config lives elsewhere." >&2
  exit 1
fi

if (( apply )); then
  mkdir -p "$dst_skills"
else
  echo "${prefix}mkdir -p ${dst_skills}"
fi

# ---- install ---------------------------------------------------------------

# Prefer rsync — it preserves perms and avoids partial writes on retry.
have_rsync=0
command -v rsync >/dev/null 2>&1 && have_rsync=1

copy_tree() {
  local src="$1" dst="$2"
  if (( have_rsync )); then
    rsync -a --delete "${src}/" "${dst}/"
  else
    rm -rf "$dst"
    cp -R "$src" "$dst"
  fi
}

for name in "${SKILLS[@]}"; do
  src="${src_root}/${name}"
  dst="${dst_skills}/${name}"

  if [[ -e "$dst" ]]; then
    if (( force )); then
      echo "${prefix}Removing existing $dst"
      (( apply )) && rm -rf "$dst"
    else
      echo "error: $dst already exists." >&2
      echo "       Re-run with --force to replace it." >&2
      exit 1
    fi
  fi

  echo "${prefix}Installing ${name} -> ${dst}"
  (( apply )) && copy_tree "$src" "$dst"
done

if (( apply )); then
  echo "Done. Installed ${#SKILLS[@]} skill(s) into ${dst_skills}."
else
  echo "Dry run complete. ${#SKILLS[@]} skill(s) would be installed into ${dst_skills}."
  echo "Re-run with --apply to perform the install."
fi
