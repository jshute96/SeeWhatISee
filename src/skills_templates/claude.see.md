---
name: see-what-i-see
description: Read the latest screenshot or HTML snapshot taken by the SeeWhatISee Chrome extension and describe what you see.
allowed-tools: "Bash(${CLAUDE_PLUGIN_ROOT}/scripts/get-latest.sh:*),Read(~/Downloads/SeeWhatISee/**)"
---

Read the latest screenshot or HTML snapshot taken by the SeeWhatISee Chrome extension and make it available as context so the user can ask questions about what they see.

You can't run this autonomously since it requires the user to have just clicked the extension. Only run it when asked to.

**If you get any failures, just report them. Don't try to find other solutions.**

## Steps

1. Run `${CLAUDE_PLUGIN_ROOT}/scripts/get-latest.sh` and parse its JSON output.
  - If the script fails, the SeeWhatISee Chrome extension probably hasn't taken any captures yet.
  - The JSON output has absolute paths already filled in for `screenshot`, `contents`, and `selection`.

2. [[json-record.template.md]]

3. [[process.template.md]]
