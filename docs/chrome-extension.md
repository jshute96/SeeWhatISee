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
  - This is what makes "Take screenshot in 2s" work: the handler
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

- The "Take screenshot in 2s" path `await`s a timer, then
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
- **`chrome.action.setTitle`** appends `Last error: <message>` as
  an extra line on the toolbar tooltip so a user can hover the icon
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

- **Default tooltip.** `refreshActionTooltip()` reads the current
  default click action's `tooltip` field and calls `setTitle`.
  Runs on preference change, `onInstalled`, and `onStartup`.
- **Double-click hint.** Every action's tooltip includes a second
  line (via embedded `\n`) describing the double-click alternate
  action.
- **Error tooltip.** `reportCaptureError()` appends a
  `Last error: <message>` line. See the error-reporting
  section above.

### Abandoned: capture-page tooltip override

Goal: show "SeeWhatISee — Capture" when the capture page is
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
  - Erased "Last error:" tooltip messages.
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
  delay and "Set default click action" by delay.
  - **ChromeOS workaround.** ChromeOS sometimes fails to render
    native `type: 'separator'` items in the extension action menu.
    `installContextMenu` in `background.ts` detects the platform
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
    checked in each.
  - The "Set default click action" submenu avoids radio items for
    this reason — it uses normal items with a `✓ ` title prefix
    on the selected entry, updated by `setDefaultClickActionId`.
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
  - The "Set default click action" submenu is unchanged — its ✓
    already covers "this is the click action", and stacking another
    `(Click)` on the same row is noise.
  - Hints are refreshed by `setDefaultClickActionId` alongside the ✓
    prefix updates, so the menu stays in sync with the stored
    preference.
- **Submenus via `parentId`.** Any item created with a `parentId`
  becomes a child of the named parent, which Chrome then renders
  with a ▸ indicator automatically. No explicit "submenu" type.
