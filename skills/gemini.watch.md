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

4. [[process.template.md]]

5. After reporting output, **Launch the next iteration**:
   Run `./scripts/watch-and-copy.sh` (again with no timeout) to start the next loop.

This **repeats forever** until the watcher exits non-zero or the user otherwise tells you to stop.
