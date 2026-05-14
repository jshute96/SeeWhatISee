# Chrome extension — implementation notes

Companion to [`architecture.md`](architecture.md).

That doc describes *what* the extension is and *how* the
components fit together. This one captures the Chrome-specific
hazards and surprises we hit building it — and the workarounds we
landed on.

## Manifest V3 service worker lifecycle

The background script is an MV3 service worker. That means:

- **It idles out aggressively.**
  - Chrome unloads the worker after ~30s of inactivity.
  - Listeners persist across the idle — Chrome re-wakes the
    worker on the next event — but module-level state is lost.
  - The authoritative capture log therefore lives in
    `chrome.storage.local`, not in a module-level array.
- **`await` keeps it alive.** Inside a listener, awaiting a
  promise (including an `await new Promise(r => setTimeout(r, ms))`)
  holds the worker awake for the duration.
  - This is what makes "Save screenshot in 3s" work: the handler
    sleeps on an awaited timer and Chrome doesn't reclaim the
    worker until the handler returns.
  - Don't `setTimeout(() => captureVisible(), 3000)` without
    awaiting — the timer fires in a dead worker.
- **`chrome.downloads.download` resolves on download *start*, not
  completion.**
  - For our tiny data-URL payloads (PNG + JSON sidecar) this is
    effectively immediate.
  - If we ever see partial files or interleaving in `log.json`,
    the fix is to wait on `chrome.downloads.onChanged` for
    `state === 'complete'` before returning. Marked "overkill for
    v1" inside `saveCapture`.
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
     which catches the rejection and surfaces it on the icon +
     tooltip.
  2. A targeted `unhandledrejection` handler installed by
     `background/error-reporting.ts` catches the user-friendly
     messages (`No active tab found to capture`, `Failed to
     retrieve page contents`) from bare
     `self.SeeWhatISee.captureVisible()` calls in the SW devtools
     console — that path doesn't go through
     `runWithErrorReporting`. The allowlist is deliberately
     narrow so real bugs still surface.

## Permissions: what we ended up with and why

The manifest declares:

- `activeTab` — granted by a real user gesture (toolbar click).
  The only thing that lets `captureVisibleTab` work on restricted
  URLs like `chrome://` pages.
- `<all_urls>` host permission — covers normal http(s) pages for
  the Playwright path, which bypasses the toolbar gesture and
  can't trigger `activeTab`.
- `contextMenus` — required even for menus scoped to
  `contexts: ['action']`. The scope argument tells Chrome *where*
  to show the menu; it doesn't exempt you from the permission
  gate on `chrome.contextMenus.create`.
- `downloads` — the only way an MV3 service worker can drop files
  onto the local filesystem without a native messaging host.
- `scripting` — for `chrome.scripting.executeScript`, which is
  how we pull `document.documentElement.outerHTML` for HTML
  snapshots.
- `storage` — the authoritative home of the capture log.

### Why not `tabs`

- `chrome.tabs.query` works without it.
- With `<all_urls>` host permission, `tab.url` is also exposed
  on http(s) pages.
- For restricted schemes like `chrome://`, `tab.url` comes back
  undefined regardless — adding `tabs` wouldn't change that.
- Dropping the unneeded permission also keeps the Chrome Web
  Store reviewer's job simpler.

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

- The "Save screenshot in 3s" path `await`s a timer, then
  re-queries the active tab. If the user switches to a different
  tab during the delay, the captured tab won't be covered by
  `activeTab` anymore — it has to fall back to the host
  permission.
- Normal http(s) pages are fine because `<all_urls>` covers them.
- A delayed capture that lands on a *different* `chrome://` tab
  than the gesture originated from will fail: `<all_urls>`
  doesn't cover `chrome://`, and the `activeTab` grant doesn't
  follow the user to a new restricted tab.

### Gotcha: the Chrome Web Store blocks `captureVisibleTab`

Even with `activeTab` granted, Chrome refuses to let an extension
screenshot the CWS page itself. That's a Chrome policy limit, not
something the manifest can fix — just something to warn users
about.

### Ask flow uses dynamic injection (no `content_scripts`)

The Ask button on the Capture page sends artifacts to a
third-party AI tab (claude.ai, gemini.google.com, chatgpt.com, or
google.com). Two design choices fall out of the permissions we
already have:

