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
  - This is what makes "Save screenshot in 2s" work: the handler
    sleeps on an awaited timer and Chrome doesn't reclaim the worker
    until the handler returns.
  - Don't `setTimeout(() => captureVisible(), 2000)` without
    awaiting — the timer fires in a dead worker.
- **`chrome.downloads.download` resolves on download *start*, not
  completion.**
  - For our tiny data-URL payloads (PNG + JSON sidecar) this is
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
     `runWithErrorReporting` in `background/error-reporting.ts`,
     which catches the rejection and surfaces it on the icon + tooltip.
  2. A targeted `unhandledrejection` handler installed by
     `background/error-reporting.ts` catches the user-friendly messages
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

- The "Save screenshot in 2s" path `await`s a timer, then
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

### Ask flow uses dynamic injection (no `content_scripts`)

The Ask button on the Capture page sends artifacts to a third-party
AI tab (claude.ai, gemini.google.com, chatgpt.com, or google.com).
Two design choices fall out of the permissions we already have:

- **No `content_scripts` declaration.** The manifest does not list
  AI-site URLs — `chrome.scripting.executeScript` covers it on
  demand, so the extension runs zero code on AI sites until the user
  actually clicks Ask.
- **MAIN world execution.** `src/ask-inject.ts` is loaded with
  `world: 'MAIN'` so it can dispatch `change` / `input` /
  `beforeinput` events that the AI site's composer actually listens
  to (Claude and ChatGPT use ProseMirror, Gemini uses Quill — all
  ignore `.value =` writes and only respond to real input pipeline
  events).
  An isolated-world script fires events into a separate JS realm
  and the page never sees them.

- `executeScript({ files: ['ask-inject.js'] })` installs the IIFE's
  postMessage bridge listener.
- The ISOLATED-world widget then drives one operation at a time
  (`attachFile`, `typePrompt`, `clickSubmit`) over that bridge.
- Keeping `ask-inject.ts` as a classic script (no `import`/`export`)
  lets retries land in the same MAIN-world realm without re-loading
  the bundle.

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
  - Rejected for errors, but the badge *is* used for the countdown
    timer during delayed captures (see `countdownSleep` in
    `capture.ts`), where the large size helps visibility.
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
- **`chrome.action.setTitle`** slots an `ERROR: <message>` line
  directly under the app title on the tooltip (above the blank that
  already brackets the action block, so it lands where the eye goes
  first) so a user can hover the icon and read what happened
  without digging into devtools.

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

## Countdown badge for delayed captures

When a delayed capture starts (2s or 5s), a `countdownSleep` helper
in `capture.ts` shows a countdown on the toolbar badge via
`chrome.action.setBadgeText`: "5", "4", "3", "2", "1". The badge
clears when the timer finishes and the capture fires.

### Implementation details

- **Orange background** (`#FF8C00`) — set once before the countdown
  loop starts. The large badge pill that made `setBadgeText`
  unsuitable for the error surface works in the countdown's favor:
  the number is easy to read at a glance.
- **250ms polling interval** — a `setInterval` checks `Date.now()`
  against the target end time and updates the displayed number via
  `Math.ceil`. The 250ms tick means the badge updates within a
  quarter-second of each real second boundary.
- **Non-async interval callback** — the `setInterval` callback is
  deliberately synchronous, chaining `.then` / `.catch` on the
  Chrome API promises. An `async` callback would produce unhandled
  promise rejections invisible to the outer `Promise` (since
  `setInterval` ignores the return value). On failure, the interval
  is cleared and the outer promise is rejected so the capture
  surfaces the error through `runWithErrorReporting`.
- **Shared across all three capture paths** — `captureVisible`,
  `savePageContents`, and `captureBothToMemory` all call
  `countdownSleep(delayMs)` when `delayMs > 0`.

## Toolbar tooltip (`chrome.action.setTitle`)

### Scope: global, not per-tab

`chrome.action.setTitle({ title })` (without `tabId`) sets a
**single global tooltip** shared across all browser windows.
There is no per-window variant.

`setTitle({ tabId, title })` creates a tab-scoped override that
Chrome is *supposed* to show when that tab is active, falling back
to the global title on other tabs. In practice we found this
**unreliable**: `getTitle({ tabId })` confirmed the override was
stored, but the tooltip Chrome actually rendered on hover still
showed the global title. We don't use per-tab titles.

### Our tooltip strategy

- **Default tooltip.** `refreshActionTooltip()` calls
  `getDefaultActionTooltip()`, which snapshots the four stored
  defaults + `capturePageDefaults` + the bound shortcuts and feeds
  them into `buildTooltip` (in `src/background/tooltip.ts` — pure
  logic, unit-tested). Runs on preference change, `onInstalled`, and
  `onStartup`.
