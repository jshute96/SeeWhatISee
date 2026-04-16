---
name: see-what-i-see-watch
description: Start a background loop that watches for new captures from the SeeWhatISee Chrome extension. Each time a screenshot or HTML snapshot is taken, describe what you see and start watching for the next one.
allowed-tools: "Bash(${CLAUDE_PLUGIN_ROOT}/scripts/watch.sh:*),Read"
---

Start a background loop that watches for new captures from the SeeWhatISee Chrome extension. Each time a screenshot or HTML snapshot is taken, describe what you see and start watching for the next one.

**If you get any failures, just report them. Don't try to find other solutions.**

## Getting snapshots in a loop

1. **Start the loop.** Run `${CLAUDE_PLUGIN_ROOT}/scripts/watch.sh` via the Bash tool with `run_in_background: true` (no timeout — let it run indefinitely). This blocks until the next capture arrives. (`watch.sh` auto-kills any previous watcher via its `.watch.pid` file, so no manual guard is needed.)

2. **On completion.** When the background task completes, check its exit code:
  - **Non-zero exit (killed / error):** Tell the user the watcher stopped and do NOT restart. The watcher was likely killed intentionally by `/see-what-i-see-stop` or by another watcher replacing it.
  - **Exit 0 (success — a capture arrived):**
    1. Read the task's captured stdout to get the JSON record(s). The JSON has absolute paths already filled in for `screenshot` and `contents`.
    2. Process each record as described below.
    3. Immediately launch the next iteration: run `${CLAUDE_PLUGIN_ROOT}/scripts/watch.sh --after <timestamp>` again with `run_in_background: true` (no timeout), passing the most recently processed record's `timestamp` field. The `--after` flag ensures we don't miss any captures added before we restarted; if any captures are reported on the next run, process each the same way.

3. **Repeat forever** until the watcher exits non-zero or the user otherwise tells you to stop.

## Process each snapshot

1. You have a JSON record for this capture. It contains `{timestamp, url}` plus some combination of:
  - `screenshot` — absolute path to a PNG file.
  - `highlights` — `true` when the screenshot has user-drawn red markup baked
    into it (boxes and/or lines calling attention to specific regions
    of the image).
  - `contents` — absolute path to an HTML file.
  - `prompt` — the user's instruction for this capture (if present)

  Any record will have at least one of `screenshot` / `contents`.
  **Look at these files only. Don't go fishing for others unless asked to.**

2. Process the capture:
  - If `screenshot` is present, Read it with the Read tool.
    - **If `highlights` is `true`, the user has drawn red markup to call attention to specific regions. Focus your description on those marked areas. If a `prompt` is present, it is likely referring to those regions specifically — interpret it in that context.**
  - If `contents` is present, don't Read it up front (HTML can be large); wait until you know what to look for.
  - **If `prompt` is present, treat it as the user's instruction for this capture and act on it directly.** Use the screenshot and/or HTML as the subject of that instruction. Mention the source `url` if relevant.
  - If `prompt` is absent:
    - For screenshots, briefly describe what you see and mention the source `url`. When `highlights` is `true`, lead with what's highlighted.
    - For HTML-only captures, report that you have an HTML snapshot from the source `url` and ask the user what they want to know.
