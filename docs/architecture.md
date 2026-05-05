# Architecture

SeeWhatISee is a small Manifest V3 Chrome extension plus a
standard on-disk drop directory that coding agents can read from.

This doc is a high-level overview of components and data flow.
Topic-specific design notes live in companion docs:

- [`capture-actions.md`](capture-actions.md) — action catalog,
  toolbar / image / keyboard menus, default-click dispatch.
- [`capture-page.md`](capture-page.md) — the `capture.html`
  preview/edit/save flow.
- [`chrome-extension.md`](chrome-extension.md) — Chrome MV3
  hazards: SW lifecycle, permissions, error surface, context-menu
  gotchas, image-fetch strategies.
- [`testing.md`](testing.md) — Playwright + devtools-console
  patterns.
- [`options-and-settings.md`](options-and-settings.md) — Options
  page, default-action storage shape, tooltip layout.
- [`ask-on-web.md`](ask-on-web.md) /
  [`ask-widget.md`](ask-widget.md) — Ask flow.

## Components

```
+----------------------+        +-----------------------+        +-----------+
| Toolbar click /      |  -->   | background service    |  -->   | ~/Downloads/
| Playwright evaluate  |        | worker (background.ts)|        |  SeeWhatISee/
+----------------------+        +-----------------------+        +-----------+
                                          |
                                          v
                                +---------------------------+
                                | src/capture.ts              |
                                |  - captureVisible()         |
                                |  - savePageContents()       |
                                |  - captureBothToMemory()    |
                                |  - downloadScreenshot()     |
                                |  - downloadHtml()           |
                                |  - recordDetailedCapture()  |
                                |  - clearCaptureLog()        |
                                +---------------------------+
```

## Service-worker layout

`src/background.ts` is a thin entrypoint that wires Chrome event
listeners. The substantive logic lives in `src/background/`:

- `error-reporting.ts` — icon/tooltip error surface
  (`runWithErrorReporting`).
- `capture-actions.ts` — the `CAPTURE_ACTIONS` table +
  `captureUrlOnly` / `saveDefaults` / `captureAll` shortcuts. See
  [`capture-actions.md`](capture-actions.md).
- `default-action.ts` — Click + Double-click defaults,
  `handleActionClick` dispatcher, `runDblDefault`,
  `getDefaultActionTooltip` builder.
- `context-menu.ts` — `installContextMenu`, menu title refresh,
  More-submenu utilities (copy-last, snapshots dir, offscreen
  clipboard).
- `capture-details.ts` — Capture-page per-tab session,
  `ensure*Downloaded` cache, multi-capture filename bump (locks
  files referenced by a `recordDetailedCapture` and writes
  `<base>-N.<ext>` on later edits).
- `capture-page-defaults.ts` — stored Capture-page Save defaults
  (`capturePageDefaults`).
- `options.ts` — Options-page SW wire (`getOptionsData` /
  `setOptions`).
- `ask/` — Ask flow: routes the staged Capture-page payload to a
  chosen AI tab. See [`ask-on-web.md`](ask-on-web.md).

## Capture functions

`src/capture.ts` provides the building blocks every action calls:

- `captureVisible(delayMs?)` calls `chrome.tabs.captureVisibleTab`
  to get a PNG data URL of the visible tab region and saves it
  directly. `delayMs` runs a countdown (with a toolbar badge)
  before the active-tab lookup so the user can reposition / hover
  during the wait.
- `savePageContents(delayMs?)` uses
  `chrome.scripting.executeScript` to grab
  `document.documentElement.outerHTML` from the active tab and
  saves it as an HTML file. Same delay semantics as
  `captureVisible`.
- `captureBothToMemory(delayMs?)` does *both* of the above
  without saving, returning the data for the Capture page flow to
  stash and preview. Same delay semantics.
- `downloadScreenshot` / `downloadHtml` start a download from the
  pre-captured data; `waitForDownloadComplete` polls until the
  file is on disk and returns its absolute path. The SW caches
  these per-tab so a Copy-button pre-download and the eventual
  Capture share one file each.
- `recordDetailedCapture` writes the sidecar log entry
  referencing whichever artifacts the caller decided to keep.
  Splitting the download from the record lets the SW materialize
  files on demand (Copy clicks) without committing them to the
  log until the user actually clicks Capture.

