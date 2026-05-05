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
  `BASE_CAPTURE_ACTIONS × CAPTURE_DELAYS_SEC` (0, 2, 5 seconds). A
  base with `supportsDelayed: false` (e.g. `save-url`,
  `save-selection-*`) opts out: only the 0s variant is generated,
  no 2s / 5s entries appear anywhere for it.
- Each generated entry has an id (`<baseId>` for delay 0,
  `<baseId>-<N>s` otherwise), a menu title, a `tooltipFragment`
  (used by `getDefaultActionTooltip` to build the toolbar icon's
  hover tooltip), `baseId` / `group` / `delaySec` fields for
  routing into the right menu section, and a zero-arg `run()`
  that forwards the delay to the base action's handler.
- Each base carries a `group: 'primary' | 'more'` that decides
  which section of the action menu surfaces the undelayed
  variant:
  - `'primary'` — top-level entry + a slot in the "Capture with
    delay" submenu for each delayed variant.
  - `'more'` — entry inside the "More" submenu. Delayed variants
    are reachable via the Capture-with-delay submenu when the
    base sets `showInDelayedSubmenu` (e.g. `save-defaults`,
    `save-all`), and via the Options page in any case.

### Primary bases

- **`save-screenshot` — "Save screenshot".** Calls
  `captureVisible(delayMs)`. Immediate PNG of the visible tab.
  The delayed variants show a countdown badge on the toolbar
  icon ("5", "4", "3", …) before capturing, so the user can
  activate hover states, open menus, etc. on the page. The
  `await` keeps the service worker alive for the duration. Any
  `delayMs` value is also callable from the devtools console as
  `SeeWhatISee.captureVisible(2000)`.
- **`save-page-contents` — "Save HTML contents".** Uses
  `chrome.scripting.executeScript` to grab
  `document.documentElement.outerHTML` from the active tab and
  saves it as `contents-<timestamp>.html`. The capture is
  recorded in `log.json` just like a screenshot — only the
  filename differs. Requires the `scripting` permission. Takes
  the same optional `delayMs` as `captureVisible`; also callable
  as `SeeWhatISee.savePageContents(2000)`.
- **`capture` — "Capture...".** Opens the Capture page
  (`capture.html`) where the user picks which artifacts to save,
  adds an optional prompt, and optionally annotates the
  screenshot. Takes the same `delayMs`, forwarded through
  `captureBothToMemory` so the delay applies to the pre-open
  screenshot + HTML snapshot. See
  [`capture-page.md`](capture-page.md) for the full design.

### More bases

