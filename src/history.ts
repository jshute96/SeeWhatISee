// Controller for `src/history.html` — the Capture history page.
//
// A read-only table view over the same capture log that backs
// `log.json`: the `captureLog` array in `chrome.storage.local`, newest
// entry first. Nothing here writes to the log; the page is a way to
// look back at what was captured and jump to the saved files.
//
// The one action it offers is *Restore last capture*, on the single
// row (if any) the restorable capture corresponds to — see
// `restorableLogKey` below. The SW owns both halves of that; the page
// only renders the button and forwards the click.
//
// Loaded as a module script (unlike `options.ts`) so it can import the
// log-store / downloads helpers directly instead of round-tripping
// through the service worker. Everything it needs — `storage.local`
// and `downloads.search` — is available to any extension page.
//
// **Older captures.** `chrome.storage.local` only buffers the most
// recent captures; older ones are flushed to `history-*.json` files
// beside `log.json` (see `capture/log-store.ts`). Those are read back
// on demand, appended after the in-storage records — reading them is a
// `file://` fetch, so it's opt-in per visit rather than something the
// page does on load.
//
// **File access.** The saved screenshots / HTML / selection files live
// on disk under `<downloads>/SeeWhatISee/`. The only way to reference
// them from a page is a `file://` URL, which Chrome blocks unless the
// user has turned on "Allow access to file URLs" for the extension. We
// render the thumbnails / links regardless and surface an explanatory
// hint when the toggle is off, rather than hiding the columns — the
// rest of the row (date, URL, title, prompt) is still useful either
// way.

import {
  getArchiveFilePaths,
  getCaptureDirectory,
  getCaptureFileExistence,
  joinCapturePath,
  pathToFileUrl,
} from './capture/downloads.js';
import {
  dedupeRecords,
  LOG_STORAGE_KEY,
  parseLogText,
  serializeRecord,
} from './capture/log-store.js';
import type { CaptureRecord, SelectionFormat } from './capture/types.js';

const searchInput = document.getElementById('search') as HTMLInputElement;
const countEl = document.getElementById('count') as HTMLElement;
const tableEl = document.getElementById('table') as HTMLTableElement;
const rowsEl = document.getElementById('rows') as HTMLElement;
const emptyEl = document.getElementById('empty') as HTMLElement;
const noMatchesEl = document.getElementById('no-matches') as HTMLElement;
const fileAccessHintEl = document.getElementById('file-access-hint') as HTMLElement;
const fileAccessLink = document.getElementById('file-access-btn') as HTMLAnchorElement;
const optionsBtn = document.getElementById('options-btn') as HTMLButtonElement;
const olderEl = document.getElementById('older') as HTMLElement;
const loadOlderBtn = document.getElementById('load-older') as HTMLButtonElement;
const olderNoteEl = document.getElementById('older-note') as HTMLElement;

// The "Allow access to file URLs" toggle lives on Chrome's own
// per-extension details page, not in our Options page — so this jumps
// straight there.
//
// It's a real `<a href>` so the destination shows in the status bar on
// hover and right-click → Copy link address works, but the navigation
// itself has to be intercepted: Chrome blocks a page-initiated load of
// a `chrome://` URL, so the open goes through `chrome.tabs.create`
// (the same call the Options page's "Edit shortcuts" button makes).
// The href is assigned here rather than in the markup so it can't
// drift from the URL we actually open.
const FILE_ACCESS_URL = `chrome://extensions/?id=${chrome.runtime.id}`;
fileAccessLink.href = FILE_ACCESS_URL;
// `click` alone isn't enough. Looking like a real link invites the
// gestures people use on real links, and the ones that skip `click`
// would fall through to the blocked `chrome://` href and silently do
// nothing: middle-click fires `auxclick`, and ctrl/⌘-click expects a
// *background* tab. Enter/Space do fire `click`, so keyboard is
// covered by the first handler.
const openFileAccessPage = (e: MouseEvent, active: boolean): void => {
  e.preventDefault();
  void chrome.tabs.create({ url: FILE_ACCESS_URL, active });
};
fileAccessLink.addEventListener('click', (e) => {
  openFileAccessPage(e, !(e.ctrlKey || e.metaKey));
});
fileAccessLink.addEventListener('auxclick', (e) => {
  if (e.button !== 1) return;
  openFileAccessPage(e, false);
});

optionsBtn.addEventListener('click', () => {
  // `openOptionsPage` honours the manifest's `open_in_tab: true`, so
  // it lands in a new tab (or focuses an existing Options tab).
  chrome.runtime.openOptionsPage();
});

