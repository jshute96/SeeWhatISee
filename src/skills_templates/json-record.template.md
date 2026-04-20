The JSON record contains `{timestamp, url}` plus any of:
  - `screenshot` — object `{ "filename": "<abs path>", "hasHighlights": true?, "hasRedactions": true?, "isCropped": true? }` pointing at a PNG file.
    - `hasHighlights: true` means the user drew red markup (boxes and/or lines) on top of the screenshot to call attention to specific regions.
    - `hasRedactions: true` means the user blacked out at least one region. Treat those areas as deliberately hidden — don't speculate about what's under them.
    - `isCropped: true` means the PNG covers only a region the user selected, not the full capture. The source `url` still references the original page.
  - `contents` — object `{ "filename": "<abs path>", "isEdited": true? }` pointing at an HTML file (whole-page snapshot). `isEdited: true` means the user edited the captured HTML before saving, so it didn't come exactly from the website.
  - `selection` — object `{ "filename": "<abs path>", "isEdited": true? }` pointing at an HTML file containing just the user's page selection at capture time (text and HTML). Same `isEdited` semantics as `contents`.
  - `prompt` — the user's instruction for this capture.

  A record may have any subset of `screenshot` / `contents` / `selection`, or none — in the none case, the URL (and optional prompt) is the whole payload.

  **Look at referenced files only. Don't go fishing for others unless asked to.**
