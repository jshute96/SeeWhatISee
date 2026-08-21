# History page

A read-only table view over the capture log — the same `captureLog`
array in `chrome.storage.local` that backs the on-disk `log.json`
sidecar (see [architecture.md](architecture.md) for the log itself).

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
- The log is capped at 100 entries by `log-store.ts`, so the page never
  has to paginate.

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
| Date | Local date over local time, from the record's UTC `timestamp` |
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
