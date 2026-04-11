# Chrome extension — implementation notes

Companion to [`architecture.md`](architecture.md).

That doc describes *what* the extension is and *how* the components
fit together. This one captures the Chrome-specific hazards and
surprises we hit building it — and the workarounds we landed on.

## Manifest V3 service worker lifecycle

The background script is an MV3 service worker. That means:

- **It idles out aggressively.**
  - Chrome unloads the worker after ~30s of inactivity.
  - Listeners persist across the idle — Chrome re-wakes the worker on
    the next event — but module-level state is lost.
  - The authoritative capture log therefore lives in
    `chrome.storage.local`, not in a module-level array.
- **`await` keeps it alive.** Inside a listener, awaiting a promise
  (including an `await new Promise(r => setTimeout(r, ms))`) holds
  the worker awake for the duration.
  - This is what makes "Take screenshot in 5s" work: the handler
    sleeps on an awaited timer and Chrome doesn't reclaim the worker
    until the handler returns.
  - Don't `setTimeout(() => captureVisible(), 5000)` without
    awaiting — the timer fires in a dead worker.
- **`chrome.downloads.download` resolves on download *start*, not
  completion.**
  - For our tiny data-URL payloads (PNG + JSON sidecars) this is
    effectively immediate.
  - If we ever see partial files or interleaving in `log.json`, the
    fix is to wait on `chrome.downloads.onChanged` for
    `state === 'complete'` before returning. Marked "overkill for v1"
    inside `saveCapture`.
- **The Chrome downloads API can only write whole files.** No
  append, no edit, no partial overwrite.
  - `log.json` is therefore a *snapshot* rewritten from
    `chrome.storage.local` on every capture.
  - The log is capped at 100 entries so the per-capture rewrite
    stays O(1) instead of growing with total capture count.
- **Unhandled rejections get promoted to `chrome://extensions` →
  Errors.** Any promise that rejects without a `.catch` lands on
  the extension's Errors page, which makes the extension look
  broken to anyone who opens it.

  We handle this on two paths:

  1. Every user-initiated click flows through
     `runWithErrorReporting` in `background.ts`, which catches the
     rejection and surfaces it on the icon + tooltip.
  2. A targeted `unhandledrejection` handler at the top of
     `background.ts` catches the user-friendly messages
     (`No active tab found to capture`, `Failed to retrieve page
     contents`) from bare `self.SeeWhatISee.captureVisible()` calls
     in the SW devtools console — that path doesn't go through
     `runWithErrorReporting`. The allowlist is deliberately narrow
     so real bugs still surface.

## Permissions: what we ended up with and why

The manifest declares:

- `activeTab` — granted by a real user gesture (toolbar click). The
  only thing that lets `captureVisibleTab` work on restricted URLs
  like `chrome://` pages.
- `<all_urls>` host permission — covers normal http(s) pages for
  the Playwright path, which bypasses the toolbar gesture and can't
  trigger `activeTab`.
- `contextMenus` — required even for menus scoped to
  `contexts: ['action']`. The scope argument tells Chrome *where* to
  show the menu; it doesn't exempt you from the permission gate on
  `chrome.contextMenus.create`.
- `downloads` — the only way an MV3 service worker can drop files
  onto the local filesystem without a native messaging host.
- `scripting` — for `chrome.scripting.executeScript`, which is how
  we pull `document.documentElement.outerHTML` for HTML snapshots.
- `storage` — the authoritative home of the capture log.

### Why not `tabs`

- `chrome.tabs.query` works without it.
- With `<all_urls>` host permission, `tab.url` is also exposed on
  http(s) pages.
- For restricted schemes like `chrome://`, `tab.url` comes back
  undefined regardless — adding `tabs` wouldn't change that.
- Dropping the unneeded permission also keeps the Chrome Web Store
  reviewer's job simpler.

### Why not `notifications`

We considered using `chrome.notifications` as the error channel.
Three problems:

- The OS toast layer adds non-removable "Settings" / "Activate"
  buttons on Linux and macOS.
- The content duplicates what a tooltip can already convey.
- Requires an extra permission on the CWS listing.

Not worth it. See the error-reporting section below.

### Gotcha: `activeTab` is granted at gesture time, not capture time

A real toolbar click grants `activeTab` for *the tab that was
active when the click happened*.

