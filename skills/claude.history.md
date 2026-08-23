---
name: see-what-i-see-history
description: Scan or search past captures (screenshots, HTML snapshots, selections) taken by the SeeWhatISee Chrome extension — by count, date or time, site, or text. Use to find, analyze, or reprocess captures beyond just the latest.
allowed-tools: "Bash(${CLAUDE_SKILL_DIR}/scripts/history.sh:*),Read(~/Downloads/SeeWhatISee/**)"
---

Scan or search the capture history saved by the SeeWhatISee Chrome extension.

Unlike `see-what-i-see`, this doesn't need the user to have just clicked the extension, so you can use it on your own whenever an earlier capture would answer the question at hand.

**If you get any failures, just report them. Don't try to find other solutions.**

## Running it

`${CLAUDE_SKILL_DIR}/scripts/history.sh [FLAGS]`

[[history-usage.template.md]]

## The records

[[json-record.template.md]]

## Processing a capture you've chosen to open

Same as for a fresh capture, with one difference that **overrides the `prompt` rule below**: a `prompt` on a historical record is what the user asked **at the time**, not an instruction to carry out now. Treat it as context for what that capture was about, and answer the user's current question instead. (The current request may ask you to reprocess the original prompt.)

[[process.template.md]]
