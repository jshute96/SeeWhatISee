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
                                +---------------------+
                                | src/capture.ts        |
                                |  - captureVisible()   |
                                |  - savePageContents() |
                                |  - clearCaptureLog()  |
                                |  - (future: full,     |
                                |     element, ...)     |
                                +---------------------+
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
- **Capture.** `src/capture.ts` provides two capture functions:
  - `captureVisible` calls `chrome.tabs.captureVisibleTab` to get a
    PNG data URL of the visible tab region.
  - `savePageContents` uses `chrome.scripting.executeScript` to grab
    `document.documentElement.outerHTML` from the active tab and saves
    it as an HTML file.

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
  - `latest.json` — pretty-printed `{timestamp, filename, url}` of the
    most recent capture, overwritten each time.
    - Lets an agent get the newest capture without having to `ls`.
    - `filename` is the bare content file basename (`.png` or `.html`), without the directory.
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
  - Supports `--after BASENAME` to catch up on missed captures.
  - If `--directory` is not given, looks for a `.SeeWhatISee` config file
    (in the current directory, then `$HOME`) with a `directory=<path>` setting.

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
