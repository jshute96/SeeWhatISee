---
name: see-what-i-see-stop
description: Stop the background SeeWhatISee watch loop started by /see-what-i-see-watch.
allowed-tools: "Bash(${CLAUDE_PLUGIN_ROOT}/scripts/watch.sh:*)"
---

Stop the background SeeWhatISee watch loop started by `/see-what-i-see-watch`.

## Steps

1. Stop the watcher by running:
   ```
   ${CLAUDE_PLUGIN_ROOT}/scripts/watch.sh --stop
   ```
2. Relay the script's output to the user (it will say either "Stopping existing watcher" or "No existing watcher to stop").
