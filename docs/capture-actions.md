# Capture actions, menus, and dispatch

This doc covers everything between "the user clicks something" and
"a capture handler runs":

- The `CAPTURE_ACTIONS` catalog and how it's generated.
- The toolbar icon's left-click / double-click default dispatch.
- The toolbar context menu's structure.
- The image right-click menu wiring.
- Keyboard commands.

For the broader architecture see [`architecture.md`](architecture.md).
For per-action storage / fresh-install defaults / the Capture-page
first-paint pre-checks see
[`options-and-settings.md`](options-and-settings.md). For the
Chrome-platform hazards behind the menus (top-level cap, separator
gotchas, image fetch strategies) see
[`chrome-extension.md`](chrome-extension.md).

## The `CAPTURE_ACTIONS` catalog

A single `CAPTURE_ACTIONS` array in
`src/background/capture-actions.ts` is the source of truth for
every user-visible way to grab content.

- Generated at module load from
  `BASE_CAPTURE_ACTIONS × CAPTURE_DELAYS_SEC` (0 and 3 seconds).
  A base with `supportsDelayed: false` (e.g. `save-url`,
  `save-selection-*`) opts out: only the 0s variant is generated,
  no 3s entry appears anywhere for it.
- Each generated entry has an id (`<baseId>` for delay 0,
  `<baseId>-<N>s` otherwise), a menu title, a `tooltipFragment`
  (used by `getDefaultActionTooltip` to build the toolbar icon's
  hover tooltip), `baseId` / `group` / `delaySec` fields for
  routing into the right menu section, and a zero-arg `run()`
  that forwards the delay to the base action's handler.
- Each base carries a `group: 'primary' | 'more'` that decides
  which section of the action menu surfaces the undelayed
  variant:
  - `'primary'` — eligible to be promoted to a top-level
    shortcut row. The exact set of top-level rows is the
    `TOP_LEVEL_SHORTCUT_ACTION_IDS` list in `context-menu.ts`,
    not "every primary base" — the menu cap means we hand-pick
    which shortcuts to promote.
  - `'more'` — entry inside the "More" submenu.
- Only `capture` and `save-screenshot` produce a delayed (3s)
  variant today; every other base sets `supportsDelayed: false`
  and surfaces only the 0s row. The two delayed bases' 3s rows
  are rendered together as a single block inside the More
  submenu (the `MORE_DELAYED_ACTION_IDS` list in
  `context-menu.ts`), and bindable as click / double-click
  defaults via the Options page.

### Primary bases

- **`capture` — "Capture...".** Opens the Capture page
  (`capture.html`) where the user picks which artifacts to save,
  adds an optional prompt, and optionally annotates the
  screenshot. Takes the same `delayMs`, forwarded through
  `captureBothToMemory` so the delay applies to the pre-open
  screenshot + HTML snapshot. See
  [`capture-page.md`](capture-page.md) for the full design.
  - Currently the only `'primary'` base. The undelayed variant
    is the first top-level shortcut row, and the 3s variant is
    promoted to the third top-level slot for one-click delayed
    capture.

### More bases

Shortcuts that skip the Capture-page dialog round-trip.

- **`save-screenshot` — "Save screenshot".** Calls
  `captureVisible(delayMs)`. Immediate PNG of the visible tab.
  The delayed variant shows a countdown badge on the toolbar
  icon ("3", "2", "1") before capturing, so the user can
  activate hover states, open menus, etc. on the page. The
  `await` keeps the service worker alive for the duration. Any
  `delayMs` value is also callable from the devtools console as
  `SeeWhatISee.captureVisible(3000)`. Its 3s variant sits in
  the More submenu's delayed-shortcut block alongside the
  delayed `capture` row.
- **`save-page-contents` — "Save HTML contents".** Uses
  `chrome.scripting.executeScript` to grab
  `document.documentElement.outerHTML` from the active tab and
  saves it as `contents-<timestamp>.html`. The capture is
  recorded in `log.json` just like a screenshot — only the
  filename differs. Requires the `scripting` permission. Takes
  the same optional `delayMs` as `captureVisible` (e.g. via the
  devtools console as `SeeWhatISee.savePageContents(3000)`), but
  sets `supportsDelayed: false`, so no delayed row surfaces in
  the menus or Options page.