- The "Take screenshot in 5s" path `await`s a timer, then
  re-queries the active tab. If the user switches to a different
  tab during the delay, the captured tab won't be covered by
  `activeTab` anymore — it has to fall back to the host permission.
- Normal http(s) pages are fine because `<all_urls>` covers them.
- A delayed capture that lands on a *different* `chrome://` tab
  than the gesture originated from will fail: `<all_urls>` doesn't
  cover `chrome://`, and the `activeTab` grant doesn't follow the
  user to a new restricted tab.

### Gotcha: the Chrome Web Store blocks `captureVisibleTab`

Even with `activeTab` granted, Chrome refuses to let an extension
screenshot the CWS page itself. That's a Chrome policy limit, not
something the manifest can fix — just something to warn users about.

## Error reporting: from invisible to visible

### Before

Capture failures (no active tab, failed HTML grab, etc.) went to
`console.warn` in the *service worker's* devtools console.

To see them, a user would have to:

1. Open `chrome://extensions`
2. Enable Developer mode
3. Find the SeeWhatISee extension card
4. Click the "Service Worker" link to open its devtools
5. Switch to the Console tab

In practice, a failed capture looked like *nothing happening at all*:

- The toolbar icon stayed the same.
- The file didn't show up in `~/Downloads/SeeWhatISee/`.
- There was no on-screen signal anywhere.

The Errors page on `chrome://extensions` was also noisy because
`unhandledrejection`s from the devtools-console path leaked onto it.

### Options we considered

- **`chrome.notifications`** — native OS toast. Loud, but:
  - Chrome injects a mandatory "Notification settings" button on
    every toast from an extension (anti-spam policy, not
    controllable).
  - Linux notification daemons add a default-action button labeled
    something like "Activate" for each toast.
  - Requires the `notifications` permission, which shows up on the
    CWS listing even though it's silent at install time.
  - Mostly duplicates what a tooltip can convey.
- **`chrome.action.setBadgeText`** — a colored pill on the toolbar
  icon. Cheap and visible, but:
  - Chrome renders the badge at a fixed pixel size (~half the icon
    height) and there is **no API to shrink it**.
  - The full surface is `setBadge{Text,BackgroundColor,TextColor}`:
    no font size, no pill shape, no inset.
  - At 16px icon sizes the badge consumes a ridiculous fraction of
    the space.
- **`chrome.action.setIcon`** — swap the whole toolbar icon to a
  pre-rendered variant.
  - Full pixel control, no extra permission, matches the visual
    language of the base icon.
  - Cost: a tiny generator + three PNG variants.
- **`chrome.action.setTitle`** — rewrite the toolbar tooltip.
  - Chrome honors embedded `\n`, so we can add a second line with
    the error message while keeping the default text on line one.

### What we picked

Two-channel error surface routed through one helper.

- **`chrome.action.setIcon`** swaps to a pre-rendered "error" variant
  (`icons/icon-error-{16,48,128}.png`): same base camera icon with a
  solid red rounded-rect badge and a white `!` centered inside it,
  painted in the bottom-right corner. The base icons are restored
  explicitly on next success.
- **`chrome.action.setTitle`** appends `Last error: <message>` as a
  second line on the toolbar tooltip so a user can hover the icon
  and read what happened without digging into devtools.

Both calls are wrapped in `runWithErrorReporting(fn)`:

- Every user-initiated click (action click, all context-menu
  entries) routes through it.
- A successful run calls `clearCaptureError()`; a failing run calls
  `reportCaptureError()`.
- Result: errors are visible *and* explained, without any extra
  permission or OS chrome.

### Icon generation is code, not art