/** Newest-first view of the log, rebuilt on every storage change. */
let records: CaptureRecord[] = [];
/**
 * `serializeRecord` key of the capture that *Restore last capture*
 * would re-open, or `null` when there is nothing to restore.
 *
 * Supplied by the SW — the page can't read the `lastCapture`
 * session-storage slot without importing the capture module graph.
 * Set from the `historyPageReady` reply and refreshed by the
 * `restorableCaptureChanged` push; see `background/history-page.ts`.
 *
 * Matching on the serialized record rather than on position is what
 * makes the button land on the *right* row. "Newest row" is wrong
 * often enough to matter: a shift-click save keeps its Capture page
 * open and so never promotes, letting a newer row sit above the
 * restorable one — and a capture closed without ever saving has no
 * row at all, which is `logKey` being absent.
 */
let restorableLogKey: string | null = null;
/**
 * Set once the initial load has rendered.
 *
 * Both routes that deliver `restorableLogKey` — the registration
 * reply and the SW's push — can land *before* the storage reads at
 * the bottom of this file finish, and neither waits for them.
 * Rendering from there early would flash "No captures in the log yet"
 * on a page that has plenty; setting the value and letting the
 * initial render use it costs nothing.
 */
let firstRenderDone = false;
/**
 * Set once a `restorableCaptureChanged` push has been applied, which
 * makes the `historyPageReady` reply stale for good.
 *
 * The two channels are unordered: the SW reads the slot *before* it
 * replies, so a slot change in that window pushes the fresh value
 * down a different path — and the page has no guarantee the reply
 * resolves first. Without this, a push that wins the race gets
 * overwritten by the older reply and the button sits on the wrong
 * row until the next slot change.
 */
let sawRestorablePush = false;
/**
 * Set while a restore round trip is in flight, so the button stays
 * disabled through it.
 *
 * Module scope rather than left on the element: `render()` rebuilds
 * every row with `replaceChildren`, so a re-render mid-flight — a
 * `captureLog` change, a downloads sweep, a keystroke in the search
 * box — would otherwise hand back a fresh, enabled button.
 */
let restoreInFlight = false;
/**
 * Absolute path of `<downloads>/SeeWhatISee/`, or `null` when it
 * couldn't be resolved (no capture has been written yet, so there is
 * no `log.json` download record to derive it from). With `null` we
 * still render every row, just without thumbnails or file links.
 */
let captureDir: string | null = null;
/**
 * Bare filename → still on disk, from `chrome.downloads`. A missing
 * key means "unknown" (the user cleared their download history), which
 * renders as a normal link — see `getCaptureFileExistence`.
 */
let fileExists = new Map<string, boolean>();

/**
 * Absolute paths of the `history-*.json` archive files, newest first
 * (by download start time — see `getArchiveFilePaths`).
 */
let archivePaths: string[] = [];
/**
 * Records read out of each archive file we've loaded, keyed by path,
 * each newest-first within its file. Keyed by path rather than
 * accumulated into one list so the merge can walk `archivePaths` in
 * order — an archive written *after* some are already loaded belongs
 * ahead of them, not appended to the end.
 */
const archiveFileRecords = new Map<string, CaptureRecord[]>();
/** Message from a failed archive read, shown next to the button. */
let archiveError = '';
/**
 * True while a read is in flight. Both entry points — the button and
 * the storage listener — go through `loadArchivesInteractively`, so
 * this covers a click landing mid-capture as well as a double-click.
 */
let archiveLoading = false;

/**
 * Bumped whenever the loaded archives are discarded wholesale (a
 * *Clear log history*). A read started before that must not write its
 * results back afterwards — they'd reappear under the emptied log,
 * which is the state the clear exists to avoid.
 */
let archiveGeneration = 0;

/** Archive files we know about but haven't read yet. */
function unloadedArchives(): string[] {
  return archivePaths.filter((p) => !archiveFileRecords.has(p));
}

/**
 * Loaded archives in display order: the current listing first, then
 * any loaded file that has dropped off it.
 *
 * A path can vanish from the listing without its records becoming
 * wrong — clearing Chrome's download history hides archives that are
 * still on disk, and we've already read them. Dropping those rows
 * would make captures disappear from the page for a reason that has
 * nothing to do with them. The strays go last, which is where they
 * belong in the common case: a cleared download history strands
 * *every* loaded file at once, and `Map` iterates in insertion order,
 * which is the newest-first order they were read in.
 */
function archiveDisplayOrder(): string[] {
  const listed = new Set(archivePaths);
  const strays = [...archiveFileRecords.keys()].filter((p) => !listed.has(p));
  return [...archivePaths, ...strays];
}

