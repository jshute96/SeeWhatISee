#!/usr/bin/env bash
# Thin wrapper: defer to SeeWhatISee.py with the caller's flags.
#
# Unlike the other wrappers this one forces no action — the history
# skill passes --limit / --all / --search / --filter_site /
# --filter_time itself, and --help reaches the master too.
#
# It does insist on one of those flags. The backend falls back to
# --get-latest when given no action at all, so a history run that lost
# its flags would quietly describe the newest capture instead of
# listing anything. Fail loudly rather than answer a different
# question.
#
# SeeWhatISee.py lives in the see-what-i-see skill's scripts/ dir;
# reach across sibling-relative.

set -euo pipefail

# Match flag names, ignoring any =value.
flags=
for arg in "$@"; do flags+=" ${arg%%=*}"; done

case "$flags " in
  *" --limit "*|*" --all "*|*" --search "*) ;;
  *" --filter_site "*|*" --filter_time "*|*" --help "*) ;;
  *)
    echo "history.sh: pass a count (--limit N / --all) or a filter" \
         "(--search / --filter_site / --filter_time). --help lists them." >&2
    exit 2 ;;
esac

exec "$(dirname "${BASH_SOURCE[0]}")/../../see-what-i-see/scripts/SeeWhatISee.py" "$@"