- **`save-defaults` — "Save default items".** Runs the same
  artifact-write path the Capture page would on Save click,
  applying the user's stored `capturePageDefaults` (split by
  selection-presence). Probes the captured page state and picks
  the with-selection branch when at least one selection format
  has saveable content — same rule the Capture page uses to
  decide whether the master Save-selection row is enabled.
  Format pick prefers `capturePageDefaults.withSelection.format`
  and falls back to the first format with non-empty content.
  Throws on `screenshotError` / `htmlError` only when the
  matching default is set; the toolbar error channel surfaces
  the reason.
  - **Title rewrite for `save-defaults`** is purely a property of
    `capturePageDefaults` — routing-independent. `saveDefaultsMenuTitle`
    in `tooltip.ts` looks at the no-sel and with-sel branches:
    - Both branches save exactly one artifact, *same* item →
      `Save <item>` (e.g. both branches = screenshot →
      `Save screenshot`).
    - Both branches save exactly one artifact, *different* items →
      `Save <noSelItem> or <withSelItem>` (the fresh-install case
      reads as `Save screenshot or selection`; selection format is
      always dropped — see below).
    - Either branch is empty or saves multiple artifacts → catalog
      `Save default items`. The `or`-form requires single-word nouns
      on each side, so anything richer falls back rather than
      introducing comma-and joins.
  - Selection format dropped at expansion time. A with-sel branch of
    `{ selection: true, format: 'markdown' }` reads as
    `Save selection`, not `Save selection markdown` — the format
    suffix would break the single-word noun the row-collapse rule
    needs. Users still see the format on the Capture page checkbox
    and on the dedicated `Save selection as <fmt>` menu entries.
- **`save-url` — "Save URL".** Equivalent to the Capture page
  with *neither* file checked: the record gets just `timestamp`
  + `url` (no `screenshot`, no `contents`). Goes through
  `captureBothToMemory` + `recordDetailedCapture` so the delay /
  active-tab-after-delay semantics match; the screenshot + HTML
  payloads are discarded.
- **`save-all` — "Save everything".** Saves the screenshot, the
  HTML, and (when the page has a non-empty selection) the
  selection in the user's configured selection-format default —
  same fallback rule as `save-defaults`. Re-throws
  `screenshotError` / `htmlError`; the selection branch is
  skipped silently when no selection was present or the scrape
  errored. `supportsDelayed: false` — the menus only surface the
  0s row.
- **`save-selection-html` / `save-selection-text` /
  `save-selection-markdown`** — three format-specific shortcuts
  that each call `captureSelection(format)`. The scrape returns
  all three bodies in one `executeScript` round-trip (HTML
  fragment + `selection.toString()`); markdown is produced in
  the SW by running the HTML through the pure `htmlToMarkdown`
  converter in `src/markdown.ts`.
  - The converter is called with the page URL as a `baseUrl`
    argument so relative `<a href>` / `<img src>` values get
    resolved to absolute URLs (the saved file lives outside the
    page, so a bare `foo.html` would otherwise point nowhere).
    Fragment-only refs (`#section`) pass through unchanged.
  - Saved HTML stays byte-identical to the scrape — only the
    markdown output gets URL rewriting. Saved text comes from
    `selection.toString()` and carries no URLs.
  - The markdown / text converters skip elements the page itself
    marks invisible — the HTML5 `hidden` attribute and inline
    `style="display: none"`. Catches the common "snackbar /
    toast template embedded in the live HTML" pattern that
    `Selection.toString()` already filters out via layout.
    CSS-class-driven hiding (`.sr-only`, stylesheet rules) still
    leaks through; we don't run a layout / CSS engine.
  - File lands at `selection-<timestamp>.{html,txt,md}`; the
    record is `{ filename, format, isEdited?: true }` with
    `format` ∈ `{"html","text","markdown"}` so downstream
    consumers don't have to sniff the extension.
  - Image-only selections are still captured as long as the
    chosen format has content: the HTML fragment always does,
    but text / markdown may be empty — in which case the action
    throws `No selection {format} content` and surfaces via the
    icon/tooltip channel.
  - Each is a `BASE_CAPTURE_ACTION` with
    `supportsDelayed: false` — bindable as the default click
    action at 0s but with no delayed variant (a delay doesn't
    help: the selection already exists when the user triggers
    the action).

