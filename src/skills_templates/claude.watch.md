---
name: see-what-i-see-watch
description: Start a background loop that watches for new captures from the SeeWhatISee Chrome extension. Each time a screenshot or HTML snapshot is taken, describe what you see and start watching for the next one.
allowed-tools: "Bash(${CLAUDE_PLUGIN_ROOT}/scripts/watch.sh:*),Read(~/Downloads/SeeWhatISee/**)"
---

Start a background loop that watches for new captures from the SeeWhatISee Chrome extension. Each time a screenshot or HTML snapshot is taken, describe what you see and start watching for the next one.

**If you get any failures, just report them. Don't try to find other solutions.**

## Getting snapshots in a loop

1. **Start the loop.** Run `${CLAUDE_PLUGIN_ROOT}/scripts/watch.sh` via the Bash tool with `run_in_background: true` (no timeout — let it run indefinitely). This blocks until the next capture arrives. (`watch.sh` auto-kills any previous watcher via its `.watch.pid` file, so no manual guard is needed.)

2. **On completion.** When the background task completes, check its exit code:
  - **Non-zero exit (killed / error):** Tell the user the watcher stopped and do NOT restart. The watcher was likely killed intentionally by `/see-what-i-see-stop` or by another watcher replacing it.
  - **Exit 0 (success — a capture arrived):**
    1. Read the task's captured stdout to get the JSON record(s). The JSON has absolute paths already filled in for `screenshot`, `contents`, and `selection`.
    2. Process each record as described below.
    3. Immediately launch the next iteration: run `${CLAUDE_PLUGIN_ROOT}/scripts/watch.sh --after <timestamp>` again with `run_in_background: true` (no timeout), passing the most recently processed record's `timestamp` field. The `--after` flag ensures we don't miss any captures added before we restarted; if any captures are reported on the next run, process each the same way.

3. **Repeat forever** until the watcher exits non-zero or the user otherwise tells you to stop.

## Process each snapshot

1. [[json-record.template.md]]

2. [[process.template.md]]
