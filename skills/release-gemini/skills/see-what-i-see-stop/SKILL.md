---
name: see-what-i-see-stop
description: Stop a running SeeWhatISee watch loop started by /see-what-i-see-watch.
---

Stop a running SeeWhatISee watch loop started by `/see-what-i-see-watch`.

The watch loop is a series of blocking runs, one per capture. This stops the run that is currently waiting; the loop it belongs to must not be restarted afterwards. It can also stop a watcher started in another session, or by another tool.

**Do not read the script.** Just run it, following the instructions below.

## Steps

1. Run `./scripts/stop.sh` (relative to this skill's directory).
2. Relay the script's output to the user. It says what it found and what it did.
