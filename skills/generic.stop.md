---
name: see-what-i-see-stop
description: Stop the background SeeWhatISee watch loop started by see-what-i-see-watch.
---

Stop the background SeeWhatISee watch loop started by `see-what-i-see-watch`.

This only applies to the **streaming/background watcher** (the one started with `./scripts/watch.sh`), which records a pidfile. The polling path has nothing to stop — you just stop re-running it.

## Steps

1. Run `./scripts/stop.sh` (relative to this skill's directory).
2. Relay the script's output to the user (it will say either "Stopping existing watcher" or "No existing watcher to stop").
