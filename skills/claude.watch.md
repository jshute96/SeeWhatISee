---
name: see-what-i-see-watch
description: Start a background loop that watches for new captures from the SeeWhatISee Chrome extension. Each time a screenshot or HTML snapshot is taken, describe what you see and start watching for the next one.
allowed-tools: "Monitor,Bash(${CLAUDE_SKILL_DIR}/scripts/watch.sh:*),Read(~/Downloads/SeeWhatISee/**)"
---

Start a background loop that watches for new captures from the SeeWhatISee Chrome extension. Each time a screenshot or HTML snapshot is taken, describe what you see and start watching for the next one.

**If you get any failures, just report them. Don't try to find other solutions.**

## Getting snapshots in a loop

1. **Start the watcher.** Use the `Monitor` tool with:
   - `command`: `${CLAUDE_SKILL_DIR}/scripts/watch.sh`
   - `persistent`: `true`
   - `description`: `see-what-i-see-watch`

   Each line of stdout from the script is one capture record, delivered as its own notification. (`watch.sh` auto-kills any previous watcher via its `.watch.pid` file, so no manual guard is needed.)

2. **Process each notification as it arrives.** Each notification carries one JSON record — process it as described in the section below.

3. **When the monitor reports the script exited:** Tell the user the watcher stopped and do NOT restart. The watcher was likely killed intentionally by `/see-what-i-see-stop` or by another watcher replacing it.

## Process each snapshot

1. [[json-record.template.md]]

2. [[process.template.md]]
