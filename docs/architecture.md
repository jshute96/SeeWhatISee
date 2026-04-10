# Architecture

SeeWhatISee is a small Manifest V3 Chrome extension plus a standard
on-disk drop directory that coding agents can read from.

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
                                |  - (future: full,     |
                                |     element, ...)     |
                                +---------------------+
```

- **Trigger.** A click on the toolbar action fires
  `chrome.action.onClicked` in `src/background.ts`. Right-clicking the
  toolbar icon opens a context menu (registered on
  `chrome.runtime.onInstalled` with `contexts: ['action']`) with three
  entries:
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

  Both the immediate (left-click / "Take screenshot") and the delayed
  paths share a single resolution strategy: `captureVisible` always
  re-queries the active tab in the last-focused window *after* any
  delay, then captures that tab and records that tab's URL. This
  keeps the recorded `url` and the captured pixels consistent even
  if the user switches tabs, windows, or interacts with a popup
  during the delay. If the focused window isn't a regular browser
  window with an active tab (e.g. DevTools is on top), the query
  returns nothing and the call throws — we deliberately do *not*
  fall back to "the previous regular window," because capturing a
  different window than the one the user is looking at is
  confusing. Failures are downgraded to `console.warn` by the
  action / context-menu wrappers, and a targeted
  `unhandledrejection` handler in `background.ts` catches the SW
  devtools console invocation path, so the throws don't pollute the
  chrome://extensions Errors page.

  Practical workflow from the SW devtools console: a no-arg
  `SeeWhatISee.captureVisible()` will usually fail (DevTools is the
  focused window). The working pattern is
  `SeeWhatISee.captureVisible(5000)` — call it, click into the real
  window, wait, get a screenshot of what's now in front.

  The trade-off is that `activeTab` only covers the tab that was
  active at gesture time, so a delayed capture that lands on a
  *different* `chrome://` tab will fail (normal http(s) pages are
  covered by `<all_urls>`).

  The same capture functions are also attached to `self.SeeWhatISee` so
  they can be invoked from the service worker devtools console or from
  Playwright via `serviceWorker.evaluate(...)`. This is the only way to
  drive the extension from tests, since Playwright cannot click the
  browser toolbar or open its context menu.
- **Permissions.** The manifest carries both `activeTab` and `<all_urls>`
  host permission because the two trigger paths need different things.
  A real toolbar click counts as a user gesture, which activates
  `activeTab` for the current tab — required to capture restricted URLs
  like `chrome://` pages, which `<all_urls>` deliberately excludes. The
  Playwright path bypasses the toolbar gesture and instead relies on
  `<all_urls>` to authorize captures of normal http(s) pages. Removing
  either one will silently break one of the paths. `contextMenus` is
  needed to register the right-click menu entries, `downloads` to write
  the screenshot and sidecar files, `scripting` to inject the
  content-retrieval script for "Save html contents", `storage` to back
  the in-extension capture log, and `tabs` so `chrome.tabs.query` can
  read the active tab's URL after the (possibly delayed) capture fires. Note that the
  Chrome Web Store is blocked from `captureVisibleTab` even with
  `activeTab`; that's a Chrome policy limit, not something the manifest
  can fix.
- **Capture.** `src/capture.ts` provides two capture functions:
  - `captureVisible` calls `chrome.tabs.captureVisibleTab` to get a
    PNG data URL of the visible tab region.
  - `savePageContents` uses `chrome.scripting.executeScript` to grab
    `document.documentElement.outerHTML` from the active tab and saves
    it as an HTML file.

  Future variations (full-page stitching, element crop, etc.) will
  live alongside these as additional exported functions. The
  `CaptureResult` returned by both functions includes the
  `chrome.downloads` ids of the content file and both JSON sidecars
  (`sidecarDownloadIds.{latest,log}`); production callers ignore them,
  but the e2e tests use them to look up each saved file's actual
  on-disk path via `chrome.downloads.search`.
- **Save.** Captures are written via `chrome.downloads.download` into
  `~/Downloads/SeeWhatISee/`. Screenshots are saved as
  `screenshot-<timestamp>.png` and HTML snapshots as
  `contents-<timestamp>.html`. The timestamp is `YYYYMMDD-HHMMSS-mmm`
  (local time, millisecond precision) which is fine-grained enough
  that filenames are always unique in practice. We use the downloads
  API rather than a native messaging host so v1 has no native
  dependencies; the trade-off is that the directory must live under
  the user's configured downloads folder.
- **Metadata sidecars.** Alongside the content file, every capture also
  writes two JSON sidecars into the same directory:
  - `latest.json` — pretty-printed `{timestamp, filename, url}` of the
    most recent capture, overwritten each time. Lets an agent get the
    newest capture without having to `ls`. `filename` is the bare
    content file basename (`.png` or `.html`), without the directory.
  - `log.json` — newline-delimited JSON (one record per line, same
    schema as `latest.json`), grep-friendly history of recent captures.
    Because the Chrome downloads API can only write whole files, the
    authoritative log lives in `chrome.storage.local` and `log.json` is
    a snapshot of it rewritten on every capture. Deleting `log.json`
    on disk is harmless — the next capture recreates it from storage.
    To actually clear history, also clear the extension's storage.
    The log is capped at 100 entries (FIFO eviction of the oldest);
    without a cap, rewriting the whole file on every capture would be
    quadratic in capture count.
- **Handoff.** A coding agent (Claude Code, etc.) reads the latest file
  from `~/Downloads/SeeWhatISee/`. Three Claude Code slash commands are
  provided: `/SeeWhatISee` (read the latest capture),
  `/SeeWhatISeeWatch` (background loop that describes each new
  capture as it arrives), and `/SeeWhatISeeStop` (stop the watcher).
  `scripts/watch.sh` is the underlying filesystem watcher — it detects
  changes to `latest.json` by polling mtime every 0.5s and
  supports `--after BASENAME` to catch up on missed captures.

## Why a separate `dist/`

`src/` holds TypeScript and the manifest template. `npm run build`
compiles to `dist/` and copies the manifest and icons across. Chrome loads the extension unpacked from `dist/`. Keeping
sources and build output separate means the loaded extension is always
the result of an explicit build, which matches what Playwright tests run
against.

## Adding a new capture mode

1. Add a new exported function to `src/capture.ts` (e.g.
   `captureFullPage`).
2. Register it on `self.SeeWhatISee` in `src/background.ts` so it is
   reachable from tests and the devtools console.
3. Wire it to its trigger — typically a `chrome.contextMenus` entry
   created in the background service worker on `onInstalled`.
4. Add a Playwright test that drives it via `serviceWorker.evaluate`.
