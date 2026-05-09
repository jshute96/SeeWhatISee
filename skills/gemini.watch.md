description = """
Watch for new captures from the SeeWhatISee Chrome extension. Each time a capture arrives, describe what you see (or follow the user's prompt) and then watch for the next, until stopped by the user.
"""
prompt = """
**If anything fails, do not try to debug or fix anything. Just report the failure.**

Watch for new captures from the SeeWhatISee Chrome extension. Each time a capture arrives, process it as described below, then watch for the next one. Keep looping until the user tells you to stop, or until a failure.

This is a foreground loop: each iteration blocks on a shell command that doesn't return until the next capture lands.

## Getting snapshots in a loop

1. **Start the loop.** Run `$HOME/.gemini/scripts/watch-and-copy.sh` with no timeout. This blocks until there's a capture to process, then prints a JSON record to stdout.

2. **On each record,** process it as described in the next section, then immediately launch the next iteration: run `$HOME/.gemini/scripts/watch-and-copy.sh --after <timestamp>` (again with no timeout), passing the most recently processed record's `timestamp` field. The `--after` flag ensures we don't miss any captures that arrived while you were processing.

3. **Repeat forever**, but stop on failures. Don't try to recover from failures — just report them and exit.

## Process each snapshot

1. [[json-record.template.md]]

2. [[process.template.md]]
"""