The `CaptureResult` returned by `captureVisible` and
`savePageContents` includes the `chrome.downloads` ids of the
content file and the JSON sidecar (`sidecarDownloadIds.log`):

- Production callers ignore them.
- The e2e tests use them to look up each saved file's actual
  on-disk path via `chrome.downloads.search`.

## Save directory + metadata sidecar

Captures are written via `chrome.downloads.download` into
`~/Downloads/SeeWhatISee/`.

- Screenshots are saved as `screenshot-<timestamp>.png`; HTML
  snapshots as `contents-<timestamp>.html`.
- The timestamp is `YYYYMMDD-HHMMSS-mmm` (local time, millisecond
  precision) — fine-grained enough that filenames are always
  unique in practice.
- We use the downloads API rather than a native messaging host so
  v1 has no native dependencies.
- Trade-off: the directory must live under the user's configured
  downloads folder.

Alongside the content file, every capture also writes a JSON
sidecar into the same directory. `log.json` is newline-delimited
JSON (one record per line), grep-friendly history of recent
captures. Scripts use `tail -1 log.json` to get the latest record.

### Record fields

Every record has `timestamp` and `url`, plus optional fields:

- `screenshot` — `ScreenshotArtifact` object
  `{ "filename": "screenshot-<timestamp>.png", "hasHighlights"?: true, "hasRedactions"?: true, "isCropped"?: true }`,
  set when a screenshot was saved.
  - `hasHighlights` is `true` iff the saved PNG has red markup
    (Box-tool boxes, Line-tool lines) baked into it. Redactions
    and crops are separate kinds, reported via `hasRedactions` /
    `isCropped` instead — they don't count as highlights.
  - `hasRedactions` is `true` iff the saved PNG has at least one
    opaque black redaction rectangle baked in.
  - `isCropped` is `true` iff the saved PNG was cropped to a
    user-selected region (the bytes on disk cover only that
    region, not the full capture). A crop that was dragged back
    out to cover the entire image collapses to "no crop" — the
    flag is omitted and the saved PNG matches the original
    capture.
  - All three flags are independent (any combination can appear)
    and are omitted when false, so presence is itself the signal.
    The see-what-i-see skills check `hasHighlights` and steer
    their attention to the marked regions.
- `contents` — `Artifact` object
  `{ "filename": "contents-<timestamp>.html", "isEdited"?: true }`,
  set when HTML contents were saved.
- `selection` — selection artifact object
  `{ "filename": "selection-<timestamp>.{html,txt,md}", "format": "html"|"text"|"markdown", "isEdited"?: true }`,
  set by the More → Capture-selection-as-… shortcuts or the
  Capture page flow when the user picked a format on a
  Save-selection-as-… row. A capture only ever writes one
  selection format; the `format` field is the ground truth (the
  extension mirrors it for human readability).
