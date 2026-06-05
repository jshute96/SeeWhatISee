---
name: see-what-i-see-watch
description: Watch for new captures from the SeeWhatISee Chrome extension. Each time a capture arrives, describe what you see (or follow the user's prompt) and then watch for the next, until stopped by the user.
---

**If anything fails, do not try to debug or fix anything. Just report the failure.**

Watch for new captures from the SeeWhatISee Chrome extension. Each time a capture arrives, process it as described below, then watch for the next one. Keep looping until the user tells you to stop, or until a failure.

This is a **foreground loop: each iteration blocks** on a shell command that doesn't return until the next capture lands.

## Getting snapshots in a loop

1. **Wait for the next capture.** Run `./scripts/watch-and-copy.sh` with no timeout. This blocks until there's a capture to process, then prints a JSON record to stdout.  **Block until it completes.**

2. **Check the exit code:**
  - **Non-zero exit (killed / error):** Tell the user the watcher stopped and do NOT restart.
  - **Exit 0 (success — a capture arrived):**

3. **Read captured stdout to get the JSON record(s).** 
  [[json-record.template.md]]

4. **Process each snapshot record** **before restarting the script for the next iteration**.
  - If `screenshot` is present, read the screenshot.
    - **If `screenshot.hasHighlights` is `true`, the user has drawn red markup to call attention to specific regions. Focus your description on those marked areas. If a `prompt` is present, it is likely referring to those regions specifically — interpret it in that context.**
  - If `contents` is present, don't read the file up front (HTML can be large); wait until you know what to look for.
  - If `selection` is present, don't read the file until you know what to look for.
  - **If `prompt` is present, treat it as the user's instruction for this capture and act on it directly.** Use the screenshot, HTML, selection, and/or `url` as the subject of that instruction. If no files were saved, the `url` is what the prompt is about.
  - If `prompt` is absent:
    - For screenshots, briefly describe what you see and mention the source `url`. When `screenshot.hasHighlights` is `true`, lead with what's highlighted.
    - For HTML-only captures, report that you have an HTML snapshot from the source `url` and ask the user what they want to know.
    - For selection-only captures, quote or summarize the selected fragment and mention the source `url`.
    - For URL-only captures (no files), report the `url` and ask the user what they want to know about it.

5. After reporting output, **Launch the next iteration**:
   Run `./scripts/watch-and-copy.sh` (again with no timeout) to start the next loop.

This **repeats forever** until the watcher exits non-zero or the user otherwise tells you to stop.
