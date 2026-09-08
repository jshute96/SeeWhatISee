---
name: see-what-i-see-stop
description: Stop a running SeeWhatISee watch loop started by see-what-i-see-watch.
---

Stop a running SeeWhatISee watch loop started by `see-what-i-see-watch`.

This works for both streaming and polling single-shot watchers.

## Steps

1. Run `./scripts/stop.sh` (relative to this skill's directory).
2. Relay the script's output to the user (it will say either "Stopping existing watcher" or "No existing watcher to stop").
