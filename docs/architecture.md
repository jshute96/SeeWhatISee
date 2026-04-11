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

- **Trigger.** A click on the toolbar action fires
  `chrome.action.onClicked` in `src/background.ts`. Right-clicking the
  toolbar icon opens a context menu (registered on
  `chrome.runtime.onInstalled` with `contexts: ['action']`) with the
  following entries:
  - **Take screenshot** — same as left-click; listed for
    discoverability.
  - **Take screenshot in 2s** / **Take screenshot in 5s** — pass the
    chosen delay through to `captureVisible(delayMs)`, which `await`s a
    `setTimeout` before capturing. The user gets time to activate a
    hover state, open a menu, etc. on the page; the `await` keeps the
    service worker alive for the duration of the timer. The menu
    handler is data-driven over a `MENU_ITEMS` array, so adding another
    delay (or changing the durations) is a one-line edit. The same
    `delayMs` argument is callable from the devtools console as
    `SeeWhatISee.captureVisible(5000)`.
  - **Save html contents** — uses `chrome.scripting.executeScript` to
    grab `document.documentElement.outerHTML` from the active tab and
    saves it as `contents-<timestamp>.html` in the same download directory.
    The capture is recorded in `latest.json` / `log.json` just like a
    screenshot — the only difference is the `.html` filename. Requires
    the `scripting` permission. Also callable from the devtools console
    as `SeeWhatISee.savePageContents()`.
  - **Capture with details...** — opens a bundled extension page
    (`capture.html`) where the user picks which artifacts to save,
    adds an optional prompt, and optionally annotates the
    screenshot. See ["Capture with details flow"](#capture-with-details-flow)
    below for the full design.
  - *(separator)*
  - **Clear Chrome history** — erases the capture log from
    `chrome.storage.local` via `clearCaptureLog()`. The on-disk
    `log.json` is intentionally *not* rewritten at clear time; it
    catches up on the next capture, at which point it will contain
    exactly one entry (the new one). Also callable as
    `SeeWhatISee.clearCaptureLog()`.

  Both paths share a single resolution strategy: `captureVisible` always
  re-queries the active tab in the last-focused window *after* any delay,
  then captures that tab and records its URL.

  - This keeps `url` and captured pixels consistent even if the user switches tabs,
    windows, or interacts with a popup during the delay.
  - If the focused window isn't a regular browser window with an active tab
    (e.g. DevTools is on top), the query returns nothing and the call throws.

  Every user-initiated click flows through `runWithErrorReporting` in `background.ts`:

  - On failure: swaps the toolbar icon to a pre-rendered error variant and appends
    `Last error: …` to the tooltip.
  - On later success: restores both.
  - See [`chrome-extension.md`](chrome-extension.md) for the design rationale
    (why not badge text, why not `chrome.notifications`) and how error icon variants
    are generated.

  The same capture functions are also attached to `self.SeeWhatISee` so they can be
  invoked from the service worker devtools console or from Playwright via
  `serviceWorker.evaluate(...)`.

  - This is the only way to drive the extension from tests, since Playwright cannot
    click the browser toolbar or open its context menu.
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
  - `captureVisible` calls `chrome.tabs.captureVisibleTab` to get a
    PNG data URL of the visible tab region and saves it directly.
  - `savePageContents` uses `chrome.scripting.executeScript` to grab
    `document.documentElement.outerHTML` from the active tab and saves
    it as an HTML file.
  - `captureBothToMemory` does *both* of the above without saving,
    returning the data for the details flow to stash and preview.
  - `saveDetailedCapture` takes pre-captured data plus flags for
    which artifacts to keep and an optional prompt, and writes the
    selected files + a single combined sidecar record.

  Future variations (full-page stitching, element crop, etc.) will live alongside
  these as additional exported functions.

  The `CaptureResult` returned by both functions includes the `chrome.downloads` ids
  of the content file and both JSON sidecars (`sidecarDownloadIds.{latest,log}`):

  - Production callers ignore them.
  - The e2e tests use them to look up each saved file's actual on-disk path via
    `chrome.downloads.search`.
- **Save.** Captures are written via `chrome.downloads.download` into
  `~/Downloads/SeeWhatISee/`.
  - Screenshots are saved as `screenshot-<timestamp>.png`; HTML snapshots as `contents-<timestamp>.html`.
  - The timestamp is `YYYYMMDD-HHMMSS-mmm` (local time, millisecond precision) — fine-grained enough that filenames are always unique in practice.
  - We use the downloads API rather than a native messaging host so v1 has no native dependencies.
  - Trade-off: the directory must live under the user's configured downloads folder.
- **Metadata sidecars.** Alongside the content file, every capture also
  writes two JSON sidecars into the same directory:
  - `latest.json` — pretty-printed record for the most recent capture,
    overwritten each time. Lets an agent get the newest capture without
    having to `ls`. Every record has `timestamp` and `url`, plus:
    - `screenshot` — bare PNG filename, set when a screenshot was saved.
    - `highlights` — `true` when the saved PNG has user-drawn red
      markup (boxes, lines, dots) baked into it. Only present when
      `screenshot` is also present, and only ever set to `true`
      (absent otherwise) so the field's presence is itself the
      signal. The see-what-i-see skills check this and steer their
      attention to the marked regions.
    - `contents` — bare HTML filename, set when HTML contents were saved.
    - `prompt` — user-entered text from "Capture with details…", omitted
      when empty.

    Legacy screenshot captures emit `{timestamp, screenshot, url}`;
    legacy HTML captures emit `{timestamp, contents, url}`. The
    detailed-capture path can emit any or all of the optional fields
    (the screenshot / contents filenames are chosen from the *same*
    compact timestamp so they share a suffix).
  - `log.json` — newline-delimited JSON (one record per line, same
    schema as `latest.json`), grep-friendly history of recent captures.
    - The Chrome downloads API can only write whole files, so the authoritative log lives in `chrome.storage.local`; `log.json` is a snapshot rewritten on every capture.
    - Deleting `log.json` on disk is harmless — the next capture recreates it from storage.
    - To clear history, use the **Clear Chrome history** entry on the toolbar right-click menu (`clearCaptureLog()`): wipes the `captureLog` key from `chrome.storage.local`; `log.json` catches up on the next capture (containing exactly the new entry).
    - The log is capped at 100 entries (FIFO eviction of the oldest); without a cap, rewriting the whole file on every capture would be quadratic in capture count.
- **Handoff.** A coding agent (Claude Code, etc.) reads the latest file
  from `~/Downloads/SeeWhatISee/`. Four Claude Code plugin skills are
  provided:
    - `/see-what-i-see` — read the latest capture
    - `/see-what-i-see-watch` — background loop that describes each new
      capture as it arrives
    - `/see-what-i-see-stop` — stop the watcher
    - `/see-what-i-see-help` — print a summary of the commands

  `scripts/watch.sh` is the underlying filesystem watcher:

  - Detects changes to `latest.json` by polling mtime every 0.5s.
  - Supports `--after TIMESTAMP` to catch up on missed captures;
    TIMESTAMP is the ISO `timestamp` field from a previous record
    (matched against `log.json`).
  - If `--directory` is not given, looks for a `.SeeWhatISee` config file
    (in the current directory, then `$HOME`) with a `directory=<path>` setting.
  - When a capture has a `prompt`, the skill that consumes it treats
    the prompt as the user's instruction and acts on it directly
    instead of just describing the image.

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
- **Save checkboxes** — pick screenshot, HTML, or both.
- **Prompt** — auto-growing textarea (capped at 200px). Enter
  submits, Shift+Enter inserts a newline.
- **Highlight overlay** — see [Image annotation](#image-annotation).
- **Preview image** — fits 90% of body width and shrinks vertically
  via JS-managed `max-height` so the page never scrolls.

### Image annotation

The screenshot preview is wrapped in an SVG overlay where the user
can draw red markup on the regions they want the agent to focus on.

- **Left-click** — drops a red filled circle ("dot"), 10px diameter.
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
  URL. Stroke widths and dot radii scale by the display→natural
  ratio so they look the same in the saved file as during editing.
- The page sends a `saveDetails` runtime message back to the
  background with the selected save options, the prompt, a
  `highlights: boolean` flag, and the `screenshotOverride` data URL
  when present.
- The background swaps the override into the stashed
  `InMemoryCapture` and calls `saveDetailedCapture()`. The saved
  sidecar record can include any of `screenshot`, `contents`,
  `prompt`, and `highlights: true`, on top of the always-present
  `timestamp` and `url`.
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
   `captureFullPage`).
2. Register it on `self.SeeWhatISee` in `src/background.ts` so it is
   reachable from tests and the devtools console.
3. Wire it to its trigger — typically a `chrome.contextMenus` entry
   created in the background service worker on `onInstalled`.
4. Add a Playwright test that drives it via `serviceWorker.evaluate`.