- **No `content_scripts` declaration.** The manifest does not
  list AI-site URLs — `chrome.scripting.executeScript` covers it
  on demand, so the extension runs zero code on AI sites until
  the user actually clicks Ask.
- **MAIN world execution.** `src/ask-inject.ts` is loaded with
  `world: 'MAIN'` so it can dispatch `change` / `input` /
  `beforeinput` events that the AI site's composer actually
  listens to (Claude and ChatGPT use ProseMirror, Gemini uses
  Quill — all ignore `.value =` writes and only respond to real
  input pipeline events). An isolated-world script fires events
  into a separate JS realm and the page never sees them.
- `executeScript({ files: ['ask-inject.js'] })` installs the
  IIFE's postMessage bridge listener.
- The ISOLATED-world widget then drives one operation at a time
  (`attachFile`, `typePrompt`, `clickSubmit`) over that bridge.
- Keeping `ask-inject.ts` as a classic script (no `import`/`export`)
  lets retries land in the same MAIN-world realm without
  re-loading the bundle.

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
`unhandledrejection`s from the devtools-console path leaked onto
it.

### Options we considered

- **`chrome.notifications`** — native OS toast. Requires extra
  permission, mandatory "Notification settings" button, mostly
  duplicates what a tooltip / page can convey.
- **`chrome.action.setBadgeText`** — colored pill on the icon.
  Fixed-size pill, no API to shrink, ridiculous fraction of a 16px
  icon. (Used today only for the countdown timer in
  `countdownSleep`, where its size is a feature.)
- **Toolbar icon swap + tooltip text** (the previous design):
  flipped the action icon to a red-`!` variant and slotted
  `ERROR: <msg>` under the app title in the tooltip. Worked, but
  the icon-flip was easy to miss, and the tooltip text wasn't
  selectable so reporting an error to the dev required the same
  console-digging we were trying to avoid.

### What we picked

One channel: **a dedicated Capture-page error tab.**

- **`runWithErrorReporting(fn)`** wraps every user-initiated
  click (action click, hotkey, all context-menu entries). On a
  rejection it opens `capture.html?error=<friendly message>` next
  to the active source tab. The page renders its
  `#capture-failed-error` pane (in `capture.html`, controlled by
  `capture-page.ts`) with the message inline.
- **`friendlyErrorMessage(err)`** rewrites the common throw-site
  strings (`No active tab found to capture`, `Failed to retrieve
  page contents`, the `noSelectionContentMessage` family,
  `Cannot access contents of the page`, …) into action-oriented
  text. Anything unrecognised falls through verbatim.
- **`reportCaptureError(err, opener?)`** is the public entry —
  `runWithErrorReporting` calls it on rejection, and the
  session-storage-quota path inside `openCapturePageWithSession`
  also lands users on the same page (just routed through the
  capture-details flow rather than the wrapper).
- A successful run is a no-op — there's no persistent icon flip
  or tooltip text to clean up anymore.

Why one full-page surface beats the icon+tooltip duo:

- Visible: the user lands on a real tab and reads a real
  paragraph; they don't have to notice a small red `!`.
- Copy-pasteable: the message is selectable HTML text; reporting
  a bug doesn't require devtools.
- Anchored: tab placement (`opener.index + 1`) keeps the error
  visually next to whatever the user just acted on, the same way
  a successful Capture page lands.

## Countdown badge for delayed captures

When a delayed capture starts (3s today), a `countdownSleep`
helper in `capture.ts` shows a countdown on the toolbar badge via
`chrome.action.setBadgeText`: "3", "2", "1". The badge clears
when the timer finishes and the capture fires.

### Implementation details

- **Orange background** (`#FF8C00`) — set once before the
  countdown loop starts. The large badge pill that made
  `setBadgeText` unsuitable for the error surface works in the
  countdown's favor: the number is easy to read at a glance.
- **250ms polling interval** — a `setInterval` checks
  `Date.now()` against the target end time and updates the
  displayed number via `Math.ceil`. The 250ms tick means the
  badge updates within a quarter-second of each real second
  boundary.
- **Non-async interval callback** — the `setInterval` callback
  is deliberately synchronous, chaining `.then` / `.catch` on the
  Chrome API promises. An `async` callback would produce
  unhandled promise rejections invisible to the outer `Promise`
  (since `setInterval` ignores the return value). On failure,
  the interval is cleared and the outer promise is rejected so
  the capture surfaces the error through `runWithErrorReporting`.
