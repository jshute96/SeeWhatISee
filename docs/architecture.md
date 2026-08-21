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
                                |  - captureSelection()       |
                                |  - recordDetailedCapture()  |
                                |  - saveCapture()            |
                                | + src/capture/              |
                                |    - types.ts (wire types)  |
                                |    - downloads.ts           |
                                |    - log-store.ts           |
                                |    - recompress.ts          |
                                |    - packed-text.ts         |
                                |    - image-source.ts        |
                                +---------------------------+
```

## Service-worker layout

`src/background.ts` is a thin entrypoint that wires Chrome event
listeners. The substantive logic lives in `src/background/`:

- `error-reporting.ts` — Capture-failed-page error surface
  (`runWithErrorReporting`, `friendlyErrorMessage`).
- `session-quota.ts` — pre-flight `chrome.storage.session` quota
  check shared by Capture, Upload, and Ask write paths.
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
- `last-capture.ts` — single-slot `lastCapture` session-storage:
  promote-on-close, restore-on-menu-click, low-priority quota
  relief. See [`capture-page.md` → Restore last
  capture](capture-page.md#restore-last-capture).
- `annotation-clipboard.ts` — the two geometry-only session slots
  behind the Capture page's Copy / Paste / Import annotations items
  (`annotationClipboard`, `lastCaptureAnnotations`). See
  [`capture-page.md` → Annotation
  transfer](capture-page.md#annotation-transfer-copy--paste--import).
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
    (Box-tool boxes, Line-tool lines, Arrow-tool arrows) baked
    into it. Redactions and crops are separate kinds, reported via
    `hasRedactions` / `isCropped` instead — they don't count as
    highlights.
  - `hasRedactions` is `true` iff the saved PNG has at least one
    opaque black redaction rectangle baked in.
  - Both describe the saved bytes, so markup that falls entirely
    outside the crop doesn't set them — it never reaches the file.
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
- To browse the log, use the top-level **History** context-menu
  entry — a table view over the same `captureLog` array. See
  [history-page.md](history-page.md).
- To clear history, use the **More → Clear log history**
  context-menu entry on the toolbar icon (or call
  `SeeWhatISee.clearCaptureLog()` from the service-worker
  devtools console). Both wipe the `captureLog` key from
  `chrome.storage.local` *and* overwrite the on-disk `log.json`
  with an empty file so downstream consumers see the cleared
  state immediately. `get-latest.sh` treats an empty `log.json`
  the same as "no captures yet"; `watch.sh` swallows the clear's
  mtime bump without emitting a spurious empty record.
- The in-storage log is capped at 100 entries; without a cap,
  rewriting the whole file on every capture would be quadratic in
  capture count.

### Archived logs

- Entries aging out of the 100-entry buffer are **not** discarded.
  Once the log goes over the cap, the oldest 50 are written to
  `history-<timestamp>.json` beside `log.json` and dropped from
  storage.
- So the full capture history lives on disk while no single write
  grows without bound. Steady-state cost per capture is still one
  `log.json` rewrite; the extra file lands once per 50 captures.
- `<timestamp>` is the `compactTimestamp` of the newest record in
  the file, so the name matches that capture's own files and
  archives sort chronologically.
- Consequence for readers: once the log has filled, `log.json`
  holds **51–100** entries depending on where in the flush cycle
  it is, not always 100.
  - `get-latest.sh` / `watch.sh` only ever want the tail, so they
    are unaffected.
  - `SeeWhatISee.sh --after TIMESTAMP` replays from `log.json`, so
    its catch-up window shrinks to as few as 51 records right
    after a flush. An older timestamp falls back to plain watching
    (with a warning), same as it always did.
- An entry leaves storage only after its archive file is written,
  one batch at a time, so nothing is trimmed out from under a write
  that didn't happen.
  - A failed archive write is **not** a failed capture: the flush is
    abandoned, everything un-archived stays in storage (the new
    record included), and the next capture retries. Rejecting would
    orphan the screenshot already on disk and lose the record.
- **Clear log history does not touch the archives.** It clears
  storage and empties `log.json`; the `history-*.json` files stay
  on disk (deleting user files isn't something the extension does)
  and the History page can still load them.

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

Two surfaces, picked by whether the user has an on-screen surface
to read the error from:

- **Toolbar click / hotkey / context menu** — no Capture page yet,
  so `runWithErrorReporting` opens a fresh `capture.html?error=…`
  tab next to the source tab. The page reveals its
  `#capture-failed-error` pane with the friendly-rewrite message
  from `friendlyErrorMessage`.