/**
 * The rows to render: the in-storage log, then the loaded archives in
 * newest-file-first order. Cached rather than rebuilt per render,
 * since `render()` runs on every keystroke in the search box.
 */
let mergedRecords: CaptureRecord[] = [];

/**
 * Recompute `mergedRecords`: concatenate in file order, then drop
 * exact repeats.
 *
 * **No sort.** `archivePaths` is already newest-first by download
 * start time, which is true write order, and each file's records are
 * reversed out of append order. Sorting by `timestamp` would only
 * reshuffle the records a single Capture session wrote — a session
 * pins one timestamp and writes a record per save, so append order and
 * timestamp order genuinely differ. The live log has always been shown
 * in append order; archives match it.
 *
 * **Dedup is exact-match only**, via `dedupeRecords`. It's there for
 * *Restore last capture* re-saved unchanged, which writes a record
 * byte-identical to the previous one. Anything looser — keying on
 * `timestamp` — merges the distinct records of a single editing
 * session and drops real captures; that shipped once already.
 * Duplicates can land anywhere relative to each other (adjacent, or
 * split across the storage/archive boundary), so the pass is global
 * rather than adjacent-only.
 */
function rebuildMerged(): void {
  const all = [...records];
  for (const path of archiveDisplayOrder()) {
    const loaded = archiveFileRecords.get(path);
    if (loaded?.length) all.push(...loaded);
  }
  mergedRecords = dedupeRecords(all);
}

/**
 * `true` only when Chrome positively tells us the file is gone.
 * Unknown filenames answer `false` so we never label a live capture
 * deleted on the strength of missing information.
 */
function isDeleted(filename: string): boolean {
  return fileExists.get(filename) === false;
}

// ───────────────────────────── rendering ─────────────────────────────

/**
 * True for the one row the saved last-capture describes.
 *
 * At most one row can match: `mergedRecords` is deduped on exactly
 * this key, so byte-identical records — the *Restore last capture*
 * re-saved-unchanged case — have already collapsed into one.
 *
 * Guarded on `restorableLogKey` first so the common "nothing to
 * restore" case doesn't serialize every record on every keystroke.
 */
function isRestorable(r: CaptureRecord): boolean {
  return restorableLogKey !== null && serializeRecord(r) === restorableLogKey;
}

/**
 * Tooltip on the Restore button. Deliberately echoes the toolbar's
 * *Restore last capture* entry, which does exactly the same thing —
 * the two are one feature with two entry points, and a user who has
 * met one shouldn't have to work out that the other is the same.
 */
const RESTORE_TOOLTIP = 'Restore last capture — re-open this capture\'s page with '
  + 'the prompt, drawings and checkbox state it was closed with';

/**
 * Send the restore click to the SW, which reads the `lastCapture` slot
 * and opens the Capture page (see `background/history-page.ts`).
 *
 * The button is disabled for the round trip so a double-click can't
 * fire two restores — and it stays disabled on success, because a
 * restore *consumes* the slot: the SW's `restorableCaptureChanged`
 * push arrives moments later and takes the button off the row
 * entirely. Only a failure puts it back, with the reason in its
 * tooltip.
 *
 * A slot that turned out to be empty counts as a failure — the SW
 * says so explicitly rather than reporting success on a restore that
 * opened nothing, which would leave the button dead on a row with
 * nothing behind it.
 */
function restoreFromRow(btn: HTMLButtonElement): void {
  restoreInFlight = true;
  btn.disabled = true;
  // Drop any error left by a previous attempt — it describes what
  // happened last time, not what this click is doing.
  btn.title = RESTORE_TOOLTIP;
  void (async () => {
    try {
      const resp = (await chrome.runtime.sendMessage({
        action: 'restoreLastCaptureFromHistory',
      })) as { ok?: boolean; error?: string } | undefined;
      if (resp?.ok) return;
      throw new Error(resp?.error ?? 'The restore did not go through.');
    } catch (err) {
      // Expected-and-handled: the user sees the button come back, and
      // the tooltip carries the reason. Not `console.error` — Chrome
      // promotes that onto the extension's Errors page.
      console.info('[SeeWhatISee] history: restore failed:', err);
      restoreInFlight = false;
      btn.disabled = false;
      btn.title = `Could not restore this capture: ${
        err instanceof Error ? err.message : String(err)}`;
    }
  })();
}