- **Shared across all three capture paths** — `captureVisible`,
  `savePageContents`, and `captureBothToMemory` all call
  `countdownSleep(delayMs)` when `delayMs > 0`.

## Toolbar tooltip (`chrome.action.setTitle`)

### Scope: global, not per-tab

`chrome.action.setTitle({ title })` (without `tabId`) sets a
**single global tooltip** shared across all browser windows.
There is no per-window variant.

`setTitle({ tabId, title })` creates a tab-scoped override that
Chrome is *supposed* to show when that tab is active, falling
back to the global title on other tabs. In practice we found
this **unreliable**: `getTitle({ tabId })` confirmed the override
was stored, but the tooltip Chrome actually rendered on hover
still showed the global title. We don't use per-tab titles.

### Our tooltip strategy

- **Default tooltip.** `refreshActionTooltip()` calls
  `getDefaultActionTooltip()`, which snapshots the four stored
  defaults + `capturePageDefaults` + the bound shortcuts and
  feeds them into `buildTooltip` (in `src/background/tooltip.ts`
  — pure logic, unit-tested). Runs on preference change,
  `onInstalled`, and `onStartup`.
- **Layout.** Header (`SeeWhatISee`) + optional `ERROR: …` block
  + a Click row + a Double-click row + trailing blank. Each row
  is one line: the no-sel and with-sel fragments collapse via
  `combineFragments` (equal → that fragment; both
  `Save <single-word>` → `Save X or Y`; otherwise `...`). Full
  algorithm in
  [`docs/options-and-settings.md`](options-and-settings.md#toolbar-tooltip).
- **Hotkeys folded in.** `_execute_action` and
  `secondary-action` shortcuts (when bound) trail the row's
  fragment as `  [<key>]`. The same hotkey fires both branches
  of the row, so it never carries a +sel/-sel scope qualifier.
- **No tooltip-side error surface.** `reportCaptureError()` does
  not modify the toolbar tooltip — failures open a Capture-page
  error tab instead. See the error-reporting section above for
  the rationale.

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
  listener to restore the default tooltip on tab switch.
  Problems:
  - Fired on *every* tab switch, not just away from capture
    tabs.
  - Erased "ERROR:" tooltip messages.
  - Didn't survive switching away and back to the capture tab.

If revisited, the delayed-set-from-page approach was the most
promising — the main issue was the `onActivated` restore logic.

## Context menus on the toolbar action

For the menu structure (which entries appear where), see
[`capture-actions.md`](capture-actions.md). This section covers
the Chrome-platform mechanics of building it.

- **Permission required.** `contextMenus` is required even for
  `contexts: ['action']`. See the permissions section.
- **Registration on `onInstalled`.** Menus are created with
  `contexts: ['action']`. Chrome persists the entries across
  service-worker restarts, so we don't recreate them on every
  wake.
- **Install / update / chrome_update all fire `onInstalled`.**
  Calling `chrome.contextMenus.create` with an id that already
  exists throws "Cannot create item with duplicate id." We call
  `removeAll` first, then recreate — handles all three paths
  identically.
  - **Install path is serialized.** `onInstalled` can fire more
    than once in quick succession (rapid dev reloads, or
    install + chrome_update arriving back-to-back). Because
    `installContextMenu` is async, two listener invocations
    could otherwise interleave and both reach `create` with the
    same ids. We chain each run onto an `activeInstall` promise
    so a second event waits for the first to finish before
    its own `removeAll` + recreate.
- **Separators.** `chrome.contextMenus.create` accepts
  `type: 'separator'`, but separator items must *not* include a
  `title` field at all (passing `title: undefined` still throws).
  At the top level of the action menu, separators count against
  the 6-item cap, so we don't use any there. Inside the "More"
  submenu they're free, and we use them to split the capture
  shortcuts into clusters (`save-defaults` | the non-selection
  capture shortcuts | the delayed-shortcut block | the three
  `save-selection-*` shortcuts) and then fence off the
  copy-last, snapshots-dir, and clear-log utility rows.
  - **ChromeOS workaround.** ChromeOS sometimes fails to render
    native `type: 'separator'` items in the extension action
    menu. `installContextMenu` in `background/context-menu.ts`
    detects the platform via `chrome.runtime.getPlatformInfo()`
    and falls back to a disabled normal item titled with a
    fixed-length run of U+2500 box-drawing chars (`────…`) on
    ChromeOS to preserve visual grouping.
    - **A11y trade-off.** `chrome.contextMenus` has no API to
      mark an item non-focusable or aria-hidden, so the fake
      separator is still reachable via keyboard navigation and
      screen readers announce it as a dimmed row of dashes.
      Native separators skip focus. We accept this because the
      native path is already broken on ChromeOS — invisible
      grouping is worse than a focusable dash row.
- **No per-item tooltip.** There's no `description` or similar
  field on a menu entry. The `title` is the only user-visible
  text. If you want a tooltip, put the extra context in a source
  comment and keep the title short.
- **Radio items.** `type: 'radio'` items render with a radio
  indicator.
  - A *contiguous* run of radio items with the same `parentId`
    forms a mutually exclusive group; Chrome auto-flips the
    selection on click.
  - **Separators break the group.** Inserting a separator
    between two same-parent radios splits them into two
    *independent* mutual-exclusion groups, so the user can end
    up with one item checked in each. (Historically why the
    retired Set-default-click submenu used `✓ ` title prefixes
    on normal items rather than radio items — its sections were
    separated.)
- **Click / double-click hints on run entries.** Top-level
  entries and More-submenu run entries append a `  -  (...)`
  hint that summarises what triggers the action.
  - No real italics — menu titles are plain text. Italics are
    faked with Unicode mathematical sans-serif italic letters,
    so the hint reads `(𝘊𝘭𝘪𝘤𝘬)`.
  - No right-alignment — `chrome.contextMenus` has no
    accelerator / secondary-label slot, and space-padding only
    approximates a column on one machine (menu rendering uses
    the platform UI font, so widths drift across OSes). An
    inline dash separator reads as intentional on every
    platform.
  - Two scope-aware groups + one full-scope group:
    - **Click group.** Rendered when the action is the click
      no-sel default, the click with-sel default, or both. The
      activate (`_execute_action`) hotkey, when bound, is
      grouped *with* the italic word via ` or ` — both fire
      the same dispatch — and a single +/-sel scope suffix
      applies to the whole group:
      - `𝘊𝘭𝘪𝘤𝘬` — both branches route to this action.
      - `𝘊𝘭𝘪𝘤𝘬 w/o sel` — only the no-sel branch.
      - `𝘊𝘭𝘪𝘤𝘬 w/ sel` — only the with-sel branch.
      With `_execute_action` bound the group reads
      `𝘊𝘭𝘪𝘤𝘬 or Ctrl+Shift+X` (and any scope suffix at the
      end). `IGNORE_SELECTION_ID` on the with-sel slot is
      treated as fall-through to the no-sel default, so an
      action that's the click no-sel default with
      `ignore-selection` on the with-sel slot reports `both`.
    - **Double-click group.** Same shape, with `𝘋𝘰𝘶𝘣𝘭𝘦-𝘤𝘭𝘪𝘤𝘬`
      and `secondary-action` instead.
    - **Action-specific hotkey.** The action's own bound
      shortcut (e.g. `12-save-screenshot` mapped to a key) is
      always full-scope — it triggers this action regardless of
      page selection state. Appears as a bare group at the end:
      `(𝘊𝘭𝘪𝘤𝘬 or Ctrl+Shift+X, Alt+S)`.
  - Setting any of the four click / dbl defaults refreshes every
    menu row's hint via `refreshMenusAndTooltip`. Shortcut binding
    edits made at `chrome://extensions/shortcuts` propagate via
    `refreshMenusIfHotkeysChanged` on the next user interaction
    or Options-page open.
- **Submenus via `parentId`.** Any item created with a
  `parentId` becomes a child of the named parent, which Chrome
  then renders with a ▸ indicator automatically. No explicit
  "submenu" type.
- **Persisted state doesn't survive `removeAll`.** The install
  handler wipes the menu on every install / update /
  chrome_update, so any initial state derived from storage (e.g.
  the click / double-click hints on the run-entry titles) has to
  be re-read from `chrome.storage.local` and passed back into
  the `create()` calls on every recreate.
- **Top-level item limit.** Chrome caps each extension at
  `chrome.contextMenus.ACTION_MENU_TOP_LEVEL_LIMIT = 6`
  top-level items per context. The constant is read-only — it's
  reporting a hard limit baked into Chrome, not a setting.
  - **Separators count.** A `type: 'separator'` entry takes one
    of the six slots. That's why the action menu has none;
    spending a slot on a divider would cost us a real entry.
  - **Overflow fails silently.** When you exceed the cap,
    `chrome.contextMenus.create()` sets
    `chrome.runtime.lastError` to *"You cannot add more than 6
    …"* on the offending call and the item simply doesn't
    register. Because the loop in `background/context-menu.ts`
    doesn't pass a `create()` callback, we never read
    `lastError` and the failure is invisible until someone
    notices the menu entry is gone. This has already bitten us
    once: commit 8e100d1 added "Capture with details..." as a
    7th entry, which silently dropped "Clear log history" off
    the menu until the regression was spotted later. Keep the
    top level at 6 or below, or move entries into a submenu.

## Image right-click context menu

Image-context entries (currently `Capture... (this image)` and
`Save screenshot (this image)`) live in `contexts: ['image']` and
surface in the page context menu when the user right-clicks any
`<img>`-like element.
Distinct from the toolbar `action` menu above — different context
root, different click info shape (`info.srcUrl` is set), and not
subject to the 6-item top-level cap (that limit applies only to
`contexts: ['action']`).

For the user-facing routing of these entries, see
[`capture-actions.md` → Image right-click menu](capture-actions.md#image-right-click-menu).
This section covers the Chrome-platform plumbing.

- **Auto-grouping.** Chrome bundles all top-level page-context
  entries from a single extension under a parent submenu labeled
  with the extension name. We don't create that parent ourselves
  — registering two siblings produces "SeeWhatISee ▸ Capture...
  (this image) / Save screenshot (this image)".
- **Click info.** `chrome.contextMenus.onClicked` delivers
  `info.srcUrl` (image URL) and `tab` (the page the image lives
  on). The image URL is typically `http(s):`, `data:`, or
  `blob:`; the page-side fetch path described below resolves
  all three from the source page's context. Cross-origin images
  without permissive CORS may still fail — the failure surfaces
  as a `capture.html?error=…` tab via `runWithErrorReporting`.

### Image bytes via page-side fetch

Both entries call `fetchImageInPage(tabId, srcUrl)` which runs a
one-shot `executeScript` in the page's isolated world. Two
strategies, in order:

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
- **Limitation.** The canvas fallback requires an `<img>`
  element matching `srcUrl`. CSS `background-image` URLs are not
  supported — Chrome's `contexts: ['image']` doesn't fire on
  those anyway.

### Filename extension

`imageExtensionFor(mime, srcUrl)` picks an extension via a
three-step ladder:

- Known MIMEs hit the static table (`png` / `jpg` / `webp` /
  `gif` / `svg` / `avif` / `bmp` / `ico`).
- Off-table MIMEs fall through to the URL pathname extension
  (e.g. `/photo.heic` → `heic`). Useful when servers send
  `application/octet-stream`.
- Final fallback is `unknown` (never `.png` — misnaming bytes is
  the bug we're avoiding).
- Filename is `screenshot-<ts>.<ext>` so the bytes stay honest.

### Bake-in keeps the source format sticky

The Capture-page bake (`renderHighlightedImage`) emits the same
encoding the user dropped in for JPEG, and PNG for everything else.

- JPG source → bake re-encodes as JPEG (`toDataURL('image/jpeg', q)`).
- PNG source → bake emits PNG.
- WEBP / GIF / AVIF / … → bake emits PNG (canvas re-encode is lossy
  anyway, and PNG keeps the markup crisp).

`ensureScreenshotDownloaded` rewrites the filename's extension to
match the override's MIME prefix (via `extFromDataUrl`) before
writing, and reverts to `screenshotOriginalExt` when the user undoes
back to clean. The clipboard "copy image" path always forces PNG
(see `renderHighlightedImage('image/png')`) because that's the only
image MIME `ClipboardItem` accepts reliably.

### Capture-time PNG → JPEG recompress for large screenshots

`chrome.tabs.captureVisibleTab` only emits PNG, which inflates
quickly on photo-heavy pages.

Right after the capture, `maybeRecompressLargeScreenshot` (in
`capture.ts`) checks the PNG size and, when over the threshold,
tries a JPEG re-encode via `OffscreenCanvas`. The JPEG wins only
if it's at least 10% smaller than the PNG — for plain UI / text
screenshots PNG often beats JPEG, and we don't want to trade
fidelity for a marginal saving.

- Default threshold: 2 MiB of binary PNG bytes
  (`LARGE_SCREENSHOT_PNG_THRESHOLD_BYTES_DEFAULT`). Compared
  against `Blob.size` after decoding the capture's `data:` URL,
  not the base64-inflated URL length.
- JPEG quality: 0.92 (matches `JPEG_BAKE_QUALITY` in capture-page.ts).
- Savings floor: ≥10% smaller, else keep the PNG.
- Both sizes are logged whenever the JPEG encode runs (`PNG x →
  JPG y — using JPG / kept PNG`) so the constants can be tuned
  from real captures. Under-threshold captures are silent.
- Failure modes (no `OffscreenCanvas`, decode error, encode error)
  fall back to the PNG with a `console.warn`.
- Applies to both `captureVisible` (quick-save) and
  `captureBothToMemory` (Capture-page flow). The image-context
  right-click flow already starts from a non-PNG source and is
  governed by sticky-format only.
- Once the recompress promotes a capture to JPEG, the rest of the
  pipeline carries `.jpg` through — sticky-format keeps it stable
  through subsequent edits.

`_setLargeScreenshotThresholdForTest(bytes | null)` is exposed on
`self.SeeWhatISee` so e2e can exercise both branches without
producing an actual 2 MB capture (see
`tests/e2e/large-screenshot-recompress.spec.ts`).

### Routing summary

- `IMAGE_CAPTURE_MENU_ID` →
  `startCaptureWithDetailsFromImage(tab, srcUrl)`. Builds the
  `InMemoryCapture` with the image bytes as `screenshotDataUrl`,
  skips the page HTML scrape, still scrapes selection. Opens
  `capture.html` next to the source tab. Session carries
  `htmlUnavailable: true` and `imageUrl: srcUrl` so the page can
  quiet-disable Save HTML and the SW can record the source URL.
- `IMAGE_SAVE_SCREENSHOT_MENU_ID` →
  `captureImageAsScreenshot(tab, srcUrl)`. Writes the bytes via
  `saveCapture(..., ext, srcUrl)` and appends a `screenshot` +
  `imageUrl` record to `log.json`. No Capture page round-trip;
  no HTML scrape.

### `imageUrl` on the record

Top-level `CaptureRecord` field, emitted by `serializeRecord`
last in the JSON object — after `url` and `title`. Keeps the
per-record metadata block (page URL, page title, source image
URL) visually grouped at the end.

- Independent of `screenshot`: `recordDetailedCapture` forwards
  `capture.imageUrl` even when `includeScreenshot: false`.
- Intent is "remember which image the user picked" — shouldn't
  get dropped just because they unchecked Save Screenshot before
  clicking Capture.

### Image-flow defaults

`imageFlowDefaults(user)` in `capture-details.ts` synthesizes a
`CaptureDetailsDefaults` for image sessions.

- Save Screenshot ✓, Save HTML false, Save Selection ✓ (when
  present).
- Inherits the user's selection `format` plus `defaultButton` /
  `promptEnter` so the page's highlight ring and Enter behavior
  don't change.
- The user's stored `capturePageDefaults` is **not** mutated;
  only the wire response is overridden.

### Error reporting

Both routes are wrapped in `runWithErrorReporting` so a fetch
failure (CORS-blocked image, 404, restricted-URL scrape) opens a
`capture.html?error=…` tab the same way other capture failures
do.

## Options page (`options.html`)

Bundled second extension page reached via right-click → Options
on the toolbar action. Owns the only UI for editing the four
toolbar defaults and the Capture-page Save defaults. See
[options-and-settings.md](options-and-settings.md) for the
layout, wire, and the storage shape it edits.

## Capture page (`capture.html`)

The Capture page is a bundled extension page opened in a new tab
that previews a pre-captured screenshot, lets the user pick which
artifacts to save, and (optionally) annotate the screenshot
before save.

Full design — pre-capture flow, page contents, image annotation,
edit dialogs, copy-filename buttons, save and close, multi-capture
filename strategy — lives in [`capture-page.md`](capture-page.md),
including the Chrome-platform hazards specific to that page (CSP,
runtime-message channel close, stale-page guard, manual
tab-close cleanup).
