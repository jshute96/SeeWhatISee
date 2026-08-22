#!/usr/bin/env bash
# Thin wrapper: defer to SeeWhatISee.py with the caller's flags, and
# translate the skill-level --copy flag into --copy-to-dir <tmpdir>.
#
# The history skill passes --limit / --all / --search / --filter_site
# / --filter_time itself, so no action is forced here.
#
# Copying is opt-in for history, unlike the other Gemini wrappers,
# which always copy: a listing can cover many captures, and copying
# every file of every match before knowing which ones matter is a lot
# of wasted work. The skill lists first, then re-runs with --copy for
# the records it actually wants to read.
# See ../../see-what-i-see/scripts/copy-last-snapshot.sh for why
# copying is needed at all.
#
# SeeWhatISee.py lives in the see-what-i-see skill's scripts/ dir;
# reach across sibling-relative.

set -euo pipefail

# Consume the skill-level --copy flag and require a history action.
#
# The backend defaults to --get-latest when no action flag is given, so
# a history run that lost its flags would silently describe the newest
# capture instead. Fail loudly rather than answer a different question.
#
# --copy is matched only in flag position: a value-taking flag's
# argument (--search --copy) belongs to that flag, not to us.
VALUE_FLAGS=" --limit --search --filter_site --filter_time --directory --copy-to-dir --after "
COUNT_OR_FILTER=" --all --limit --search --filter_site --filter_time "

args=()
copy=
expect_value=
have_action=
for arg in "$@"; do
  if [[ -n "$expect_value" ]]; then
    expect_value=
    args+=("$arg")
    continue
  fi
  [[ "$VALUE_FLAGS" == *" $arg "* ]] && expect_value=1
  [[ "$COUNT_OR_FILTER" == *" $arg "* ]] && have_action=1
  if [[ "$arg" == "--copy" ]]; then
    copy=1
    continue
  fi
  args+=("$arg")
done

# --help and --stop are actions of their own; everything else needs a
# count or a filter to be a history listing.
if [[ -z "$have_action" ]]; then
  case " $* " in
    *" --help "*|*" --stop "*|*" --get-latest "*|*" --watch "*) ;;
    *)
      echo "history.sh: pass a count (--limit N / --all) or a filter" \
           "(--search / --filter_site / --filter_time). --help lists them." >&2
      exit 2 ;;
  esac
fi

if [[ -n "$copy" ]]; then
  # Honors $TARGET_DIR from the environment when set (used by tests).
  if [[ -z "${TARGET_DIR:-}" ]]; then
    WORKSPACE=$(basename "$(pwd)")
    # Match Gemini's workspace-dir munging: `.` -> `-`, then lowercase.
    WORKSPACE="${WORKSPACE//./-}"
    WORKSPACE="${WORKSPACE,,}"
    # Deliberately $HOME, not $SNAP_REAL_HOME: the .gemini/tmp dir
    # lives wherever Gemini itself puts it.
    TARGET_DIR="$HOME/.gemini/tmp/$WORKSPACE"
  fi
  args+=(--copy-to-dir "$TARGET_DIR/SeeWhatISee")
fi

# ${args[@]+...} keeps `set -u` from treating an empty array as
# unbound, as older bash does.
exec "$(dirname "${BASH_SOURCE[0]}")/../../see-what-i-see/scripts/SeeWhatISee.py" \
  ${args[@]+"${args[@]}"}
