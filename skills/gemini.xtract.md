---
name: see-what-i-see-xtract
description: >
  Read the latest screenshot or HTML snapshot taken by the SeeWhatISee Chrome extension.

  You can't run this autonomously since it requires the user to have just clicked the extension. Only run it when asked to.

  (Alias for /see-what-i-see.)
---

To look for older captures (the last few, by date or time, by site, or by text), use the `see-what-i-see-history` skill.

**If anything fails, do not try to debug or fix anything. Just report the failure.**

**Do not read the script.** Just run it, following the instructions below.

1. Read this JSON object:
!{./scripts/copy-last-snapshot.sh}

2. [[json-record.template.md]]

3. [[process.template.md]]