- **Capture page** — `saveDetails` responds `{ ok: false, error }`
  over the message channel and the page renders the error in
  `#ask-status` (the same status slot the Ask flow uses). No
  separate error tab opens for these.

See [`chrome-extension.md`](chrome-extension.md) for the design
rationale (why one full-page surface beat the older toolbar
icon/tooltip duo).

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

Layout:

- Each skill that needs a script bundles it in its own
  `skills/claude-plugin/skills/<name>/scripts/` directory. No
  plugin-root-level `scripts/` dir.
- All per-skill scripts are thin wrappers around a single unified
  backend, `SeeWhatISee.sh`. The backend lives next to its owning
  skill's wrapper at
  `skills/claude-plugin/skills/see-what-i-see/scripts/SeeWhatISee.sh`,
  and is a verbatim copy of the canonical `skills/SeeWhatISee.sh`
  (propagated by `skills/generate-skills.py`). Sibling-skill
  wrappers reach across to it via
  `../../see-what-i-see/scripts/SeeWhatISee.sh`.
- The repo-root `scripts/` directory holds a single relative
  symlink, `scripts/SeeWhatISee.sh -> ../skills/SeeWhatISee.sh`,
  for direct dev-time and e2e-test invocation of the unified
  backend. The per-skill wrappers' install-time defaults
  (`--watch --pid-lockfile`, `--copy-to-dir <tmp>`, etc.) are
  inlined into the test calls instead of going through the
  wrapper scripts, so we don't need a separate dev-tree wrapper
  per skill.
- The shipped per-skill wrappers continue to use plain
  `dirname "${BASH_SOURCE[0]}"` (no `readlink -f`) for sibling
  reach, since install layouts never invoke them via a symlink
  and avoiding `readlink -f` keeps us portable to BSD `readlink`
  (macOS ≤ 12.2).

The scripts:

- `skills/claude-plugin/skills/see-what-i-see/scripts/SeeWhatISee.sh`
  — unified backend with all the actual logic. Actions
  (`--get-latest`, `--watch`, `--stop`) are combinable; options
  (`--directory`, `--copy-to-dir`, `--pid-lockfile`, `--loop`,
  `--after`, `--catch-up-one`, `--print_selection`) tune behavior.
  Handles directory resolution (config file / `--directory` /
  default), JSON path absolutization, optional file copy into a
  sandbox-readable target dir, mtime polling, pidfile management,
  and `--after` catch-up. See `cli_commands.md` for the full
  flag inventory.
- `skills/claude-plugin/skills/see-what-i-see/scripts/get-latest.sh`
  — `exec`s `SeeWhatISee.sh --get-latest`. Reads the last line of
  `log.json` and prints a single JSON record with absolute paths.
- `skills/claude-plugin/skills/see-what-i-see-watch/scripts/watch.sh`
  — `exec`s `SeeWhatISee.sh --watch --pid-lockfile` and forwards
  the watcher flags (`--loop`, `--after`, `--print_selection`,
  `--stop`, `--directory`). The backend polls `log.json`'s mtime
  every 0.5s and emits records with absolute paths to stdout;
  status messages go to stderr.
- `skills/claude-plugin/skills/see-what-i-see-stop/scripts/stop.sh`
  — `exec`s `SeeWhatISee.sh --stop` (which auto-implies
  `--pid-lockfile`). Used by `/see-what-i-see-stop`.

All of these resolve the download directory the same way: if
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
- `pnpm run build` compiles to `dist/` and copies the manifest and
  icons across.
- Chrome loads the extension unpacked from `dist/`.
- Keeping sources and build output separate means the loaded
  extension is always the result of an explicit build, which
  matches what Playwright tests run against.
