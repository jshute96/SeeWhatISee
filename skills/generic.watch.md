---
name: see-what-i-see-watch
description: Watch for new captures from the SeeWhatISee Chrome extension. Each time a screenshot or HTML snapshot is taken, describe what you see and start watching for the next one.
---

Watch for new captures from the SeeWhatISee Chrome extension. Each time a capture arrives, process it as described below, then watch for the next one. Keep looping until the user tells you to stop, or until a failure.

**If anything fails, do not try to debug or fix anything. Just report the failure.**

## Getting captures in a loop

Pick the approach that fits your tool. It comes down to two independent questions:

- Can your tool **stream** a long-running command's output, reading each line as it's printed?
- Can your tool run a command in the **background** and wake you when it produces output or exits?

### If your tool can stream output — streaming watcher

1. **Start the watcher.** Run `./scripts/watch.sh` (relative to this skill's directory) and leave it running. It prints one capture record per line as each capture arrives, and runs until stopped. It writes a pidfile, so `/see-what-i-see-stop` (or a later watcher) can replace it.
   - Run it in the **background** if your tool supports that, so you stay responsive to the user while it waits.
2. **Process each line as it arrives** — each line of stdout is one JSON record (see below).
3. **When the watcher exits:** tell the user it stopped and do NOT restart. It was likely stopped on purpose (via `/see-what-i-see-stop` or by another watcher replacing it).

### Otherwise — single-shot watcher, run in a loop

Each run of `./scripts/watch-once.sh` (no timeout) blocks until the next capture, prints one JSON record, then exits — so you re-run it once per capture:

1. Run `./scripts/watch-once.sh` and wait for it to finish. It prints one JSON record.
2. Process that record (see below).
3. Run `./scripts/watch-once.sh --after <timestamp of that record>` and repeat from step 2.

**Foreground or background:** if your tool can run a command in the background and wake you when it finishes, launch each run in the background — you stay responsive to the user between captures and pick up step 2 when it completes. Otherwise run it in the foreground, which blocks the conversation until each capture arrives.

Always pass `--after <timestamp of the last record you processed>` on the follow-up runs. That makes each run emit the single next capture after that timestamp — returning immediately if one was already waiting.

**On a non-zero exit** (the watcher was killed or errored): tell the user it stopped and do NOT restart.

## Process each snapshot

1. [[json-record.template.md]]

2. [[process.template.md]]
