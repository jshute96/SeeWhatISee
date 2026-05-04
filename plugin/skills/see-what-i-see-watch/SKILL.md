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

1. The JSON record contains `{timestamp, url, title}` plus any of:
  - `screenshot` — object describing a captured PNG, with:
    - `filename` — absolute path.
    - `hasHighlights: true` means the user drew red markup (boxes and/or lines) on top of the screenshot to call attention to specific regions.
    - `hasRedactions: true` means the user blacked out at least one region. Those are deliberately hidden as irrelevant or private — don't comment about them unless asked.
    - `isCropped: true` means the PNG covers only a region the user selected.
  - `contents` — object describing a captured whole-page HTML snapshot, with:
    - `filename` — absolute path.
    - `isEdited: true` means the user edited the captured HTML before saving, so it didn't come exactly from the website.
  - `selection` — object describing the user's selected text in the page, with:
    - `filename` — absolute path.
    - `format` — one of `"html"`, `"text"`, `"markdown"`.
    - `isEdited: true` — same as `contents.isEdited`.
  - `prompt` — the user's instruction for this capture.
  - `imageUrl` — URL of a specific image the user captured, inside the page.

  A record may have any subset of `screenshot` / `contents` / `selection`, or none of them (meaning the URL and optional `prompt` are the whole payload).

  **Look at referenced files only. Don't go fishing for others unless asked to.**

2. Process the capture:
  - If `screenshot` is present, read `screenshot.filename`.
    - **If `screenshot.hasHighlights` is `true`, the user has drawn red markup to call attention to specific regions. Focus your description on those marked areas. If a `prompt` is present, it is likely referring to those regions specifically — interpret it in that context.**
  - If `contents` is present, don't read the file up front (HTML can be large); wait until you know what to look for.
  - If `selection` is present, don't read the file until you know what to look for.
  - **If `prompt` is present, treat it as the user's instruction for this capture and act on it directly.** Use the screenshot, HTML, selection, and/or `url` as the subject of that instruction. If no files were saved, the `url` is what the prompt is about.
  - If `prompt` is absent:
    - For screenshots, briefly describe what you see and mention the source `url`. When `screenshot.hasHighlights` is `true`, lead with what's highlighted.
    - For HTML-only captures, report that you have an HTML snapshot from the source `url` and ask the user what they want to know.
    - For selection-only captures, quote or summarize the selected fragment and mention the source `url`.
    - For URL-only captures (no files), report the `url` and ask the user what they want to know about it.
