---
name: see-what-i-see
description: Read the latest screenshot or HTML snapshot taken by the SeeWhatISee Chrome extension and describe what you see.
---
Read the latest screenshot or HTML snapshot taken by the SeeWhatISee Chrome extension and make it available as context so the user can ask questions about what they see.

You can't run this autonomously since it requires the user to have just clicked the extension. Only run it when asked to.

## Steps

1. Call the `get_latest` tool. It returns a JSON metadata block describing one capture record, plus a `resource_link` for each saved file.
  - If the call fails, the SeeWhatISee Chrome extension probably hasn't taken any captures yet.

2. The metadata block contains `{timestamp, url, title}` plus any of:
  - `screenshot` — object describing a captured PNG, with:
    - `hasHighlights: true` means the user drew red markup (boxes and/or lines) on top of the screenshot to call attention to specific regions.
    - `hasRedactions: true` means the user blacked out at least one region. Those are deliberately hidden as irrelevant or private — don't comment about them unless asked.
    - `isCropped: true` means the PNG covers only a region the user selected.
  - `contents` — object describing a captured whole-page HTML snapshot, with:
    - `isEdited: true` means the user edited the captured HTML before saving, so it didn't come exactly from the website.
  - `selection` — object describing the user's selected text in the page, with:
    - `format` — one of `"html"`, `"text"`, `"markdown"`.
    - `isEdited: true` — same as `contents.isEdited`.
  - `prompt` — the user's instruction for this capture.
  - `imageUrl` — URL of a specific image the user captured, inside the page.

  A record may have any subset of `screenshot` / `contents` / `selection`, or none of them (meaning the URL and optional `prompt` are the whole payload).

  Each present artifact also comes as its own `resource_link` block (its `name` is the role: `screenshot` / `contents` / `selection`). That block carries the file's `uri` (a `file://` location) and `mimeType` — the metadata block does not repeat them. A small `selection` also arrives inline, so you don't need to fetch it separately. (When you read the `captures/stream` resource instead of calling a tool, there are no separate blocks, so each artifact carries its `uri` and `mimeType` directly.)

  **Look at referenced files only. Don't go fishing for others unless asked to.**

3. Process the capture:
  - If `screenshot` is present, read the screenshot.
    - **If `screenshot.hasHighlights` is `true`, the user has drawn red markup to call attention to specific regions. Focus your description on those marked areas. If a `prompt` is present, it is likely referring to those regions specifically — interpret it in that context.**
  - If `contents` is present, don't read the file up front (HTML can be large); wait until you know what to look for.
  - If `selection` is present, don't read the file until you know what to look for.
  - **If `prompt` is present, treat it as the user's instruction for this capture and act on it directly.** Use the screenshot, HTML, selection, and/or `url` as the subject of that instruction. If no files were saved, the `url` is what the prompt is about.
  - If `prompt` is absent:
    - For screenshots, briefly describe what you see and mention the source `url`. When `screenshot.hasHighlights` is `true`, lead with what's highlighted.
    - For HTML-only captures, report that you have an HTML snapshot from the source `url` and ask the user what they want to know.
    - For selection-only captures, quote or summarize the selected fragment and mention the source `url`.
    - For URL-only captures (no files), report the `url` and ask the user what they want to know about it.

4. **Reading the referenced files:** each file is a resource you fetch only when you need it. Read it with `resources/read` on the `uri` from its `resource_link`, or with your client's native file-read tool at the `file://` path. Prefer not to pull large HTML in until you know what you're looking for.