Shortcuts that skip the Capture-page dialog round-trip.

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
  errored.
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
    action at 0s but with no 2s/5s variants (a delay doesn't
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
`chrome.runtime.onInstalled` with `contexts: ['action']`. Top
level: 5 entries — one slot below the 6-item
`ACTION_MENU_TOP_LEVEL_LIMIT` cap, since the Set-default-click
submenu was retired in favor of the Options page.

### Top-level entries

- The three **undelayed** primary-group `CAPTURE_ACTIONS` items
  (Capture..., Save screenshot, Save HTML contents), each running
  its action immediately when clicked. "Save screenshot" is
  functionally identical to a plain left-click when
  `save-screenshot` is the default — listed for discoverability.
- **Capture with delay ▸** — submenu with the 2s and 5s variants
  of every base with `showInDelayedSubmenu` (primary-group by
  default, plus any more-group base that opts in — e.g.
  `save-defaults`, `save-all`). Separator-grouped by delay.
  In-submenu separators don't count against the top-level cap, so
  the visual grouping is free. More-group actions that don't opt
  in (`save-url` and the three `save-selection-{html,text,markdown}`
  — all `supportsDelayed: false` anyway) are only reachable via
  the Options page.
- **More ▸** — submenu home for the more-group capture actions
  and for infrequent utilities that would otherwise crowd out
  primary capture entries at the top level. See below.

### More submenu

- **Save default items** — runs `saveDefaults`: the Capture-page
  Save path with the user's stored `capturePageDefaults`, no
  dialog. Listed first under More with its own divider, since
  it's the everyday Save-without-dialog pick.
- **Save URL** / **Save everything** — shortcuts for the
  "neither" and "everything" checkbox combinations, skipping the
  dialog round-trip.
  - *Save URL* is a `BASE_CAPTURE_ACTION` with
    `supportsDelayed: false` (no delayed variants): the action
    records the URL at click time, so a delay would only let the
    user navigate somewhere else first — a confusing interaction
    that's easy to reproduce intentionally just by opening the
    other page.
  - *Save everything* (`save-all`) gets delayed variants and sets
    `showInDelayedSubmenu: true` so they surface in the main
    "Capture with delay" submenu next to the primary delayed
    entries; matches the other capture actions'
    active-tab-after-delay semantics. Also saves the selection
    when one is present, picking the user's configured
    selection-format default.
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
- The menu currently has 5 top-level entries (3 undelayed + 2
  submenu parents: Capture with delay, More) — one slot under
  the cap.
- **Prefer nesting new entries under an existing submenu** (More
  is the natural home for infrequent utilities); reserve the
  free slot for genuinely top-level work.
- Overflow fails silently via `chrome.runtime.lastError`, so a
  careless addition drops a previously-working entry without any
  build- or runtime-time error. See
  [chrome-extension.md → Context menus on the toolbar action](chrome-extension.md#context-menus-on-the-toolbar-action)
  for the full story, including the 8e100d1 regression this
  caused.

## Image right-click menu

Image-context entries (currently Capture… and Save screenshot)
surface in `contexts: ['image']` when the user right-clicks any
image on a page; Chrome auto-groups them under a `SeeWhatISee`
submenu inside the page context menu (no parent created in code).

- **Capture...** routes to
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
  - Highlights / redactions / crop flags still surface on the
    saved record's `screenshot` artifact the same way they do on
    the toolbar path.
- **Save screenshot** routes to
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
- No `suggested_key` is declared on any entry; Chrome caps
  suggested defaults at four per extension and a fresh-install
  default risks colliding with Chrome / other extensions. Users
  bind keys themselves at `chrome://extensions/shortcuts` (or via
  the Options page's "Edit in Chrome" button).
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
   so the new base automatically gains immediate + 2s + 5s
   variants in whichever menu sections its `group` unlocks, plus
   an Options-page row per delay. Set `supportsDelayed: false`
   when delayed variants don't make sense for the mode (only the
   0s variant is then generated). No other plumbing.
   - **Pick the group deliberately.** `'primary'` promotes the
     undelayed variant to a top-level slot and surfaces delayed
     variants in the "Capture with delay" submenu — right for
     primary capture paths. `'more'` tucks the undelayed variant
     into the "More" submenu; delayed variants surface in
     "Capture with delay" only when `showInDelayedSubmenu: true`
     is also set. Either way the action is bindable as the click
     / double-click default via the Options page.
   - **Watch the top-level cap.** Chrome allows at most
     `ACTION_MENU_TOP_LEVEL_LIMIT = 6` top-level items per
     action context menu, and separators count. The menu
     currently has 5 (3 primary undelayed entries + Capture with
     delay + More) — one slot free. A new `'primary'` base
     consumes that slot; a second new primary would push it past
     6 and silently drop an entry, so add the base as `'more'`
     instead, or fold the undelayed primary slots into a submenu
     of their own (e.g. "Capture now") first.
4. If the action should be bindable as a keyboard shortcut (i.e.
   it's a non-selection base), add a matching entry under
   `commands` in `src/manifest.json`. The command name is
   `NN-<baseId>` where `NN` is the next two-digit ordering prefix
   — pick a number that slots the entry into the desired position
   on `chrome://extensions/shortcuts`; the listener in
   `background.ts` strips the prefix before dispatching via
   `findCaptureAction`. Omit `suggested_key` so the extension
   doesn't ship a default binding.
5. Add a Playwright test that drives the new function via
   `serviceWorker.evaluate`. See [`testing.md`](testing.md) for
   the patterns.
