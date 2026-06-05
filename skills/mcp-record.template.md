The metadata block contains `{timestamp, url, title}` plus any of:
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

  Each present artifact also comes as its own `resource_link` block (its `name` is the role: `screenshot` / `contents` / `selection`). That block carries the file's `uri` (a `file://` location) and `mimeType` — the metadata block does not repeat them. A small `selection` is also included inline. (When you read the `captures/stream` resource instead of calling a tool, there are no separate blocks, so each artifact carries its `uri` and `mimeType` directly.)

  **Look at referenced files only. Don't go fishing for others unless asked to.**
