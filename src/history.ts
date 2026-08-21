// Controller for `src/history.html` — the Capture history page.
//
// A read-only table view over the same capture log that backs
// `log.json`: the `captureLog` array in `chrome.storage.local`, newest
// entry first. Nothing here writes; the page is purely a way to look
// back at what was captured and jump to the saved files.
//
// Loaded as a module script (unlike `options.ts`) so it can import the
// log-store / downloads helpers directly instead of round-tripping
// through the service worker. Everything it needs — `storage.local`
// and `downloads.search` — is available to any extension page.
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
  getCaptureDirectory,
  getCaptureFileExistence,
  joinCapturePath,
  pathToFileUrl,
} from './capture/downloads.js';
import { LOG_STORAGE_KEY } from './capture/log-store.js';
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
 * `true` only when Chrome positively tells us the file is gone.
 * Unknown filenames answer `false` so we never label a live capture
 * deleted on the strength of missing information.
 */
function isDeleted(filename: string): boolean {
  return fileExists.get(filename) === false;
}

// ───────────────────────────── rendering ─────────────────────────────

/**
 * Format an ISO timestamp for the Date column: local date on the first
 * line, local time on the second. Two lines keeps the column narrow
 * without truncating either half.
 *
 * Records written before a field existed — or a hand-edited log — can
 * carry a timestamp that `Date` can't parse; we fall back to showing
 * the raw string rather than rendering "Invalid Date".
 */
function dateCell(timestamp: string): HTMLElement {
  const td = document.createElement('td');
  td.className = 'date-cell';
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) {
    td.textContent = timestamp;
    return td;
  }
  td.append(d.toLocaleDateString());
  td.append(document.createElement('br'));
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = d.toLocaleTimeString();
  td.append(time);
  return td;
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
  tr.append(dateCell(r.timestamp), screenshotCell(r), filesCell(r), pageCell(r), promptCell(r));
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

function render(): void {
  const terms = searchInput.value.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = records.filter((r) => matches(r, terms));

  rowsEl.replaceChildren(...shown.map(buildRow));

  const hasAny = records.length > 0;
  emptyEl.hidden = hasAny;
  noMatchesEl.hidden = !hasAny || shown.length > 0;
  tableEl.hidden = shown.length === 0;
  // Only mention the filtered count when a filter is actually active —
  // "12 of 12" is noise. The noun agrees with whichever number it
  // directly follows: "1 capture", but "1 of 12 captures".
  const total = records.length;
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
  fileAccessHintEl.hidden = !fileAccessBlocked
    || captureDir === null
    || !records.some((r) => r.screenshot || r.contents || r.selection);
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

async function loadRecords(): Promise<void> {
  const data = await chrome.storage.local.get(LOG_STORAGE_KEY);
  const log = (data[LOG_STORAGE_KEY] as CaptureRecord[] | undefined) ?? [];
  // The stored log is oldest-first (append order); the page shows
  // newest at the top.
  records = [...log].reverse();
}

searchInput.addEventListener('input', render);

// Keep the page live: a capture taken (or a Clear log history) while
// the History tab sits open rewrites `captureLog`, and re-reading is
// cheap enough to just do it wholesale.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(LOG_STORAGE_KEY in changes)) return;
  void (async () => {
    await loadRecords();
    // A first-ever capture is also what makes the capture directory
    // resolvable, so retry that while we're here.
    if (!captureDir) await loadCaptureDir();
    // The new capture's own files won't be in the existence map yet.
    await loadFileExistence();
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

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (
    !msg
    || typeof msg !== 'object'
    || (msg as { action?: unknown }).action !== 'pingHistoryPage'
  ) {
    return false;
  }
  sendResponse({ ok: true });
  return false;
});

void (async () => {
  // Fire-and-forget: if the SW can't be reached the only cost is that
  // the next History click opens a second tab.
  chrome.runtime.sendMessage({ action: 'historyPageReady' }).catch(() => {});

  fileAccessBlocked = !(await chrome.extension.isAllowedFileSchemeAccess());
  await Promise.all([loadRecords(), loadCaptureDir(), loadFileExistence()]);
  render();
})();
