# Capture page (`capture.html`)

The Capture page opens in a new tab, previews the pre-captured
screenshot, and waits for the user to pick which artifacts to save
before writing anything. Implementation lives in
`src/background.ts`, `src/capture.html`, and `src/capture-page.ts`.

For the broader architecture and the action that opens this page,
see [`architecture.md`](architecture.md) and
[`capture-actions.md`](capture-actions.md). Chrome-platform hazards
referenced from this doc live in
[`chrome-extension.md`](chrome-extension.md).

## Pre-capture and tab open

- `captureBothToMemory()` snapshots the screenshot + HTML up-front,
  *before* opening the new tab. This way the preview shows the
  user's current page, not the empty `capture.html` tab.
- `startCaptureWithDetails()` then opens `capture.html` immediately
  to the right of the active tab (`index: active.index + 1`) and
  links it via `openerTabId`.
- The capture data and the opener id are stashed in
  `chrome.storage.session` keyed by the new tab's id, in a
  `DetailsSession` wrapper.
- Module-level state doesn't survive the SW idling out, so
  `chrome.storage.session` is the right home — in-memory (not
  written to disk) but survives the worker unloading between the
  menu click and the user clicking Capture.
- A `chrome.tabs.onRemoved` handler drops the stashed session when
  the user closes the page without clicking Capture, so session
  storage doesn't grow until browser restart.

## Graceful handling of failed screenshot / HTML / selection scrape

- `captureBothToMemory` catches failures from
  `chrome.scripting.executeScript` and from
  `chrome.tabs.captureVisibleTab` and returns an `InMemoryCapture`
  with `htmlError` / `selectionError` / `screenshotError` set
  instead of throwing.
- Common trigger: restricted URLs (chrome://, the Web Store) where
  extensions can't inject scripts. On the Web Store
  `captureVisibleTab` is also blocked, so `screenshotError` fires
  there; on generic `chrome://` pages the screenshot still
  succeeds.

### Impact on the Capture page

- The Capture page still opens with the screenshot preview.
  When `screenshotError` is set the preview image will be broken
  (empty data URL) but the rest of the page still renders; Save
  screenshot and its Copy button are disabled + unchecked and the
  row carries an error icon explaining why.
- Save HTML and the master Save-selection checkbox are disabled +
  unchecked; their Copy and Edit buttons are hidden (the shared
  `.copy-btn:disabled` rule covers both).
- The `.selection-formats` wrapper around the format radios stays
  hidden whenever no selection has saveable content — so scrape
  failures simply show no format rows.
- The error icon + tooltip is shown only on the Save HTML row.
  Selection is scraped in the same `executeScript` call as HTML,
  so when the call fails the errors are always twins and a
  duplicate icon on the master row would just repeat the same
  message. The master row stays greyed out without an icon; the
  wiring is ready for a future SW that reports per-format failures
  separately (each format row keeps its own
  `#error-selection-{html,text,markdown}` element) but today's
  `captureBothToMemory` never emits that combination.
- Hotkeys (Alt+H, etc) are no-ops while the corresponding control
  is disabled.
- `ensureHtmlDownloaded` / `ensureSelectionDownloaded(format)`
  throw if the matching `*Error` is set (or the requested format's
  body trims to empty), as a belt-and-suspenders guard so a stale
  page message can't materialize an empty file.

### Impact on the More-menu shortcuts

- `save-url` (URL-only) deliberately ignores `htmlError` — it
  doesn't need HTML anyway.
- `save-defaults` re-throws `screenshotError` / `htmlError` only
  when the matching default is on (e.g. an `htmlError` only fails
  the action when `withSelection.html === true` /
  `withoutSelection.html === true` for the active branch);
  otherwise the action records what it can and leaves the broken
  artifact off the sidecar. `selectionError` is never re-thrown —
  `data.selections` is unset on a selection-scrape failure, so
  `useWithSelection` collapses to false and the user's
  with-selection defaults don't apply.
- `save-all` (screenshot + HTML + selection-if-any) re-throws
  `screenshotError` or `htmlError` so the toolbar icon / tooltip
  surfaces the reason via the standard error-reporting channel.
  The selection branch is silently skipped when no selection was
  present or its scrape errored — same `selectionError` policy as
  `save-defaults`.

## What the page shows

### Captured-page card

- Bordered strip showing the capture's page metadata.
- Title row: clickable link with the captured tab's title (falls
  back to the URL when the title is empty); two pill badges
  right-aligned via `margin-left: auto` on the first.
  - `HTML · <size>` — `formatBytes(new Blob([html]).size)`.
  - `Selection · <size>` — byte count of the format the
    Selection pill is currently showing (the checked radio when
    the master is on; the sticky last-picked format otherwise).
    Describes *what was captured and is available to save*, NOT
    what's being saved — so unchecking the master Save-selection
    checkbox leaves the pill visible (parallel to the HTML pill
    not hiding when Save-HTML is unchecked). Hidden only when no
    selection was captured at all.
  - Both pills update on every Edit-dialog save (HTML + each
    selection format) so the displayed bytes track the live
    `captured` body. The Selection pill also updates whenever the
    user picks a different format radio.
- URL row: monospace blue link with a trailing external-link glyph,
  followed inline by a 22px Copy URL button matching the per-row
  `.copy-btn` chrome elsewhere on the page.
