---
name: see-what-i-see-watch
description: Watch for new captures from the SeeWhatISee Chrome extension. Each time a screenshot or HTML snapshot is taken, describe what you see and start watching for the next one.
---

Watch for new captures from the SeeWhatISee Chrome extension. Each time a capture arrives, process it as described below, then watch for the next one. Keep looping until the user tells you to stop, or until a failure.

To look for older captures (the last few, by date or time, by site, or by text), use the `see-what-i-see-history` skill.

**If anything fails, do not try to debug or fix anything. Just report the failure.**

**Do not read the script.** Just run it, following the instructions below.

This is a **loop of single-shot runs**: each run of `./scripts/watch-once.sh` waits for the next capture, prints one JSON record, and exits — so you re-run it once per capture.

The run happens in the background, so the user can keep prompting you while it waits. Stay responsive to them between captures; just come back to the record when the run finishes.

## Getting captures in a loop

1. **Wait for the next capture.** Run `./scripts/watch-once.sh` (relative to this skill's directory), with no timeout. It waits until a capture arrives, then prints one JSON record to stdout and exits. **Wait for it to complete before going on to step 2** — but keep answering the user in the meantime.

2. **Check the exit code.**
   - **3 (stopped on request):** tell the user the watch was stopped — stderr says whether that was a stop request or another watcher taking over — and do NOT restart.
   - **Other non-zero (killed or errored):** tell the user the watcher stopped unexpectedly and do NOT restart.
   - **Zero:** a capture arrived — continue.

3. **Process the record** it printed (see below).

4. **Start the next iteration.** Run `./scripts/watch-once.sh --after <timestamp of the record you just processed>` and go back to step 2.

Always pass `--after <timestamp of the last record you processed>` on the follow-up runs. That makes each run emit the single next capture after that timestamp — returning immediately if one was already waiting while you were busy.

## Process each snapshot

1. [[json-record.template.md]]

2. [[process.template.md]]