- `isEdited` (on `contents` / `selection`) — `true` iff the user
  saved an edit through the corresponding Edit dialog before
  capture. Omitted on the raw scrape. See
  [`capture-page.md` → isEdited sidecar flag](capture-page.md#isedited-sidecar-flag).
- `imageUrl` — top-level field set by the image right-click flow
  (the URL of the right-clicked source image). Independent of
  `screenshot`, so it survives even when the user unchecks Save
  Screenshot in the Capture page.
- `prompt` — user-entered text from the Capture page, omitted
  when empty.

### Record shapes by trigger

- Screenshot captures emit `{timestamp, screenshot, url}`.
- HTML captures emit `{timestamp, contents, url}`.
- The detailed-capture path can emit any or all of the optional
  artifact fields — including none of `screenshot` / `contents` /
  `selection` (URL-only, typically with a `prompt`).
- The `screenshot.filename` / `contents.filename` /
  `selection.filename` timestamps share the *same* compact
  local-time suffix so all three sort together for a single
  capture.

### Storage model

- The Chrome downloads API can only write whole files, so the
  authoritative log lives in `chrome.storage.local`; `log.json`
  is a snapshot rewritten on every capture.
- Deleting `log.json` on disk is harmless — the next capture
  recreates it from storage. `watch.sh` is also resilient to the
  whole `~/Downloads/SeeWhatISee/` directory not existing yet
  (it `mkdir -p`s on startup and polls for `log.json` to appear),
  so `/see-what-i-see-watch` can be launched before any capture.
- To clear history, use the **More → Clear log history**
  context-menu entry on the toolbar icon (or call
  `SeeWhatISee.clearCaptureLog()` from the service-worker
  devtools console). Both wipe the `captureLog` key from
  `chrome.storage.local` *and* overwrite the on-disk `log.json`
  with an empty file so downstream consumers see the cleared
  state immediately. `get-latest.sh` treats an empty `log.json`
  the same as "no captures yet"; `watch.sh` swallows the clear's
  mtime bump without emitting a blank line.
- The log is capped at 100 entries (FIFO eviction of the oldest);
  without a cap, rewriting the whole file on every capture would
  be quadratic in capture count.

## Permissions

- The manifest declares `activeTab`, `<all_urls>` host permission,
  `contextMenus`, `downloads`, `scripting`, and `storage`.
- Both `activeTab` and `<all_urls>` are needed because they serve
  different trigger paths (real toolbar gesture vs.
  Playwright-driven `evaluate`); dropping either one silently
  breaks one of them.
- We deliberately do *not* request the `tabs` permission.
- See [`chrome-extension.md`](chrome-extension.md) for the full
  rationale and Chrome-specific permission hazards (including why
  the Chrome Web Store itself blocks `captureVisibleTab`).

## Error reporting

Two channels, picked by whether the user has an on-screen surface
to read the error from:

- **Toolbar click / context menu** — no Capture page open, so the
  failure is reported via the toolbar. `runWithErrorReporting` in
  `background.ts` swaps in a pre-rendered error icon variant and
  slots an `ERROR: …` line under the app title in the tooltip; a
  later successful run restores both.
- **Capture page** — `saveDetails` responds `{ ok: false, error }`
  over the message channel and the page renders the error in
  `#ask-status` (the same status slot the Ask flow uses). The
  toolbar is left alone. A successful Capture-page save also
  calls `clearCaptureError()` so a previous toolbar-channel error
  doesn't linger.

See [`chrome-extension.md`](chrome-extension.md) for the design
rationale (why not badge text, why not `chrome.notifications`)
and how error icon variants are generated.

## Test hook

- The same capture functions are attached to `self.SeeWhatISee`
  so they can be invoked from the service worker devtools console
  or from Playwright via `serviceWorker.evaluate(...)`.
- This is the only way to drive the extension from tests, since
  Playwright cannot click the browser toolbar or open its context
  menu.
- See [`testing.md`](testing.md) for the full test patterns.

## Handoff to coding agents

A coding agent (Claude Code, etc.) reads the latest file from
`~/Downloads/SeeWhatISee/`. Four Claude Code plugin skills are
provided:

- `/see-what-i-see` — read the latest capture
- `/see-what-i-see-watch` — background loop that describes each
  new capture as it arrives
- `/see-what-i-see-stop` — stop the watcher
- `/see-what-i-see-help` — print a summary of the commands

Three helper scripts live in `plugin/scripts/` (symlinked from
`scripts/`):

- `_common.sh` — shared helpers sourced by the other two:
  directory resolution (config file, `--directory`, default),
  config parsing, and `absolutize_paths` (rewrites bare filenames
  in JSON to absolute paths via sed).
- `get-latest.sh` — reads the last line of `log.json` and prints
  a single JSON record with absolute paths to stdout. Used by
  `/see-what-i-see`.
- `watch.sh` — filesystem watcher used by `/see-what-i-see-watch`.
  Detects changes to `log.json` by polling mtime every 0.5s.
  Supports `--after TIMESTAMP` to catch up on missed captures;
  TIMESTAMP is the ISO `timestamp` field from a previous record
  (matched against `log.json`). Emits JSON records with absolute
  paths to stdout; status messages go to stderr.

All three resolve the download directory the same way: if
`--directory` is not given, look for a `.SeeWhatISee` config file
(in `.` then `$HOME`) with a `directory=<path>` setting, falling
back to `~/Downloads/SeeWhatISee`.

When a capture has a `prompt`, the skill that consumes it treats
the prompt as the user's instruction and acts on it directly
instead of just describing the image. URL-only captures
(no `screenshot`, no `contents`) let the user send a
prompt-about-the-URL without attaching any page content.

## Why a separate `dist/`

- `src/` holds TypeScript and the manifest template.
- `npm run build` compiles to `dist/` and copies the manifest and
  icons across.
- Chrome loads the extension unpacked from `dist/`.
- Keeping sources and build output separate means the loaded
  extension is always the result of an explicit build, which
  matches what Playwright tests run against.
