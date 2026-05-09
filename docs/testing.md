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

### Capturing the SW-opened error tab

- `runWithErrorReporting` opens an error-page tab on failure. The
  error-reporting e2e spec asserts on the `?error=` query param of
  that tab's URL.
- We **spy on `chrome.tabs.create`** rather than listening for
  `chrome.tabs.onCreated`. The extension only has the `activeTab`
  permission (no `tabs` permission), so Chrome strips URL fields
  from tabs delivered to `onCreated`/`onUpdated` listeners — a
  filter on `capture.html?error=` would never match.
- Spy + action + read all happen inside a **single**
  `serviceWorker.evaluate` block. The MV3 service worker can
  recycle between separate `evaluate` calls and drop the spy
  state, stranding the read.
- Same `chrome.tabs.create` stub shape as `upload-image.spec.ts` —
  capture create-properties without actually opening a tab so the
  suite doesn't accumulate stray windows.

### `chrome.tabs.captureVisibleTab` rate limit

- Capped at `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`
  (~2 calls/sec per window) — a third call within any rolling
  1-second window throws.
- Handled by `tests/fixtures/capture-quota.ts`:
  - `installCaptureQuotaTracker(sw)` patches the SW-side
    `chrome.tabs.captureVisibleTab` to record the last 2 successful
    call timestamps in `globalThis.__seeCapTimes`, and to
    auto-retry on the quota error using the exact remaining wait
    computed from the ring.
  - `waitForCaptureQuota(sw)` reads the ring and sleeps only the
    minimum needed (often 0 ms) so a third call won't trip the
    quota.
- A global `test.beforeEach` in `tests/fixtures/extension.ts`
  installs the tracker and waits — specs no longer carry their
  own ~600 ms cushion.
- Backoff retries are tagged `[capture-quota]` and forwarded from
  the SW console to test stderr, so spikes in retries are visible
  during a run without per-spec instrumentation.

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
  - `reportCaptureError(new Error("…"))` — test the error
    surface without having to trigger a real failure (opens a
    `capture.html?error=…` tab next to the active tab).
