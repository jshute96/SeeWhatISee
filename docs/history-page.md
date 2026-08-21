# History page

A table view over the capture log — the same `captureLog`
array in `chrome.storage.local` that backs the on-disk `log.json`
sidecar (see [architecture.md](architecture.md) for the log itself).

- Read-only with respect to the log. The one action it offers is
  [Restore from a row](#restore-from-a-row).

- Files: `src/history.html` + `src/history.ts`.

## Opening it

Two entry points, both landing on `openHistoryPage()` in
`background/history-page.ts`:

- **History** on the toolbar icon's right-click menu — a top-level
  row directly above the *More* submenu. `background.ts` calls the
  helper directly. (It is not duplicated inside *More*; see
  [capture-actions.md → Top-level item cap](capture-actions.md#top-level-item-cap),
  which the top level now sits exactly at.)
- The **History** button in the app-header of the Capture and Options
  pages — see [options-and-settings.md → Shared header button
  group](options-and-settings.md#shared-header-button-group).
  - Those pages send `{ action: 'openHistoryPage' }` rather than
    opening a tab themselves.
  - They can't call the helper directly: `options.ts` is a classic
    script and can't `import` at all.

### Reusing the open tab

`openHistoryPage()` focuses an already-open History tab (and its
window) rather than stacking a second one — the page is a read-only
view that live-updates from storage, and the header button sits on
pages the user bounces between.

Finding that tab is less obvious than it looks:

- **`chrome.tabs.query({ url })` does not work here.** The `url`
  filter only matches tabs whose URL the extension may see, and
  `tab.url` is populated only with the `"tabs"` permission or a host
  permission covering that URL. We have neither for
  `chrome-extension://` — `<all_urls>` doesn't span that scheme — so
  every `tab.url` reads `undefined` and the query returns `[]`.
  - It fails *silently*: you simply get a new tab every time.
  - `"tabs"` would fix it by granting read access to every tab URL in
    the browser — wildly disproportionate for focusing our own page.
- **So the page identifies itself.** On load `history.ts` sends
  `{ action: 'historyPageReady' }`; the SW stores `sender.tab.id` under
  `historyTabId` in `chrome.storage.session` (session, because a tab id
  is meaningless after a browser restart but must survive an SW
  respawn).
- **And the SW pings before reusing.** A stored id goes stale two ways
  — tab closed (ids can even be reused), or the user navigated it
  elsewhere — and without `tab.url` those are indistinguishable. So the
  SW sends `pingHistoryPage` to that tab; only a live History page
  answers. Any failure means open a fresh tab.
- Registering from the page rather than recording the id from
  `tabs.create` also covers History tabs we didn't open — a session
  restore, or a reload from browser history.

## Data source

- Renders entirely from `chrome.storage.local` plus
  `chrome.downloads.search`. Both are available to any extension page,
  so no service-worker round-trip is needed to draw the table. (The SW
  is involved only in *opening* the page — see above.)
- Loaded as a **module** script (unlike `options.ts`, a classic
  script) so it can import the storage key from `capture/log-store.js`
  and the directory / path helpers from `capture/downloads.js` instead
  of restating them.
- `imageUrl` (the source-image URL on image-context and Upload
  captures) is deliberately not shown or searched — the Page column
  carries the captured tab's URL. Such a record can therefore show
  *N/A* under Page while still holding an `imageUrl`.
- Records come out oldest-first (append order) and are reversed for
  display — newest at the top.
- A `chrome.storage.onChanged` listener re-reads the log, so a capture
  taken (or a *Clear log history*) while the tab sits open updates it
  in place.
- The in-storage log is capped at 100 entries by `log-store.ts`, so the
  live view never has to paginate. Older captures are loaded on demand
  — see below.

### Older captures

- Captures that age out of storage are archived to
  `history-*.json` files on disk (see [architecture.md → Archived
  logs](architecture.md#archived-logs)). The page reads them back so
  the table can cover the whole history, not just the buffer.
- **Load older captures** sits under the table — where the rows it adds
  go — with a count of archive files not yet read.
  - Opt-in rather than automatic: reading them is a `file://` fetch,
    which is gated by the same **Allow access to file URLs** toggle as
    the thumbnails, and a long history is a lot of rows to render for a
    user who only wanted the recent ones.
  - One click loads *all* remaining files. A batch is 50 captures, so
    paging 50 at a time would be tedious; the search box is the tool
    for narrowing what's on screen.
- `getArchiveFilePaths()` (`capture/downloads.ts`) finds the files
  through `chrome.downloads`, because an extension has no directory
  listing — the download records are the only index of what we wrote.
  - Clearing download history therefore hides archives that are still
    on disk. The offer shrinks; nothing claims those records are gone.
    - Files already read stay on screen. Losing the listing doesn't
      make the records wrong, and dropping those rows would make
      captures vanish for a reason unrelated to them. They sort after
      the still-listed files (`archiveDisplayOrder`).
- Merging is a plain concatenation: the storage log, then each archive
  file's records, files in `getArchiveFilePaths()` order (newest first
  by download start time). No sort; dedup only on exact record text.
  - **Not sorted by `timestamp`.** File order is *append* order, which
    isn't timestamp order: a Capture-page session pins its timestamp
    when it opens, so a record saved later can carry an earlier stamp
    than one appended before it. The live log has always been shown in
    append order (`[...log].reverse()`), so archives match it — sorting
    would reorder rows the page has always shown as-written.
  - **Deduped on exact record text only** (`dedupeRecords`), keeping
    the first occurrence.
    - The case it's for is *Restore last capture* re-saved unchanged.
      Restore rehydrates a session with its pinned timestamp and
      filenames, so `recordDetailedCapture` writes a record identical
      to the previous one, pointing at the same files — two rows the
      user can't tell apart, for one capture they re-sent.
    - Global, not adjacent-only: the copies can be separated by other
      captures, or split across the storage/archive boundary.
    - `serializeRecord` supplies the key, not `JSON.stringify` —
      `chrome.storage.local` doesn't preserve key order, so only a
      canonical field order compares equal.
    - **Nothing looser.** Keying on `timestamp` shipped a bug: a
      timestamp doesn't identify a record, so one session's six saves
      (`…-733.png`, `…-733-1.png`, …) collapsed to a single row and
      102 records rendered as 96.
    - The log files themselves keep every save; this is display only.
  - Files are keyed by path, not accumulated into one list, so an
    archive written *after* others are loaded lands ahead of them
    rather than at the end.
  - A line that won't parse is skipped (`parseLogText`) rather than
    failing the file: these sit in the user's Downloads folder where
    they can be edited or truncated.
- A capture taken while the tab is open can itself trigger a flush. The
  storage listener re-reads the archive list, and re-reads the files
  too if the user already opted in — otherwise records would appear to
  vanish as they aged out of storage.
- Failures are **per file**: whatever read is merged and marked read,
  and the note reports how many didn't.
  - All-or-nothing would let one dead file — deleted outside the
    browser, so the download record's stale `exists` still lists it —
    veto every other archive, permanently, since retrying wouldn't
    heal it.
  - The transient case still retries in full: with the file-URL toggle
    off *every* read fails, so nothing is marked read.
  - `res.ok` is checked. A missing file can resolve non-ok, which would
    otherwise pass as a successful read of an empty archive and drop 50
    captures off the page with no error.
- The "No captures in the log yet" notice is suppressed while unread
  archives exist — after a *Clear log history* on a long-running
  install it would sit directly above an offer to load 40 files.
- A *Clear log history* also drops the archived rows already loaded
  into the tab, so the page reflects the clear instead of leaving
  hundreds of rows under an emptied log. The files are untouched, so
  the button just offers them again.
  - A read still in flight when that happens is disowned via a
    generation counter — merging its results afterwards would put the
    cleared rows straight back on screen.
- Not covered by the e2e tests: Playwright rewrites every download into
  its own artifacts directory under a UUID, so a real capture's archive
  never matches the path `getArchiveFilePaths()` searches for. The
  archiving side is tested; the load side isn't.

## Layout

- Sticky shell: header bar, then a non-scrolling toolbar row (so the
  search box stays put), then the table scrolling inside `<main>`.
- The table's header row is sticky. Two non-obvious consequences:
  - `<main>` carries **no top padding** — padding there would be a
    strip above the pinned header that rows stay visible in as they
    scroll past.
  - The table uses `border-collapse: separate` with zero spacing.
    Under `collapse` the borders belong to the table rather than the
    cells, so they stay behind while the sticky `<th>`s travel and the
    header loses its outline.
- `table-layout: fixed`. Under auto layout the column widths are only
  *suggestions* — the browser hands leftover space out across every
  column, so on a wide window the screenshot column drifts well past
  its declared width and stops matching the thumbnails.
- Two CSS custom properties keep the sizes that must agree in lockstep.
  Resize the thumbnails by changing these two numbers and nothing else:
  - `--thumb-w` — the thumbnail `max-width` **and** the screenshot
    column's width. A fixed column can't shrink to its content, so any
    difference between the two shows up as dead space down the right of
    every row.
  - `--thumb-h` — the thumbnail `max-height` **and** the `.scroll-box`
    cap on the Prompt and Page cells, so nothing in a row outgrows the
    screenshot beside it.

## Columns

| Column | Contents |
|--------|----------|
| Date | Local date over local time, from the record's UTC `timestamp`; plus the Restore button on the one restorable row |
| Screenshot | Browser-scaled thumbnail of the saved PNG, linked to the full-size file |
| Files | One link per saved HTML / selection artifact; the selection link names its format |
| Page | Captured tab's title over its URL (the URL links back to the live page) |
| Prompt | Capture-page prompt text |

- Any column with nothing to show renders a greyed *N/A* — no
  screenshot saved, no prompt entered, no URL/title available.
- Column widths are honoured exactly (`table-layout: fixed`), so each
  narrow column is sized to its widest possible value plus a few px,
  and Prompt absorbs the remaining width.
  - Date 100px — *12:30:59 PM* is wider than any date line.
  - Files 116px — *Selection (html)*. No `nowrap`, so a wider platform
    UI font wraps the label instead of spilling into Page.
  - Re-measure before changing either; don't eyeball it on a scaled
    display, where every column looks proportionally wider.
- The Prompt and Page cells share a `.scroll-box` capped to the
  thumbnail height, so no row grows taller than its own screenshot.
  Both scroll internally.
  - Page needs it for search URLs carrying a wall of tracking
    parameters — a dozen wrapped lines, none of it past the origin and
    path worth reading in a table.
  - The cap is on an inner `<div>`, not the `<td>`: `overflow` on a
    table cell isn't reliably honoured.

## Restore from a row

A **Restore** button under the timestamp in the Date cell, on the one
row that *Restore last capture* would re-open. Same action as the
More-submenu entry (see [capture-page.md → Restore last
capture](capture-page.md#restore-last-capture)) — the tooltip says so.

### Finding the row

- Each Capture-page save stashes `serializeRecord` of the `log.json`
  record it just wrote on its session, as `logKey`. That rides into
  the `lastCapture` slot on close like any other session field.
- The page renders the button on the row whose `serializeRecord`
  equals that key. **At most one row can match**: `mergedRecords` is
  deduped on exactly this key, so byte-identical records have already
  collapsed into one.
- **Not "the newest row".** Cases that break that shortcut:
  - The quick-capture menu entries (`capture-actions.ts`) write log
    rows without ever opening a Capture page, so they never touch
    `lastCapture`. Any number of them can stack above the restorable
    row. This is the common case.
  - A shift-click save keeps its Capture page open and so never
    promotes, which lets a newer row sit above the restorable one.
  - A capture closed without ever saving has no row at all. It's still
    restorable from the menu; `logKey` is simply absent, so no row
    lights up.
- The row is the one the session **last wrote**, which isn't always
  what the restored page will show: shift-click save, then edit the
  prompt, then close without saving, and the button sits on a row
  carrying the older prompt while the restored page opens with the
  newer one. The slot is the authority on what comes back.
- Keying on anything looser is not an option — a record's `timestamp`
  does not identify it. Same reasoning as `dedupeRecords`; see
  [Older captures](#older-captures).
- Archived rows are matched too. The key is computed per rendered
  record, so a restorable capture that has aged out of storage still
  gets its button once the archives are loaded.

### Plumbing

- The page **can't read the slot itself**: `lastCapture` lives in
  `chrome.storage.session` under a key owned by
  `background/last-capture.ts`, and importing that module would pull
  the whole capture module graph into the page (no bundler — pages
  load the compiled modules directly).
- So the SW hands it over:
  - The `historyPageReady` reply carries the initial `logKey`, reusing
    the round trip the page already makes to register its tab id.
  - `notifyHistoryPageRestorable()` pushes `restorableCaptureChanged`
    afterwards, driven from the same `chrome.storage.onChanged`
    listener in `background.ts` that re-enables the menu entry — so
    every writer of the slot is covered without per-writer plumbing.
  - The push pings with `historyTabAlive` first, the same guard
    `openHistoryPage` uses. A stored tab id can belong to an unrelated
    tab, and the payload carries the captured URL, title and prompt.
  - Both are best-effort. A failure costs the button, nothing else.
  - **The push wins any race with the reply.** The SW reads the slot
    before it replies, so a change in that window travels down the
    other channel, and the page can't order the two. Once a push has
    landed the page ignores the reply (`sawRestorablePush`).
- The click goes back as `restoreLastCaptureFromHistory` →
  `restoreLastCapture(sender.tab)`. The History tab is the opener, so
  the Capture page opens beside it and returns focus there on close.
- The button disables itself for the round trip and **stays** disabled
  on success: a restore consumes the slot, so the push that follows
  takes the button off the row. Only a failure re-enables it (with the
  reason in the tooltip).
  - The in-flight flag is module state, not the element's `disabled` —
    `render()` rebuilds every row, so a re-render mid-restore would
    otherwise hand back a live button. The push clears it.
  - An **empty slot counts as a failure**, which is why
    `restoreLastCapture` returns a boolean. Reporting `ok` for a
    restore that opened nothing would strand a disabled button on a
    row with nothing behind it — reachable whenever the page's view of
    the slot is stale, which the best-effort push allows.
- Errors surface in the button's tooltip, not through
  `runWithErrorReporting` (the toolbar-icon error surface the menu
  entry uses). The user is looking at the History page; that is where
  the answer belongs.

## File links and `file://`

- Saved files live under `<downloads>/SeeWhatISee/`, so the only way
  to reference them from a page is a `file://` URL.
- The directory is resolved with the shared `getCaptureDirectory()`
  helper in `capture/downloads.ts` (also used by *Snapshots
  directory*), which derives it from the `log.json` download record.
- Thumbnails are plain `<img src="file://…">`. The browser loads the
  PNG itself; nothing reads the bytes into the extension, so there is
  no size limit to worry about and `loading="lazy"` keeps offscreen
  rows free.
- Chrome blocks `file://` subresources unless the user enables **Allow
  access to file URLs** for the extension. The page renders the
  thumbnails/links regardless — the rest of each row is useful either
  way.

### The file-access banner

- Amber banner under the search box (outside the scrolling `<main>`,
  so it can't scroll away from the rows it explains), shrink-wrapped
  to its own text with `width: fit-content`.
- Shown only when all of: the toggle is off
  (`chrome.extension.isAllowedFileSchemeAccess()`), the capture
  directory resolved, and some record references a file. Any of those
  missing means flipping the toggle would change nothing.
- Keyed off the whole log, not the search-filtered subset — it
  describes a standing browser setting, so blinking in and out while
  typing would read as a glitch.
- The *extension settings* link opens `chrome://extensions/?id=<runtime.id>`,
  the details page that actually carries the toggle (our own Options
  page does not).
  - It's a real `<a href>` — hover shows the destination and
    right-click → Copy link address works — but the click is
    intercepted: Chrome blocks page-initiated `chrome://` navigation,
    so the open runs through `chrome.tabs.create`, the same call the
    Options page's *Edit shortcuts* button makes.
  - `history.ts` assigns the `href` from the same constant it passes
    to `tabs.create`, so the two can't drift.
  - Looking like a real link invites real-link gestures, and the ones
    that skip `click` would hit the blocked href and do nothing. So
    `auxclick` is handled too (middle-click → background tab), and
    ctrl/⌘-click opens in the background rather than stealing focus.
    Enter/Space fire `click`, so keyboard needs nothing extra.
- Two graceful degradations, and the Screenshot and Files columns
  must agree on both — they fail for the same reasons, so a filename
  in one column beside a live link in the other just looks broken:
  - Directory unresolvable (no capture has been written yet): no
    `file://` URL exists, so both columns show a greyed, unlinked
    label (filename / "HTML" / "Selection (md)").
  - Thumbnail fails to load anyway — the toggle is off, or the
    download records don't know the file (deletion is caught earlier,
    see below). The `<img>` is swapped for the filename **inside the
    surviving `<a>`**, so there's no unexplained broken-image icon.
  - The `<a>` stays because its href is the last useful thing on the
    row: right-click → Copy link address still works. Files-column
    links stay links for the same reason — and they have no load event
    to react to anyway.

### Deleted files

- `getCaptureFileExistence()` (`capture/downloads.ts`) reads
  `DownloadItem.exists` for what we've written under `SeeWhatISee/`,
  giving a bare-filename → still-there map. Chrome's query caps at its
  default 1000 newest records, so a very long history truncates — into
  *unknown*, which renders normally.
- Needed because an `<img>` error carries no reason (deleted? toggle
  off?) and the Files-column links have no load event at all. This is
  the only signal that works for both columns.
- A filename **absent** from the map is *unknown*, not deleted — the
  user can clear their download history without touching the files.
  Those render as normal links.
- The newest record wins per filename — `conflictAction: 'overwrite'`
  leaves several pointing at one path. Only `state: 'complete'` records
  answer; an in-flight download reports `exists: false`, so if the
  newest record is still writing the name reads as unknown rather than
  letting an older record call a live file deleted.
- Keyed on the bare filename because `compactTimestamp` makes capture
  filenames unique; `log.json`, the one reused name, is never rendered.
- A known-deleted file renders as the greyed unlinked label with a
  `(deleted)` marker on its own line, nested inside that artifact's
  element so a row listing two files says which one is gone. The
  screenshot column skips the `<img>` entirely rather than loading it
  to watch it fail.
- Refreshed on `chrome.downloads.onChanged` deltas that carry
  `exists`, so a file deleted while the tab is open updates in place.
  - Also the delayed half of the read: `exists` can be stale, and it's
    the `search()` call that prompts Chrome to re-check, with the
    answer arriving as one of these events.
  - Coalesced on a 500ms timer. The delta carries only a download id,
    so we can't cheaply tell our downloads from anyone else's, and one
    re-check sweeps the directory and rebuilds every row — deleting a
    folder of captures would otherwise fire one sweep per file.
- "Deleted" is the plain-language reading: strictly, the file is no
  longer at the path we wrote it to, which also covers a move.

## Search

- Single box at the top, filtering as you type.
- Every whitespace-separated term must appear in the record's URL,
  title, or prompt (case-insensitive substring) — so `github review`
  narrows to captures mentioning both, in either field, in either
  order.
- The count line next to the box reads `N of M captures` only while a
  filter is active.
