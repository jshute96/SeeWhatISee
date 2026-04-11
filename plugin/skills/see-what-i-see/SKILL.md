---
name: see-what-i-see
description: Read the latest screenshot or HTML snapshot taken by the SeeWhatISee Chrome extension and describe what you see.
allowed-tools: "Read"
---

Read the latest screenshot or HTML snapshot taken by the SeeWhatISee Chrome extension and make it available as context so the user can ask questions about what they see.

You can't run this autonomously since it requires the user to have just clicked the extension. Only run it when asked to.

## Steps

1. Read `~/Downloads/SeeWhatISee/latest.json` to find the most recent capture. It contains `{timestamp, filename, url}`.
   * If that file doesn't exist, report an error that the SeeWhatISee
     Chrome extension hasn't taken any captures yet — nothing in
     `~/Downloads/SeeWhatISee/`.
   * The referenced file is `~/Downloads/SeeWhatISee/<filename>`.
   * The extension could be `.png` (screenshot) or `.html` (page contents).

2. For PNG:
   * Read the file using the Read tool.
   * If you don't have other instructions from the user, briefly describe what you see, mentioning the source `url` from `latest.json`.

3. For HTML:
   * The file could be large so don't read it until you know what to look for.
   * If you don't have other instructions from the user, just report that you have an HTML snapshot from the source `url` and ask the user what they want to know.