- When the captured URL isn't linkable (empty, or a non-http(s)
  scheme like `chrome://` / `file://` / `data:`) both rows lose
  their `href` and render as plain black text; the URL row's blue
  is overridden and the trailing external-link glyph is hidden.
  Copy URL stays enabled whenever the URL string is non-empty (so
  you can copy `chrome://...` to the clipboard); it follows the
  `.copy-btn:disabled { display: none }` rule and vanishes when
  the URL is empty.
- When HTML capture failed the size pill is hidden outright rather
  than showing a misleading `0 B`.

### Save checkboxes

- Pick any of screenshot, HTML, selection (one format), or none
  (URL-only record). Capture stays enabled even with neither
  ticked.
- Save selection is a master checkbox (`Save selection`) plus a
  group of three mutually-exclusive format radios (`as HTML`,
  `as text`, `as markdown`). The master gates whether anything is
  saved; the radios pick which serialization.
- Master / radio coupling, wired in `wireSelectionControls()`:
  - Clicking a radio also checks the master (picking a format
    implies "save the selection").
  - Unchecking the master clears all three radios.
  - Re-checking the master restores the last-picked format (or
    the initial default on the first check — see below).
- Initial defaults: `loadData` reads `capturePageDefaults` and
  applies the matching branch (with-selection or without-selection)
  on first paint. See
  [options-and-settings.md → Capture-page first-paint pre-checks](options-and-settings.md#capture-page-first-paint-pre-checks)
  for the rules + fresh-install values.
- Each radio enables independently based on the presence of
  non-empty content in that format (an image-only selection
  enables HTML but leaves text / markdown disabled with a per-row
  "no {format} content" error icon). Each format row has its own
  `Copy filename` + `Edit` buttons — the user can materialize or
  edit any format independent of which one ends up getting saved.
- Save HTML and the whole selection group can also be greyed out
  because the scrape itself failed (see
  [Graceful handling](#graceful-handling-of-failed-screenshot--html--selection-scrape)).
  In that case the master row shows a hoverable red error icon
  whose tooltip explains the reason.
- Hotkeys: `Alt+S` toggles screenshot, `Alt+H` toggles HTML,
  `Alt+N` toggles the master Save-selection checkbox (triggering
  the coupling above), and `Alt+L` / `Alt+T` / `Alt+M` pick the
  selection format (HTML / text / markdown respectively), also
  auto-checking the master. All are no-ops when their control is
  disabled. Holding Shift suppresses every Alt hotkey so the user
  can still type shifted letters in other focus paths.

### Per-row icon buttons

Each Save row carries a small icon strip next to its checkbox /
radio:

- **Copy** — pre-materializes the artifact under its pinned
  capture filename and writes the absolute path to the clipboard.
  See [Copy-filename buttons](#copy-filename-buttons).
- **Edit** — opens a modal editor for the captured body (HTML /
  selection formats); Save updates the SW's authoritative copy.
  See [Edit dialogs](#edit-dialogs-template-driven).
- **Save as…** — opens a native save dialog seeded with a
  generic default filename (`screenshot.png`, `contents.html`,
  `selection.{html,txt,md}`).
  - Writes the *current edited* body: the screenshot bake includes
    any highlights / redactions / crop; HTML and selection bodies
    come from the in-page `captured[kind]` mirror the Edit dialogs
    keep in sync.
  - Disabled (and hidden) for any row whose body is unavailable —
    failed scrape, or a per-format selection that trimmed empty.
  - Implementation: `chrome.downloads.download({ saveAs: true })`
    called directly from the extension page — no SW round-trip.
  - Selection / HTML bodies route through a `blob:` URL whose
    revocation is deferred ~30 s (the API resolves on download
    *start*, not finish, so a synchronous revoke can truncate
    large bodies).
  - `USER_CANCELED` rejections are silenced — the user dismissing
    the save dialog isn't a failure.
- **Edit-dialog Download** — each Edit dialog also has a
  "Download" button right of the Edit / Preview toggle, which
  saves the *current editor source* (un-Saved edits included).
  Useful for exporting an experimental edit without committing it
  back to the SW.

### Prompt textarea

- Auto-growing, capped at 200px. `rows="1"` initially; on each
  `input` event we set `style.height = 'auto'` then
  `style.height = scrollHeight + 'px'`. Once `scrollHeight`
  exceeds the cap we flip `overflow-y` from `hidden` to `auto`
  so the scrollbar only appears when needed.
- Enter submits, Shift+Enter inserts a newline.
- The keydown handler reads two stored `capturePageDefaults`
  fields:
  - `promptEnter` (`'send'` | `'newline'`): plain Enter follows
    this radio. Default `'send'`.
  - `defaultButton` (`'capture'` | `'ask'`): when an Enter press
    submits, it clicks whichever button (`#capture` or
    `#ask-btn`) the user picked as default. Default
    `'capture'`. Same routing is used by the SW's
    `triggerCapture` toolbar-icon hand-off.
- `\` + Enter (in `promptEnter='send'` mode) consumes the `\`
  immediately to the left of the caret (anywhere in the buffer,
  not just end-of-text) and inserts a newline. Mirrors CLI coding
  agents so the familiar shortcut lands the expected behavior.
  The swap goes through `execCommand('insertText')` so Ctrl+Z
  restores the backslash. Skipped in `'newline'` mode (plain
  Enter is already a newline) and on Ctrl+Enter (always submits).
- Ctrl+Enter always submits via the chosen default button —
  overrides `promptEnter='newline'` so a user with that setting
  can still send without clicking.
- The chosen default button also gets a `.is-default` highlight
  ring in the UI so it reads as "primary" before the user focuses
  anything.
- **Smart paste** — Ctrl+V on the prompt or an edit dialog routes
  rich-text content to the right format for the target surface
  (markdown / HTML source / plain text). Ctrl+Shift+V always
  pastes verbatim plain text. See [smart-paste.md](smart-paste.md)
  for the full design.

### Preview image

Fills the remaining flex slot beside the tool palette and shrinks
vertically via JS-managed `max-height` so the page never scrolls.
See [Image fit-to-viewport](#image-fit-to-viewport).

## Image annotation pane

The screenshot preview is wrapped in an SVG overlay where the user
draws annotations with a *modal* tool palette. Exactly one tool
button is selected at a time; a left-button drag commits an edit
of that tool's kind. There's no right-click drawing, and no
in-place "convert this rect to a crop / redact" — every drag is a
fresh edit.

### Tool palette

- Bold "Edit image" header (matches the "Prompt:" label's
  weight/size so the two field titles read as siblings) sits above
  the column.
- Buttons stack vertically, all sized to the widest label. The
  column has clusters separated by 14px gaps:
  - Box, Line, Arrow, Crop, Redact (tool selectors).
  - Shrink (image-content transform — its own cluster because it
    rewrites a rect's geometry from pixel data, not the edit stack).
  - Undo, Clear (edit-stack actions).
  - Copy, Save (image-level actions — Copy puts the *current* PNG
    bytes on the clipboard; Save opens the native save-as dialog).
- Box / Line / Arrow use red icons (rectangle outline, diagonal
  line, diagonal line with arrowhead); the rest use text labels.
  Default selected tool is Box.
- Selected button gets `.selected` (darker face + inset shadow)
  and `aria-pressed="true"`. Tool selection fires on `mousedown`
  (not `click`) so the previously-selected tool deselects the
  moment the user presses a new one — otherwise both old
  `.selected` and new `:active` paint at once.
- Action buttons (Shrink / Undo / Clear / Copy / Save) are
  *actions*, not modes — they never get `.selected`. They share a
  `.btn` press-look with every other primary button on the page
  (header Options, Capture, Ask, edit-dialog Cancel/Save/Download),
  so all click-feedback uses one shared visual vocabulary.
- Copy / Save disable when the screenshot capture errored — same
  gate as the per-row `.copy-btn` / `#download-screenshot-btn`
  next to the Save-screenshot checkbox above.
- Every button carries a `title` tooltip explaining what it does.

### Drawing tools

- **Box** — drag commits a 3px red stroked rectangle.
- **Line** — drag commits a 3px red diagonal line.
- **Arrow** — drag commits a 3px red line with a barbed arrowhead
  at the click-release end. Barb length is 25% of the segment
  length, capped at 18 CSS px (scaled to natural pixels in the
  bake-in path).
- **Crop** — drag paints the live cropped preview (dim frame
  outside the drag bounds, dashed border, corner grips) so the
  user sees the final cropped result while dragging. Commits on
  mouseup as a crop region; saved PNG is shrunk to the crop.
  Multiple crops stack; the most-recently-added active crop wins.
- **Redact** — drag paints a filled black rectangle live, matching
  the committed appearance — opaque fill that hides whatever was
  underneath in the saved PNG.

### Shrink action

- Tightens a rectangle around its content by reading the *base*
  (pre-edit) image and trimming solid borders. Operates on the
  most recent edit of the selected tool's kind for Box / Redact,
  on the active crop for Crop, or commits a new crop edit when
  Crop has no active region (using the full image as the start).
- Disabled in Line / Arrow modes. Disabled in Box / Redact modes
  when no edit of that kind exists. The `render()` pass refreshes
  the disabled flag, and `setSelectedTool` re-renders so the
  button tracks the active tool.
- Backed by `src/shrink.ts` — a pure pixel-buffer operator with
  unit tests. Each edge advances inward as long as the line one
  step deeper still matches the *original* edge line, sliced to
  the current perpendicular range.
- Snapshot vs. neighbour: comparing every candidate against the
  *original* edge keeps the algorithm anchored to "what bg looked
  like" — avoids the over-shrink an iterative compare-to-neighbour
  rule hits once the perpendicular range narrows onto solid
  content.
- Per-channel tolerance (default 3) absorbs JPEG noise / mild
  anti-aliasing.
- Box mode expands the tight content bbox by 1 natural pixel on
  every side (clamped to the image) so the stroke centerline sits
  just outside the wrapped object. The stroke's half-width can
  still cross by a fraction of a display pixel on a downscaled
  preview. Crop / Redact use the tight bbox unchanged.
- Cache: the natural-resolution `ImageData` is materialized on
  first click and cached keyed by `previewImg.src` — repeated
  clicks on the same capture skip the canvas decode.
- Each click is its own undoable step:
  - Rect-edit shrinks mutate the existing edit's geometry and
    push a `HistoryOp` carrying the *previous* `{x, y, w, h}`.
    Undo restores those coordinates in place.
  - The new-crop case (Crop mode, no active crop) appends a
    fresh `'crop'` edit and pushes a regular `add` op. Undo
    removes it, returning to "no crop yet".
- Box-mode drilling retry:
  - A Box rect's edges sit 1 pixel *outside* the wrapped content
    (the +1 expansion), so a fresh algorithm call from the box
    edge sees plain bg as the snapshot.
  - That snapshot can't reach the previous content's outline, so
    the algorithm doesn't advance — Box would lose the multi-step
    drilling that Crop / Redact get for free.
  - The click handler retries with the rect contracted by 1 when
    the first attempt couldn't advance. That puts the snapshot ON
    the previous content's outer pixels, matching Crop / Redact's
    starting state — successive Box clicks then drill into nested
    content the same way.
- Algorithm-noop guard — when neither attempt advances (the rect
  already wraps as tightly as the snapshot rule allows), the click
  is a silent no-op. The Box +1 expansion fires only when the
  algorithm actually contracted at least one edge. Without this
  guard, repeat Box clicks would re-expand by 1 each time —
  pulsing on clean content, growing on noisy content.
- Multi-step refinement (all rect modes) — successive clicks can
  legitimately keep shrinking when an earlier click landed on a
  uniform stripe (e.g. a button border). On the next click that
  stripe becomes the new bg snapshot, and the algorithm walks past
  it to the next layer of content. The `shrink:` e2e tests pin
  every behaviour: idempotent on Box, drills further on Box *and*
  Crop using the nested-content fixture.
- Known limitation — the algorithm assumes the starting edges sit
  on background. If the rect is already flush with content (or
  drawn entirely inside a uniform region), `shrink()` returns
  `null` and the click is a silent no-op rather than producing a
  mis-tightened rect.

### Crop-edge handles (drag-to-crop / drag-to-resize)

- The four edges and four corners of the *effective* crop region
  (the active crop if one exists, else the full image) are
  draggable. With no active crop, dragging an image edge inward
  creates a crop from scratch; with an active crop, the handles
  sit on the crop's own edges. The hit-test wins over the selected
  tool, so a drag that starts in the band always becomes a
  crop-handle drag rather than a tool draw.
- Hit-testing is a `HANDLE_PX` band (10 CSS px) around each
  effective edge. Corners beat plain edges. The `cursor` CSS flips
  to the matching resize cursor on hover.
- Small white grip squares mark the four corners of the effective
  crop region — even when no crop exists, so the image's own
  corners show grips and the "drag here to start cropping"
  affordance is discoverable. Grips center on the corner and may
  extend past the image edge; `#overlay` is `overflow: visible`
  so a boundary corner shows the full square.
- Each completed drag commits a **new** `'crop'` edit on the stack
  — not an in-place mutation of the previous one. Undo peels back
  one resize at a time; earlier crops stay in the stack hidden
  behind the newer one and re-emerge as Undo walks backward.
- Bounds are clamped on three axes:
  - Inside the image: 0 ≤ x, x+w ≤ 100 (and the same for y).
  - `MIN_CROP_PCT` floor (1.5%) on width and height.
  - Dragged-edge-only: a drag past the opposite edge clamps the
    dragged edge at `MIN_CROP_PCT` away from the opposite one.
    The opposite edge never moves.
  - Why not flip / push? A flipped crop is surprising on a resize
    tool and never useful. Pushing the opposite edge out to
    preserve the minimum used to produce n/w vs. s/e asymmetry,
    so that's avoided too.
- Sub-`CLICK_THRESHOLD_PX` drags are discarded so a stray click on
  a handle doesn't add a no-op entry.

### Edit stack & geometry

- **Undo / Clear** — single edit-history stack of two op kinds:
  - `add` ops — drag-committed edits. Undo removes the matching
    edit from the stack.
  - shrink ops — carry the pre-shrink geometry of an existing
    rect / redact / crop edit. Undo restores those coordinates in
    place instead of removing the edit.

  Clear wipes everything. Both buttons disable when the stack is
  empty.
- **Resize-stable coordinates** — edits are stored as percentages
  of the image dimensions, not CSS pixels, so they stay aligned
  across window resizes and after the prompt grows.
- **Click-vs-drag threshold** — movement under 4 CSS pixels
  between mousedown and mouseup counts as a stray click and is
  discarded, so no tool can produce a degenerate zero-size shape.

### Crop rendering

- The preview paints a single dim "picture frame" around the
  active crop via an SVG `<path>` with `fill-rule="evenodd"`
  (outer = full image, inner = crop), plus a thin dashed white
  border on the crop edges.
- **Single path, not four strips.**
  - Four adjacent dim strips partially-cover the pixel row
    straddling the crop's top/bottom edge from *two* rects in
    series instead of one solid fill.
  - Alpha-over-alpha composites brighter than a single fill
    (≈14% brighter at 0.55 alpha), so those shared edges showed
    up as faint guide lines spanning the full image.
  - Vertical edges didn't show the artifact because the strip's
    inner edge borders un-dim content — smooth ramp, not a
    brighter spike.
- **Dashed border is per-side.**
  - Each crop edge is its own `<line>`; a side flush with the
    image boundary is *omitted*.
  - A dash right at the image edge is cosmetic noise, and drawing
    one there while omitting it on the other axis (the case a
    full-width-but-not-full-height crop produces) read as an
    asymmetric guide line past the crop.
- Prior crops are hidden by the most recent one.

### Full-image crop collapses to "no crop"

- A crop with bounds `(0, 0, 100, 100)` is treated as no crop
  everywhere: `activeCrop()` returns `undefined`, no dim overlay
  or dashed border, bake-in skipped, and no `isCropped` flag on
  the saved record.
- The edit stays in the stack so Undo can still walk back through
  it.
- Fires when the user drags the crop back out to cover the entire
  image (all four sides at the boundary) — the saved PNG then
  matches what they see, an un-marked full-size capture.

## Edit dialogs (template-driven)

- Pencil icons sit next to each editable artifact's Copy button
  in the Capture page — currently HTML plus one per selection
  format (HTML, text, markdown); more kinds can be added without
  new dialog markup.
- A single `<template id="edit-dialog-template">` in
  `capture.html` supplies the modal structure.
  `capture-page.ts::createEditDialog` clones it per kind and
  stamps `edit-${kind}-${role}` ids onto the inner elements so
  e2e tests can target a specific kind without knowing the full
  catalog.
- `EDIT_KINDS` in `capture-page.ts` is the catalog — one entry
  per editable kind with its pencil button, title, and optional
  `onSaved` hook (e.g. HTML's size-readout refresh). Adding a
  kind is one entry + one markup button.

### Per-kind behavior

- Open: seeds the editor from the page's `captured[kind]` mirror
  (via CodeJar's `updateCode`), clears any prior error, focuses
  the editor with a zero-range Selection collapsed to the top.
- Save: no-op when the body is unchanged; otherwise posts
  `{ action: 'updateArtifact', kind, value }` to the SW and runs
  the per-kind `onSaved` hook on success. Errors surface inline
  in a `role="alert"` region.
- Cancel / Escape: closes without touching anything.

### SW-side `updateArtifact` handler

- Dispatches on `msg.kind` via the `EDITABLE_ARTIFACTS` spec table
  — each entry declares how to commit the new body to
  `DetailsSession.capture` and which `session.downloads` entry to
  drop. New kinds add one entry.
- Writes the body, sets the sticky `session.{html,selection}Edited`
  flag, and drops the matching `session.downloads.{html,selection}`
  entry so the next `ensureHtmlDownloaded` /
  `ensureSelectionDownloaded` re-materializes the file under the
  same pinned filename (via `conflictAction: 'overwrite'`).
- The eventual Save — whether Capture clicks or a later Copy —
  therefore writes the edited content.
- Only the HTML body and the three selection-format bodies are
  editable; the screenshot has no text-edit UI (the highlight
  overlay covers its annotation use case). The selection formats
  edit independently — editing the markdown version doesn't
  retranslate the HTML body, and vice versa — but only the format
  the user picks on the Save-selection-as-… radio ends up in
  `log.json`.

### Preview mode (HTML / markdown dialogs)

- Three dialogs expose an Edit / Preview segmented toggle next to
  the title: **Page contents HTML**, **Selection HTML**, and
  **Selection markdown**. `EDIT_KINDS` marks each via
  `preview: 'html' | 'markdown'`; selection-text (plain text)
  stays edit-only.
- Edit is selected on open; `setMode()` swaps between the editor
  and a sandboxed preview iframe positioned absolutely inside
  `.edit-dialog-body`. The editor stays in the DOM with
  `visibility: hidden` in Preview so its resized height keeps
  defining the slot — dialog dimensions can't jump across modes.
- Pipeline:
  - HTML kinds read the editor source via `getCode()` (which
    calls CodeJar's `toString()`, i.e. the editor element's
    `textContent`) and pass it straight into `buildPreviewHtml()`.
  - Markdown kind first calls `renderMarkdown()` (which delegates
    to `window.marked.parse()` from the UMD bundle loaded by
    `capture.html`), then feeds the HTML into `buildPreviewHtml()`
    so the same sanitizer + charset + base-href wrapping applies.
- `buildPreviewHtml()` assembles the previewed document:
  - Parses the HTML via `DOMParser('text/html')` (tolerant
    parser — malformed HTML still yields a full document).
  - Removes `<script>` tags (defense-in-depth; sandbox already
    denies `allow-scripts`) and `<meta http-equiv="refresh">`
    tags (the one remaining vector by which captured HTML could
    hijack the preview iframe to an attacker URL without JS).
    Raw HTML embedded in markdown passes through marked, so this
    stripping matters for the markdown preview too.
  - Strips any existing `<meta charset>` / `Content-Type meta`
    and injects `<meta charset="utf-8">` as the first child of
    `<head>` so non-ASCII captures don't render as mojibake
    (Chrome falls back to Windows-1252 for blob: HTML with no
    declared charset).
  - Strips any existing `<base>` and injects one with the
    captured page's URL + `target="_blank"` so relative URLs
    resolve and link clicks open in a new tab instead of
    replacing the preview.
- The assembled HTML is loaded as a `blob:` URL
  (`text/html;charset=utf-8`), not `srcdoc`, because `srcdoc` is
  an HTML attribute with a browser-dependent size limit that
  silently truncates large captures to blank. The blob is revoked
  on every mode flip and on the dialog's `close` event.
- Iframe sandbox: `allow-popups allow-popups-to-escape-sandbox`
  only. Scripts, forms, same-origin, and top navigation are all
  denied; link clicks via `target="_blank"` open a normal new tab
  that escapes the sandbox so it behaves like a regular browser
  tab.
- `marked` ships as `dist/marked.umd.js`, copied from
  `node_modules/marked/lib/marked.umd.js` by `scripts/build.mjs`
  and loaded as a classic `<script>` before `capture-page.js`.
  UMD (not ESM) because `capture-page.ts` compiles to a non-module
  script — `import` would force a module-worker rewrite of how
  the extension page is wired up.

### Syntax highlighting in the edit dialogs

- Each dialog hosts a `<div contenteditable="plaintext-only">`
  (not a `<textarea>`) wrapped by **CodeJar**. CodeJar rewrites
  `innerHTML` on every input via a highlighter callback so the
  content is painted by `<span class="hljs-*">` tokens from
  **highlight.js**.
- Language per kind (`hljsLanguageFor`):
  - `html`, `selectionHtml` → `xml` (hljs models HTML as XML).
  - `selectionMarkdown` → `markdown`.
  - `selectionText` (and any future plain-text kind) → `plaintext`
    — the callback still runs so CodeJar has a consistent render
    path, but no tokens are produced.
- `hljs.highlight(code, { language, ignoreIllegals: true })` —
  the `ignoreIllegals` flag keeps partial / malformed input from
  throwing mid-typing.
- Source-of-truth read / write:
  - Read: `jar.toString()` → `editor.textContent`. Tests read the
    same way via `getEditorCode` in `details-helpers.ts`.
  - Write: `jar.updateCode(code)` clears and re-highlights.
- Theme: `github.min.css` (light) renamed to
  `dist/highlight-theme.css` by `scripts/build.mjs`. The editor
  element carries the `hljs` class so the theme's
  background / default-color rules apply.
- Asset plumbing: `scripts/build.mjs` copies
  `@highlightjs/cdn-assets/highlight.min.js` (the "common" bundle
  that includes xml + markdown + plaintext) and the theme into
  `dist/`, and transforms `node_modules/codejar/dist/codejar.js`
  by rewriting its sole top-level `export function CodeJar` into
  `function CodeJar(…)` + `window.CodeJar = CodeJar;` so it loads
  as a classic script alongside `marked.umd.js`.

## Highlight bake-in on save

If the user has any edits *and* is saving the screenshot:

- The page renders the preview image plus the overlay onto a
  `<canvas>`. With no active crop the canvas is the screenshot's
  *natural* resolution; with an active crop the canvas is sized
  to just that crop region (so the saved PNG ships a smaller
  image) and every edit's coordinates are translated into the
  cropped frame.
- Red rectangles and lines stroke at 3px scaled by the
  display→natural ratio so they look the same in the saved PNG
  as during editing.
- Redactions paint as solid black fills that cover whatever was
  underneath — they are the only edit kind that obliterates the
  original pixels in the bake, which is the whole point.
- A clip rectangle matching the canvas size keeps any edit that
  extends past the crop from bleeding onto the saved bytes.
- The resulting `canvas.toDataURL('image/png')` is sent back to
  the background as a `screenshotOverride` field on the
  `saveDetails` runtime message, alongside three per-kind edit
  flags (`highlights`, `hasRedactions`, `isCropped`).
  - `highlights` is `true` iff at least one red rectangle or line
    is on the stack. Redactions and crops are separate edit kinds
    and flip their own flag instead.
  - `hasRedactions` is `true` iff any redaction rectangle is
    baked into the PNG.
  - `isCropped` is `true` iff the saved PNG was cropped to a
    region.
  - The three are independent — any combination can be true at
    once on a single save.
- The background passes `screenshotOverride` through to
  `ensureScreenshotDownloaded` (the same helper the Copy-filename
  buttons use). On a cache miss it becomes the body of the PNG
  download; on a cache hit (the page already pre-downloaded at
  this `editVersion`) it's dropped because the on-disk file
  already matches. `recordDetailedCapture` then writes the
  sidecar with the screenshot artifact carrying whichever of
  `hasHighlights: true` / `hasRedactions: true` /
  `isCropped: true` are set for this save.
- The see-what-i-see skills read
  `screenshot.hasHighlights === true` as the signal to focus on
  the marked regions.
- If there are no edits, or the screenshot isn't being saved, no
  override is sent and the record's screenshot object stays bare
  (just `filename`, no edit flags).
- **Bake-in always emits PNG.** `renderHighlightedPng` →
  `canvas.toDataURL('image/png')` is rasterized PNG regardless of
  the source format. `ensureScreenshotDownloaded` swaps the
  filename's extension to `.png` before write whenever
  `screenshotOverride` is set, and reverts to
  `screenshotOriginalExt` when the user undoes back to clean.

## `isEdited` sidecar flag

- Emitted inside `contents` / `selection` artifact objects in
  `log.json` whenever the user saved an edit through the
  corresponding dialog and then kept the artifact on the Capture
  page — i.e. the artifact carries
  `{ "filename": "…", "isEdited": true }` instead of the
  bare-filename object.
- Sticky per session: once the user has saved an *actual change*
  through the dialog (an unchanged-textarea Save is a no-op and
  doesn't flip the flag), later saves on the same Capture page
  tab carry `isEdited: true` regardless of whether they edit
  again — the on-disk body *is* the edit.
- Omitted on unedited records, matching the
  `screenshot.hasHighlights` policy where presence is itself the
  signal.
- Intended to let downstream consumers (e.g. the see-what-i-see
  skills) distinguish "this is the raw page scrape" from "the
  user reshaped this before handing it off."

## Copy-filename buttons

- A small icon button sits next to each Save checkbox.
  - Tooltip: `Copy filename`.
  - Click writes the file's path to the clipboard via
    `navigator.clipboard.writeText` (extension pages have direct
    clipboard access — no offscreen helper involved here, unlike
    the SW's Copy-last-… menu entries).
- Each click materializes the file on disk via the SW's
  `ensureScreenshotDownloaded` / `ensureHtmlDownloaded` /
  `ensureSelectionDownloaded` helpers, then puts the file's
  **real on-disk path** on the clipboard. The user always gets a
  valid path — there's no "the file doesn't exist yet" caveat.
- Per-tab download cache lives on `DetailsSession.downloads`.
  Repeat Copy clicks short-circuit on a cache hit; the eventual
  Capture click also goes through the same helpers, so files
  already pre-downloaded by Copy aren't re-written.
  - Screenshot cache is keyed by an `editVersion` — a monotonic
    counter the page bumps on every highlight draw / undo /
    clear. On mismatch the SW re-downloads with the page's
    freshly baked-in PNG (sent as `screenshotOverride` in the
    message).
  - HTML cache is unconditional until the user edits the body via
    the Edit HTML dialog — `updateArtifact { kind: 'html' }`
    clears the cache so the next Copy / Capture writes the edited
    content.
  - Selection cache follows the same pattern as HTML:
    unconditional until the user edits the body via the Edit
    selection dialog, which fires `updateArtifact { kind:
    'selection' }` to clear the cache.
- Filenames are pinned at capture time in `captureBothToMemory`
  (`screenshotFilename` / `contentsFilename` / optional
  `selectionFilename` on `InMemoryCapture`) and reused by every
  download in the session.
  - Side-effect: the saved record's `timestamp` and the embedded
    local-time filename suffix both describe when the screenshot
    was *taken*, not when the user clicked Save.
  - All re-downloads use `conflictAction: 'overwrite'`, so a
    re-download under the same pinned filename rewrites the
    on-disk file rather than producing `screenshot-… (1).png`.
- Orphan-file trade-offs. Copy and Capture have decoupled
  semantics: Copy materializes a file; Capture writes the log
  entry. As a result, two scenarios leave on-disk files with no
  log entry:
  - User clicks Copy and then closes the Capture page tab without
    clicking Capture.
  - User clicks Copy on (say) the screenshot, then unchecks the
    Save screenshot checkbox before clicking Capture. The log
    record gets no `screenshot` field, but the file from the Copy
    step is still on disk.
  - In both cases this is intentional: the user explicitly opted
    into a file via the Copy click. We don't proactively delete
    via `chrome.downloads.removeFile` because the user can move /
    rename the file between Copy and Capture, and we don't want
    to chase it.

## Save and close

- On Capture click, if there are any edits *and* the screenshot
  is being saved, the page bakes the SVG overlay onto a `<canvas>`
  at the screenshot's natural resolution and produces a fresh PNG
  data URL. See [Highlight bake-in on save](#highlight-bake-in-on-save).
- The page sends a `saveDetails` runtime message back to the
  background with the selected save options, the prompt, three
  per-kind edit flags (`highlights`, `hasRedactions`, `isCropped`),
  the current `editVersion`, and the `screenshotOverride` data
  URL when present.
- The background runs each requested artifact through the same
  `ensureScreenshotDownloaded` / `ensureHtmlDownloaded` /
  `ensureSelectionDownloaded` helpers that powered any earlier
  Copy clicks — so a file pre-downloaded by Copy (at the same
  `editVersion` for screenshots) is *not* re-written, and the
  on-disk file from the Copy step is what the log entry
  references. Then `recordDetailedCapture` writes the sidecar.
  The saved sidecar record can include any of `screenshot`,
  `contents`, `selection`, and `prompt`, on top of the
  always-present `timestamp` and `url`. Each artifact object can
  carry per-kind flags: `screenshot.hasHighlights`,
  `screenshot.hasRedactions`, `screenshot.isCropped`,
  `contents.isEdited`, `selection.isEdited`. It's valid to save
  with no checkboxes ticked — the record then carries just the
  URL (and any prompt).

### Click modifiers

Click modifiers route the post-save lifecycle:

- **Plain click** — the historical behavior. SW closes the
  Capture page tab after the save and re-activates the opener tab
  so the user lands back on the page they captured from. Chrome's
  natural close-time pick is not reliably the immediate right
  neighbor (the headless e2e environment activates the tab two
  positions right of the closed slot), so the explicit
  re-activation is required for deterministic behavior;
  `openerTabId` alone has no effect on close-time focus.
- **Shift-click** — same save, but the SW keeps the page open and
  preserves the per-tab session so the user can edit / retake /
  re-save without losing the staged content.
- **Ctrl-click** — same as plain click on the Capture button. The
  modifier exists for symmetry: the same chord on the Ask button
  is the explicit "send and dismiss" gesture, and that path
  leaves focus on the destination provider tab rather than the
  opener (see [`ask-on-web.md`](ask-on-web.md)).
- On any error the SW keeps the page open regardless of modifier
  — the user keeps the preview as a recovery surface and can read
  the message in `#ask-status`.

### Multi-capture filename strategy

Only meaningful when the page stays open across multiple saves
(i.e. shift-click).

- Plain / ctrl-click Capture removes the per-tab
  `chrome.storage.session` entry on the way out (the tab is
  closing).
- Shift-click leaves the entry intact so a second Capture click
  can save again.
- Each successful `recordDetailedCapture` snapshots a per-artifact
  `saved.<x> = { bumpIndex, revision }` on the session.
- The next `ensure*Downloaded` consults `nextSaveFilename`:
  - **Same revision** → reuse the locked filename
    (`bumpedFilename(bases.<x>, saved.bumpIndex)`). No
    re-download; the new log record references the existing file.
    Optimizes multi-prompt flows where the user iterates the
    prompt without re-editing the artifact.
  - **Diverged revision** (user edited via Edit dialog or drew on
    the screenshot) → bump `bumpIndex + 1`. The previous file
    stays immutable on disk; the new log record points at the
    freshly-written file. Filenames look like `selection-2026.md`
    → `selection-2026-1.md` → `selection-2026-2.md`.
- The "base" filename is pinned in `session.bases.<x>` at session
  creation. Computing every bumped filename from the *base* (not
  from the previously-bumped name) keeps the suffix logic robust
  against the timestamp's millisecond portion, which already
  looks like a `-N` counter.
- Caveat: reloading the Capture page mid-session is not a
  supported workflow. The page-side `editVersion` resets to 0 on
  reload while the SW-side `saved.<x>` lock survives, so a save
  after reload would falsely diverge the screenshot revision and
  bump a fresh `-N` against bytes the user never edited. Sessions
  are intended to live across multiple captures via shift-click;
  reloads should be rare.

### Tab positioning + return-to-opener

`startCaptureWithDetails` opens the Capture page tab at
`index: active.index + 1` and sets `openerTabId: active.id`, so
it appears immediately to the right of the tab the user captured
from.

On close, the `saveDetails` happy path runs `closeCapturePageTab`
with `focusOpener: true`:

1. Removes the session-storage entry.
2. Re-activates the opener tab via `chrome.tabs.update`.
3. Removes the Capture page tab.

The standalone `closeCapturePage` SW handler (fired by Ask's
ctrl-click) runs the same helper with `focusOpener: false`:

- The Ask flow's `sendToAi` already focused the destination
  provider tab — that's where the answer is about to stream in.
- Re-activating the opener here would yank focus back to the
  original screenshot tab and the user would lose sight of the
  result, defeating the "send and watch" gesture. The "ask:
  ctrl-click closes the Capture page and leaves focus on the
  provider tab" e2e test pins this down.

For the saveDetails path the ordering matters and the explicit
re-activation is required:

- **Why not rely on Chrome's natural close behavior?** Chrome
  activates the *right neighbor* of a closed tab, not its opener.
  Setting `openerTabId` does not influence close-time activation.
  The "details: tab opens next to opener and returns focus on
  close" e2e test pins this down.
- **Why activate before remove?** If we removed first, Chrome
  would briefly flash the right neighbor before our update could
  land. Activating first means a single, direct focus jump.
- **Why use a stashed `openerTabId` instead of `chrome.tabs.get`?**
  `Tab.openerTabId` is one of the fields Chrome strips when the
  extension lacks the `tabs` permission, and `<all_urls>` host
  permission doesn't cover our own `chrome-extension://` Capture
  page tab. We stash the opener id in the `DetailsSession`
  wrapper at create time and read it back from there.
- **Best-effort.** If the opener was closed during the Capture
  page flow, `chrome.tabs.update` rejects; we log and proceed
  with the close.

## Image fit-to-viewport

- The preview image must not produce a vertical scrollbar.
- CSS caps it at `max-width: 100%` of its `.image-box` flex slot
  (the flex row reserves the tool-palette column on the left, so
  the slot is the body width minus the palette's natural width).
- A `fitImage()` function sets `max-height` inline based on the
  remaining viewport height (`window.innerHeight - top - reserved`).
- It re-runs on window resize, after the prompt textarea grows
  (which pushes the image's top down), and after the image loads.
- Resetting `max-height` before measuring is safe: the image's
  top is determined by elements above it, which don't depend on
  the image's own size.

## Chrome-platform gotchas

- **Extension pages have CSP that forbids inline scripts.** The
  default extension CSP does not allow `<script>` blocks inside
  `capture.html`. The controller is a separate file
  (`src/capture-page.ts`, compiled to `dist/capture-page.js`)
  referenced via `<script src="capture-page.js">`.
- **`web_accessible_resources` is not needed.** `capture.html`
  is opened via
  `chrome.tabs.create({ url: chrome.runtime.getURL(...)})`, which
  is a same-origin navigation within the extension. WAR is only
  required to expose a resource to *non-extension* contexts
  (content scripts in arbitrary pages, `<iframe>` from a web
  page).
- **Runtime message listeners must return `true` to keep the
  response channel open for an async reply.** `getDetailsData`
  reads from `chrome.storage.session` asynchronously and calls
  `sendResponse` later — the listener must return `true` or
  Chrome drops the channel and the page-side `sendMessage`
  resolves with `undefined`. `saveDetails` always replies
  (`{ ok: true }` / `{ ok: false, error }`), so it returns
  `true`.
- **Don't race the tab close against the save.** The
  `saveDetails` handler always responds before closing — the
  `sendResponse({ ok: true })` fires first, then
  `closeCapturePageTab` runs. That ordering matters because
  `chrome.tabs.remove` tears down the message channel and a
  response sent after wouldn't reach the page.
- **Capture-page errors land on the page, not the toolbar.**
  - When the user is on the Capture page and the save fails, the
    SW does NOT call `runWithErrorReporting`. The page has a
    status slot (`#ask-status`) right next to the buttons that
    produced the error, and surfacing the message there is more
    discoverable than swapping the toolbar icon.
  - The toolbar error channel is reserved for paths that have no
    on-screen surface (toolbar click, context menu).
  - Successful saves still call `clearCaptureError()` so a
    previously toolbar-reported failure gets cleaned up by the
    next healthy save.
- **Stale-page guard for direct loads.** Opening `capture.html`
  without a session-storage entry (old bookmark, history entry,
  browser-restart tab restore) causes `getDetailsData` to resolve
  `undefined`. The page handles this in `loadData`:
  - Hides every `[data-capture-main]` block (capture-card,
    controls, hr, image-and-highlights).
  - Reveals the `#missing-session-error` pane with a one-liner
    pointing the user back to the toolbar icon.
  - The header (Options button) stays visible as an escape hatch.
  - `[data-capture-main][hidden] { display: none !important }` is
    required because the per-block `display: flex` /
    `display: block` rules tie the UA `[hidden]` rule on
    specificity and win on source order, so plain
    `el.hidden = true` wouldn't take.