/**
 * Date column: local date on the first line, local time on the second.
 * Two lines keeps the column narrow without truncating either half.
 *
 * Records written before a field existed — or a hand-edited log — can
 * carry a timestamp that `Date` can't parse; we fall back to showing
 * the raw string rather than rendering "Invalid Date".
 *
 * The Restore button (on the one restorable row) hangs below the
 * timestamp, on both the parsed and unparseable paths — the row is
 * restorable either way.
 */
function dateCell(r: CaptureRecord): HTMLElement {
  const td = document.createElement('td');
  td.className = 'date-cell';
  const d = new Date(r.timestamp);
  if (Number.isNaN(d.getTime())) {
    td.textContent = r.timestamp;
    appendRestoreButton(td, r);
    return td;
  }
  td.append(d.toLocaleDateString());
  td.append(document.createElement('br'));
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = d.toLocaleTimeString();
  td.append(time);
  appendRestoreButton(td, r);
  return td;
}

/** Add the Restore button to `td` if `r` is the restorable row. */
function appendRestoreButton(td: HTMLElement, r: CaptureRecord): void {
  if (!isRestorable(r)) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn restore-btn';
  btn.textContent = 'Restore';
  // A re-render mid-restore rebuilds this element; carry the in-flight
  // disable across it rather than handing back a live button.
  btn.disabled = restoreInFlight;
  btn.title = RESTORE_TOOLTIP;
  btn.addEventListener('click', () => restoreFromRow(btn));
  td.append(btn);
}

/** A greyed-out "N/A" placeholder for a column with nothing to show. */
function naSpan(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'na';
  span.textContent = 'N/A';
  return span;
}

/**
 * Build the `file://` URL for a bare capture filename, or `null` when
 * the capture directory hasn't been resolved.
 */
function fileUrlFor(filename: string): string | null {
  if (!captureDir) return null;
  return pathToFileUrl(joinCapturePath(captureDir, filename));
}

/**
 * A saved file we shouldn't offer as a working link. Two reasons, and
 * the marker distinguishes them:
 *
 * - The capture directory never resolved, so there is no `file://` URL
 *   to point at. Renders as the bare label.
 * - Chrome reports the file gone, so a link would 404. Renders with
 *   the `(deleted)` marker.
 *
 * Greyed either way so it doesn't read as a dead link. `label`
 * defaults to the filename (what the Screenshot column shows); the
 * Files column passes its own ("HTML", "Selection (md)").
 *
 * Not used for a file that merely failed to *load* — there we keep the
 * link, since its href is still worth right-clicking.
 */
function unlinkedFile(filename: string, label = filename): HTMLElement {
  const span = document.createElement('span');
  span.className = 'flag';
  span.textContent = label;
  span.title = filename;
  if (isDeleted(filename)) {
    // Nested rather than appended to the label text: it renders on its
    // own line (`.deleted-mark` is `display: block`) so the Files
    // column doesn't have to be wide enough for
    // "Selection (html) (deleted)" on one line, and it stays *inside*
    // the artifact's own element so a row listing both an HTML and a
    // selection file can't leave you guessing which one is gone.
    //
    // "deleted" is the plain-language reading of what Chrome reports —
    // strictly, the file is no longer at the path we wrote it to,
    // which also covers a move or a rename.
    const mark = document.createElement('span');
    mark.className = 'deleted-mark';
    mark.textContent = '(deleted)';
    span.append(mark);
  }
  return span;
}

/**
 * Screenshot column — the saved PNG scaled down by the browser, linked
 * to the full-size file. Falls back to "N/A" when the record has no
 * screenshot (the user unchecked Save screenshot, or the capture was
 * HTML/selection-only) and to the bare filename when we can't build a
 * `file://` URL.
 */
function screenshotCell(r: CaptureRecord): HTMLElement {
  const td = document.createElement('td');
  td.className = 'shot-cell';
  if (!r.screenshot) {
    td.append(naSpan());
    return td;
  }
  const url = fileUrlFor(r.screenshot.filename);
  if (!url || isDeleted(r.screenshot.filename)) {
    // Either no directory resolved (so there's no href to offer) or
    // the file is known gone. Both render as the greyed non-link the
    // Files column uses; a deleted file skips the <img> entirely
    // rather than loading it just to watch it fail.
    td.append(unlinkedFile(r.screenshot.filename));
    return td;
  }
  const link = document.createElement('a');
  link.className = 'thumb-link';
  link.href = url;
  link.target = '_blank';
  link.rel = 'noreferrer noopener';
  link.title = r.screenshot.filename;
  const img = document.createElement('img');
  img.className = 'thumb';
  img.src = url;
  img.alt = r.screenshot.filename;
  img.loading = 'lazy';
  // A thumbnail that can't load would otherwise render as a
  // broken-image icon with no explanation. Deletion is caught upstream
  // by `isDeleted`, so what reaches here is the file-URL toggle being
  // off, a file the download records don't know about, or a decode
  // failure. Swap just the <img> for the filename and keep the
  // surrounding <a>: the link's href is still the one useful thing
  // left on the row, so the user can right-click → Copy link address
  // and open the file another way. The Files column behaves the same
  // — its links stay links whether or not the bytes are reachable —
  // and the two columns must not disagree about a failure they share.
  img.addEventListener('error', () => {
    img.replaceWith(document.createTextNode(r.screenshot!.filename));
  });
  link.append(img);
  td.append(link);
  return td;
}

