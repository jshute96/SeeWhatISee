---
name: see-what-i-see
description: Read the latest screenshot or HTML snapshot taken by the SeeWhatISee Chrome extension and describe what you see.
allowed-tools: "Bash(${CLAUDE_PLUGIN_ROOT}/scripts/get-latest.sh:*),Read"
---

Read the latest screenshot or HTML snapshot taken by the SeeWhatISee Chrome extension and make it available as context so the user can ask questions about what they see.

You can't run this autonomously since it requires the user to have just clicked the extension. Only run it when asked to.

**If you get any failures, just report them. Don't try to find other solutions.**

## Steps

1. Run `${CLAUDE_PLUGIN_ROOT}/scripts/get-latest.sh` and parse its JSON output.
   * If the script fails, the SeeWhatISee Chrome extension probably hasn't taken any captures yet.
   * The JSON output has absolute paths already filled in for `screenshot` and `contents`.

2. The JSON contains `{timestamp, url}` plus some combination of:
   * `screenshot` — absolute path to a PNG file.
   * `highlights` — `true` when the screenshot has user-drawn red markup baked
     into it (boxes, lines, and/or dots calling attention to specific regions
     of the image).
   * `contents` — absolute path to an HTML file.
   * `prompt` — the user's instruction for this capture.

   Any record will have at least one of `screenshot` / `contents`.
   **Look at these files only. Don't go fishing for others unless asked to.**

3. Process the capture:
   * If `screenshot` is present, Read it with the Read tool.
     - **If `highlights` is `true`, the user has drawn red markup to call attention to 
       specific regions. Focus your description on those marked areas. 
       If a `prompt` is present, it is likely referring to those regions specifically — interpret 
       it in that context.**
   * If `contents` is present, don't Read it up front (HTML can be large);
     wait until you know what to look for.
   * **If `prompt` is present, treat it as the user's instruction for this
     capture and act on it directly.** Use the screenshot and/or HTML as the
     subject of that instruction. Mention the source `url` if relevant.
   * If `prompt` is absent:
     - For screenshots, briefly describe what you see and mention the source
       `url`. When `highlights` is `true`, lead with what's highlighted.
     - For HTML-only captures, report that you have an HTML snapshot from
       the source `url` and ask the user what they want to know.
