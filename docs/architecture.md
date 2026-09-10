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
  More-submenu utilities (copy-last filenames, offscreen
  clipboard).
- `capture-details.ts` — Capture-page per-tab session,
  `ensure*Downloaded` cache, multi-capture filename bump (locks
  files referenced by a `recordDetailedCapture` and writes
  `<base>-N.<ext>` on later edits).
  - `reopenCapture` also lives here: a new capture seeded from an
    existing `log.json` record's saved files. See [`history-page.md` →
    Reopen from a row](history-page.md#reopen-from-a-row).
- `last-capture.ts` — single-slot `lastCapture` session-storage:
  promote-on-close, restore-on-menu-click, low-priority quota
  relief. See [`capture-page.md` → Restore last
  capture](capture-page.md#restore-last-capture).
  - Restore is also offered from the row it describes on the History
    page, matched via the slot's `logKey`. See [`history-page.md` →
    Restore from a row](history-page.md#restore-from-a-row).
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

- Every entry point takes an optional `gestureTab` and resolves
  its target through `resolveCaptureTab`
  (`src/capture/target-tab.ts`) — see
  [capture-actions.md → Target-tab resolution](capture-actions.md#target-tab-resolution).
- `captureVisible(delayMs?, gestureTab?)` calls
  `chrome.tabs.captureVisibleTab` to get a PNG data URL of the
  visible tab region and saves it directly. `delayMs` runs a
  countdown (with a toolbar badge) before the target lookup so the
  user can reposition / hover during the wait.
- `savePageContents(delayMs?, gestureTab?)` uses
  `chrome.scripting.executeScript` to grab
  `document.documentElement.outerHTML` from the target tab and
  saves it as an HTML file. Same delay semantics as
  `captureVisible`.
- `captureBothToMemory(delayMs?, gestureTab?)` does *both* of the
  above without saving, returning the data for the Capture page
  flow to stash and preview. Same delay semantics.
  `captureBothToMemoryWithTab` is the same call plus the tab it
  resolved, so the Capture page can be placed next to the page it
  actually captured.
- `downloadScreenshot` / `downloadHtml` start a download from the
  pre-captured data; `waitForDownloadComplete` polls until the
  file is on disk and returns its absolute path. The SW caches
  these per-tab so a Copy-button pre-download and the eventual
  Capture share one file each.
- `recordDetailedCapture` writes the log record
  referencing whichever artifacts the caller decided to keep.
  Splitting the download from the record lets the SW materialize
  files on demand (Copy clicks) without committing them to the
  log until the user actually clicks Capture.

The `CaptureResult` returned by `captureVisible` and
`savePageContents` includes the `chrome.downloads` ids of the
content file and the `log.json` (`logDownloadId`):

- Production callers ignore them.
- The e2e tests use them to look up each saved file's actual
  on-disk path via `chrome.downloads.search`.

## Save directory + capture log

Captures are written via `chrome.downloads.download` into
`~/Downloads/SeeWhatISee/`.

- Screenshots are saved as `screenshot-<timestamp>.png`; HTML
  snapshots as `contents-<timestamp>.html`.
- The timestamp is `YYYYMMDD-HHMMSS-mmm` (local time, millisecond
  precision) — fine-grained enough that filenames are always
  unique in practice.
  - `SeeWhatISee.py --filter_time` accepts that stamp, whole or
    truncated, so a filename can be pasted back as a time filter (see
    [Time spans](cli_commands.md#time-spans)).
- We use the downloads API rather than a native messaging host so
  v1 has no native dependencies.
- Trade-off: the directory must live under the user's configured
  downloads folder.

Alongside the content file, every capture also writes a JSON
log file into the same directory. `log.json` is newline-delimited
JSON (one record per line), grep-friendly history of recent
captures. Scripts read the last line of `log.json` to get the latest record.

The same directory also carries the watch script's coordination
files — `.watch.pid`, `.watch-status.json`, `watch-stop.json` — which
are how the Capture page shows and stops a running watcher. They hold
no capture data; see [`watch-protocol.md`](watch-protocol.md).

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
  [`capture-page.md` → isEdited log flag](capture-page.md#isedited-log-flag).
- `imageUrl` — top-level field set by the image right-click flow
  (the URL of the right-clicked source image). Independent of
  `screenshot`, so it survives even when the user unchecks Save
  Screenshot in the Capture page.
- `prompt` — user-entered text from the Capture page, omitted
  when empty.
- `skipInWatcher` — `true` iff the user armed Pause in the Capture
  page's watcher box before saving. Watchers pass the record over;
  every other reader treats it normally. Omitted when not paused. See
  [`watch-protocol.md` → Pausing](watch-protocol.md#pausing--captures-a-watcher-passes-over).

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
- A record's `timestamp` is unique within `log.json`, so it can serve
  as a cursor (`--after`, the MCP `watch` tool).
  - It isn't unique when captured: a Capture-page session pins one
    timestamp and writes a record per save, so re-cropping or editing
    highlights produces several records built from the same stamp.
  - `uniqueTimestamp` (`capture/log-store.ts`) advances each collision
    by a millisecond as the record enters the log. The milliseconds are
    a uniqueness device, not a measurement — nothing displays them.
  - Only the record moves. Its files keep the compact stamp they were
    written with, so a second save's record can sit a millisecond past
    its own filenames.
  - No exception for a re-save that changed nothing: it's still its
    own save, and the cursor consumers need every record nameable.
  - Dedupe on the whole record — keying on the timestamp alone has
    already caused a bug on the History page.

### Storage model

- **`log.json` on disk is authoritative; `chrome.storage.local` is a
  cache.** The downloads API can only write whole files, so every
  capture still rewrites the file — but it reconciles against what is
  there first. See [log-consistency.md](log-consistency.md) for the
  full state table.
- Deleting `log.json` starts a new log. The next capture notices (via
  the download record's `exists`, or a failed read) and drops the
  buffer instead of putting the old records back.
  - Deleting or editing individual rows sticks too — but only when
    the extension can read the file. Without the "Allow access to file
    URLs" permission nothing reveals a change to a file's contents, so
    an edit is overwritten by the next capture; deletion of the whole
    file is honored either way.
  - The history files are untouched either way, and the History page
    still offers them.
- A capture only ever **adds** one record to what's on disk (plus the
  flush into history files, which moves older records into a
  `history-<timestamp>.json` beside `log.json`). It never rewrites or drops a
  record already there.
- When the extension can't tell what is on disk, it **doesn't write**
  — the capture fails right there and the user is asked: a dialog over
  the Capture page, or (for a context-menu / hotkey capture, which has
  no page of its own) the ordinary "Capture failed" page with the same
  dialog on top. Retry runs the append again, Overwrite forces it,
  Cancel drops the record (its files stay on disk). Nothing about the
  failure is stored — the next capture re-detects the condition on its
  own if it still holds.
- `watch.sh` is resilient to the whole `~/Downloads/SeeWhatISee/`
  directory not existing yet (it `mkdir -p`s on startup and polls for
  `log.json` to appear), so `/see-what-i-see-watch` can be launched
  before any capture.
- To browse the log, use the top-level **History** context-menu
  entry — a table view that opens from `log.json` itself when file
  reads allow, with the `captureLog` cache as fallback. See
  [history-page.md](history-page.md).
- There is no "clear history" menu entry. Clearing the cache alone
  would be undone by the next reconcile, and deleting the user's
  files is a separate feature that hasn't been built yet; deleting
  `log.json` by hand is the supported gesture in the meantime.
  `SeeWhatISee.clearCaptureLog()` from the service-worker devtools
  console empties the buffer only, and exists for tests.
- The in-storage log is capped at 100 entries; without a cap,
  rewriting the whole file on every capture would be quadratic in
  capture count.

### History files

- Entries aging out of the 100-entry buffer are **not** discarded.
  Once the log goes over the cap, the oldest 50 are written to a
  **history file** — `history-<timestamp>.json` beside `log.json` —
  and dropped from storage.
- So the full capture history lives on disk while no single write
  grows without bound. Steady-state cost per capture is still one
  `log.json` rewrite; the extra file lands once per 50 captures.
- `<timestamp>` is the `compactTimestamp` of **when the file was
  written**, not of any record inside it, so history files sort
  chronologically by name.
  - Deliberately not a stamp from a record inside the file: record
    timestamps are pinned when the capture is *taken*, so they aren't
    in append order — a Capture-page session can save minutes after
    other captures have appended ahead of it, which would let a batch
    end on a record older than one in an earlier file.
  - That matters because every reader treats filename order as
    chronological, including `SeeWhatISee.py --limit`, which walks
    from the newest *file* and stops early.
  - Ascending order is an **invariant**, not just what the clock
    usually does — a drain starts its stamps past the newest history
    file it can see (`stampFloor`), so a DST fall-back hour or a clock
    set backwards can't produce a name that sorts too low. A stamp
    more than ~25h ahead of the clock is ignored as bogus, so one
    stray file can't drag every later name forward with it.
- Consequence for readers: once the log has filled, `log.json`
  holds **51–100** entries depending on where in the flush cycle
  it is, not always 100.
  - `get-latest.sh` / `watch.sh` only ever want the tail, so they
    are unaffected.
  - `SeeWhatISee.py --all` / `--limit N` read the history files too,
    so they see the whole history rather than that window. They
    are globbed from the download dir and read in name order
    (= chronological), then `log.json` last; `--limit` walks that
    list from the newest end and stops once it has enough.
  - `SeeWhatISee.py --after TIMESTAMP` replays from `log.json`, so
    its catch-up window shrinks to as few as 51 records right
    after a flush. An older timestamp falls back to plain watching
    (with a warning), same as it always did.
- An entry leaves storage only after the history file holding it is
  written, one batch at a time, so nothing is trimmed out from under a
  write that didn't happen.
  - A failed history-file write is **not** a failed capture: the move
    is abandoned, everything not yet moved stays in storage (the new
    record included), and the next capture retries. Rejecting would
    orphan the screenshot already on disk and lose the record.
  - A batch's chosen name is recorded in `chrome.storage.local`
    (`pendingHistoryFiles`) *before* the file is written, and the
    retry reuses it — so a capture that writes the file and then dies
    before trimming the log overwrites its own orphan rather than
    writing the same 50 records twice under two names. Cleared once
    the batch is out of the log for good.
  - A new history file never takes a name one on disk already uses —
    see [log-consistency.md](log-consistency.md).
- **Nothing in the extension deletes the history files.** A `log.json`
  the user deletes takes the browser copy with it, but the history
  files stay on disk (deleting user files isn't something the
  extension does) and the History page can still load them.

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
`~/Downloads/SeeWhatISee/`. The Claude Code plugin skills are:

- `/see-what-i-see` — read the latest capture
- `/see-what-i-see-watch` — background loop that describes each
  new capture as it arrives
- `/see-what-i-see-stop` — stop the watcher
- `see-what-i-see-history` — scan or search past captures

Layout:

- Each skill that needs a script bundles it in its own
  `skills/claude-plugin/skills/<name>/scripts/` directory. No
  plugin-root-level `scripts/` dir.
- All per-skill scripts are thin wrappers around a single unified
  backend, `SeeWhatISee.py`. The backend lives next to its owning
  skill's wrapper at
  `skills/claude-plugin/skills/see-what-i-see/scripts/SeeWhatISee.py`,
  and is a verbatim copy of the canonical `skills/SeeWhatISee.py`
  (propagated by `skills/generate-skills.py`). Sibling-skill
  wrappers reach across to it via
  `../../see-what-i-see/scripts/SeeWhatISee.py`.
- The repo-root `scripts/` directory holds a single relative
  symlink, `scripts/SeeWhatISee.py -> ../skills/SeeWhatISee.py`,
  for direct dev-time and e2e-test invocation of the unified
  backend. The per-skill wrappers' install-time defaults
  (`--watch --loop`, `--copy-to-dir <tmp>`, etc.) are
  inlined into the test calls instead of going through the
  wrapper scripts, so we don't need a separate dev-tree wrapper
  per skill.
- The shipped per-skill wrappers continue to use plain
  `dirname "${BASH_SOURCE[0]}"` (no `readlink -f`) for sibling
  reach, since install layouts never invoke them via a symlink
  and avoiding `readlink -f` keeps us portable to BSD `readlink`
  (macOS ≤ 12.2).

The scripts:

- `skills/claude-plugin/skills/see-what-i-see/scripts/SeeWhatISee.py`
  — unified backend with all the actual logic, written in
  stdlib-only Python 3 (no third-party packages, so a skill bundle
  installs by copying files). Actions
  (`--get-latest`, `--all` / `--limit N`, `--watch`, `--stop`) are
  combinable; options (`--directory`, `--copy-to-dir`,
  `--no-lockfiles`, `--loop`, `--after`, `--catch-up-one`,
  `--print_selection`, and `--search` / `--filter_site` /
  `--filter_time` for the history listing) tune behavior.
  Handles directory resolution (config file / `--directory` /
  default), JSON path absolutization, optional file copy into a
  sandbox-readable target dir, mtime polling, pidfile management,
  and `--after` catch-up. See `cli_commands.md` for the full
  flag inventory.
- `skills/claude-plugin/skills/see-what-i-see/scripts/get-latest.sh`
  — `exec`s `SeeWhatISee.py --get-latest`. Reads the last line of
  `log.json` and prints a single JSON record with absolute paths.
- `skills/claude-plugin/skills/see-what-i-see-watch/scripts/watch.sh`
  — `exec`s `SeeWhatISee.py --watch --loop` and forwards
  the watcher flags (`--after`, `--print_selection`, `--stop`,
  `--directory`). The backend polls `log.json`'s mtime
  every 0.5s and emits records with absolute paths to stdout;
  status messages go to stderr. Each change emits *every* record
  past the last one it emitted, since a burst of captures can add
  several between two polls.
- `skills/claude-plugin/skills/see-what-i-see-stop/scripts/stop.sh`
  — `exec`s `SeeWhatISee.py --stop`. Used by `/see-what-i-see-stop`.
- `skills/claude-plugin/skills/see-what-i-see-history/scripts/history.sh`
  — `exec`s `SeeWhatISee.py` with the caller's history flags and no
  forced action, so the skill picks `--limit` / `--all` and the
  filters itself.

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