/**
 * Display name for each selection format in the Files column.
 * `markdown` is abbreviated so the longest label stays short enough
 * for the column's fixed width; `html` / `text` are already short.
 */
const SELECTION_LABELS: Record<SelectionFormat, string> = {
  html: 'html',
  text: 'text',
  markdown: 'md',
};

/**
 * Files column — one link per saved non-screenshot artifact (HTML
 * contents, selection). Each link is annotated with what it is; the
 * selection link also names its format (html / text / markdown) since
 * that's what determines how the file reads.
 */
function filesCell(r: CaptureRecord): HTMLElement {
  const td = document.createElement('td');
  td.className = 'files-cell';
  const add = (label: string, artifact: { filename: string }): void => {
    const url = fileUrlFor(artifact.filename);
    if (url && !isDeleted(artifact.filename)) {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noreferrer noopener';
      a.textContent = label;
      a.title = artifact.filename;
      td.append(a);
    } else {
      td.append(unlinkedFile(artifact.filename, label));
    }
  };
  if (r.contents) add('HTML', r.contents);
  if (r.selection) {
    // Fall back to the raw format string for a value outside the
    // union — a legacy or hand-edited `log.json` record would
    // otherwise render "Selection (undefined)". Same defensiveness as
    // `dateCell`'s unparseable-timestamp path.
    const label = SELECTION_LABELS[r.selection.format] ?? r.selection.format;
    add(`Selection (${label})`, r.selection);
  }
  if (!td.childElementCount) td.append(naSpan());
  return td;
}

/**
 * Page column — the captured tab's title above its URL. The URL is a
 * live link back to the page. Either half can be missing (restricted
 * tabs, uploads), so each is rendered only when present and the cell
 * falls back to "N/A" when both are.
 *
 * Capped to the same height as the Prompt box and the thumbnail: a
 * search URL carrying a wall of tracking parameters otherwise wraps to
 * a dozen lines and stretches the row, and none of it past the origin
 * and path is worth reading in a table.
 */
function pageCell(r: CaptureRecord): HTMLElement {
  const td = document.createElement('td');
  td.className = 'page-cell';
  // Title and URL go in an inner scrolling box rather than capping the
  // <td> itself, because `overflow` on a table cell isn't reliably
  // honoured — and the cap has to cover the pair together anyway.
  const box = document.createElement('div');
  box.className = 'scroll-box';
  td.append(box);
  if (r.title) {
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = r.title;
    box.append(title);
  }
  if (r.url) {
    const a = document.createElement('a');
    a.className = 'url';
    a.href = r.url;
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    a.textContent = r.url;
    box.append(a);
  }
  if (!box.childElementCount) box.append(naSpan());
  return td;
}

/**
 * Prompt column — the Capture-page prompt text, in a box capped to the
 * thumbnail height that scrolls internally (see `.prompt-box` in
 * history.html) so a long prompt can't stretch the row.
 */
function promptCell(r: CaptureRecord): HTMLElement {
  const td = document.createElement('td');
  td.className = 'prompt-cell';
  if (!r.prompt) {
    td.append(naSpan());
    return td;
  }
  const box = document.createElement('div');
  box.className = 'prompt-box scroll-box';
  box.textContent = r.prompt;
  td.append(box);
  return td;
}

function buildRow(r: CaptureRecord): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.append(dateCell(r), screenshotCell(r), filesCell(r), pageCell(r), promptCell(r));
  return tr;
}

// ────────────────────────────── filtering ────────────────────────────

/**
 * Match a record against the search box. Every whitespace-separated
 * term must appear somewhere in the record's URL, title, or prompt
 * (case-insensitively) — so typing `github review` narrows to captures
 * that mention both, in either field, in either order.
 */