- **Persisted state doesn't survive `removeAll`.** The install
  handler wipes the menu on every install / update / chrome_update,
  so initial `checked` values have to be re-read from
  `chrome.storage.local` and passed back to `create({checked})` on
  every recreate. The "Set default click action" submenu does this for
  its current selection.
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
    `background.ts` doesn't pass a `create()` callback, we never
    read `lastError` and the failure is invisible until someone
    notices the menu entry is gone. This has already bitten us
    once: commit 8e100d1 added "Capture with details..." as a 7th
    entry, which silently dropped "Clear log history" off the
    menu until the regression was spotted later. Keep the top
    level at 6 or below, or move entries into a submenu.
  - Our action menu currently has 6 top-level entries — three
    undelayed primary-group capture actions, the "Capture with
    delay" submenu parent, the "Set default click action" submenu
    parent, and the "More" submenu parent (which hosts the two
    more-group capture actions "Capture URL" and "Capture screenshot
    and HTML", plus "Copy last screenshot filename", "Copy last HTML
    filename", "Snapshots directory", and "Clear log history"). This
    is **at the cap** — any further top-level addition will drop an
    existing entry. Nest new utilities under "More" (or add new
    capture actions with `group: 'more'` so they land there
    automatically).

## "Capture with details…" — extension page + runtime messaging

The details flow opens a bundled extension page (`capture.html`)
in a new tab, previews the pre-captured screenshot, and waits for
the user to pick which artifacts to save before writing anything.

This section is split by topic:

- [Page contents](#page-contents)
- [Image annotation pane](#image-annotation-pane)
- [Highlight bake-in on save](#highlight-bake-in-on-save)
- [Image fit-to-viewport](#image-fit-to-viewport)
- [Tab positioning + return-to-opener](#tab-positioning--return-to-opener)
- [Chrome-specific gotchas](#chrome-specific-gotchas)

### Page contents

- **Captured URL** — read-only single-line input (monospace,
  horizontal scroll for long URLs).
- **HTML byte size** — `new Blob([html]).size`, formatted as
  `B` / `KB` / `MB` / `GB` / `TB` so the user can sanity-check
  before saving.
- **Save checkboxes** — pick screenshot, HTML, both, or neither.
  Capture stays enabled even with neither ticked; a neither-save
  still writes a log record with just the URL (and any prompt),
  so the user can hand an agent a URL + prompt without attaching
  any captured page content.
- **Prompt textarea** — auto-growing, capped at 200px. `rows="1"`
  initially; on each `input` event we set `style.height = 'auto'`
  then `style.height = scrollHeight + 'px'`. Once `scrollHeight`
  exceeds the cap we flip `overflow-y` from `hidden` to `auto` so
  the scrollbar only appears when needed. Plain Enter submits;
  Shift+Enter inserts a newline.
- **Preview image** — see [fit-to-viewport](#image-fit-to-viewport).

### Image annotation pane

The screenshot preview is layered with an SVG overlay that lets
the user draw red markup on the regions they want the agent to
focus on, convert drawn rectangles into opaque redactions, and
convert a drawn rectangle into the active crop region.

- **Left-click-drag** — draws a 3px-bordered red rectangle.
- **Right-click-drag** — draws a 3px red line. The browser
  context menu is suppressed on the overlay.
- **Redact button** — converts the most recent unconverted red
  rectangle into an opaque black box in the preview and the
  saved PNG. Enabled whenever any unconverted red rectangle
  exists; each click consumes one, walking back through the
  stack on repeated clicks.
- **Crop button** — converts the top-of-stack red rectangle into
  the active crop region. Everything outside the region dims in
  the preview; on save the canvas is cropped to just that region.
  Disabled unless the top of the stack is currently an
  un-converted red rectangle, so a crop always applies to the box
  the user just drew (rather than silently reaching further back).
- **Drag-to-crop / resize-crop.** The four edges and four corners
  of the effective crop rectangle are draggable handles. With no
  active crop, the effective rectangle is the whole image — so
  dragging an image edge inward creates a crop from scratch. With
  an active crop, the handles sit on the crop's own edges.
  - Hit-testing is a `HANDLE_PX` band (10 CSS px) around each
    edge. Corners take precedence over plain edges; the `cursor`
    CSS flips to `ns-resize` / `ew-resize` / `nwse-resize` /
    `nesw-resize` on hover so the affordance is discoverable
    without reading the tooltip.
  - Small white grip squares at the four corners make the handles
    visible even before the user hovers — otherwise the hit
    regions are invisible.
  - Each completed drag commits a **new** `'crop'` edit on the
    stack, not an in-place mutation of the previous one. Undo
    peels back one resize at a time; earlier crops stay in the
    stack (hidden behind the newer one for rendering) and
    re-emerge as Undo walks backward.
  - The proposed bounds are clamped on three axes:
    - Inside the image: 0 ≤ x, x+w ≤ 100 (and the same for y).
    - `MIN_CROP_PCT` floor (3%) on width and height.
    - Dragged-edge-only: a drag past the opposite edge clamps
      the dragged edge at `MIN_CROP_PCT` away from the opposite
      one. The opposite edge never moves.
    - Why not flip / push? A flipped crop is surprising on a
      resize tool and never useful. Pushing the opposite edge
      out to preserve the minimum used to produce n/w vs. s/e
      asymmetry, so that's avoided too.
  - A sub-`CLICK_THRESHOLD_PX` drag is discarded, so a stray
    click on a handle doesn't add a no-op entry to the stack.
- **Undo / Clear** — single edit-history stack covering draws
  *and* conversions. Undo reverses the most recent action, which
  means popping a conversion restores the red rectangle it came
  from. Both buttons disable when the stack is empty.
- **Resize-stable coordinates** — edits are stored as percentages
  of the image dimensions, not CSS pixels, so they stay aligned
  across window resizes and after the prompt grows.
- **Click-vs-drag threshold** — movement under 4 CSS pixels
  between mousedown and mouseup counts as a stray click and is
  discarded, so neither button can produce a degenerate
  zero-size rectangle or zero-length line.
- **Tooltips** — every button has a `title` attribute describing
  what it does (e.g. "Turn the last drawn box into a black
  redaction"). Kept short so the hover reads at a glance; the
  disabled-state rationale is conveyed by the button itself being
  grayed out, not spelled out in the tooltip.
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
  - `highlights` is `true` iff at least one *un-converted* red
    rectangle or line survives on the stack. A rectangle the
    user converted to a redaction / crop no longer counts as a
    highlight — the bake turned it into something else, so it
    flips the other flag instead.
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
- CSS caps it at `max-width: calc((100vw - 48px) * 0.9 - 2px)`
  (90% of body content width minus the 1px wrap border each side).
- A `fitImage()` function sets `max-height` inline based on the
  remaining viewport height (`window.innerHeight - top - reserved`).
- It re-runs on window resize, after the prompt textarea grows
  (which pushes the image's top down), and after the image loads.
- Resetting `max-height` before measuring is safe: the image's top
  is determined by elements above it, which don't depend on the
  image's own size.

### Tab positioning + return-to-opener

`startCaptureWithDetails` opens the details tab at
`index: active.index + 1` and sets `openerTabId: active.id`, so it
appears immediately to the right of the tab the user captured from.

On close, the `saveDetails` finally block:

1. Removes the session-storage entry.
2. Re-activates the opener tab via `chrome.tabs.update`.
3. Removes the details tab.

The ordering matters and the explicit re-activation is required:

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
  permission doesn't cover our own `chrome-extension://` details
  tab. We stash the opener id in the `DetailsSession` wrapper at
  create time and read it back from there.
- **Best-effort.** If the opener was closed during the details
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
  `undefined`. `saveDetails` doesn't reply, so it returns `false`.
- **Don't race the tab close against the save.** The `saveDetails`
  handler does the save inside `runWithErrorReporting` and only
  closes the tab in a `finally` block, so the close happens after
  the download calls return *and* runs even when the save throws
  — which matters because `chrome.downloads.download` resolves on
  download *start*, not completion (overkill for our tiny data-URL
  payloads in practice).
- **Manual tab close cleanup.** If the user closes the details
  tab without clicking Capture, a `chrome.tabs.onRemoved` handler
  drops the stashed capture from `chrome.storage.session`. Without
  this, session storage would grow until the browser restarts.

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
