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
- Run `pnpm run build` first so `dist/` is up to date.

### `getServiceWorker()` re-resolves every call

- MV3 service workers idle out quickly, and a previously
  obtained handle can go stale between test steps.
- The helper re-resolves on each call with a no-op probe.
- There's still a tiny TOCTOU window (the SW can die between
  probe and caller's `evaluate`); practical mitigation is to
  bundle all work for a single test into one `evaluate` block.

### Parallelism is per file, across whole browsers

- `fullyParallel: false` keeps each spec file on a single worker;
  `workers` is unset, so Playwright uses half the cores.
- Every worker gets its own browser, profile, download dir,
  `captureVisibleTab` quota, and fixture HTTP server — nothing is
  shared, which is what makes this safe.
- A worker is a whole Chromium, so this is real CPU load, but the
  tests mostly wait on CDP and SW round-trips: 4 workers cut the
  suite from 8.8 min to ~3 min on an 8-core box.
- Don't push it higher by hand. At 6 workers the gain was ~30 s and
  contention started tripping the 5 s `expect` timeouts.

### The test tree is type-checked separately

- `tsconfig.json` compiles `src/` only, and Playwright transpiles
  specs without checking types — so nothing checked `tests/*.ts`.
- `tsconfig.tests.json` + `pnpm run typecheck:tests` close that gap,
  and `pnpm test` runs the check before the suite.
- It runs in about a second, so it's the cheapest way to catch a
  broken annotation before paying for a 9-minute e2e run.

### Shared per-test hooks must be fixtures, not `beforeEach`

- `tests/fixtures/extension.ts` is imported by every e2e spec, but
  Node caches the module: its top level executes **once per
  Playwright worker**, while the worker's *first* spec file loads.
- Playwright attaches a `test.beforeEach` / `test.afterEach` to
  whichever file is loading when the call runs. Module-level hooks
  there therefore covered only that first spec file — every later
  file in the worker ran without them, silently.
- That is exactly what happened here: the capture-quota wait and
  the leftover-page cleanup stopped running after the first spec
  file, so pages leaked for the rest of the worker's life.
- Each extra attached page slows every CDP round-trip, which made
  identical tests run several times slower purely because of what
  ran before them.
- **Rule:** shared per-test setup/teardown belongs in an
  `{ auto: true }` fixture (`extensionHooks`), which has no file
  affinity. Reserve `beforeEach`/`afterEach` for hooks written
  inside a spec file, or in a helper the spec calls at load time
  (e.g. `installAskTestHooks()`).
- Corollary, now that cleanup really does run everywhere: a page
  must not be expected to survive into a later test. Create pages
  inside the test that uses them.

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
- The `extensionHooks` auto fixture in
  `tests/fixtures/extension.ts` installs the tracker and waits —
  specs no longer carry their own ~600 ms cushion.
- Backoff retries are tagged `[capture-quota]` and forwarded from
  the SW console to test stderr, so spikes in retries are visible
  during a run without per-spec instrumentation.

### Pointer coordinates are truncated to whole CSS pixels

Chrome truncates the coordinates the DevTools protocol hands it, so
`page.mouse.move(x, 351.6)` arrives in the page as `clientY === 351`.

- The Capture page's preview image is centred in a flex row, so its
  viewport origin is routinely fractional (e.g. `y = 301.59375`).
- A spec that builds a target as `r.y + 100`, dispatches it, then
  asserts against its own unrounded `r.y + 100` is comparing 401.59
  against the 401 the page actually saw.
- **This fails silently for a long time.** While the origin's fraction
  is under 0.5 the miss is inside the usual `toBeCloseTo(…, 0)`
  tolerance; the day an unrelated layout change pushes the fraction
  over 0.5, a pile of drawing specs goes red at once with no change to
  the code under test. That is what happened once already.
- Use `previewPoint(r, dx, dy)` from `capture-drawing-helpers.ts` for
  every dispatched point, and assert against what it returns:
  - `x` / `y` — the floored viewport coords, matching what the page
    will see.
  - `dx` / `dy` — the offset from the image origin the page will
    *actually* see, for percent-space assertions. Not the requested
    offset.
- Points read *back* from the page (a committed box corner, a line
  endpoint that a drag is meant to snap onto) keep their exact
  fractional values — don't round those, or the snap assertions stop
  meaning anything.

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
