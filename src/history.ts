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

import { getCaptureDirectory, joinCapturePath, pathToFileUrl } from './capture/downloads.js';
import { LOG_STORAGE_KEY } from './capture/log-store.js';
import type { CaptureRecord, SelectionFormat } from './capture/types.js';

const searchInput = document.getElementById('search') as HTMLInputElement;
const countEl = document.getElementById('count') as HTMLElement;
const tableEl = document.getElementById('table') as HTMLTableElement;
const rowsEl = document.getElementById('rows') as HTMLElement;
const emptyEl = document.getElementById('empty') as HTMLElement;
const noMatchesEl = document.getElementById('no-matches') as HTMLElement;
const fileAccessHintEl = document.getElementById('file-access-hint') as HTMLElement;
const optionsBtn = document.getElementById('options-btn') as HTMLButtonElement;

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
 * A saved file we can't offer as a working link — either the capture
 * directory never resolved, or the bytes wouldn't load. Greyed so it
 * doesn't read as a dead link. `label` defaults to the filename;
 * the Files column passes its own ("HTML", "Selection (md)").
 *
 * Shared by the Files column and the screenshot column's broken-image
 * fallback so both degrade the same way.
 */
function unlinkedFile(filename: string, label = filename): HTMLElement {
  const span = document.createElement('span');
  span.className = 'flag';
  span.textContent = label;
  span.title = filename;
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
  if (!url) {
    td.textContent = r.screenshot.filename;
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
  // A thumbnail that can't load (file deleted, or the file-URL toggle
  // is off) would otherwise render as a broken-image icon with no
  // explanation. Replace the whole link — not just its contents —
  // with the greyed filename, matching how the Files column renders an
  // artifact it can't build a URL for. Keeping the <a> would leave a
  // link that looks live but goes nowhere, since whatever stopped the
  // <img> loading stops the navigation too.
  img.addEventListener('error', () => {
    link.replaceWith(unlinkedFile(r.screenshot!.filename));
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
    if (url) {
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
 */
function pageCell(r: CaptureRecord): HTMLElement {
  const td = document.createElement('td');
  td.className = 'page-cell';
  if (r.title) {
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = r.title;
    td.append(title);
  }
  if (r.url) {
    const a = document.createElement('a');
    a.className = 'url';
    a.href = r.url;
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    a.textContent = r.url;
    td.append(a);
  }
  if (!td.childElementCount) td.append(naSpan());
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
  box.className = 'prompt-box';
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
  // and a working link — i.e. the toggle is off AND some visible row
  // would otherwise have rendered a file:// URL. Without the
  // `captureDir` check it would fire on a log whose directory never
  // resolved, where flipping the toggle changes nothing (the real
  // reason is that no capture has been written yet); without the
  // artifact check it would fire on a log of prompt- or URL-only
  // records, which reference no files at all.
  fileAccessHintEl.hidden = !fileAccessBlocked
    || captureDir === null
    || !shown.some((r) => r.screenshot || r.contents || r.selection);
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
    render();
  })();
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
  await Promise.all([loadRecords(), loadCaptureDir()]);
  render();
})();
