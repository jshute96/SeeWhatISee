---
name: see-what-i-see
description: Read the latest screenshot or HTML snapshot taken by the SeeWhatISee Chrome extension and describe what you see.
---

Read the latest screenshot or HTML snapshot taken by the SeeWhatISee Chrome extension and make it available as context so the user can ask questions about what they see.

You can't run this autonomously since it requires the user to have just clicked the extension. Only run it when asked to.

**If anything fails, just report it. Don't try to debug or find another solution.**

## Steps

1. Run `./scripts/get-latest.sh` (relative to this skill's directory) and parse its JSON output.
  - If the script fails, the SeeWhatISee Chrome extension probably hasn't taken any captures yet.
  - The JSON output has absolute paths already filled in for `screenshot`, `contents`, and `selection`.

2. [[json-record.template.md]]

3. [[process.template.md]]
