Start a background loop that watches for new captures from the SeeWhatISee Chrome extension. Each time a screenshot or HTML snapshot is taken, describe what you see and start watching for the next one.

## Steps

1. **Start the loop.** Run `scripts/watch.sh` via the Bash tool with `run_in_background: true` (no timeout — let it run indefinitely). This blocks until the next capture arrives. (`watch.sh` auto-kills any previous watcher via its `.watch.pid` file, so no manual guard is needed.)

2. **On completion.** When the background task completes, check its exit code:
   - **Non-zero exit (killed / error):** Tell the user the watcher stopped (mention the exit code) and do NOT restart. The watcher was likely killed intentionally by `/SeeWhatISeeStop` or by another watcher replacing it.
   - **Exit 0 (success — a capture arrived):**
     a. Read the task's captured stdout to get the JSON record (which contains `filename` and `url`).
     b. Read the file at `~/Downloads/SeeWhatISee/<filename>` using the Read tool. The filename will end in `.png` (screenshot) or `.html` (page contents).
     c. Briefly describe what you see (mention the source `url`).
     d. Remember the `filename` from this capture.
     e. Immediately launch the next iteration: run `scripts/watch.sh --after <filename>` again with `run_in_background: true` (no timeout). The `--after` flag ensures we don't miss any captures added before we restarted. If any captures are reported, read and describe each of them too before restarting the watcher.

3. **Repeat forever** until the watcher exits non-zero, the user runs `/SeeWhatISeeStop`, or the user otherwise tells you to stop.