function matches(r: CaptureRecord, terms: string[]): boolean {
  if (!terms.length) return true;
  const haystack = `${r.url ?? ''}\n${r.title ?? ''}\n${r.prompt ?? ''}`.toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

/**
 * The "Load older captures" row under the table.
 *
 * Hidden entirely when there's nothing more to offer — no archive
 * files, or every one already read — so a user who never fills the
 * 100-entry buffer never sees it. A read failure keeps the row up with
 * its message so the button stays available to retry.
 */
function renderOlder(): void {
  const remaining = unloadedArchives().length;
  olderEl.hidden = remaining === 0 && !archiveError;
  loadOlderBtn.disabled = archiveLoading || remaining === 0;
  loadOlderBtn.textContent = archiveLoading ? 'Loading…' : 'Load older captures';
  if (archiveError) {
    olderNoteEl.textContent = archiveError;
  } else if (remaining > 0) {
    // File count, not record count: the records inside are only known
    // after reading, and the file count is what the wait scales with.
    olderNoteEl.textContent = `${remaining} archived log ${remaining === 1 ? 'file' : 'files'} on disk`;
  } else {
    olderNoteEl.textContent = '';
  }
}

function render(): void {
  const terms = searchInput.value.toLowerCase().split(/\s+/).filter(Boolean);
  const all = mergedRecords;
  const shown = all.filter((r) => matches(r, terms));

  rowsEl.replaceChildren(...shown.map(buildRow));
  renderOlder();

  const hasAny = all.length > 0;
  // "No captures in the log yet. Capture something…" is the wrong
  // story when archived captures are sitting right there unread — the
  // usual way to get here is a *Clear log history* on an account with
  // archives. Suppress it and let the "Load older captures" row below
  // speak for itself.
  emptyEl.hidden = hasAny || unloadedArchives().length > 0;
  noMatchesEl.hidden = !hasAny || shown.length > 0;
  tableEl.hidden = shown.length === 0;
  // Only mention the filtered count when a filter is actually active —
  // "12 of 12" is noise. The noun agrees with whichever number it
  // directly follows: "1 capture", but "1 of 12 captures".
  const total = all.length;
  countEl.textContent = hasAny
    ? (terms.length
      ? `${shown.length} of ${total} ${total === 1 ? 'capture' : 'captures'}`
      : `${total} ${total === 1 ? 'capture' : 'captures'}`)
    : '';
  // The hint tells the user to enable "Allow access to file URLs", so
  // only show it when that is actually the thing standing between them
  // and a working link — i.e. the toggle is off AND some row would
  // otherwise have rendered a file:// URL. Without the `captureDir`
  // check it would fire on a log whose directory never resolved, where
  // flipping the toggle changes nothing (the real reason is that no
  // capture has been written yet); without the artifact check it would
  // fire on a log of prompt- or URL-only records, which reference no
  // files at all.
  //
  // Deliberately keyed off the whole log, not the filtered `shown`
  // set: the banner describes a standing browser setting, so having it
  // blink in and out as the user types in the search box would read as
  // a glitch.
  //
  // Unread archive files count as a reason too: reading one is a
  // `file://` fetch, so the toggle is exactly what stands between the
  // user and the older half of their history.
  fileAccessHintEl.hidden = !fileAccessBlocked
    || (captureDir === null && archivePaths.length === 0)
    || !(unloadedArchives().length > 0
      || all.some((r) => r.screenshot || r.contents || r.selection));
}

// ─────────────────────────────── loading ─────────────────────────────

/**
 * `true` when the extension does *not* have "Allow access to file
 * URLs" — every `file://` thumbnail and link on the page will fail, so
 * we show the explanatory hint. Resolved once at load: the toggle
 * lives in `chrome://extensions` and flipping it reloads the
 * extension anyway.
 */
let fileAccessBlocked = false;

async function loadCaptureDir(): Promise<void> {
  try {
    captureDir = await getCaptureDirectory();
  } catch {
    // "No captures yet" — expected on a fresh install, and the empty
    // state already says so. Rows (if any exist without a resolvable
    // directory) simply render without links.
    captureDir = null;
  }
}

async function loadFileExistence(): Promise<void> {
  try {
    fileExists = await getCaptureFileExistence();
  } catch {
    // Leave the map empty — every file reads as "unknown", so the page
    // renders exactly as it did before this check existed.
    fileExists = new Map();
  }
}

async function loadArchiveList(): Promise<void> {
  try {
    archivePaths = await getArchiveFilePaths();
  } catch {
    // No download records to search, or the API refused — same
    // outcome as having no archives: the page shows the in-storage log
    // and doesn't offer more.
    archivePaths = [];
  }
  // The merge walks this list, so the rows go stale the moment it
  // changes — a newly-written archive has to take its place among the
  // loaded ones now, not whenever some later load happens to rebuild.
  // Records already read are kept even if their path dropped off; see
  // `archiveDisplayOrder`.
  rebuildMerged();
}

/**
 * Read every archive file we haven't read yet and merge its records
 * in, newest first.
 *
 * All of them in one pass rather than a file at a time: a batch is 50
 * captures, so paging through them 50 at a time would be tedious, and
 * a `file://` read of a few hundred KB of JSON is fast. The cost of
 * loading the whole history is a longer table, which is what the
 * search box is for.
 *
 * Each file's records are reversed into the page's newest-first
 * order; `rebuildMerged` does the assembling, and neither sorts (see
 * its comment for why timestamp order is the wrong order here).
 *
 * **Per-file outcomes.** A file that reads is merged and marked read
 * even if others failed, and the count of failures is returned. One
 * dead file (deleted outside the browser, so the download record's
 * stale `exists` still says it's there) must not veto the archives
 * that *are* readable — and it wouldn't heal on retry, so all-or-
 * nothing would lock the rest of the history out for the session.
 * The transient case still retries in full: with the file-URL toggle
 * off every read fails, so nothing is marked and the button retries
 * the whole set.
 */
async function loadArchives(): Promise<number> {
  const pending = unloadedArchives();
  if (pending.length === 0) return 0;
  const generation = archiveGeneration;
  const results = await Promise.allSettled(pending.map(async (path) => {
    // A `file://` read that Chrome refuses (toggle off) rejects, but a
    // missing file can resolve non-ok — and that would otherwise look
    // like a successful read of an empty archive, silently dropping 50
    // captures off the page. `fetchImageInSW` checks `ok` on this same
    // scheme for the same reason.
    const res = await fetch(pathToFileUrl(path));
    if (!res.ok) throw new Error(`archive read failed: ${res.status}`);
    return await res.text();
  }));

  // A *Clear log history* landing while these reads were in flight
  // discards the loaded archives; merging in anyway would put the
  // cleared rows straight back on screen.
  if (generation !== archiveGeneration) return 0;

  let failed = 0;
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      failed += 1;
      return;
    }
    // Reversed to match the page's newest-first order, the same way
    // `loadRecords` reverses the append-ordered storage log.
    archiveFileRecords.set(pending[i], parseLogText(result.value).reverse());
  });
  rebuildMerged();
  return failed;
}