`scripts/generate-error-icons.mjs` uses `pngjs` (already a devDep
for the tests' pixel helpers) to read each base icon, paint a
rounded-rect badge + white `!` at a defined pixel offset, and
write the variant PNGs.

Why code instead of hand-drawn art:

- Sizing constants (badge side = `size/2`, corner radius ~20% of the
  badge, stem/dot proportions) all live in code.
- Tweaking the look is a one-line edit — no need to open Photoshop
  and hand-edit three files.
- A `--variants` mode writes size-sweep previews to
  `tmp/icon-size-variants/` so the final badge size can be picked
  by eye without touching the committed icons.

There's no anti-aliasing — pngjs is raw RGBA — but at these sizes
jagged edges aren't visible and the solid color + straight edges
render cleanly.

## Context menus on the toolbar action

- **Permission required.** `contextMenus` is required even for
  `contexts: ['action']`. See the permissions section.
- **Registration on `onInstalled`.** Menus are created with
  `contexts: ['action']`. Chrome persists the entries across
  service-worker restarts, so we don't recreate them on every wake.
- **Install / update / chrome_update all fire `onInstalled`.**
  Calling `chrome.contextMenus.create` with an id that already
  exists throws "Cannot create item with duplicate id." We call
  `removeAll` first, then recreate — handles all three paths
  identically.
- **Separators.** `chrome.contextMenus.create` accepts
  `type: 'separator'`, but separator items must *not* include a
  `title` field at all (passing `title: undefined` still throws).
  The code builds the properties object conditionally.
- **No per-item tooltip.** There's no `description` or similar
  field on a menu entry. The `title` is the only user-visible text.
  If you want a tooltip, put the extra context in a source comment
  and keep the title short.

## Testing an MV3 extension with Playwright

- **Persistent context with the unpacked extension loaded.** The
  worker-scoped fixture in `tests/fixtures/extension.ts` launches a
  Chromium persistent context with `--load-extension=<dist>` plus
  an allowlist for the extension service worker. Run `npm run
  build` first so `dist/` is up to date.
- **`getServiceWorker()` re-resolves every call.**
  - MV3 service workers idle out quickly, and a previously obtained
    handle can go stale between test steps.
  - The helper re-resolves on each call with a no-op probe.
  - There's still a tiny TOCTOU window (the SW can die between
    probe and caller's `evaluate`); practical mitigation is to
    bundle all work for a single test into one `evaluate` block.
- **Playwright cannot click the toolbar or open a context menu.**
  - There's no real click on the extension icon and no
    `contextMenu.show()`-style API.
  - We attach every capture function to `self.SeeWhatISee` in
    `background.ts` and drive tests via
    `serviceWorker.evaluate(() => self.SeeWhatISee.captureVisible())`.
  - Any new feature that adds a user-triggered code path should
    register itself on `self.SeeWhatISee` so tests can reach it.
- **Page `download` event never fires for SW-initiated downloads.**
  - Playwright's context-level `download` event only fires for
    downloads a page initiates (an attachment-style navigation).
  - `chrome.downloads.download` from the service worker is
    invisible to that event.
  - We resolve downloads via `chrome.downloads.search({ id })`
    inside the SW, polling for `state === 'complete'`, then reading
    the returned `filename` field — which is the actual on-disk
    path Playwright uses for its download interception storage
    (typically a UUID under a temp dir, not the path we asked for,
    but the one we need to read the bytes back).
- **No `chrome.action.getIcon`.**
  - There's no read-side API for the current toolbar icon.
  - The error-reporting tests install a monkey-patch on
    `chrome.action.setIcon` inside the service worker that records
    every call's `path` argument.
  - The test side reads the log back via `serviceWorker.evaluate`.
  - The spy is reset in `beforeEach` and lives on the SW global
    (`__setIconCalls`) so it survives the test-harness boundary.
- **`chrome.tabs.captureVisibleTab` is rate-limited** to
  `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` (~2 calls/sec per
  window).
  - Tests that capture back-to-back need a ~600ms cushion between
    calls or they blow the quota.
  - The shared screenshot spec uses a `test.beforeEach` sleep to
    keep the suite order-independent.

## Practical devtools-console workflow

- **Open the SW console** via `chrome://extensions` → Service
  worker link on the SeeWhatISee card.
- **A no-arg `SeeWhatISee.captureVisible()` usually fails** with
  `No active tab found to capture` because DevTools itself is the
  focused window. `SeeWhatISee.captureVisible(5000)` is the working
  pattern: start the delayed capture, click into the real window,
  wait for the capture.
- The SW devtools console is also the fastest way to exercise:
  - `savePageContents()` — grab the current tab's HTML.
  - `clearCaptureLog()` — wipe the storage log.
  - `reportCaptureError(new Error("…"))` / `clearCaptureError()` —
    test the error surface without having to trigger a real failure.