- **Layout.** Header (`SeeWhatISee`) + optional `ERROR: …` block + a
  Click row + a Double-click row + trailing blank. Each row is one
  or two lines depending on whether the with-selection slot
  collapses. Full algorithm + Case 1–4 rules in
  [`docs/options-and-settings.md`](options-and-settings.md#toolbar-tooltip).
- **Hotkeys folded in.** `_execute_action` and `secondary-action`
  shortcuts (when bound) attach to the row's first line — at the end
  on Case-1 (single-line) rows, inside the label header
  (`Click [<key>]:`) on Case-2/3/4 rows. Never on a continuation
  line: the same hotkey fires both branches of the row.
- **Error tooltip.** `reportCaptureError()` passes the error
  message into `getDefaultActionTooltip(message)`, which slots
  `ERROR: <message>` between the app title and the action block
  (bracketed by its own blank lines). See the error-reporting
  section above. Only fires for capture paths with no on-screen
  surface (toolbar click, context menu) — Capture-page failures
  land in `#ask-status` instead.

### Abandoned: capture-page tooltip override

Goal: show "SeeWhatISee — Capture" when the Capture page is
active. Approaches tried:

- **`setTitle` from background after `chrome.tabs.create`** —
  Chrome overwrote it. Cause unconfirmed; possibly Chrome's own
  tooltip text (e.g. "Wants access to this site") lands
  asynchronously after our call.
- **Per-tab `setTitle({ tabId })`** — `getTitle({ tabId })`
  confirmed the value was stored, but Chrome rendered the global
  title on hover anyway.
- **`setTitle` from `capture-page.ts` after a 200 ms delay** —
  worked for the initial display, but required an `onActivated`
  listener to restore the default tooltip on tab switch. Problems:
  - Fired on *every* tab switch, not just away from capture tabs.
  - Erased "ERROR:" tooltip messages.
  - Didn't survive switching away and back to the capture tab.

If revisited, the delayed-set-from-page approach was the most
promising — the main issue was the `onActivated` restore logic.

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
  At the top level of the action menu, separators count against
  the 6-item cap, so we don't use any there. Inside submenus
  they're free and we use them to group "Capture with delay" by
  delay; inside "More" they split the capture shortcuts into a
  three-way cluster (`save-defaults` | `save-url` + `save-all` |
  the three `save-selection-*` shortcuts) and then fence off the
  copy-last, snapshots-dir, and clear-log utility rows.
  - **ChromeOS workaround.** ChromeOS sometimes fails to render
    native `type: 'separator'` items in the extension action menu.
    `installContextMenu` in `background/context-menu.ts` detects the platform
    via `chrome.runtime.getPlatformInfo()` and falls back to a
    disabled normal item titled with a fixed-length run of U+2500
    box-drawing chars (`────…`) on ChromeOS to preserve visual
    grouping.
    - **A11y trade-off.** `chrome.contextMenus` has no API to mark
      an item non-focusable or aria-hidden, so the fake separator
      is still reachable via keyboard navigation and screen readers
      announce it as a dimmed row of dashes. Native separators skip
      focus. We accept this because the native path is already
      broken on ChromeOS — invisible grouping is worse than a
      focusable dash row.
- **No per-item tooltip.** There's no `description` or similar
  field on a menu entry. The `title` is the only user-visible text.
  If you want a tooltip, put the extra context in a source comment
  and keep the title short.
- **Radio items.** `type: 'radio'` items render with a radio
  indicator.
  - A *contiguous* run of radio items with the same `parentId`
    forms a mutually exclusive group; Chrome auto-flips the
    selection on click.
  - **Separators break the group.** Inserting a separator between
    two same-parent radios splits them into two *independent*
    mutual-exclusion groups, so the user can end up with one item
    checked in each. (Historically why the retired
    Set-default-click submenu used `✓ ` title prefixes on normal
    items rather than radio items — its sections were separated.)
- **Click / double-click hints on run entries.** Top-level entries
  and the "Capture with delay" submenu entries append a
  `  -  (Click)` or `  -  (Double-click)` hint to whichever item
  matches the current toolbar-click routing.
  - No real italics — menu titles are plain text. Italics are faked
    with Unicode mathematical sans-serif italic letters, so the hint
    reads `(𝘊𝘭𝘪𝘤𝘬)`.
  - No right-alignment — `chrome.contextMenus` has no accelerator /
    secondary-label slot, and space-padding only approximates a
    column on one machine (menu rendering uses the platform UI font,
    so widths drift across OSes). An inline dash separator reads
    as intentional on every platform.
  - Hints track the without-selection default only — the
    with-selection default only kicks in when a selection exists
    on the active tab, which we can't reliably predict at
    menu-render time. Setting either default refreshes every menu
    row's hint via `refreshMenusAndTooltip`.
- **Submenus via `parentId`.** Any item created with a `parentId`
  becomes a child of the named parent, which Chrome then renders
  with a ▸ indicator automatically. No explicit "submenu" type.
- **Persisted state doesn't survive `removeAll`.** The install
  handler wipes the menu on every install / update / chrome_update,
  so any initial state derived from storage (e.g. the click /
  double-click hints on the run-entry titles) has to be re-read
  from `chrome.storage.local` and passed back into the `create()`
  calls on every recreate.
- **Top-level item limit.** Chrome caps each extension at
  `chrome.contextMenus.ACTION_MENU_TOP_LEVEL_LIMIT = 6` top-level
  items per context. The constant is read-only — it's reporting a
  hard limit baked into Chrome, not a setting.
  - **Separators count.** A `type: 'separator'` entry takes one of
    the six slots. That's why the action menu has none; spending a
    slot on a divider would cost us a real entry.
  - **Overflow fails silently.** When you exceed the cap,
    `chrome.contextMenus.create()` sets `chrome.runtime.lastError`
    to *"You cannot add more than 6 …"* on the offending call and
    the item simply doesn't register. Because the loop in
    `background/context-menu.ts` doesn't pass a `create()` callback, we never
    read `lastError` and the failure is invisible until someone
    notices the menu entry is gone. This has already bitten us
    once: commit 8e100d1 added "Capture with details..." as a 7th
    entry, which silently dropped "Clear log history" off the
    menu until the regression was spotted later. Keep the top
    level at 6 or below, or move entries into a submenu.
  - Our action menu currently has 5 top-level entries — three
    undelayed primary-group capture actions, the "Capture with
    delay" submenu parent, and the "More" submenu parent (which
    hosts the more-group capture actions "Save default items",
    "Save URL", "Save everything", and the three
    "Save selection as …" shortcuts, plus "Copy last screenshot
    filename", "Copy last HTML filename", "Copy last selection
    filename", "Snapshots directory", and "Clear log history").
    One slot is free below the cap — the retired Set-default-click
    submenu used to occupy it. Adding a new top-level entry costs
    that slot; further additions need to nest under "More" or
    promote a primary entry into a new submenu.

## Image right-click context menu

Image-context entries (currently Capture… and Save screenshot)
live in `contexts: ['image']` and surface in the page context menu
when the user right-clicks any `<img>`-like element. Distinct from
the toolbar `action` menu above — different context root, different
click info shape (`info.srcUrl` is set), and not subject to the
6-item top-level cap (that limit applies only to
`contexts: ['action']`).

- **Auto-grouping.** Chrome bundles all top-level page-context
  entries from a single extension under a parent submenu labeled
  with the extension name. We don't create that parent ourselves —
  registering two siblings produces "SeeWhatISee ▸ Capture... /
  Save screenshot".
- **Click info.** `chrome.contextMenus.onClicked` delivers
  `info.srcUrl` (image URL) and `tab` (the page the image lives
  on). The image URL is typically `http(s):`, `data:`, or `blob:`;
  the page-side fetch path described below resolves all three from
  the source page's context. Cross-origin images without permissive
  CORS may still fail — the failure surfaces on the toolbar icon
  via `runWithErrorReporting`.
- **Image bytes via page-side fetch.** Both entries call
  `fetchImageInPage(tabId, srcUrl)` which runs a one-shot
  `executeScript` in the page's isolated world. Two strategies, in
  order:
  - **fetch().** Carries the user's cookies for the URL's origin
    and respects the page-side CORS environment. Works for
    `data:` / `blob:` URLs (no network round-trip) and for most
    same-origin / CORS-clean cross-origin images. The original
    encoded bytes pass through losslessly — JPEG photos stay JPEG.
  - **Canvas snapshot.** When fetch fails (403 from a site whose
    auth doesn't accept anonymous CORS, hot-link protection
    rejecting our `Sec-Fetch-Site`, expired signed-URL params,
    etc.), the fallback finds an `<img>` whose `currentSrc` or
    `src` matches the right-clicked URL, draws it onto a canvas,
    and reads PNG bytes back. Lossy for JPEG sources but preserves
    the visual content the user already saw painted. Fails on
    tainted canvases (cross-origin without
    `crossorigin="anonymous"` on the original `<img>`); the error
    surfaces with a clear message explaining why.
  - **Errors round-trip.** The injected function catches its own
    rejections and returns an `error` field. `executeScript`
    discards page-side rejections, so the explicit envelope is the
    only way the SW sees the failure reason.
  - **Limitation.** The canvas fallback requires an `<img>` element
    matching `srcUrl`. CSS `background-image` URLs are not supported
    — Chrome's `contexts: ['image']` doesn't fire on those anyway.
- **Filename extension.** `imageExtensionFor(mime, srcUrl)` picks
  an extension via a three-step ladder.
  - Known MIMEs hit the static table (`png` / `jpg` / `webp` /
    `gif` / `svg` / `avif` / `bmp` / `ico`).
  - Off-table MIMEs fall through to the URL pathname extension
    (e.g. `/photo.heic` → `heic`). Useful when servers send
    `application/octet-stream`.
  - Final fallback is `unknown` (never `.png` — misnaming bytes is
    the bug we're avoiding).
  - Filename is `screenshot-<ts>.<ext>` so the bytes stay honest.
- **Bake-in always emits PNG.** The Capture-page bake
  (`renderHighlightedPng` → `canvas.toDataURL('image/png')`) is
  rasterized PNG regardless of the source format. To keep the
  filename honest, `ensureScreenshotDownloaded` swaps the
  extension to `.png` before writing whenever
  `screenshotOverride` is set, and reverts to
  `screenshotOriginalExt` when the user undoes back to clean.
- **Routing.**
  - `IMAGE_CAPTURE_MENU_ID` →
    `startCaptureWithDetailsFromImage(tab, srcUrl)`.
    - Builds the `InMemoryCapture` with the image bytes as
      `screenshotDataUrl`, skips the page HTML scrape, still
      scrapes selection.
    - Opens `capture.html` next to the source tab.
    - Session carries `htmlUnavailable: true` and
      `imageUrl: srcUrl` so the page can quiet-disable Save HTML
      and the SW can record the source URL.
  - `IMAGE_SAVE_SCREENSHOT_MENU_ID` →
    `captureImageAsScreenshot(tab, srcUrl)`.
    - Writes the bytes via `saveCapture(..., ext, srcUrl)` and
      appends a `screenshot` + `imageUrl` record to `log.json`.
    - No Capture page round-trip; no HTML scrape.
- **`imageUrl` on the record.** Top-level `CaptureRecord` field,
  emitted by `serializeRecord` last in the JSON object — after
  `url` and `title`. Keeps the per-record metadata block (page
  URL, page title, source image URL) visually grouped at the end.
  - Independent of `screenshot`: `recordDetailedCapture` forwards
    `capture.imageUrl` even when `includeScreenshot: false`.
  - Intent is "remember which image the user picked" — shouldn't
    get dropped just because they unchecked Save Screenshot before
    clicking Capture.
- **Image-flow defaults.** `imageFlowDefaults(user)` in
  `capture-details.ts` synthesizes a `CaptureDetailsDefaults` for
  image sessions.
  - Save Screenshot ✓, Save HTML false, Save Selection ✓ (when
    present).
  - Inherits the user's selection `format` plus `defaultButton` /
    `promptEnter` so the page's highlight ring and Enter behavior
    don't change.
  - The user's stored `capturePageDefaults` is **not** mutated;
    only the wire response is overridden.
- **Error reporting.** Both routes are wrapped in
  `runWithErrorReporting` so a fetch failure (CORS-blocked image,
  404, restricted-URL scrape) surfaces on the toolbar icon /
  tooltip the same way other capture failures do.

## Options page (`options.html`)

Bundled second extension page reached via right-click → Options on
the toolbar action. Owns the only UI for editing the four toolbar
defaults and the Capture-page Save defaults. See
[options-and-settings.md](options-and-settings.md) for the layout,
wire, and the storage shape it edits.

## Capture page (`capture.html`) — extension page + runtime messaging

The Capture page opens in a new tab, previews the pre-captured
screenshot, and waits for the user to pick which artifacts to save
before writing anything.

This section is split by topic:

- [Page contents](#page-contents)
- [Image annotation pane](#image-annotation-pane)
- [Highlight bake-in on save](#highlight-bake-in-on-save)
- [Image fit-to-viewport](#image-fit-to-viewport)
- [Tab positioning + return-to-opener](#tab-positioning--return-to-opener)
- [Chrome-specific gotchas](#chrome-specific-gotchas)

### Page contents

- **Captured-page card** — bordered strip with two text rows.
  - Top row: page title as a clickable link (`target="_blank"`)
    with right-aligned pills stacked vertically — `HTML · <size>`
    on top and `Selection · <size>` below. Both pills describe
    what was captured and is available to save (independent of the
    Save-HTML / Save-selection checkboxes). Both update on every
    Edit-dialog save; the Selection pill also tracks the chosen
    format radio.
  - Bottom row: URL in monospace blue with a trailing external-link
    glyph, followed inline by a Copy URL button (matches the
    `.copy-btn` style used by every other Copy on the page).
  - Non-linkable URLs (empty, or non-http(s) schemes like
    `chrome://`) strip the `href`: rows render as plain black text
    and the external-link glyph hides. Copy URL stays enabled when
    the URL is non-empty; it disables (and vanishes via the shared
    `.copy-btn:disabled { display: none }` rule) only when the URL
    is empty.
  - HTML scrape failures hide the size pill rather than printing a
    misleading `0 B`.
- **Save checkboxes** — pick screenshot, HTML, both, or neither.
  Capture stays enabled even with neither ticked; a neither-save
  still writes a log record with just the URL (and any prompt),
  so the user can hand an agent a URL + prompt without attaching
  any captured page content.
- **Per-row icon buttons** — each Save row carries a small icon
  strip next to its checkbox / radio:
  - **Copy** — pre-materializes the artifact under its pinned
    capture filename and writes the absolute path to the clipboard.
  - **Edit** — opens a modal editor for the captured body (HTML /
    selection formats); Save updates the SW's authoritative copy.
  - **Save as…** — opens a native save dialog seeded with a
    generic default filename (`screenshot.png`, `contents.html`,
    `selection.{html,txt,md}`).
    - Writes the *current edited* body: the screenshot bake includes
      any highlights / redactions / crop; HTML and selection bodies
      come from the in-page `captured[kind]` mirror the Edit dialogs
      keep in sync.
    - Disabled (and hidden) for any row whose body is unavailable —
      failed scrape, or a per-format selection that trimmed empty.
    - Implementation: `chrome.downloads.download({ saveAs: true })`
      called directly from the extension page — no SW round-trip.
    - Selection / HTML bodies route through a `blob:` URL whose
      revocation is deferred ~30 s (the API resolves on download
      *start*, not finish, so a synchronous revoke can truncate
      large bodies).
    - `USER_CANCELED` rejections are silenced — the user dismissing
      the save dialog isn't a failure.
  - **Edit-dialog Download** — each Edit dialog also has a
    "Download" button right of the Edit / Preview toggle, which
    saves the *current editor source* (un-Saved edits included).
    Useful for exporting an experimental edit without committing it
    back to the SW.
- **Prompt textarea** — auto-growing, capped at 200px. `rows="1"`
  initially; on each `input` event we set `style.height = 'auto'`
  then `style.height = scrollHeight + 'px'`. Once `scrollHeight`
  exceeds the cap we flip `overflow-y` from `hidden` to `auto` so
  the scrollbar only appears when needed.
- **Enter-key routing** — the keydown handler reads two stored
  `capturePageDefaults` fields:
  - `promptEnter` (`'send'` | `'newline'`): plain Enter follows this
    radio. Default `'send'`.
  - `defaultButton` (`'capture'` | `'ask'`): when an Enter press
    submits, it clicks whichever button (`#capture` or `#ask-btn`)
    the user picked as default. Default `'capture'`. Same routing is
    used by the SW's `triggerCapture` toolbar-icon hand-off.
  - Shift+Enter always inserts a newline.
  - `\` + Enter (in `promptEnter='send'` mode) consumes the `\`
    immediately to the left of the caret (anywhere in the buffer,
    not just end-of-text) and inserts a newline. Mirrors CLI coding
    agents so the familiar shortcut lands the expected behavior.
    The swap goes through `execCommand('insertText')` so Ctrl+Z
    restores the backslash. Skipped in `'newline'` mode (plain
    Enter is already a newline) and on Ctrl+Enter (always submits).
  - Ctrl+Enter always submits via the chosen default button —
    overrides `promptEnter='newline'` so a user with that setting
    can still send without clicking.
  - The chosen default button also gets a `.is-default` highlight
    ring in the UI so it reads as "primary" before the user focuses
    anything.
- **Smart paste** — Ctrl+V on the prompt or an edit dialog routes
  rich-text content to the right format for the target surface
  (markdown / HTML source / plain text). Ctrl+Shift+V always
  pastes verbatim plain text. See [smart-paste.md](smart-paste.md)
  for the full design.
- **Preview image** — see [fit-to-viewport](#image-fit-to-viewport).

### Image annotation pane

The screenshot preview is layered with an SVG overlay driven by a
modal *tool palette* on the left. Exactly one of four tool buttons
is selected at a time; a left-button drag commits an edit of that
tool's kind. There's no right-click drawing, and no in-place
"convert this rect to a crop / redact" — every drag is a fresh edit.

#### Tool palette

- Bold "Edit image" header (matches the "Prompt:" label's
  weight/size so the two field titles read as siblings) sits above
  the column.
- Buttons stack vertically, all sized to the widest label. The
  column has clusters separated by 14px gaps:
  - Box, Line, Arrow, Crop, Redact (tool selectors).
  - Undo, Clear (edit-stack actions).
  - Copy, Save (image-level actions — Copy puts the *current* PNG
    bytes on the clipboard; Save opens the native save-as dialog).
- Box / Line / Arrow use red icons (rectangle outline, diagonal
  line, diagonal line with arrowhead); the rest use text labels.
  Default selected tool is Box.
- Selected button gets `.selected` (darker face + inset shadow) and
  `aria-pressed="true"`. Tool selection fires on `mousedown` (not
  `click`) so the previously-selected tool deselects the moment the
  user presses a new one — otherwise both old `.selected` and new
  `:active` paint at once.
- Action buttons (Undo / Clear / Copy / Save) are *actions*, not
  modes — they never get `.selected`. They share a `.btn` press-look
  with every other primary button on the page (header Options,
  Capture, Ask, edit-dialog Cancel/Save/Download), so all
  click-feedback uses one shared visual vocabulary.
- Copy / Save disable when the screenshot capture errored — same
  gate as the per-row `.copy-btn` / `#download-screenshot-btn` next
  to the Save-screenshot checkbox above.

#### Drawing tools

- **Box** — drag commits a 3px red stroked rectangle.
- **Line** — drag commits a 3px red diagonal line.
- **Arrow** — drag commits a 3px red line with a barbed arrowhead at
  the click-release end. Barb length is 25% of the segment length,
  capped at 18 CSS px (scaled to natural pixels in the bake-in path).
- **Crop** — drag paints the live cropped preview (dim frame
  outside the drag bounds, dashed border, corner grips) so the user
  sees the final cropped result while dragging. Commits on mouseup
  as a crop region; saved PNG is shrunk to the crop. Multiple crops
  stack; the most-recently-added active crop wins.
- **Redact** — drag paints a filled black rectangle live, matching
  the committed appearance — opaque fill that hides whatever was
  underneath in the saved PNG.

#### Crop-edge handles (drag-to-crop / drag-to-resize)

- The four edges and four corners of the *effective* crop region
  (the active crop if one exists, else the full image) are
  draggable. With no active crop, dragging an image edge inward
  creates a crop from scratch; with an active crop, the handles
  sit on the crop's own edges. The hit-test wins over the selected
  tool, so a drag that starts in the band always becomes a
  crop-handle drag rather than a tool draw.
- Hit-testing is a `HANDLE_PX` band (10 CSS px) around each
  effective edge. Corners beat plain edges. The `cursor` CSS flips
  to the matching resize cursor on hover.
- Small white grip squares mark the four corners of the effective
  crop region — even when no crop exists, so the image's own
  corners show grips and the "drag here to start cropping"
  affordance is discoverable. Grips center on the corner and may
  extend past the image edge; `#overlay` is `overflow: visible`
  so a boundary corner shows the full square.
- Each completed drag commits a **new** `'crop'` edit on the
  stack — not an in-place mutation of the previous one. Undo
  peels back one resize at a time; earlier crops stay in the
  stack hidden behind the newer one and re-emerge as Undo walks
  backward.
- Bounds are clamped on three axes:
  - Inside the image: 0 ≤ x, x+w ≤ 100 (and the same for y).
  - `MIN_CROP_PCT` floor (1.5%) on width and height.
  - Dragged-edge-only: a drag past the opposite edge clamps the
    dragged edge at `MIN_CROP_PCT` away from the opposite one.
    The opposite edge never moves.
  - Why not flip / push? A flipped crop is surprising on a resize
    tool and never useful. Pushing the opposite edge out to
    preserve the minimum used to produce n/w vs. s/e asymmetry,
    so that's avoided too.
- Sub-`CLICK_THRESHOLD_PX` drags are discarded so a stray click
  on a handle doesn't add a no-op entry.

#### Edit stack & geometry

- **Undo / Clear** — single edit-history stack of `add` ops only
  (no convert ops in the new model). Undo removes the
  last-added edit; Clear wipes everything. Both disable when the
  stack is empty.
- **Resize-stable coordinates** — edits are stored as percentages
  of the image dimensions, not CSS pixels, so they stay aligned
  across window resizes and after the prompt grows.
- **Click-vs-drag threshold** — movement under 4 CSS pixels
  between mousedown and mouseup counts as a stray click and is
  discarded, so no tool can produce a degenerate zero-size shape.
- **Tooltips** — every button has a `title` attribute describing
  what it does (e.g. "Drag to add a black redaction box"). Kept
  short so the hover reads at a glance.
- **Crop rendering** — the preview paints a single dim "picture
  frame" around the active crop via an SVG `<path>` with
  `fill-rule="evenodd"` (outer = full image, inner = crop),
  plus a thin dashed white border on the crop edges.
  - **Single path, not four strips.**
    - Four adjacent dim strips partially-cover the pixel row
      straddling the crop's top/bottom edge from *two* rects
      in series instead of one solid fill.
    - Alpha-over-alpha composites brighter than a single fill
      (≈14% brighter at 0.55 alpha), so those shared edges
      showed up as faint guide lines spanning the full image.
    - Vertical edges didn't show the artifact because the
      strip's inner edge borders un-dim content — smooth ramp,
      not a brighter spike.
  - **Dashed border is per-side.**
    - Each crop edge is its own `<line>`; a side flush with
      the image boundary is *omitted*.
    - A dash right at the image edge is cosmetic noise, and
      drawing one there while omitting it on the other axis
      (the case a full-width-but-not-full-height crop
      produces) read as an asymmetric guide line past the crop.
  - Prior crops are hidden by the most recent one.
- **Full-image crop collapses to "no crop".**
  - A crop with bounds `(0, 0, 100, 100)` is treated as no
    crop everywhere: `activeCrop()` returns `undefined`, no
    dim overlay or dashed border, bake-in skipped, and no
    `isCropped` flag on the saved record.
  - The edit stays in the stack so Undo can still walk back
    through it.
  - Fires when the user drags the crop back out to cover the
    entire image (all four sides at the boundary) — the saved
    PNG then matches what they see, an un-marked full-size
    capture.

### Highlight bake-in on save

If the user has any edits *and* is saving the screenshot:

- The page renders the preview image plus the overlay onto a
  `<canvas>`. With no active crop the canvas is the screenshot's
  *natural* resolution; with an active crop the canvas is sized
  to just that crop region (so the saved PNG ships a smaller
  image) and every edit's coordinates are translated into the
  cropped frame.
- Red rectangles and lines stroke at 3px scaled by the
  display→natural ratio so they look the same in the saved PNG
  as during editing.
- Redactions paint as solid black fills that cover whatever was
  underneath — they are the only edit kind that obliterates the
  original pixels in the bake, which is the whole point.
- A clip rectangle matching the canvas size keeps any edit that
  extends past the crop from bleeding onto the saved bytes.
- The resulting `canvas.toDataURL('image/png')` is sent back to
  the background as a `screenshotOverride` field on the
  `saveDetails` runtime message, alongside three per-kind edit
  flags (`highlights`, `hasRedactions`, `isCropped`).
  - `highlights` is `true` iff at least one red rectangle or line
    is on the stack. Redactions and crops are separate edit kinds
    and flip their own flag instead.
  - `hasRedactions` is `true` iff any redaction rectangle is
    baked into the PNG.
  - `isCropped` is `true` iff the saved PNG was cropped to a
    region.
  - The three are independent — any combination can be true at
    once on a single save.
- The background passes `screenshotOverride` through to
  `ensureScreenshotDownloaded` (the same helper the Copy-filename
  buttons use). On a cache miss it becomes the body of the PNG
  download; on a cache hit (the page already pre-downloaded at
  this `editVersion`) it's dropped because the on-disk file already
  matches. `recordDetailedCapture` then writes the sidecar with the
  screenshot artifact carrying whichever of `hasHighlights: true`
  / `hasRedactions: true` / `isCropped: true` are set for this
  save.
- The see-what-i-see skills read `screenshot.hasHighlights === true`
  as the signal to focus on the marked regions.
- If there are no edits, or the screenshot isn't being saved, no
  override is sent and the record's screenshot object stays bare
  (just `filename`, no edit flags).

### Image fit-to-viewport

- The preview image must not produce a vertical scrollbar.
- CSS caps it at `max-width: 100%` of its `.image-box` flex slot
  (the flex row reserves the tool-palette column on the left, so
  the slot is the body width minus the palette's natural width).
- A `fitImage()` function sets `max-height` inline based on the
  remaining viewport height (`window.innerHeight - top - reserved`).
- It re-runs on window resize, after the prompt textarea grows
  (which pushes the image's top down), and after the image loads.
- Resetting `max-height` before measuring is safe: the image's top
  is determined by elements above it, which don't depend on the
  image's own size.

### Tab positioning + return-to-opener

`startCaptureWithDetails` opens the Capture page tab at
`index: active.index + 1` and sets `openerTabId: active.id`, so it
appears immediately to the right of the tab the user captured from.

On close, the `saveDetails` happy path runs `closeCapturePageTab`
with `focusOpener: true`:

1. Removes the session-storage entry.
2. Re-activates the opener tab via `chrome.tabs.update`.
3. Removes the Capture page tab.

The standalone `closeCapturePage` SW handler (fired by Ask's
ctrl-click) runs the same helper with `focusOpener: false`:

- The Ask flow's `sendToAi` already focused the destination
  provider tab — that's where the answer is about to stream in.
- Re-activating the opener here would yank focus back to the
  original screenshot tab and the user would lose sight of the
  result, defeating the "send and watch" gesture. The "ask:
  ctrl-click closes the Capture page and leaves focus on the
  provider tab" e2e test pins this down.

For the saveDetails path the ordering matters and the explicit
re-activation is required:

- **Why not rely on Chrome's natural close behavior?** Chrome
  activates the *right neighbor* of a closed tab, not its opener.
  Setting `openerTabId` does not influence close-time activation.
  The "details: tab opens next to opener and returns focus on
  close" e2e test pins this down.
- **Why activate before remove?** If we removed first, Chrome
  would briefly flash the right neighbor before our update could
  land. Activating first means a single, direct focus jump.
- **Why use a stashed `openerTabId` instead of `chrome.tabs.get`?**
  `Tab.openerTabId` is one of the fields Chrome strips when the
  extension lacks the `tabs` permission, and `<all_urls>` host
  permission doesn't cover our own `chrome-extension://` Capture page
  tab. We stash the opener id in the `DetailsSession` wrapper at
  create time and read it back from there.
- **Best-effort.** If the opener was closed during the Capture page
  flow, `chrome.tabs.update` rejects; we log and proceed with the
  close.

### Chrome-specific gotchas

- **Extension pages have CSP that forbids inline scripts.** The
  default extension CSP does not allow `<script>` blocks inside
  `capture.html`. The controller is a separate file
  (`src/capture-page.ts`, compiled to `dist/capture-page.js`)
  referenced via `<script src="capture-page.js">`.
- **`web_accessible_resources` is not needed.** `capture.html` is
  opened via `chrome.tabs.create({ url: chrome.runtime.getURL(...)})`,
  which is a same-origin navigation within the extension. WAR is
  only required to expose a resource to *non-extension* contexts
  (content scripts in arbitrary pages, `<iframe>` from a web page).
- **Module-level state doesn't survive SW idle-out**, so the
  pre-captured screenshot + HTML are stashed in
  `chrome.storage.session`, keyed by the new tab's id. Session
  storage is in-memory (not written to disk) but survives the
  worker unloading between the menu click and the user clicking
  Capture on the page.
- **Runtime message listeners must return `true` to keep the
  response channel open for an async reply.** `getDetailsData`
  reads from `chrome.storage.session` asynchronously and calls
  `sendResponse` later — the listener must return `true` or Chrome
  drops the channel and the page-side `sendMessage` resolves with
  `undefined`. `saveDetails` always replies (`{ ok: true }` /
  `{ ok: false, error }`), so it returns `true`.
- **Don't race the tab close against the save.** The `saveDetails`
  handler always responds before closing — the `sendResponse({ ok:
  true })` fires first, then `closeCapturePageTab` runs. That ordering
  matters because `chrome.tabs.remove` tears down the message
  channel and a response sent after wouldn't reach the page.
- **Capture-page errors land on the page, not the toolbar.**
  - When the user is on the Capture page and the save fails, the
    SW does NOT call `runWithErrorReporting`. The page has a
    status slot (`#ask-status`) right next to the buttons that
    produced the error, and surfacing the message there is more
    discoverable than swapping the toolbar icon.
  - The toolbar error channel is reserved for paths that have no
    on-screen surface (toolbar click, context menu).
  - Successful saves still call `clearCaptureError()` so a
    previously toolbar-reported failure gets cleaned up by the
    next healthy save.
- **Multi-capture: shift-click preserves the session for re-saves.**
  - Plain / ctrl-click Capture removes the per-tab
    `chrome.storage.session` entry on the way out (the tab is
    closing).
  - Shift-click leaves the entry intact so a second Capture click
    can save again.
  - Each successful save snapshots a per-artifact
    `saved.<x> = { bumpIndex, revision }` on the session; the next
    `ensure*Downloaded` consults it via `nextSaveFilename`:
    - **Same revision** → reuse the locked filename
      (`bumpedFilename(bases.<x>, saved.bumpIndex)`). No re-download;
      the new log record references the existing file. Optimizes
      multi-prompt flows where the user iterates the prompt without
      re-editing the artifact.
    - **Diverged revision** (user edited via Edit dialog or drew on
      the screenshot) → bump `bumpIndex + 1`. The previous file stays
      immutable on disk; the new log record points at the freshly-
      written file. Filenames look like `selection-2026.md` →
      `selection-2026-1.md` → `selection-2026-2.md`.
  - The "base" filename is pinned in `session.bases.<x>` at session
    creation. Computing every bumped filename from the *base* (not
    from the previously-bumped name) keeps the suffix logic robust
    against the timestamp's millisecond portion, which already
    looks like a `-N` counter.
  - Caveat: reloading the Capture page mid-session is not a
    supported workflow. The page-side `editVersion` resets to 0
    on reload while the SW-side `saved.<x>` lock survives, so a
    save after reload would falsely diverge the screenshot
    revision and bump a fresh `-N` against bytes the user never
    edited. Sessions are intended to live across multiple
    captures via shift-click; reloads should be rare.
- **Manual tab close cleanup.** If the user closes the Capture page
  tab without clicking Capture, a `chrome.tabs.onRemoved` handler
  drops the stashed capture from `chrome.storage.session`. Without
  this, session storage would grow until the browser restarts.
- **Stale-page guard for direct loads.** Opening `capture.html`
  without a session-storage entry (old bookmark, history entry,
  browser-restart tab restore) causes `getDetailsData` to resolve
  `undefined`. The page handles this in `loadData`:
  - Hides every `[data-capture-main]` block (capture-card,
    controls, hr, image-and-highlights).
  - Reveals the `#missing-session-error` pane with a one-liner
    pointing the user back to the toolbar icon.
  - The header (Options button) stays visible as an escape hatch.
  - `[data-capture-main][hidden] { display: none !important }` is
    required because the per-block `display: flex` / `display:
    block` rules tie the UA `[hidden]` rule on specificity and win
    on source order, so plain `el.hidden = true` wouldn't take.

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
  focused window. `SeeWhatISee.captureVisible(2000)` is the working
  pattern: start the delayed capture, click into the real window,
  wait for the capture. Any `delayMs` is fine — pick a longer one
  if 2s doesn't give you enough time to switch windows.
- The SW devtools console is also the fastest way to exercise:
  - `savePageContents()` — grab the current tab's HTML.
  - `clearCaptureLog()` — wipe the storage log.
  - `reportCaptureError(new Error("…"))` / `clearCaptureError()` —
    test the error surface without having to trigger a real failure.