/**
 * Read the pending archives and fold the outcome into the page state.
 * Shared by the button and the storage listener so both show the
 * loading state and report failures the same way — and so neither can
 * start a second read while one is in flight.
 */
async function loadArchivesInteractively(): Promise<void> {
  if (archiveLoading) return;
  archiveLoading = true;
  archiveError = '';
  renderOlder();
  try {
    const failed = await loadArchives();
    // The newly-loaded rows reference files we haven't asked about
    // yet, so refresh the "(deleted)" map alongside them.
    await loadFileExistence();
    if (failed > 0) {
      // Anything readable has already been merged in; this names what
      // is still missing rather than implying the whole load failed.
      // The toggle being off fails *every* file, and the banner above
      // is guaranteed visible in that case, so point at it.
      archiveError = fileAccessBlocked
        ? `Could not read ${failed} archived ${failed === 1 ? 'log' : 'logs'} — see the note above.`
        : `Could not read ${failed} archived ${failed === 1 ? 'log' : 'logs'}.`;
    }
  } catch {
    // `loadArchives` reports per-file failures through its return
    // value, so reaching here means the read itself broke.
    archiveError = 'Could not read the archived logs.';
  }
  archiveLoading = false;
  render();
}

loadOlderBtn.addEventListener('click', () => {
  void loadArchivesInteractively();
});

async function loadRecords(): Promise<void> {
  const data = await chrome.storage.local.get(LOG_STORAGE_KEY);
  const log = (data[LOG_STORAGE_KEY] as CaptureRecord[] | undefined) ?? [];
  // The stored log is oldest-first (append order); the page shows
  // newest at the top.
  records = [...log].reverse();
  rebuildMerged();
}

searchInput.addEventListener('input', render);

