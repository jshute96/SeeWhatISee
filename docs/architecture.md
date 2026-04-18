# Architecture

SeeWhatISee is a small Manifest V3 Chrome extension plus a standard
on-disk drop directory that coding agents can read from.

This doc is a high-level overview of components and data flow.
Chrome-specific hazards, workarounds, and the error-reporting
design live in [`chrome-extension.md`](chrome-extension.md).

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
                                |  - saveDetailedCapture()    |
                                |  - clearCaptureLog()        |
                                +---------------------------+
```

- **Capture actions.** A single `CAPTURE_ACTIONS` array in
  `src/background.ts` is the source of truth for every user-visible
  way to grab content.

  - Generated at module load from `BASE_CAPTURE_ACTIONS ×
    CAPTURE_DELAYS_SEC` — three bases times three delays (0, 2,
    5 seconds).
  - Each generated entry has an id (`<baseId>` for delay 0,
    `<baseId>-<N>s` otherwise), a menu title, an icon tooltip,
    `baseId` + `delaySec` fields for routing into the right menu
    section, and a zero-arg `run()` that forwards the delay to
    the base action's handler.

  The three bases are:

  - **`capture-now` — "Take screenshot".** Calls
    `captureVisible(delayMs)`. Immediate PNG of the visible tab.
    The delayed variants show a countdown badge on the toolbar
    icon ("5", "4", "3", …) before capturing, so the user can
    activate hover states, open menus, etc. on the page. The
    `await` keeps the service worker alive for the duration. Any `delayMs` value is also callable
    from the devtools console as
    `SeeWhatISee.captureVisible(2000)`.
  - **`save-page-contents` — "Save html contents".** Uses
    `chrome.scripting.executeScript` to grab
    `document.documentElement.outerHTML` from the active tab and
    saves it as `contents-<timestamp>.html`. The capture is
    recorded in `log.json` just like a screenshot
    — only the filename differs. Requires the `scripting`
    permission. Takes the same optional `delayMs` as
    `captureVisible`; also callable as
    `SeeWhatISee.savePageContents(2000)`.
  - **`capture-with-details` — "Capture with details...".** Opens
    a bundled extension page (`capture.html`) where the user picks
    which artifacts to save, adds an optional prompt, and
    optionally annotates the screenshot. Takes the same
    `delayMs`, forwarded through `captureBothToMemory` so the
    delay applies to the pre-open screenshot + HTML snapshot.
    See ["Capture with details flow"](#capture-with-details-flow)
    below for the full design.

- **Default click action.** The id of one `CAPTURE_ACTIONS` entry
  is persisted in `chrome.storage.local` under the
  `defaultClickAction` key.

  - A click on the toolbar icon fires `chrome.action.onClicked`,
    which routes through `handleActionClick`. Three cases:
    1. **Viewing the capture page** — if the active tab is a
       `capture.html` page with stashed session data, the click
       sends it a `triggerCapture` message, which programmatically
       clicks the Capture button.
    2. **Double-click** — a second click within 250 ms runs an
       alternate action: screenshot when the default is
       `capture-with-details`, or capture-with-details when
       the default is anything else.
    3. **Single click** — waits 250 ms for a potential second
       click, then runs the default action.
  - Fresh installs default to `capture-with-details` — the details
    page with double-click screenshot shortcut.
  - All delay variants (0s, 2s, 5s) are defaultable — the "Set
    default click action" submenu mirrors the full delay set.
  - The toolbar icon's hover tooltip is set from the selected
    action's `tooltip` field via `chrome.action.setTitle`, so the
    icon always tells the user what a click is about to do.
    `refreshActionTooltip()` rewrites it whenever the preference
    changes and on `onInstalled` / `onStartup`.
  - Every tooltip includes a second line ("Double-click for …")
    describing the alternate action.

- **Right-click menu.** The toolbar icon's context menu is
  registered on `chrome.runtime.onInstalled` with
  `contexts: ['action']`. Top level (6 entries):

  - The three **undelayed** `CAPTURE_ACTIONS` items (Take
    screenshot, Save html contents, Capture with details...),
    each running its action immediately when clicked. "Take
    screenshot" is functionally identical to a plain left-click
    when `capture-now` is the default — listed for discoverability.
  - **Capture with delay ▸** — submenu with the 2s and 5s variants
    of each base action, separator-grouped by delay. In-submenu
    separators don't count against the top-level cap, so the
    visual grouping is free.
  - **Set default click action ▸** — submenu of normal items, one
    per `CAPTURE_ACTIONS` entry: three undelayed items, a separator,
    three 2s-delay items, a separator, then three 5s-delay items.
    The selected item gets a `✓ ` title prefix; picking one
    persists its id as `defaultClickAction` and refreshes the
    tooltip.
    - Uses normal items instead of `type: 'radio'` because Chrome's
      radio mutual-exclusion only covers a contiguous run — the
      separator would cause two items to appear selected.

  - **More ▸** — submenu home for infrequent utilities that would
    otherwise crowd out primary capture entries at the top level.
    - **Clear log history** — `clearCaptureLog()` erases the
      in-storage capture log *and* overwrites `log.json` on disk
      with an empty file so `/see-what-i-see` et al. see the cleared
      state immediately. Still exposed on
      `SeeWhatISee.clearCaptureLog()` for the devtools console.

  **Top-level item cap.**

  - Chrome enforces `chrome.contextMenus.ACTION_MENU_TOP_LEVEL_LIMIT
    = 6`. Top-level separators count against it.
  - The menu currently has 6 top-level entries (3 undelayed + 3
    submenu parents: Capture with delay, Set default click action,
    and More) — **at the cap**.
  - **Do not add another top-level entry** — nest new items under
    an existing submenu parent (More is the natural home for new
    infrequent utilities).
  - Overflow fails silently via `chrome.runtime.lastError`, so a
    careless addition drops a previously-working entry without any
    build- or runtime-time error. See
    [chrome-extension.md → Context menus on the toolbar action](chrome-extension.md#context-menus-on-the-toolbar-action)
    for the full story, including the 8e100d1 regression this caused.

- **Active-tab resolution.** `captureVisible` always re-queries
  the active tab in the last-focused window *after* any delay,
  then captures that tab and records its URL.

  - This keeps `url` and captured pixels consistent even if the
    user switches tabs, windows, or interacts with a popup during
    the delay.
  - If the focused window isn't a regular browser window with an
    active tab (e.g. DevTools is on top), the query returns
    nothing and the call throws.

- **Error reporting.** Every user-initiated click flows through
  `runWithErrorReporting` in `background.ts`.

  - On failure: swaps the toolbar icon to a pre-rendered error
    variant and appends `Last error: …` to the tooltip.
  - On later success: restores both.
  - See [`chrome-extension.md`](chrome-extension.md) for the
    design rationale (why not badge text, why not
    `chrome.notifications`) and how error icon variants are
    generated.

- **Test hook.** The same capture functions are attached to
  `self.SeeWhatISee` so they can be invoked from the service
  worker devtools console or from Playwright via
  `serviceWorker.evaluate(...)`. This is the only way to drive
  the extension from tests, since Playwright cannot click the
  browser toolbar or open its context menu.
- **Permissions.** The manifest declares `activeTab`, `<all_urls>` host permission,
  `contextMenus`, `downloads`, `scripting`, and `storage`.
  - Both `activeTab` and `<all_urls>` are needed because they serve different trigger
    paths (real toolbar gesture vs. Playwright-driven `evaluate`); dropping either one
    silently breaks one of them.
  - We deliberately do *not* request the `tabs` permission.
  - See [`chrome-extension.md`](chrome-extension.md) for the reasoning and other
    Chrome-specific permission hazards (including why the Chrome Web Store itself
    blocks `captureVisibleTab`).
- **Capture.** `src/capture.ts` provides these capture functions:
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
    without saving, returning the data for the details flow to
    stash and preview. Same delay semantics.
  - `saveDetailedCapture` takes pre-captured data plus flags for
    which artifacts to keep and an optional prompt, and writes the
    selected files + a single combined sidecar record.

  Future variations (full-page stitching, element crop, etc.)
  live here as additional exported functions.

  The `CaptureResult` returned by `captureVisible` and
  `savePageContents` includes the `chrome.downloads` ids of the
  content file and the JSON sidecar (`sidecarDownloadIds.log`):

  - Production callers ignore them.
  - The e2e tests use them to look up each saved file's actual
    on-disk path via `chrome.downloads.search`.
- **Save.** Captures are written via `chrome.downloads.download` into
  `~/Downloads/SeeWhatISee/`.
  - Screenshots are saved as `screenshot-<timestamp>.png`; HTML snapshots as `contents-<timestamp>.html`.
  - The timestamp is `YYYYMMDD-HHMMSS-mmm` (local time, millisecond precision) — fine-grained enough that filenames are always unique in practice.
  - We use the downloads API rather than a native messaging host so v1 has no native dependencies.
  - Trade-off: the directory must live under the user's configured downloads folder.
- **Metadata sidecar.** Alongside the content file, every capture also
  writes a JSON sidecar into the same directory:
  - `log.json` — newline-delimited JSON (one record per line),
    grep-friendly history of recent captures. Scripts use
    `tail -1 log.json` to get the latest record. Every record has
    `timestamp` and `url`, plus optional fields:
    - `screenshot` — bare PNG filename, set when a screenshot was saved.
    - `highlights` — `true` when the saved PNG has user-drawn red
      markup (boxes, lines) baked into it. Only present when
      `screenshot` is also present, and only ever set to `true`
      (absent otherwise) so the field's presence is itself the
      signal. The see-what-i-see skills check this and steer their
      attention to the marked regions.
    - `contents` — bare HTML filename, set when HTML contents were saved.
    - `prompt` — user-entered text from "Capture with details…", omitted
      when empty.

    Legacy screenshot captures emit `{timestamp, screenshot, url}`;
    legacy HTML captures emit `{timestamp, contents, url}`. The
    detailed-capture path can emit any or all of the optional fields —
    including neither `screenshot` nor `contents` (URL-only, typically
    with a `prompt`). The screenshot / contents filenames share the
    *same* compact timestamp so they have a matching suffix.
    - The Chrome downloads API can only write whole files, so the authoritative log lives in `chrome.storage.local`; `log.json` is a snapshot rewritten on every capture.
    - Deleting `log.json` on disk is harmless — the next capture recreates it from storage. `watch.sh` is also resilient to the whole `~/Downloads/SeeWhatISee/` directory not existing yet (it `mkdir -p`s on startup and polls for `log.json` to appear), so `/see-what-i-see-watch` can be launched before any capture.
    - To clear history, use the **More → Clear log history** context-menu entry on the toolbar icon (or call `SeeWhatISee.clearCaptureLog()` from the service-worker devtools console). Both wipe the `captureLog` key from `chrome.storage.local` *and* overwrite the on-disk `log.json` with an empty file so downstream consumers see the cleared state immediately. `get-latest.sh` treats an empty `log.json` the same as "no captures yet"; `watch.sh` swallows the clear's mtime bump without emitting a blank line.
    - The log is capped at 100 entries (FIFO eviction of the oldest); without a cap, rewriting the whole file on every capture would be quadratic in capture count.
- **Handoff.** A coding agent (Claude Code, etc.) reads the latest file
  from `~/Downloads/SeeWhatISee/`. Four Claude Code plugin skills are
  provided:
    - `/see-what-i-see` — read the latest capture
    - `/see-what-i-see-watch` — background loop that describes each new
      capture as it arrives
    - `/see-what-i-see-stop` — stop the watcher
    - `/see-what-i-see-help` — print a summary of the commands

  Three helper scripts live in `plugin/scripts/` (symlinked from
  `scripts/`):

  - `_common.sh` — shared helpers sourced by the other two:
    directory resolution (config file, `--directory`, default),
    config parsing, and `absolutize_paths` (rewrites bare filenames
    in JSON to absolute paths via sed).
  - `get-latest.sh` — reads the last line of `log.json` and prints a
    single JSON record with absolute paths to stdout. Used by
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

## Capture with details flow

- A right-click menu entry opens `capture.html` so the user can
  review and annotate the capture before it's saved.
- Implementation lives in `src/background.ts`, `src/capture.html`,
  and `src/capture-page.ts`.

### Pre-capture and tab open

- `captureBothToMemory()` snapshots the screenshot + HTML up-front,
  *before* opening the new tab. This way the preview shows the
  user's current page, not the empty `capture.html` tab.
- `startCaptureWithDetails()` then opens `capture.html` immediately
  to the right of the active tab (`index: active.index + 1`) and
  links it via `openerTabId`.
- The capture data and the opener id are stashed in
  `chrome.storage.session` keyed by the new tab's id, in a
  `DetailsSession` wrapper.

### What the page shows

- **Captured URL** — read-only single-line monospace input.
- **HTML byte size** — `formatBytes(new Blob([html]).size)` →
  `B` / `KB` / `MB` / `GB` / `TB`.
- **Save checkboxes** — pick screenshot, HTML, both, or neither
  (URL-only record).
- **Prompt** — auto-growing textarea (capped at 200px). Enter
  submits, Shift+Enter inserts a newline.
- **Highlight overlay** — see [Image annotation](#image-annotation).
- **Preview image** — fits 90% of body width and shrinks vertically
  via JS-managed `max-height` so the page never scrolls.

### Image annotation

The screenshot preview is wrapped in an SVG overlay where the user
can draw red markup on the regions they want the agent to focus on.

- **Left-click-drag** — draws a 3px-bordered red rectangle.
- **Right-click-drag** — draws a 3px red line. The browser context
  menu is suppressed on the overlay.
- **Undo / Clear** — single edit stack; buttons disabled when empty.
- Edits are stored as percentages of the image dimensions so they
  stay aligned across window resizes and prompt growth.

### Save and close

- On Capture click, if there are highlights *and* the screenshot is
  being saved, the page bakes the SVG overlay onto a `<canvas>` at
  the screenshot's natural resolution and produces a fresh PNG data
  URL. Stroke widths scale by the display→natural ratio so they look
  the same in the saved file as during editing.
- The page sends a `saveDetails` runtime message back to the
  background with the selected save options, the prompt, a
  `highlights: boolean` flag, and the `screenshotOverride` data URL
  when present.
- The background swaps the override into the stashed
  `InMemoryCapture` and calls `saveDetailedCapture()`. The saved
  sidecar record can include any of `screenshot`, `contents`,
  `prompt`, and `highlights: true`, on top of the always-present
  `timestamp` and `url`. It's valid to save with neither checkbox
  ticked — the record then carries just the URL (and any prompt).
- After the save resolves, the background re-activates the opener
  tab and then removes the details tab — the user lands back on
  the page they captured from. Chrome's natural close-time pick is
  not reliably the immediate right neighbor (we tested this and
  Chrome activated a tab two positions right of the closed slot in
  the headless e2e environment), so the explicit re-activation is
  required for deterministic behavior. `openerTabId` alone has no
  effect on close-time focus.

See [`chrome-extension.md`](chrome-extension.md) for the
runtime-message and session-storage hazards (CSP, SW idle-out,
permission gaps).

## Why a separate `dist/`

- `src/` holds TypeScript and the manifest template.
- `npm run build` compiles to `dist/` and copies the manifest and icons across.
- Chrome loads the extension unpacked from `dist/`.
- Keeping sources and build output separate means the loaded extension is always the result of an explicit build, which matches what Playwright tests run against.

## Adding a new capture mode

1. Add a new exported function to `src/capture.ts` (e.g.
   `captureFullPage`). If delayed variants are wanted, accept an
   optional `delayMs` and call `countdownSleep(delayMs)` before
   the real work, matching `captureVisible` /
   `savePageContents` / `captureBothToMemory`.
2. Register it on `self.SeeWhatISee` in `src/background.ts` so it
   is reachable from tests and the devtools console.
3. Add a new entry to the `BASE_CAPTURE_ACTIONS` array in
   `src/background.ts` with a base id, base title, base tooltip,
   and a `run(delayMs)` that calls your new function. The flat
   `CAPTURE_ACTIONS` array is generated from
   `BASE_CAPTURE_ACTIONS × CAPTURE_DELAYS_SEC` at module load, so
   the new base automatically gains immediate + 2s + 5s variants
   across the top-level menu, the "Capture with delay" submenu, and
   the "Set default click action" submenu. No other plumbing.
   - **Watch the top-level cap.** Chrome allows at most
     `ACTION_MENU_TOP_LEVEL_LIMIT = 6` top-level items per action
     context menu, and separators count. The menu is currently at
     5 (3 undelayed entries + Capture with delay submenu + Set
     default submenu), leaving one slot of headroom. If a future
     change would push it past 6, move the undelayed top-level
     slots into a submenu of their own (e.g. "Capture now") so
     the top-level count stays under cap.
4. Add a Playwright test that drives the new function via
   `serviceWorker.evaluate`.