### CodeMirror-style viewers (selection scrape)

GitHub blob `?plain=1` and other CM6-rendered pages are a
special case for selection scrapes:

- CM6 renders visible text on layout/measure DOM nodes whose
  `cloneContents()` returns an empty fragment even though
  `Selection.toString()` returns the full visible text. Focus is
  parked on a hidden `<textarea
  id="read-only-cursor-text-area">`.
- Fallback: the scrape accepts the selection as long as *either*
  `cloneContents()` or `toString()` is non-empty. Text saves
  work; HTML / markdown rows stay disabled (no real HTML to
  convert).
- Diagnostic: when the scrape returns null, both call sites log
  `[SeeWhatISee] selection scrape empty: {diag}` to the SW
  console with `rangeCount` / `clonedHtmlLen` / `selStrLen` /
  `anchorTag` / `activeTag` so the next failure mode is
  diagnosable without instrumentation.
- Page-side worker lives in its own module
  (`src/scrape-page-state.ts`) so it has zero imports — required
  because `executeScript` serializes `func` via
  `Function.toString()` and re-parses it in the page world.

### Markdown for the rest of the selection-format trio

- `selectionMarkdownBody` either short-circuits to the verbatim
  selection text (when the selection is itself markdown source —
  e.g. a `.md` file viewed in GitHub `?plain=1` or a CodeMirror
  editor, where running `htmlToMarkdown` over span-only HTML
  would collapse the file onto a single line) or runs the cloned
  HTML through `htmlToMarkdown`. Both paths take the page URL as
  the base URL so relative `[label](rel)` / `![alt](rel)` /
  `<a href>` / `<img src>` refs resolve to absolute URLs. See
  `looksLikeMarkdownSource` in `src/markdown.ts` for the
  detection rule.

## Default click + double-click actions

- Four independent defaults are persisted in
  `chrome.storage.local`, one per (Click vs. Double-click) ×
  (selection present vs. not).
- A separate `capturePageDefaults` object holds the Capture-page
  Save preferences.
- The toolbar dispatcher (`handleActionClick`), the toolbar
  tooltip, and the Capture-page first-paint pre-checks all read
  these.
- Full design — storage keys, fresh-install defaults, dispatch
  paths, tooltip layout — lives in
  [options-and-settings.md](options-and-settings.md).

### With-selection choices

All at delay 0:

