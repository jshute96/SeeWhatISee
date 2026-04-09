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
                                | src/capture.ts      |
                                |  - captureVisible() |
                                |  - (future: full,   |
                                |     element, ...)   |
                                +---------------------+
```

- **Trigger.** A click on the toolbar action fires
  `chrome.action.onClicked` in `src/background.ts`. The same capture
  functions are also attached to `self.SeeWhatISee` so they can be invoked
  from the service worker devtools console or from Playwright via
  `serviceWorker.evaluate(...)`. This is the only way to drive the
  extension from tests, since Playwright cannot click the browser
  toolbar.
- **Capture.** `src/capture.ts` calls `chrome.tabs.captureVisibleTab` to
  get a PNG data URL. Future variations (full-page stitching, element
  crop, etc.) will live alongside `captureVisible` as additional
  exported functions.
- **Save.** Captures are written via `chrome.downloads.download` into
  `~/Downloads/SeeWhatISee/screenshot-<timestamp>.png`. All capture
  modes share the same filename prefix so an agent reading the
  directory only has to look for the newest `screenshot-*.png`. We use the downloads
  API rather than a native messaging host so v1 has no native
  dependencies; the trade-off is that the directory must live under the
  user's configured downloads folder.
- **Handoff.** A coding agent (Claude Code, etc.) reads the latest file
  from `~/Downloads/SeeWhatISee/`. The agent-side skill / slash command
  for this is a follow-up; the extension's only job is to make sure the
  freshest screenshot is always sitting in that directory.

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