// Keep the page live: a capture taken (or a Clear log history) while
// the History tab sits open rewrites `captureLog`, and re-reading is
// cheap enough to just do it wholesale.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(LOG_STORAGE_KEY in changes)) return;
  // A *Clear log history* wipes the key entirely. Drop the archived
  // rows loaded into this tab along with it, so the page reflects the
  // clear instead of leaving hundreds of rows under an empty log. The
  // files stay on disk, so the button simply offers them again.
  if (changes[LOG_STORAGE_KEY].newValue === undefined) {
    archiveFileRecords.clear();
    archiveError = '';
    // Disown any read still in flight — see `archiveGeneration`.
    archiveGeneration += 1;
  }
  void (async () => {
    await loadRecords();
    // A first-ever capture is also what makes the capture directory
    // resolvable, so retry that while we're here.
    if (!captureDir) await loadCaptureDir();
    // The new capture's own files won't be in the existence map yet.
    await loadFileExistence();
    // A capture can also push the log over its cap and write a new
    // archive file. Pick that up so the button's count stays right —
    // and read it straight away if the user has already opted in, so
    // records don't appear to vanish as they age out of storage.
    await loadArchiveList();
    if (archiveFileRecords.size > 0) {
      await loadArchivesInteractively();
      return; // it renders
    }
    render();
  })();
});

// Chrome reports a download's file going missing (or coming back) as
// an `exists` delta, which is the only live signal for a file deleted
// while this tab sits open — and the delayed half of the round-trip
// `getCaptureFileExistence` starts (see its doc comment). Other deltas
// (progress, state) say nothing about the "(deleted)" markers, so we
// ignore them.
//
// Coalesced because `onChanged` is global: the delta carries only an
// id, so we can't tell our downloads from anyone else's without
// tracking every id we've ever written, and a re-check sweeps the
// whole capture directory and rebuilds every row. Deleting a folder of
// captures fires one event per file; this collapses the burst into a
// single sweep.
let existenceRefresh: ReturnType<typeof setTimeout> | null = null;
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.exists || existenceRefresh !== null) return;
  existenceRefresh = setTimeout(() => {
    existenceRefresh = null;
    void (async () => {
      await loadFileExistence();
      render();
    })();
  }, 500);
});

// ───────────────────── tab identity, for reuse ───────────────────────
//
// The SW focuses this tab instead of opening a second History page,
// but it can't find us by URL: `chrome.tabs.query({ url })` needs the
// `"tabs"` permission (or a host permission covering the scheme) to
// see `tab.url` at all, and neither covers `chrome-extension://`. So
// we tell it who we are, and answer a ping so it can tell a live
// History page from a stale tab id. See `background/history-page.ts`.
//
// Registering also opens the channel the SW pushes restorable-capture
// updates down — it needs a tab id to send to, and this is where it
// gets one.

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  const action = (msg as { action?: unknown }).action;

  if (action === 'pingHistoryPage') {
    sendResponse({ ok: true });
    return false;
  }

  // The `lastCapture` slot changed: a Capture page closed (promote),
  // or a new capture / restore / quota relief cleared it. Re-render so
  // the Restore button moves to the row that now owns it, or goes
  // away. Not a `chrome.storage.onChanged` listener here because the
  // page has no clean way to name that key — see `restorableLogKey`.
  if (action === 'restorableCaptureChanged') {
    const key = (msg as { logKey?: unknown }).logKey;
    restorableLogKey = typeof key === 'string' ? key : null;
    sawRestorablePush = true;
    // The slot moved, so whatever restore was in flight has resolved
    // one way or the other. Clearing here (rather than on the success
    // path, which deliberately leaves the button disabled) is what
    // stops a later capture's button from being born disabled.
    restoreInFlight = false;
    // Same first-render guard as the registration reply: a push that
    // beats the initial storage reads only has to leave the value
    // behind for that render to pick up.
    if (firstRenderDone) render();
    // Answered so the SW's `sendMessage` resolves instead of
    // rejecting with "message port closed" on every successful
    // delivery — which would make its catch block a lie.
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

void (async () => {
  // The reply carries the initial restorable-capture key. A failure
  // costs only the Restore button (and the next History click opening
  // a second tab) — neither is worth surfacing. Deliberately not
  // awaited: waking the SW must not hold up the rows.
  chrome.runtime.sendMessage({ action: 'historyPageReady' }).then((resp: unknown) => {
    // A push that already landed read the slot later than this reply
    // did, so it wins — see `sawRestorablePush`.
    if (sawRestorablePush) return;
    const key = (resp as { logKey?: unknown } | undefined)?.logKey;
    restorableLogKey = typeof key === 'string' ? key : null;
    // Either order works: land first and the initial render below
    // draws the button; land second and this re-render adds it.
    if (firstRenderDone) render();
  }).catch(() => {});

  fileAccessBlocked = !(await chrome.extension.isAllowedFileSchemeAccess());
  await Promise.all([
    loadRecords(),
    loadCaptureDir(),
    loadFileExistence(),
    loadArchiveList(),
  ]);
  firstRenderDone = true;
  render();
})();