- `save-selection-html` — save the selection as an HTML fragment.
- `save-selection-text` — save the selection as plain text.
- `save-selection-markdown` — save the selection as markdown.
- `capture` — open the Capture page. The Save checkbox state on
  first paint comes from `capturePageDefaults`, not from this
  click default — see
  [options-and-settings.md → Capture-page first-paint pre-checks](options-and-settings.md#capture-page-first-paint-pre-checks).
- `save-defaults` — write the same artifacts the Capture page
  would on Save click, applying `capturePageDefaults` without
  ever opening the page. Default for the Double-click slot on
  fresh installs (both Click and Dbl Without-selection default
  to `capture` / `save-defaults` respectively).
- `ignore-selection` — sentinel. Skip the probe and use the
  without-selection default.

### Without-selection choices

Every `CAPTURE_ACTIONS` entry except the three
`save-selection-<format>` shortcuts. They are deliberately
excluded — they would just error on every click without a
selection.

### Tooltip + first-paint pre-checks

- Capture-page first-paint pre-checks + toolbar tooltip layout
  are owned by [options-and-settings.md](options-and-settings.md).
- `refreshActionTooltip()` rewrites the title whenever any of the
  four defaults change and on `onInstalled` / `onStartup`.

## Toolbar context menu

The toolbar icon's context menu is registered on
`chrome.runtime.onInstalled` with `contexts: ['action']`. New work
defaults to the More submenu — the menu currently uses 5 of the 6
top-level slots, so a sixth row is technically possible but pushes
the menu back to Chrome's `ACTION_MENU_TOP_LEVEL_LIMIT`.

### Top-level entries

- **Capture...** — undelayed `capture` action, opens the Capture
  page. First and most prominent shortcut.
- **Save default items** — undelayed `save-defaults` action,
  writes artifacts per stored `capturePageDefaults` with no
  dialog. Promoted to top level so the everyday "save without
  the dialog" pick is one click away.
- **Capture... in 3s** — the `capture-3s` variant, for one-click
  delayed capture without opening the More submenu.
- The three rows above are installed with `-shortcut`-suffixed
  menu ids (the `SHORTCUT_SUFFIX` constant) because each action
  also appears inside the More submenu — Chrome rejects duplicate
  ids, so the top-level row needs a unique id. The onClicked
  dispatcher strips the suffix before looking up the action in
  `CAPTURE_ACTIONS`. The set of promoted actions lives in
  `TOP_LEVEL_SHORTCUT_ACTION_IDS`.
- **More ▸** — submenu home for every action plus the
  infrequent utilities (Copy-last filenames, Snapshots
  directory, Clear log history). See below.
- **☐  Set this tab as Ask button target** — pin/unpin the active
  tab as the Ask destination. Greyed unless the active tab is on
  an enabled provider; flips between Set and Unset. Sits last in
  the top-level list, after the More submenu, since it's
  context-dependent on the active tab and not a capture action.

### More submenu

- **Capture...** — same as the top-level row, listed in More so
  the submenu is a complete catalog of every action. Uses the
  bare `capture` id (the top-level row uses `capture-shortcut`).
- **Save default items** — runs `saveDefaults`: the Capture-page
  Save path with the user's stored `capturePageDefaults`, no
  dialog. Listed second under More since it's the everyday
  Save-without-dialog pick.
- **Save screenshot** / **Save HTML contents** — undelayed
  versions of the two single-artifact shortcuts.
- **Save URL** / **Save everything** — shortcuts for the
  "neither" and "everything" checkbox combinations, skipping the
  dialog round-trip. Both `BASE_CAPTURE_ACTION`s set
  `supportsDelayed: false`, so neither has a delayed variant.
  *Save URL* records the URL at click time, so a delay would
  only let the user navigate somewhere else first; *Save
  everything* dropped its delayed variants when the
  Capture-with-delay submenu was retired.
- **Capture... in 3s** and **Save screenshot in 3s** — the
  delayed-shortcut block. Bracketed by separators so it reads as
  a distinct sub-set; the trailing separator doubles as the
  divider between the always-applicable shortcuts above and the
  selection-only shortcuts below. The set of ids lives in
  `MORE_DELAYED_ACTION_IDS` in `context-menu.ts` and matches the
  full set of delayed `CAPTURE_ACTIONS` entries — the only two
  bases with `supportsDelayed` left on are `capture` and
  `save-screenshot`, and only the 3s delay is generated.
- **Save selection as HTML / text / markdown** — the three
  format-specific shortcuts described above.
- **Copy last screenshot filename** / **Copy last HTML
  filename** / **Copy last selection filename** — copy the most
  recent capture's screenshot, HTML, or selection file's
  *absolute on-disk path* to the clipboard. The selection entry
  is format-agnostic — a capture only ever writes one selection
  file (HTML / text / markdown), so a single entry covers all
  three cases.
  - Path is built by
    `joinCapturePath(getCaptureDirectory(), filename)` — same
    directory-resolution helper that powers **Snapshots
    directory**. The separator (`/` vs `\`) reuses whatever
    `getCaptureDirectory` returned so the result is OS-native and
    paste-ready in a shell or file manager.
  - Each entry is greyed out (`enabled: false`) when the most
    recent record in `chrome.storage.local` doesn't carry the
    matching field. A storage `onChanged` listener on
    `LOG_STORAGE_KEY` keeps the enable state in sync after every
    capture and after Clear log history (no plumbing from
    `capture.ts` to `background.ts`).
  - Clipboard write goes through an offscreen document
    (`offscreen.html` + `offscreen.ts`) because MV3 service
    workers can't access `navigator.clipboard`. The document is
    created on demand, posted a one-shot message, and torn down
    afterward. The offscreen page loads its script as a
    *classic* (non-module) script so the message listener
    registers synchronously during HTML parsing — `type="module"`
    would defer registration past the load event and the SW's
    immediate `sendMessage` would arrive with no listener
    registered. `clipboardWrite` and `offscreen` permissions are
    declared in the manifest.
- **Upload image to Capture...** — opens `capture.html?upload=true`
  in a new adjacent tab so the user can pick a local image and
  drive it through the Capture-page UI.
  - The page renders an upload-landing card while
    `getDetailsData` resolves with no session; selecting an image
    sends `initializeUploadSession` to the SW.
  - The SW synthesizes an `InMemoryCapture` with
    `screenshotDataUrl` from the file's `FileReader` data URL,
    `url: 'file:///<encoded-filename>'`, `title: 'Uploaded image'`,
    `htmlUnavailable: true` (no page HTML exists), and
    `useImageFlowDefaults: true` so `getDetailsData` picks the
    image-flow defaults branch (Save Screenshot ✓ regardless of
    the user's `withoutSelection.screenshot` pref).
  - The synthetic `DetailsSession` pins `bases.screenshot` /
    `bases.contents` to the un-bumped filenames, mirroring
    `openCapturePageWithSession` — without this pin the multi-
    capture bump strategy (`rebumpFilenameIfLocked`) falls back
    to the already-bumped current filename and stacks suffixes.
  - `imageUrl` is **not** set — the file *is* the source, already
    named in `url`; setting `imageUrl` to the same value would
    duplicate that into `log.json` for no extra information.
  - On success the page strips `?upload=true` from its URL via
    `replaceState` and falls into the normal `loadData` happy-path.
  - See [capture-page.md → Upload mode](capture-page.md#upload-mode)
    for the page-side wiring.
- **Snapshots directory** — opens the on-disk capture directory
  in a new tab.
  - URL is `file://<downloads>/SeeWhatISee/`.
  - The downloads root is OS- / config-dependent and not exposed
    by any Chrome API, so the path is derived at runtime by
    searching `chrome.downloads.search` for our `log.json` record
    (every capture overwrites it, so the most recent match points
    at the live directory).
  - `byExtensionId` is checked client-side to reject any
    unrelated `log.json` from another tool that happens to share
    the path shape.
  - If no capture has happened yet, throws a clear error that
    surfaces via the icon/tooltip channel.
- **Clear log history** — `clearCaptureLog()` erases the
  in-storage capture log *and* overwrites `log.json` on disk with
  an empty file so `/see-what-i-see` et al. see the cleared state
  immediately. Still exposed on `SeeWhatISee.clearCaptureLog()`
  for the devtools console.

### Top-level item cap

- Chrome enforces
  `chrome.contextMenus.ACTION_MENU_TOP_LEVEL_LIMIT = 6`.
  Top-level separators count against it.
- **The menu currently uses 5 of the 6 slots.** Three top-level
  shortcut rows (Capture..., Save default items, Capture... in 3s),
  the More submenu parent, and the Pin-Ask-target row. One slot is
  free, but a sixth row would put the menu back at the cap and any
  later addition would silently displace an existing entry.
- **New work defaults to the More submenu** (the natural home for
  infrequent utilities and per-base shortcuts). Promote a new
  action to the top level only when it earns the slot.
- Overflow fails silently via `chrome.runtime.lastError`, so a
  careless addition drops a previously-working entry without any
  build- or runtime-time error. See
  [chrome-extension.md → Context menus on the toolbar action](chrome-extension.md#context-menus-on-the-toolbar-action)
  for the full story, including the 8e100d1 regression this
  caused.

## Image right-click menu

Image-context entries (currently `Capture... (this image)` and
`Save screenshot (this image)`) surface in `contexts: ['image']`
when the user right-clicks any
image on a page; Chrome auto-groups them under a `SeeWhatISee`
submenu inside the page context menu (no parent created in code).

- **Capture... (this image)** routes to
  `startCaptureWithDetailsFromImage(tab, info.srcUrl)`. Builds an
  `InMemoryCapture` whose `screenshotDataUrl` is the right-clicked
  image's bytes (instead of `captureVisibleTab`), skips the page
  HTML scrape entirely (the user's intent is "this image," not
  "this page") but still scrapes the selection (might be a
  caption), and opens `capture.html` next to the source tab.
  - Records carry a top-level `imageUrl` field — the URL of the
    right-clicked source image — emitted **independently of the
    `screenshot` artifact**: even if the user unchecks Save
    Screenshot in the Capture page, the URL survives in
    `log.json` so a downstream agent can resolve the image via
    its source.
  - The Capture page receives `htmlUnavailable: true` on the
    session response and quiet-disables the Save HTML row (no
    `has-error` class, no error icon — the absence is by design,
    not a failure).
  - Image-flow defaults are synthetic: Save Screenshot ✓ + Save
    Selection ✓ when a selection exists, Save HTML always false.
    Inherits the user's selection-format preference plus
    `defaultButton` / `promptEnter` so the rest of the page
    behaves the same. The user's stored `capturePageDefaults` is
    not mutated.
  - Gated on the `useImageFlowDefaults` flag on `InMemoryCapture`,
    not on `imageUrl`. The right-click flow sets both, but the
    upload-image flow sets only `useImageFlowDefaults` (it has no
    source URL to record). Keeping the flag separate means future
    flows can mix and match — e.g. record an `imageUrl` without
    wanting image-flow defaults.
  - Highlights / redactions / crop flags still surface on the
    saved record's `screenshot` artifact the same way they do on
    the toolbar path.
- **Save screenshot (this image)** routes to
  `captureImageAsScreenshot(tab, info.srcUrl)` — writes the image
  bytes directly under `screenshot-<ts>.<ext>`, records
  `screenshot` + `imageUrl` in `log.json`. No Capture page
  round-trip; no HTML scrape.
- See
  [chrome-extension.md → Image right-click context menu](chrome-extension.md#image-right-click-context-menu)
  for the page-side fetch / canvas-fallback strategies, MIME →
  extension ladder, and tainted-canvas error handling.

## Active-tab resolution

`captureVisible` always re-queries the active tab in the
last-focused window *after* any delay, then captures that tab and
records its URL.

- This keeps `url` and captured pixels consistent even if the
  user switches tabs, windows, or interacts with a popup during
  the delay.
- If the focused window isn't a regular browser window with an
  active tab (e.g. DevTools is on top), the query returns nothing
  and the call throws.

## Keyboard commands

The manifest's `commands` block exposes two meta-commands
(`_execute_action`, `01-secondary-action`) plus one entry per
base capture action. Capture actions use `1N-` prefixes;
selection-format actions use `2N-`.

- The meta-commands run whatever the user has stored as the Click
  or Dbl default and are documented in
  [options-and-settings.md → Keyboard commands](options-and-settings.md#keyboard-commands).
- The two-digit `NN-` prefix is a display-order hack, not part of
  the action id. `chrome://extensions/shortcuts` lists commands
  in raw string-sort order on the *command name*; without the
  prefix, the shortcuts page would scramble the menu order into
  an arbitrary alphabetical layout. The
  `chrome.commands.onCommand` listener strips the prefix via
  `COMMAND_PREFIX_PATTERN` before dispatching.
- Stripped names match their delay-0 `CAPTURE_ACTIONS` ids
  (except `secondary-action`, which routes to `runDblDefault()`),
  so the dispatch is a direct `findCaptureAction(stripped)`
  lookup — no separate mapping table.
- The two meta-commands ship with default `suggested_key`
  bindings: `_execute_action` defaults to `Ctrl+Shift+X`
  (`Command+Shift+X` on Mac) and `01-secondary-action` defaults
  to `Ctrl+Shift+E` (`Command+Shift+E` on Mac). The capture / selection
  hotkey entries deliberately omit `suggested_key` so the user
  picks them at `chrome://extensions/shortcuts` (or via the
  Options page's "Edit in Chrome" button) — Chrome caps
  suggested defaults at four per extension, and reserving them
  for the meta-commands keeps the budget for the bindings users
  are most likely to want.
- Selection-format hotkeys are global: they fire the action
  directly, and the action itself throws
  `No selection {format} content` when nothing is selected —
  surfaced via the standard icon/tooltip error channel.
- Command dispatch routes through `runWithErrorReporting`, so a
  restricted-URL scrape or an absent active tab surfaces on the
  toolbar icon the same way a toolbar click would.

## Adding a new capture mode

1. Add a new exported function to `src/capture.ts` (e.g.
   `captureFullPage`). If delayed variants are wanted, accept an
   optional `delayMs` and call `countdownSleep(delayMs)` before
   the real work, matching `captureVisible` /
   `savePageContents` / `captureBothToMemory`.
2. Register it on `self.SeeWhatISee` in `src/background.ts` so
   it is reachable from tests and the devtools console.
3. Add a new entry to the `BASE_CAPTURE_ACTIONS` array in
   `src/background/capture-actions.ts` with a base id, base
   title, a `baseTooltipFragment` (sentence-case, no trailing
   "…" — slotted into the toolbar tooltip's `Click: …` /
   `Double-click: …` lines), a `group: 'primary' | 'more'`, and
   a `run(delayMs)` that calls your new function. The flat
   `CAPTURE_ACTIONS` array is generated from
   `BASE_CAPTURE_ACTIONS × CAPTURE_DELAYS_SEC` at module load,
   so the new base automatically gains an immediate variant plus
   a 3s variant (the only delay in `CAPTURE_DELAYS_SEC`), with
   an Options-page row per delay. Set `supportsDelayed: false`
   when a delayed variant doesn't make sense for the mode (only
   the 0s variant is then generated). No other plumbing.
   - **Pick the group deliberately.** `'primary'` makes the base
     eligible for promotion to a top-level shortcut row;
     `'more'` tucks the undelayed variant into the "More"
     submenu. Either way the action is bindable as the click /
     double-click default via the Options page. Note that
     `'primary'` is necessary but not sufficient for top-level
     promotion — see the next bullet.
   - **Watch the top-level cap.** Chrome allows at most
     `ACTION_MENU_TOP_LEVEL_LIMIT = 6` top-level items per
     action context menu, and separators count. The menu has
     one free slot today (see "Top-level item cap" above), so a
     new base joins the More submenu by default. Promote to top
     level by editing `TOP_LEVEL_SHORTCUT_ACTION_IDS` in
     `src/background/context-menu.ts`.
   - **Surface delayed variants in the More submenu.** A new
     base with `supportsDelayed: true` shows up on the Options
     page and is bindable as a default, but its 3s row doesn't
     appear in the More submenu unless its id is listed in
     `MORE_DELAYED_ACTION_IDS` in
     `src/background/context-menu.ts`. Add it there if the base
     earns space in the delayed-shortcut block.
4. If the action should be bindable as a keyboard shortcut (i.e.
   it's a non-selection base), add a matching entry under
   `commands` in `src/manifest.json`. The command name is
   `NN-<baseId>` where `NN` is the next two-digit ordering prefix
   — pick a number that slots the entry into the desired position
   on `chrome://extensions/shortcuts`; the listener in
   `background.ts` strips the prefix before dispatching via
   `findCaptureAction`. Omit `suggested_key` so the extension
   doesn't ship a default binding (the four-per-extension budget
   is reserved for the `_execute_action` and `01-secondary-action`
   meta-commands, which already declare defaults).
5. Add a Playwright test that drives the new function via
   `serviceWorker.evaluate`. See [`testing.md`](testing.md) for
   the patterns.
