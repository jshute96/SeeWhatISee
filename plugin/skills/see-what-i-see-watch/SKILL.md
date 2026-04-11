---
name: see-what-i-see-watch
description: Start a background loop that watches for new captures from the SeeWhatISee Chrome extension. Each time a screenshot or HTML snapshot is taken, describe what you see and start watching for the next one.
allowed-tools: "Bash(${CLAUDE_PLUGIN_ROOT}/scripts/watch.sh:*),Read"
---

Start a background loop that watches for new captures from the SeeWhatISee Chrome extension. Each time a screenshot or HTML snapshot is taken, describe what you see and start watching for the next one.

## Getting snapshots in a loop

1. **Start the loop.** Run `${CLAUDE_PLUGIN_ROOT}/scripts/watch.sh` via the Bash tool with `run_in_background: true` (no timeout — let it run indefinitely). This blocks until the next capture arrives. (`watch.sh` auto-kills any previous watcher via its `.watch.pid` file, so no manual guard is needed.)

2. **On completion.** When the background task completes, check its exit code:
  - **Non-zero exit (killed / error):** Tell the user the watcher stopped and do NOT restart. The watcher was likely killed intentionally by `/see-what-i-see-stop` or by another watcher replacing it.
  - **Exit 0 (success — a capture arrived):**
    1. Read the task's captured stdout to get the JSON record.
    2. Process as described below.
    3. Immediately launch the next iteration: run `${CLAUDE_PLUGIN_ROOT}/scripts/watch.sh --after <filename>` again with `run_in_background: true` (no timeout). The `--after` flag ensures we don't miss any captures added before we restarted. If any captures are reported, process each as described below.

3. **Repeat forever** until the watcher exits non-zero or the user otherwise tells you to stop.

## Process each snapshot

1. You have a JSON record for this capture. It contains `{timestamp, filename, url}`.
  - The referenced file is `~/Downloads/SeeWhatISee/<filename>`.
  - The extension could be `.png` (screenshot) or `.html` (page contents).

2. For PNG:
  - Read the file using the Read tool.
  - Briefly describe what you see, mentioning the source `url`.

3. For HTML:
  - The file could be large so don't read it until you know what to look for.
  - Just report that you have an HTML snapshot from the source `url` and ask the user what they want to know.
