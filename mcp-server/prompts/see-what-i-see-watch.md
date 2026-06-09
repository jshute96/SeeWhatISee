---
name: see-what-i-see-watch
description: Watch for new captures from the SeeWhatISee Chrome extension. Each time a screenshot or HTML snapshot is taken, describe what you see and start watching for the next one.
---
Watch for new captures from the SeeWhatISee Chrome extension. Each time a screenshot or HTML snapshot is taken, describe what you see and start watching for the next one.

## Getting snapshots in a loop

Prefer the subscription path when the client supports it; fall back to polling otherwise.

### Subscription path (preferred)

1. Subscribe to the resource `seewhatisee://captures/stream`.
2. Each `notifications/resources/updated` notification means a new capture arrived. Read the resource to fetch the latest record, then process it as described below.
3. Continue until the user tells you to stop.

### Polling path (fallback)

1. Call the `watch` tool with no arguments. It blocks for up to ~60s and returns any new capture records — each as a JSON metadata block plus a `resource_link` per saved file, the same shape as `get_latest`. With nothing new it returns `{ records: [] }`.
2. Process each returned record as described below.
3. Call `watch` again with `after = <last record's timestamp>` to catch up on anything that arrived while you were processing, then block for the next.
4. Continue until the user tells you to stop.

## Process each snapshot

1. The capture record contains `{timestamp, url, title}` plus any of:
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

  Each present artifact also comes as its own `resource_link` block (its `name` is the role: `screenshot` / `contents` / `selection`). That block carries the file's `uri` (a `file://` location) and `mimeType`. A small `selection` also arrives inline, so you don't need to fetch it separately. (When you read the `captures/stream` resource instead of calling a tool, there are no separate blocks, so each artifact carries its `uri` and `mimeType` directly.)

  **Look at referenced files only. Don't go fishing for others unless asked to.**

2. Process the capture:
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

3. **Reading the referenced files:** each file is a resource you fetch only when you need it. Read it with `resources/read` on the `uri` from its `resource_link`, or with your client's native file-read tool at the `file://` path.
