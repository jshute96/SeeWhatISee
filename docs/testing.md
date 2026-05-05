# Testing

How the SeeWhatISee test suite is wired and the patterns to use
when adding new tests.

For Ask-flow live tests against real provider sites see
[`ask-live-tests.md`](ask-live-tests.md). For shrink-algorithm
unit tests, see `src/shrink.ts` and the e2e specs that pin the
multi-step drilling behavior.

## Testing an MV3 extension with Playwright

### Persistent context with the unpacked extension loaded

- The worker-scoped fixture in `tests/fixtures/extension.ts`
  launches a Chromium persistent context with
  `--load-extension=<dist>` plus an allowlist for the extension
  service worker.
- Run `npm run build` first so `dist/` is up to date.

### `getServiceWorker()` re-resolves every call

- MV3 service workers idle out quickly, and a previously
  obtained handle can go stale between test steps.
- The helper re-resolves on each call with a no-op probe.
- There's still a tiny TOCTOU window (the SW can die between
  probe and caller's `evaluate`); practical mitigation is to
  bundle all work for a single test into one `evaluate` block.

### Playwright cannot click the toolbar or open a context menu

- There's no real click on the extension icon and no
  `contextMenu.show()`-style API.
- We attach every capture function to `self.SeeWhatISee` in
  `background.ts` and drive tests via
  `serviceWorker.evaluate(() => self.SeeWhatISee.captureVisible())`.
- Any new feature that adds a user-triggered code path should
  register itself on `self.SeeWhatISee` so tests can reach it.

### Page `download` event never fires for SW-initiated downloads

- Playwright's context-level `download` event only fires for
  downloads a page initiates (an attachment-style navigation).
- `chrome.downloads.download` from the service worker is
  invisible to that event.
- We resolve downloads via `chrome.downloads.search({ id })`
  inside the SW, polling for `state === 'complete'`, then
  reading the returned `filename` field — which is the actual
  on-disk path Playwright uses for its download interception
  storage (typically a UUID under a temp dir, not the path we
  asked for, but the one we need to read the bytes back).

### No `chrome.action.getIcon`

- There's no read-side API for the current toolbar icon.
- The error-reporting tests install a monkey-patch on
  `chrome.action.setIcon` inside the service worker that records
  every call's `path` argument.
- The test side reads the log back via `serviceWorker.evaluate`.
- The spy is reset in `beforeEach` and lives on the SW global
  (`__setIconCalls`) so it survives the test-harness boundary.

### `chrome.tabs.captureVisibleTab` rate limit

- Capped at `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`
  (~2 calls/sec per window).
- Tests that capture back-to-back need a ~600ms cushion between
  calls or they blow the quota.
- The shared screenshot spec uses a `test.beforeEach` sleep to
  keep the suite order-independent.

## Practical devtools-console workflow

- **Open the SW console** via `chrome://extensions` → Service
  worker link on the SeeWhatISee card.
- **A no-arg `SeeWhatISee.captureVisible()` usually fails** with
  `No active tab found to capture` because DevTools itself is
  the focused window. `SeeWhatISee.captureVisible(2000)` is the
  working pattern: start the delayed capture, click into the
  real window, wait for the capture. Any `delayMs` is fine —
  pick a longer one if 2s doesn't give you enough time to
  switch windows.
- The SW devtools console is also the fastest way to exercise:
  - `savePageContents()` — grab the current tab's HTML.
  - `clearCaptureLog()` — wipe the storage log.
  - `reportCaptureError(new Error("…"))` / `clearCaptureError()`
    — test the error surface without having to trigger a real
    failure.
