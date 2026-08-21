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
  - `--thumb-h` — the thumbnail `max-height` **and** the prompt box's
    height cap, so a row's two tall cells agree.

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
- The Prompt cell is capped to the thumbnail height and scrolls
  internally, so one long prompt can't stretch the row.

## File links and `file://`

- Saved files live under `<downloads>/SeeWhatISee/`, so the only way
  to reference them from a page is a `file://` URL.
- The directory is resolved with the shared `getCaptureDirectory()`
  helper in `capture/downloads.ts` (also used by *Snapshots
  directory*), which derives it from the `log.json` download record.
- Chrome blocks `file://` subresources unless the user enables **Allow
  access to file URLs** for the extension. The page renders the
  thumbnails/links regardless and shows a hint explaining the toggle
  when it's off — the rest of each row is useful either way.
- Two graceful degradations:
  - Directory unresolvable (no capture has been written yet): the
    cells show the bare filename / an unlinked label.
  - Thumbnail fails to load (file deleted, toggle off): the `<img>`
    is swapped for the filename as text, so there's no broken-image
    icon with no explanation.

## Search

- Single box at the top, filtering as you type.
- Every whitespace-separated term must appear in the record's URL,
  title, or prompt (case-insensitive substring) — so `github review`
  narrows to captures mentioning both, in either field, in either
  order.
- The count line next to the box reads `N of M captures` only while a
  filter is active.
