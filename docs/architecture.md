# Architecture

SeeWhatISee is a small Manifest V3 Chrome extension plus a standard
on-disk drop directory that coding agents can read from.

This doc is a high-level overview of components and data flow.
Chrome-specific hazards, workarounds, and the error-reporting
design live in [`chrome-extension.md`](chrome-extension.md).

## Components

```
+----------------------+        +-----------------------+        +-----------+
| Toolbar click /      |  -->   | background service    |  -->   | ~/Downloads/
| Playwright evaluate  |        | worker (background.ts)|        |  SeeWhatISee/
+----------------------+        +-----------------------+        +-----------+
                                          |
                                          v
                                +---------------------------+
                                | src/capture.ts              |
                                |  - captureVisible()         |
                                |  - savePageContents()       |
                                |  - captureBothToMemory()    |
                                |  - downloadScreenshot()     |
                                |  - downloadHtml()           |
                                |  - recordDetailedCapture()  |
                                |  - clearCaptureLog()        |
                                +---------------------------+
```

- **Capture actions.** A single `CAPTURE_ACTIONS` array in
  `src/background.ts` is the source of truth for every user-visible
  way to grab content.

  - Generated at module load from `BASE_CAPTURE_ACTIONS ×
    CAPTURE_DELAYS_SEC` (0, 2, 5 seconds). A base with
    `supportsDelayed: false` (e.g. `capture-url`,
    `capture-selection-*`) opts out: only the 0s variant is generated,
    no 2s / 5s entries appear anywhere for it.
  - Each generated entry has an id (`<baseId>` for delay 0,
    `<baseId>-<N>s` otherwise), a menu title, a
    `tooltipFragment` (used by `getDefaultActionTooltip` to build
    the toolbar icon's hover tooltip), `baseId` / `group` /
    `delaySec` fields for routing into the right menu section,
    and a zero-arg `run()` that forwards the delay to the base
    action's handler.
  - Each base carries a `group: 'primary' | 'more'` that decides
    which section of the action menu surfaces the undelayed variant:
    - `'primary'` — top-level entry + a slot in the "Capture with
      delay" submenu for each delayed variant.
    - `'more'` — top of the "More" submenu; delayed variants are
      only reachable via "Set default click action".
    - Every base × delay pair appears in "Set default click action"
      regardless of group.

  The three `primary` bases are:

  - **`capture-now` — "Take screenshot".** Calls
    `captureVisible(delayMs)`. Immediate PNG of the visible tab.
    The delayed variants show a countdown badge on the toolbar
    icon ("5", "4", "3", …) before capturing, so the user can
    activate hover states, open menus, etc. on the page. The
    `await` keeps the service worker alive for the duration. Any `delayMs` value is also callable
    from the devtools console as
    `SeeWhatISee.captureVisible(2000)`.
  - **`save-page-contents` — "Save HTML contents".** Uses
    `chrome.scripting.executeScript` to grab
    `document.documentElement.outerHTML` from the active tab and
    saves it as `contents-<timestamp>.html`. The capture is
    recorded in `log.json` just like a screenshot
    — only the filename differs. Requires the `scripting`
    permission. Takes the same optional `delayMs` as
    `captureVisible`; also callable as
    `SeeWhatISee.savePageContents(2000)`.
  - **`capture-with-details` — "Capture with details...".** Opens
    a bundled extension page (`capture.html`) where the user picks
    which artifacts to save, adds an optional prompt, and
    optionally annotates the screenshot. Takes the same
    `delayMs`, forwarded through `captureBothToMemory` so the
    delay applies to the pre-open screenshot + HTML snapshot.
    See ["Capture with details flow"](#capture-with-details-flow)
    below for the full design.

  The two `more` bases are shortcuts for the two fixed checkbox
  combinations in the details flow:

  - **`capture-url` — "Capture URL".** Equivalent to the details
    page with *neither* file checked: the record gets just
    `timestamp` + `url` (no `screenshot`, no `contents`). Goes
    through `captureBothToMemory` + `recordDetailedCapture` so the
    delay / active-tab-after-delay semantics match; the screenshot
    + HTML payloads are discarded.
  - **`capture-both` — "Capture screenshot and HTML".**
    Equivalent to the details page with *both* files checked.
    Downloads both artifacts and writes a record that references
    both.

- **Default click action.** Two separate defaults are persisted:
  one for clicks on a page that has a selection, another for clicks
  on a page that doesn't.

  - Storage keys: `defaultClickWithSelection` and
    `defaultClickWithoutSelection` in `chrome.storage.local`.
  - Fresh installs default to `capture-selection-html` (with
    selection) and `capture-with-details` (without selection).
  - A click on the toolbar icon fires `chrome.action.onClicked`,
    which routes through `handleActionClick`. Five cases:
    1. **Viewing the capture page** — if the active tab is a
       `capture.html` page with stashed session data, the click
       sends it a `triggerCapture` message, which programmatically
       clicks the Capture button.
    2. **Double-click, selection present** — if the with-selection
       default isn't `ignore-selection`, always open the details
       page (`startCaptureWithDetails()`), regardless of what the
       without-selection default would be. Matches the "full
       dialog for this selection" intent and makes the double-click
       target predictable whenever there's something selected.
    3. **Double-click, no selection (or ignore mode)** — runs the
       classic alternate of the without-selection default:
       `capture-with-details` → screenshot, everything else →
       `capture-with-details`. Menu hints track this mapping (we
       can't predict selection state at menu-render time), so
       hints remain accurate for the common case.
    4. **Single click, selection present** — if the with-selection
       default is one of the `capture-selection-<format>` shortcuts
       or `capture-with-details`, run it. `ignore-selection` skips
       the selection probe entirely and falls through to the
       without-selection default.
    5. **Single click, no selection** — run the without-selection
       default.
  - Selection probe runs `scrapeSelection` on the active tab either
    inside the 250 ms double-click timer (single-click path) or on
    the second click itself (double-click path), so it always
    reflects the tab state at dispatch time (after any tab switch
    during the window). Probe failures (restricted URL, closed tab)
    fall through to `false` so the click still runs the
    without-selection default / classic double-click alternate.
  - **With-selection choices** (five, all at delay 0):
    - `capture-selection-html` — save the selection as an HTML
      fragment (the default on fresh installs).
    - `capture-selection-text` — save the selection as plain text.
    - `capture-selection-markdown` — save the selection as markdown
      (HTML → markdown via the pure `htmlToMarkdown` converter).
    - `capture-with-details` — open the details page with
      `selectionOnly: true`, which default-checks **only** the Save
      selection checkbox; the user can still tick screenshot / HTML
      before clicking Capture.
    - `ignore-selection` — sentinel. Skip the probe and use the
      without-selection default.
  - **Without-selection choices**: every `CAPTURE_ACTIONS` entry
    except the three `capture-selection-<format>` shortcuts. They
    are deliberately excluded — they would just error on every
    click without a selection.
  - The toolbar icon's hover tooltip is composed from
    `tooltipFragment` fields pre-authored on each
    `CaptureAction` / with-selection choice. Layout:
    - `SeeWhatISee`
    - blank
    - `Click: <click.tooltipFragment>`
    - `Double-click: <doubleClick.tooltipFragment>`
    - `With selection: <withChoice.tooltipFragment>` (omitted for
      `ignore-selection`)
    - trailing blank (separates our content from Chrome's appended
      "Wants access to this site" line)
    - When an error is pending, `ERROR: <message>` slots between
      the app title and the action block, bracketed by its own
      blanks.
  - `refreshActionTooltip()` rewrites the title whenever either
    preference changes and on `onInstalled` / `onStartup`.

- **Right-click menu.** The toolbar icon's context menu is
  registered on `chrome.runtime.onInstalled` with
  `contexts: ['action']`. Top level (6 entries):

  - The three **undelayed** primary-group `CAPTURE_ACTIONS` items
    (Take screenshot, Save HTML contents, Capture with details...),
    each running its action immediately when clicked. "Take
    screenshot" is functionally identical to a plain left-click
    when `capture-now` is the default — listed for discoverability.
  - **Capture with delay ▸** — submenu with the 2s and 5s variants
    of every base with `showInDelayedSubmenu` (primary-group by
    default, plus any more-group base that opts in — e.g.
    `capture-both`). Separator-grouped by delay. In-submenu
    separators don't count against the top-level cap, so the visual
    grouping is free. More-group actions that don't opt in
    (`capture-url` and the three
    `capture-selection-{html,text,markdown}` — all
    `supportsDelayed: false` anyway) are only reachable via "Set
    default click action" if at all.
  - **Set default click action ▸** — submenu with two sections,
    each introduced by a disabled-item subheading:
    - **`── When text is selected ──`** header (`enabled: false`),
      then the five with-selection choices (three
      `capture-selection-<format>` shortcuts,
      `capture-with-details`, `ignore-selection`).
    - Separator.
    - **`── When no text is selected ──`** header (`enabled: false`),
      then every `CAPTURE_ACTIONS` entry *except* the
      `capture-selection-<format>` shortcuts, grouped by delay
      (0s, 2s, 5s) with separators between delay groups.
    - The selected item in each section gets a `✓ ` title prefix.
      Picking one persists its id under the matching storage key
      (`defaultClickWithSelection` /
      `defaultClickWithoutSelection`) and refreshes the tooltip.
    - Uses normal items instead of `type: 'radio'` because Chrome's
      radio mutual-exclusion only covers a contiguous run — the
      separator would cause two items to appear selected.
    - Uses `enabled: false` normal items for the subheadings
      because `chrome.contextMenus` has no "label" / "group
      header" type.

  - **More ▸** — submenu home for the more-group capture actions
    and for infrequent utilities that would otherwise crowd out
    primary capture entries at the top level.
    - **Capture URL** / **Capture screenshot and HTML** — shortcuts
      for the "neither" and "both" checkbox combinations of the
      details flow, skipping the dialog round-trip.
      - *Capture URL* is a `BASE_CAPTURE_ACTION` with
        `supportsDelayed: false` (no delayed variants): the action
        records the URL at click time, so a delay would only let
        the user navigate somewhere else first — a confusing
        interaction that's easy to reproduce intentionally just by
        opening the other page.
      - *Capture screenshot and HTML* gets delayed variants and
        sets `showInDelayedSubmenu: true` so they surface in the
        main "Capture with delay" submenu next to the primary
        delayed entries; matches the other capture actions'
        active-tab-after-delay semantics.
    - **Capture selection as HTML / text / markdown** — three
      format-specific shortcuts that each call
      `captureSelection(format)`. The scrape returns all three
      bodies in one `executeScript` round-trip (HTML fragment +
      `selection.toString()`); markdown is produced in the SW by
      running the HTML through the pure `htmlToMarkdown` converter
      in `src/markdown.ts`.
      - The converter is called with the page URL as a `baseUrl`
        argument so relative `<a href>` / `<img src>` values get
        resolved to absolute URLs (the saved file lives outside
        the page, so a bare `foo.html` would otherwise point
        nowhere). Fragment-only refs (`#section`) pass through
        unchanged.
      - Saved HTML stays byte-identical to the scrape — only the
        markdown output gets URL rewriting. Saved text comes from
        `selection.toString()` and carries no URLs.
      - File lands at `selection-<timestamp>.{html,txt,md}`; the
        record is `{ filename, format, isEdited?: true }` with
        `format` ∈ `{"html","text","markdown"}` so downstream
        consumers don't have to sniff the extension.
      - Image-only selections are still captured as long as the
        chosen format has content: the HTML fragment always does,
        but text / markdown may be empty — in which case the
        action throws `No selection {format} content` and surfaces
        via the icon/tooltip channel.
      - Each is a `BASE_CAPTURE_ACTION` with `supportsDelayed: false`
        — bindable as the default click action at 0s but with no
        2s/5s variants (a delay doesn't help: the selection already
        exists when the user triggers the action).
    - **Copy last screenshot filename** / **Copy last HTML filename** /
      **Copy last selection filename** — copy the most recent capture's
      screenshot, HTML, or selection file's *absolute on-disk path* to
      the clipboard. The selection entry is format-agnostic — a capture
      only ever writes one selection file (HTML / text / markdown), so
      a single entry covers all three cases.
      - Path is built by `joinCapturePath(getCaptureDirectory(), filename)`
        — same directory-resolution helper that powers
        **Snapshots directory**. The separator (`/` vs `\`) reuses
        whatever `getCaptureDirectory` returned so the result is
        OS-native and paste-ready in a shell or file manager.
      - Each entry is greyed out (`enabled: false`) when the most recent
        record in `chrome.storage.local` doesn't carry the matching
        field. A storage `onChanged` listener on `LOG_STORAGE_KEY` keeps
        the enable state in sync after every capture and after Clear log
        history (no plumbing from `capture.ts` to `background.ts`).
      - Clipboard write goes through an offscreen document
        (`offscreen.html` + `offscreen.ts`) because MV3 service workers
        can't access `navigator.clipboard`. The document is created on
        demand, posted a one-shot message, and torn down afterward.
        The offscreen page loads its script as a *classic* (non-module)
        script so the message listener registers synchronously during
        HTML parsing — `type="module"` would defer registration past
        the load event and the SW's immediate `sendMessage` would
        arrive with no listener registered. `clipboardWrite` and
        `offscreen` permissions are declared in the manifest.
    - **Snapshots directory** — opens the on-disk capture directory in a new tab.
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
      in-storage capture log *and* overwrites `log.json` on disk
      with an empty file so `/see-what-i-see` et al. see the cleared
      state immediately. Still exposed on
      `SeeWhatISee.clearCaptureLog()` for the devtools console.

  **Top-level item cap.**

  - Chrome enforces `chrome.contextMenus.ACTION_MENU_TOP_LEVEL_LIMIT
    = 6`. Top-level separators count against it.
  - The menu currently has 6 top-level entries (3 undelayed + 3
    submenu parents: Capture with delay, Set default click action,
    and More) — **at the cap**.
  - **Do not add another top-level entry** — nest new items under
    an existing submenu parent (More is the natural home for new
    infrequent utilities).
  - Overflow fails silently via `chrome.runtime.lastError`, so a
    careless addition drops a previously-working entry without any
    build- or runtime-time error. See
    [chrome-extension.md → Context menus on the toolbar action](chrome-extension.md#context-menus-on-the-toolbar-action)
    for the full story, including the 8e100d1 regression this caused.

- **Active-tab resolution.** `captureVisible` always re-queries
  the active tab in the last-focused window *after* any delay,
  then captures that tab and records its URL.

  - This keeps `url` and captured pixels consistent even if the
    user switches tabs, windows, or interacts with a popup during
    the delay.
  - If the focused window isn't a regular browser window with an
    active tab (e.g. DevTools is on top), the query returns
    nothing and the call throws.

- **Error reporting.** Every user-initiated click flows through
  `runWithErrorReporting` in `background.ts`.

  - On failure: swaps the toolbar icon to a pre-rendered error
    variant and slots an `ERROR: …` line under the app title in
    the tooltip.
  - On later success: restores both.
  - See [`chrome-extension.md`](chrome-extension.md) for the
    design rationale (why not badge text, why not
    `chrome.notifications`) and how error icon variants are
    generated.

- **Test hook.** The same capture functions are attached to
  `self.SeeWhatISee` so they can be invoked from the service
  worker devtools console or from Playwright via
  `serviceWorker.evaluate(...)`. This is the only way to drive
  the extension from tests, since Playwright cannot click the
  browser toolbar or open its context menu.
- **Permissions.** The manifest declares `activeTab`, `<all_urls>` host permission,
  `contextMenus`, `downloads`, `scripting`, and `storage`.
  - Both `activeTab` and `<all_urls>` are needed because they serve different trigger
    paths (real toolbar gesture vs. Playwright-driven `evaluate`); dropping either one
    silently breaks one of them.
  - We deliberately do *not* request the `tabs` permission.
  - See [`chrome-extension.md`](chrome-extension.md) for the reasoning and other
    Chrome-specific permission hazards (including why the Chrome Web Store itself
    blocks `captureVisibleTab`).
- **Capture.** `src/capture.ts` provides these capture functions:
  - `captureVisible(delayMs?)` calls `chrome.tabs.captureVisibleTab`
    to get a PNG data URL of the visible tab region and saves it
    directly. `delayMs` runs a countdown (with a toolbar badge)
    before the active-tab lookup so the user can reposition / hover
    during the wait.
  - `savePageContents(delayMs?)` uses
    `chrome.scripting.executeScript` to grab
    `document.documentElement.outerHTML` from the active tab and
    saves it as an HTML file. Same delay semantics as
    `captureVisible`.
  - `captureBothToMemory(delayMs?)` does *both* of the above
    without saving, returning the data for the details flow to
    stash and preview. Same delay semantics.
  - `downloadScreenshot` / `downloadHtml` start a download from the
    pre-captured data; `waitForDownloadComplete` polls until the
    file is on disk and returns its absolute path. The SW caches
    these per-tab so a Copy-button pre-download and the eventual
    Capture share one file each.
  - `recordDetailedCapture` writes the sidecar log entry referencing
    whichever artifacts the caller decided to keep. Splitting the
    download from the record lets the SW materialize files on
    demand (Copy clicks) without committing them to the log until
    the user actually clicks Capture.

  Future variations (full-page stitching, element crop, etc.)
  live here as additional exported functions.

  The `CaptureResult` returned by `captureVisible` and
  `savePageContents` includes the `chrome.downloads` ids of the
  content file and the JSON sidecar (`sidecarDownloadIds.log`):

  - Production callers ignore them.
  - The e2e tests use them to look up each saved file's actual
    on-disk path via `chrome.downloads.search`.
- **Save.** Captures are written via `chrome.downloads.download` into
  `~/Downloads/SeeWhatISee/`.
  - Screenshots are saved as `screenshot-<timestamp>.png`; HTML snapshots as `contents-<timestamp>.html`.
  - The timestamp is `YYYYMMDD-HHMMSS-mmm` (local time, millisecond precision) — fine-grained enough that filenames are always unique in practice.
  - We use the downloads API rather than a native messaging host so v1 has no native dependencies.
  - Trade-off: the directory must live under the user's configured downloads folder.
- **Metadata sidecar.** Alongside the content file, every capture also
  writes a JSON sidecar into the same directory:
  - `log.json` — newline-delimited JSON (one record per line),
    grep-friendly history of recent captures. Scripts use
    `tail -1 log.json` to get the latest record. Every record has
    `timestamp` and `url`, plus optional fields:
    - `screenshot` — `ScreenshotArtifact` object
      `{ "filename": "screenshot-<timestamp>.png", "hasHighlights"?: true, "hasRedactions"?: true, "isCropped"?: true }`,
      set when a screenshot was saved.
      - `hasHighlights` is `true` iff the saved PNG has un-converted
        red markup (boxes, lines) baked into it. Red rectangles the
        user converted to redactions or crops don't count — those
        are reported via `hasRedactions` / `isCropped` instead.
      - `hasRedactions` is `true` iff the saved PNG has at least one
        opaque black redaction rectangle baked in.
      - `isCropped` is `true` iff the saved PNG was cropped to a
        user-selected region (the bytes on disk cover only that
        region, not the full capture). A crop that was dragged
        back out to cover the entire image collapses to "no
        crop" — the flag is omitted and the saved PNG matches
        the original capture.
      - All three flags are independent (any combination can appear)
        and are omitted when false, so presence is itself the
        signal. The see-what-i-see skills check `hasHighlights` and
        steer their attention to the marked regions.
    - `contents` — `Artifact` object
      `{ "filename": "contents-<timestamp>.html", "isEdited"?: true }`,
      set when HTML contents were saved.
    - `selection` — selection artifact object
      `{ "filename": "selection-<timestamp>.{html,txt,md}", "format": "html"|"text"|"markdown", "isEdited"?: true }`,
      set by the More → Capture-selection-as-… shortcuts or the
      details flow when the user picked a format on a
      Save-selection-as-… row. A capture only ever writes one
      selection format; the `format` field is the ground truth
      (the extension mirrors it for human readability).
    - `isEdited` (on `contents` / `selection`) — `true` iff the user
      saved an edit through the corresponding Edit dialog before
      capture. Omitted on the raw scrape. See
      [`isEdited` sidecar flag](#isedited-sidecar-flag).
    - `prompt` — user-entered text from "Capture with details…", omitted
      when empty.

    Screenshot captures emit `{timestamp, screenshot, url}`; HTML
    captures emit `{timestamp, contents, url}`. The detailed-capture
    path can emit any or all of the optional artifact fields —
    including none of `screenshot` / `contents` / `selection`
    (URL-only, typically with a `prompt`). The
    `screenshot.filename` / `contents.filename` / `selection.filename`
    timestamps share the *same* compact local-time suffix so all three
    sort together for a single capture.
    - The Chrome downloads API can only write whole files, so the authoritative log lives in `chrome.storage.local`; `log.json` is a snapshot rewritten on every capture.
    - Deleting `log.json` on disk is harmless — the next capture recreates it from storage. `watch.sh` is also resilient to the whole `~/Downloads/SeeWhatISee/` directory not existing yet (it `mkdir -p`s on startup and polls for `log.json` to appear), so `/see-what-i-see-watch` can be launched before any capture.
    - To clear history, use the **More → Clear log history** context-menu entry on the toolbar icon (or call `SeeWhatISee.clearCaptureLog()` from the service-worker devtools console). Both wipe the `captureLog` key from `chrome.storage.local` *and* overwrite the on-disk `log.json` with an empty file so downstream consumers see the cleared state immediately. `get-latest.sh` treats an empty `log.json` the same as "no captures yet"; `watch.sh` swallows the clear's mtime bump without emitting a blank line.
    - The log is capped at 100 entries (FIFO eviction of the oldest); without a cap, rewriting the whole file on every capture would be quadratic in capture count.
- **Handoff.** A coding agent (Claude Code, etc.) reads the latest file
  from `~/Downloads/SeeWhatISee/`. Four Claude Code plugin skills are
  provided:
    - `/see-what-i-see` — read the latest capture
    - `/see-what-i-see-watch` — background loop that describes each new
      capture as it arrives
    - `/see-what-i-see-stop` — stop the watcher
    - `/see-what-i-see-help` — print a summary of the commands

  Three helper scripts live in `plugin/scripts/` (symlinked from
  `scripts/`):

  - `_common.sh` — shared helpers sourced by the other two:
    directory resolution (config file, `--directory`, default),
    config parsing, and `absolutize_paths` (rewrites bare filenames
    in JSON to absolute paths via sed).
  - `get-latest.sh` — reads the last line of `log.json` and prints a
    single JSON record with absolute paths to stdout. Used by
    `/see-what-i-see`.
  - `watch.sh` — filesystem watcher used by `/see-what-i-see-watch`.
    Detects changes to `log.json` by polling mtime every 0.5s.
    Supports `--after TIMESTAMP` to catch up on missed captures;
    TIMESTAMP is the ISO `timestamp` field from a previous record
    (matched against `log.json`). Emits JSON records with absolute
    paths to stdout; status messages go to stderr.

  All three resolve the download directory the same way: if
  `--directory` is not given, look for a `.SeeWhatISee` config file
  (in `.` then `$HOME`) with a `directory=<path>` setting, falling
  back to `~/Downloads/SeeWhatISee`.

  When a capture has a `prompt`, the skill that consumes it treats
  the prompt as the user's instruction and acts on it directly
  instead of just describing the image. URL-only captures
  (no `screenshot`, no `contents`) let the user send a
  prompt-about-the-URL without attaching any page content.

## Capture with details flow

- A right-click menu entry opens `capture.html` so the user can
  review and annotate the capture before it's saved.
- Implementation lives in `src/background.ts`, `src/capture.html`,
  and `src/capture-page.ts`.

### Pre-capture and tab open

- `captureBothToMemory()` snapshots the screenshot + HTML up-front,
  *before* opening the new tab. This way the preview shows the
  user's current page, not the empty `capture.html` tab.
- `startCaptureWithDetails()` then opens `capture.html` immediately
  to the right of the active tab (`index: active.index + 1`) and
  links it via `openerTabId`.
- The capture data and the opener id are stashed in
  `chrome.storage.session` keyed by the new tab's id, in a
  `DetailsSession` wrapper.

### Graceful handling of failed HTML / selection scrape

- `captureBothToMemory` catches failures from
  `chrome.scripting.executeScript` and returns an `InMemoryCapture`
  with `htmlError` / `selectionError` set instead of throwing.
- Common trigger: restricted URLs (chrome://, the Web Store) where
  extensions can't inject scripts. The screenshot itself still
  succeeds via `chrome.tabs.captureVisibleTab`.
- Impact on the details flow:
  - The details page still opens with the screenshot preview.
  - Save HTML and the master Save-selection checkbox are
    disabled + unchecked; their Copy and Edit buttons are hidden
    (the shared `.copy-btn:disabled` rule covers both).
  - The `.selection-formats` wrapper around the three format
    radios stays hidden whenever no selection has saveable
    content — so scrape failures simply show no format rows.
  - The error icon + tooltip is shown only on the Save HTML row.
    Selection is scraped in the same `executeScript` call as
    HTML, so when the call fails the errors are always twins and
    a duplicate icon on the master row would just repeat the
    same message. The master row stays greyed out without an
    icon; the wiring is ready for a future SW that reports
    per-format failures separately (each format row keeps its
    own `#error-selection-{html,text,markdown}` element) but
    today's `captureBothToMemory` never emits that combination.
  - Hotkeys (Alt+H, etc) are no-ops while the corresponding
    control is disabled.
  - `ensureHtmlDownloaded` / `ensureSelectionDownloaded(format)`
    throw if the matching `*Error` is set (or the requested
    format's body trims to empty), as a belt-and-suspenders
    guard so a stale page message can't materialize an empty
    file.
- Impact on the More-menu shortcuts:
  - `capture-url` (URL-only) deliberately ignores `htmlError` —
    it doesn't need HTML anyway.
  - `capture-both` (screenshot + HTML) re-throws `htmlError` so
    the toolbar icon / tooltip surfaces the reason via the
    standard error-reporting channel.

### What the page shows

- **Captured URL** — read-only single-line monospace input.
- **HTML byte size** — `formatBytes(new Blob([html]).size)` →
  `B` / `KB` / `MB` / `GB` / `TB`.
- **Save checkboxes** — pick any of screenshot, HTML, selection
  (one format), or none (URL-only record).
  - Save selection is a master checkbox (`Save selection`) plus a
    group of three mutually-exclusive format radios (`as HTML`,
    `as text`, `as markdown`). The master gates whether anything
    is saved; the radios pick which serialization.
  - Master / radio coupling, wired in `wireSelectionControls()`:
    - Clicking a radio also checks the master (picking a format
      implies "save the selection").
    - Unchecking the master clears all three radios.
    - Re-checking the master restores the last-picked format (or
      the default — first non-empty format — on the first check).
  - Each radio enables independently based on the presence of
    non-empty content in that format (an image-only selection
    enables HTML but leaves text / markdown disabled with a
    per-row "no {format} content" error icon). Each format row
    has its own `Copy filename` + `Edit` buttons — the user can
    materialize or edit any format independent of which one ends
    up getting saved.
  - Save HTML and the whole selection group can also be greyed
    out because the scrape itself failed (see
    [Graceful handling of failed HTML / selection scrape](#graceful-handling-of-failed-html--selection-scrape)).
    In that case the master row shows a hoverable red error icon
    whose tooltip explains the reason.
  - Hotkeys: `Alt+S` toggles screenshot, `Alt+H` toggles HTML,
    `Alt+N` toggles the master Save-selection checkbox (triggering
    the coupling above), and `Alt+L` / `Alt+T` / `Alt+M` pick the
    selection format (HTML / text / markdown respectively), also
    auto-checking the master. All are no-ops when their control
    is disabled. Holding Shift suppresses every Alt hotkey so the
    user can still type shifted letters in other focus paths.
- **Prompt** — auto-growing textarea (capped at 200px). Enter
  submits, Shift+Enter inserts a newline.
- **Highlight overlay** — see [Image annotation](#image-annotation).
- **Preview image** — fits 90% of body width and shrinks vertically
  via JS-managed `max-height` so the page never scrolls.

### Image annotation

The screenshot preview is wrapped in an SVG overlay where the user
can draw red markup on the regions they want the agent to focus on,
and optionally convert drawn boxes into opaque redactions or the
active crop region.

- **Left-click-drag** — draws a 3px-bordered red rectangle.
- **Right-click-drag** — draws a 3px red line. The browser context
  menu is suppressed on the overlay.
- **Redact button** — converts the most recent unconverted red
  rectangle in the stack into an opaque black box. Hides whatever
  was underneath in the saved PNG. Disabled when no unconverted red
  rectangle exists. Each click converts one box, so repeated clicks
  walk backward through the stack.
- **Crop button** — converts the top-of-stack red rectangle into
  the active crop region; everything outside dims in the preview
  and the saved PNG is reduced to just that region. Disabled
  unless the top of the stack is an unconverted red rectangle, so
  a crop always applies to the box the user just drew.
- **Drag-to-crop** — the four edges and four corners of the image
  (or the active crop, when one exists) are draggable handles.
  Hovering one flips the cursor to the matching resize cursor; a
  drag inward commits a new 'crop' edit on the stack. Each drag is
  its own undoable step, so resizes nest naturally — Undo peels
  back one resize at a time rather than collapsing them.
- **Undo / Clear** — single edit-history stack; disabled when
  empty. Undo reverses both draws and conversions — popping a
  conversion turns the box back into a red rectangle.
- Edits are stored as percentages of the image dimensions so they
  stay aligned across window resizes and prompt growth.
- Every button carries a `title` tooltip explaining what it does,
  shown on hover even while disabled.

### Edit dialogs (template-driven)

- Pencil icons sit next to each editable artifact's Copy button in
  the capture page — currently HTML plus one per selection format
  (HTML, text, markdown); more kinds can be added without new dialog
  markup.
- A single `<template id="edit-dialog-template">` in `capture.html`
  supplies the modal structure. `capture-page.ts::createEditDialog`
  clones it per kind and stamps `edit-${kind}-${role}` ids onto the
  inner elements so e2e tests can target a specific kind without
  knowing the full catalog.
- `EDIT_KINDS` in `capture-page.ts` is the catalog — one entry per
  editable kind with its pencil button, title, and optional
  `onSaved` hook (e.g. HTML's size-readout refresh). Adding a kind
  is one entry + one markup button.
- Per-kind behavior:
  - Open: seeds the textarea from the page's `captured[kind]`
    mirror, clears any prior error, focuses the textarea at the top.
  - Save: no-op when the body is unchanged; otherwise posts
    `{ action: 'updateArtifact', kind, value }` to the SW and runs
    the per-kind `onSaved` hook on success. Errors surface inline
    in a `role="alert"` region.
  - Cancel / Escape: closes without touching anything.
- SW-side `updateArtifact` handler:
  - Dispatches on `msg.kind` via the `EDITABLE_ARTIFACTS` spec
    table — each entry declares how to commit the new body to
    `DetailsSession.capture` and which `session.downloads` entry to
    drop. New kinds add one entry.
  - Writes the body, sets the sticky `session.{html,selection}Edited`
    flag, and drops the matching `session.downloads.{html,selection}`
    entry so the next `ensureHtmlDownloaded` /
    `ensureSelectionDownloaded` re-materializes the file under the
    same pinned filename (via `conflictAction: 'overwrite'`).
  - The eventual Save — whether Capture clicks or a later Copy —
    therefore writes the edited content.
- Only the HTML body and the three selection-format bodies are
  editable; the screenshot has no text-edit UI (the highlight
  overlay covers its annotation use case). The three selection
  formats edit independently — editing the markdown version
  doesn't retranslate the HTML body, and vice versa — but only
  the format the user picks on the Save-selection-as-… radio
  ends up in `log.json`.

#### Preview mode (HTML / markdown dialogs)

- Three dialogs expose an Edit / Preview segmented toggle next to
  the title: **Page contents HTML**, **Selection HTML**, and
  **Selection markdown**. `EDIT_KINDS` marks each via `preview:
  'html' | 'markdown'`; selection-text (plain text) stays
  edit-only.
- Edit is selected on open; `setMode()` swaps between the textarea
  and a sandboxed preview iframe positioned absolutely inside
  `.edit-dialog-body`. The textarea stays in the DOM with
  `visibility: hidden` in Preview so its resized height keeps
  defining the slot — dialog dimensions can't jump across modes.
- Pipeline:
  - HTML kinds pass the textarea value straight into
    `buildPreviewHtml()`.
  - Markdown kind first calls `renderMarkdown()` (which delegates
    to `window.marked.parse()` from the UMD bundle loaded by
    `capture.html`), then feeds the HTML into `buildPreviewHtml()`
    so the same sanitizer + charset + base-href wrapping applies.
- `buildPreviewHtml()` assembles the previewed document:
  - Parses the HTML via `DOMParser('text/html')` (tolerant parser
    — malformed HTML still yields a full document).
  - Removes `<script>` tags (defense-in-depth; sandbox already
    denies `allow-scripts`) and `<meta http-equiv="refresh">` tags
    (the one remaining vector by which captured HTML could hijack
    the preview iframe to an attacker URL without JS). Raw HTML
    embedded in markdown passes through marked, so this stripping
    matters for the markdown preview too.
  - Strips any existing `<meta charset>` / `Content-Type meta` and
    injects `<meta charset="utf-8">` as the first child of `<head>`
    so non-ASCII captures don't render as mojibake (Chrome falls
    back to Windows-1252 for blob: HTML with no declared charset).
  - Strips any existing `<base>` and injects one with the captured
    page's URL + `target="_blank"` so relative URLs resolve and
    link clicks open in a new tab instead of replacing the preview.
- The assembled HTML is loaded as a `blob:` URL (`text/html;charset=utf-8`),
  not `srcdoc`, because `srcdoc` is an HTML attribute with a
  browser-dependent size limit that silently truncates large
  captures to blank. The blob is revoked on every mode flip and on
  the dialog's `close` event.
- Iframe sandbox: `allow-popups allow-popups-to-escape-sandbox`
  only. Scripts, forms, same-origin, and top navigation are all
  denied; link clicks via `target="_blank"` open a normal new tab
  that escapes the sandbox so it behaves like a regular browser
  tab.
- `marked` ships as `dist/marked.umd.js`, copied from
  `node_modules/marked/lib/marked.umd.js` by `scripts/build.mjs`
  and loaded as a classic `<script>` before `capture-page.js`. UMD
  (not ESM) because `capture-page.ts` compiles to a non-module
  script — `import` would force a module-worker rewrite of how
  the extension page is wired up.

### `isEdited` sidecar flag

- Emitted inside `contents` / `selection` artifact objects in
  `log.json` whenever the user saved an edit through the
  corresponding dialog and then kept the artifact on the details
  page — i.e. the artifact carries `{ "filename": "…", "isEdited":
  true }` instead of the bare-filename object.
- Sticky per session: once the user has saved an *actual change*
  through the dialog (an unchanged-textarea Save is a no-op and
  doesn't flip the flag), later saves on the same details tab carry
  `isEdited: true` regardless of whether they edit again — the
  on-disk body *is* the edit.
- Omitted on unedited records, matching the `screenshot.hasHighlights`
  policy where presence is itself the signal.
- Intended to let downstream consumers (e.g. the see-what-i-see
  skills) distinguish "this is the raw page scrape" from "the user
  reshaped this before handing it off."

### Copy-filename buttons

- A small icon button sits next to each Save checkbox.
  - Tooltip: `Copy filename`.
  - Click writes the file's path to the clipboard via
    `navigator.clipboard.writeText` (extension pages have direct
    clipboard access — no offscreen helper involved here, unlike
    the SW's Copy-last-… menu entries).
- Each click materializes the file on disk via the SW's
  `ensureScreenshotDownloaded` / `ensureHtmlDownloaded` /
  `ensureSelectionDownloaded` helpers, then puts the file's **real
  on-disk path** on the clipboard. The user always gets a valid
  path — there's no "the file doesn't exist yet" caveat.
- Per-tab download cache lives on `DetailsSession.downloads`. Repeat
  Copy clicks short-circuit on a cache hit; the eventual Capture
  click also goes through the same helpers, so files already
  pre-downloaded by Copy aren't re-written.
  - Screenshot cache is keyed by an `editVersion` — a monotonic
    counter the page bumps on every highlight draw / undo / clear.
    On mismatch the SW re-downloads with the page's freshly
    baked-in PNG (sent as `screenshotOverride` in the message).
  - HTML cache is unconditional until the user edits the body via
    the Edit HTML dialog — `updateArtifact { kind: 'html' }` clears
    the cache so the next Copy / Capture writes the edited content.
  - Selection cache follows the same pattern as HTML: unconditional
    until the user edits the body via the Edit selection dialog,
    which fires `updateArtifact { kind: 'selection' }` to clear the
    cache.
- Filenames are pinned at capture time in `captureBothToMemory`
  (`screenshotFilename` / `contentsFilename` / optional
  `selectionFilename` on `InMemoryCapture`) and reused by every
  download in the session.
  - Side-effect: the saved record's `timestamp` and the embedded
    local-time filename suffix both describe when the screenshot
    was *taken*, not when the user clicked Save.
  - All re-downloads use `conflictAction: 'overwrite'`, so a
    re-download under the same pinned filename rewrites the
    on-disk file rather than producing `screenshot-… (1).png`.
- Orphan-file trade-offs. Copy and Capture have decoupled
  semantics: Copy materializes a file; Capture writes the log
  entry. As a result, two scenarios leave on-disk files with no
  log entry:
  - User clicks Copy and then closes the details tab without
    clicking Capture.
  - User clicks Copy on (say) the screenshot, then unchecks the
    Save screenshot checkbox before clicking Capture. The log
    record gets no `screenshot` field, but the file from the Copy
    step is still on disk.
  - In both cases this is intentional: the user explicitly opted
    into a file via the Copy click. We don't proactively delete
    via `chrome.downloads.removeFile` because the user can move /
    rename the file between Copy and Capture, and we don't want
    to chase it.

### Save and close

- On Capture click, if there are any edits *and* the screenshot is
  being saved, the page bakes the SVG overlay onto a `<canvas>` at
  the screenshot's natural resolution and produces a fresh PNG data
  URL.
  - Red rectangles and lines stroke at 3px, scaled by the
    display→natural ratio so they look the same in the saved
    file as during editing.
  - Redactions paint as solid black fills.
  - If an active crop exists, the canvas is sized to the crop
    region (not the full image) and every edit's coordinates are
    translated into the cropped frame before being drawn — so the
    saved PNG is the cropped region with the remaining markup and
    redactions on top.
- The page sends a `saveDetails` runtime message back to the
  background with the selected save options, the prompt, three
  per-kind edit flags (`highlights`, `hasRedactions`, `isCropped`
  — see below), the current `editVersion`, and the
  `screenshotOverride` data URL when present.
  - `highlights` is `true` iff at least one un-converted red
    rectangle or line survives on the preview. Rectangles the
    user converted to redactions or crops flip their own flag
    (`hasRedactions` / `isCropped`) instead, not `highlights`.
  - `hasRedactions` is `true` iff any redaction rectangle is
    baked into the PNG.
  - `isCropped` is `true` iff a crop region is active and the
    saved PNG covers only that region.
  - All three are only meaningful when the screenshot is
    actually being saved; they're forced to `false` when the
    Save screenshot checkbox is unticked.
- The background runs each requested artifact through the same
  `ensureScreenshotDownloaded` / `ensureHtmlDownloaded` /
  `ensureSelectionDownloaded` helpers that powered any earlier
  Copy clicks — so a file pre-downloaded by Copy (at the same
  `editVersion` for screenshots) is *not* re-written, and the
  on-disk file from the Copy step is what the log entry references.
  Then `recordDetailedCapture` writes the sidecar. The saved
  sidecar record can include any of `screenshot`, `contents`,
  `selection`, and `prompt`, on top of the always-present
  `timestamp` and `url`. Each artifact object can carry per-kind
  flags: `screenshot.hasHighlights`, `screenshot.hasRedactions`,
  `screenshot.isCropped`, `contents.isEdited`,
  `selection.isEdited`. It's valid to save with no checkboxes
  ticked — the record then carries just the URL (and any prompt).
- After the save resolves, the background re-activates the opener
  tab and then removes the details tab — the user lands back on
  the page they captured from. Chrome's natural close-time pick is
  not reliably the immediate right neighbor (we tested this and
  Chrome activated a tab two positions right of the closed slot in
  the headless e2e environment), so the explicit re-activation is
  required for deterministic behavior. `openerTabId` alone has no
  effect on close-time focus.

See [`chrome-extension.md`](chrome-extension.md) for the
runtime-message and session-storage hazards (CSP, SW idle-out,
permission gaps).

## Why a separate `dist/`

- `src/` holds TypeScript and the manifest template.
- `npm run build` compiles to `dist/` and copies the manifest and icons across.
- Chrome loads the extension unpacked from `dist/`.
- Keeping sources and build output separate means the loaded extension is always the result of an explicit build, which matches what Playwright tests run against.

## Adding a new capture mode

1. Add a new exported function to `src/capture.ts` (e.g.
   `captureFullPage`). If delayed variants are wanted, accept an
   optional `delayMs` and call `countdownSleep(delayMs)` before
   the real work, matching `captureVisible` /
   `savePageContents` / `captureBothToMemory`.
2. Register it on `self.SeeWhatISee` in `src/background.ts` so it
   is reachable from tests and the devtools console.
3. Add a new entry to the `BASE_CAPTURE_ACTIONS` array in
   `src/background.ts` with a base id, base title, a
   `baseTooltipFragment` (sentence-case, no trailing "…" —
   slotted into the toolbar tooltip's `Click: …` /
   `Double-click: …` lines), a `group: 'primary' | 'more'`, and
   a `run(delayMs)` that calls
   your new function. The flat `CAPTURE_ACTIONS` array is generated
   from `BASE_CAPTURE_ACTIONS × CAPTURE_DELAYS_SEC` at module load,
   so the new base automatically gains immediate + 2s + 5s variants
   in whichever menu sections its `group` unlocks, plus the
   corresponding "Set default click action" entries. Set
   `supportsDelayed: false` when delayed variants don't make sense
   for the mode (only the 0s variant is then generated). No other
   plumbing.
   - **Pick the group deliberately.** `'primary'` promotes the
     undelayed variant to a top-level slot and surfaces delayed
     variants in the "Capture with delay" submenu — right for
     primary capture paths. `'more'` tucks the undelayed variant
     into the "More" submenu and only exposes delayed variants via
     "Set default click action" — right for shortcuts / niche
     modes that shouldn't crowd the top level.
   - **Watch the top-level cap.** Chrome allows at most
     `ACTION_MENU_TOP_LEVEL_LIMIT = 6` top-level items per action
     context menu, and separators count. The menu is currently at
     6 (3 primary undelayed entries + Capture with delay + Set
     default + More) — **at the cap**. Any new `'primary'` base
     would push it past 6 and silently drop an entry; add the base
     as `'more'` instead, or fold the undelayed primary slots into
     a submenu of their own (e.g. "Capture now") first.
4. Add a Playwright test that drives the new function via
   `serviceWorker.evaluate`.
