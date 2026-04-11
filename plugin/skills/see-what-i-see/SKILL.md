---
name: see-what-i-see
description: Read the latest screenshot or HTML snapshot taken by the SeeWhatISee Chrome extension and describe what you see.
allowed-tools: "Read"
---

Read the latest screenshot or HTML snapshot taken by the SeeWhatISee Chrome extension and make it available as context so the user can ask questions about what they see.

You can't run this autonomously since it requires the user to have just clicked the extension. Only run it when asked to.

## Steps

1. Read `~/Downloads/SeeWhatISee/latest.json` to find the most recent capture.
   * If that file doesn't exist, report an error that the SeeWhatISee
     Chrome extension hasn't taken any captures yet — nothing in
     `~/Downloads/SeeWhatISee/`.

2. The record contains `{timestamp, url}` plus some combination of:
   * `screenshot` — bare filename of a PNG at `~/Downloads/SeeWhatISee/<screenshot>`
   * `contents` — bare filename of an HTML file at `~/Downloads/SeeWhatISee/<contents>`
   * `prompt` — the user's instruction for this capture (if present)

   Any record will have at least one of `screenshot` / `contents`.
   **Look at these files only. Don't go fishing for others unless asked to.**

3. Process the capture:
   * If `screenshot` is present, Read it with the Read tool.
   * If `contents` is present, don't Read it up front (HTML can be large);
     wait until you know what to look for.
   * **If `prompt` is present, treat it as the user's instruction for this
     capture and act on it directly.** Use the screenshot and/or HTML as the
     subject of that instruction. Mention the source `url` if relevant.
   * If `prompt` is absent:
     - For screenshots, briefly describe what you see and mention the source
       `url`.
     - For HTML-only captures, report that you have an HTML snapshot from
       the source `url` and ask the user what they want to know.
