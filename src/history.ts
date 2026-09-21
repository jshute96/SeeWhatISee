// Controller for `src/history.html` — the Capture history page.
//
// A read-only table view over the capture log. It reads `log.json`
// itself — the file is the log, and the only copy of it — on open and
// again whenever a capture lands (see `loadRecordsFromLog`); newest
// entry first.
// Nothing here writes to the log; the page is a way to look back at
// what was captured and jump to the saved files.
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
// **Older captures.** `log.json` holds only the most recent captures;
// older ones are flushed to `history-*.json` files beside it (see
// `capture/log-store.ts`). They are found by listing the capture
// directory over `file://` (`listHistoryFiles`) and read back on
// demand, appended after the `log.json` records — the reads are
// opt-in per visit rather than something the page does on load.
//
// **File access.** The saved screenshots / HTML / selection files live
// on disk under `<downloads>/SeeWhatISee/`, and every read here — the
// log, the listing, the files — is a `file://` fetch, which Chrome
// only allows with "Allow access to file URLs" on. That toggle is
// required (`capture/file-access.ts`): with it off the page loads
// nothing and shows the dialog that explains it.

import {
  canReadFiles,
  listHistoryFiles,
  peekCaptureDirectory,
  getCaptureFileExistence,
  joinCapturePath,
  pathToFileUrl,
  readLogText,
} from './capture/downloads.js';
import { showFileAccessDialog } from './capture/file-access-dialog.js';
import {
  dedupeRecords,
  LAST_CAPTURE_FILES_KEY,
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
const optionsBtn = document.getElementById('options-btn') as HTMLButtonElement;
const snapshotsDirBtn = document.getElementById('snapshots-dir') as HTMLButtonElement;
const snapshotsDirWrap = document.getElementById('snapshots-dir-wrap') as HTMLElement;
const olderEl = document.getElementById('older') as HTMLElement;
const loadOlderBtn = document.getElementById('load-older') as HTMLButtonElement;
const olderNoteEl = document.getElementById('older-note') as HTMLElement;
const emptyHistoryFilesEl = document.getElementById('empty-history-files') as HTMLElement;
const scrollerEl = document.getElementById('scroller') as HTMLElement;

// ───────────────────────── keyboard scrolling ────────────────────────
//
// The table scrolls inside <main>, not on the document, and Chrome
// sends the scrolling keys to the focused element's nearest scrollable
// ancestor. Focus normally sits on <body> or on a header/toolbar
// button — none of which has one — so out of the box the arrows and
// Page Up/Down did nothing at all.
//
// Rather than parking focus somewhere, the page treats scrolling as a
// background behaviour: whatever has focus, a scrolling key scrolls
// <main>, with two deliberate exceptions.
//   - A form control keeps the keys it uses itself — the arrows and
//     Home/End move the caret in the search box. Page Up/Down aren't
//     among them: a single-line input does nothing with those, and
//     "type a search, then page through the hits" has to work.
//   - A cell's own `.scroll-box` (a long URL or prompt) keeps them
//     all, so a key pressed inside that box scrolls the box. The
//     boxes are `tabindex="-1"` so that clicking one gives it focus
//     and Chrome's native handling takes over — this handler only has
//     to step aside.

/** Fraction of the visible height one Page Up/Down moves. */
const PAGE_SCROLL_FRACTION = 0.9;
/** One arrow-key step. Chrome's own line step for a wheel-less scroll. */
const LINE_SCROLL_PX = 40;

/**
 * How far this key should scroll `el`, or `null` if it isn't a
 * scrolling key. Home/End ask for a full `scrollHeight` in either
 * direction — more than the box can travel, and `scrollBy` clamps the
 * excess, so it lands exactly at the end.
 */
function scrollStepFor(key: string, el: HTMLElement): number | null {
  switch (key) {
    case 'ArrowDown': return LINE_SCROLL_PX;
    case 'ArrowUp': return -LINE_SCROLL_PX;
    case 'PageDown': return el.clientHeight * PAGE_SCROLL_FRACTION;
    case 'PageUp': return -el.clientHeight * PAGE_SCROLL_FRACTION;
    case 'End': return el.scrollHeight;
    case 'Home': return -el.scrollHeight;
    default: return null;
  }
}

/**
 * The keys a focused form control uses for itself: they move the caret
 * in a text field, and the selection in a `<select>`.
 */
const CARET_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);

/** True for a control that consumes `CARET_KEYS` itself. */
function usesCaretKeys(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
    || el.tagName === 'SELECT';
}

/**
 * The innermost scrolling box between `start` and `<main>`, if any —
 * i.e. a cell's `.scroll-box` that has content to scroll. Returns null
 * once the walk reaches `<main>` itself, whose keys this handler owns,
 * and for anything outside `<main>` (a toolbar button has no inner box
 * to defer to, and walking on to <html> would let some future
 * scrollable wrapper up there silently swallow the keys).
 */
function innerScroller(start: Element | null): HTMLElement | null {
  if (!start || !scrollerEl.contains(start)) return null;
  for (let el: Element | null = start; el instanceof HTMLElement && el !== scrollerEl;
       el = el.parentElement) {
    const overflowY = getComputedStyle(el).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll')
        && el.scrollHeight > el.clientHeight) {
      return el;
    }
  }
  return null;
}

document.addEventListener('keydown', (e) => {
  // A modified key that isn't ours must reach Chrome untouched: Alt
  // and Meta combinations are browser navigation (Alt-Left is Back),
  // and Shift-arrow / Shift-Home extend a text selection.
  if (e.defaultPrevented || e.altKey || e.metaKey || e.shiftKey) return;
  // Ctrl-Home / Ctrl-End are the familiar jump-to-the-end chords, so
  // those are ours. Every other Ctrl combination belongs to Chrome —
  // notably Ctrl-Page Up/Down, which switches browser tabs.
  if (e.ctrlKey && e.key !== 'Home' && e.key !== 'End') return;
  const step = scrollStepFor(e.key, scrollerEl);
  if (step === null) return;
  const target = e.target instanceof Element ? e.target : null;
  // Both exceptions above: leave the key alone and let the control or
  // the inner box do what it would have done natively.
  if (usesCaretKeys(target) && CARET_KEYS.has(e.key)) return;
  if (innerScroller(target)) return;
  scrollerEl.scrollBy({ top: step });
  // Stops the double-scroll when focus already sits on a link inside
  // <main>, where Chrome would have scrolled it as well.
  e.preventDefault();
});

// Browse the on-disk capture directory — the same new-tab `file://`
// open the More → Snapshots directory menu entry used to do, moved
// here so it sits with the rest of the file-browsing affordances.
//
// A button rather than an `<a href>` (which the row file links show
// works fine for `file://` from this page) because the destination
// isn't known until the directory lookup resolves, and an anchor has
// no disabled state to hold in the meantime.
snapshotsDirBtn.addEventListener('click', () => {
  if (captureDir === null) return;
  // Caught: the directory could have gone away since load, and an
  // uncaught rejection in an extension page lands on the
  // chrome://extensions Errors list.
  chrome.tabs.create({ url: pathToFileUrl(captureDir) }).catch(() => {});
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
 * capture landing, a downloads sweep, a keystroke in the search
 * box — would otherwise hand back a fresh, enabled button.
 */
let restoreInFlight = false;
/**
 * Absolute path of `<downloads>/SeeWhatISee/`, or `null` when it
 * couldn't be resolved — nothing cached in storage and no download
 * record of anything we wrote to derive it from. With `null` we
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
 * Absolute paths of the `history-*.json` history files, newest first
 * (by the timestamp in each filename — see `listHistoryFiles`).
 */
let historyFilePaths: string[] = [];
/**
 * Records read out of each history file we've loaded, keyed by path,
 * each newest-first within its file. Keyed by path rather than
 * accumulated into one list so the merge can walk `historyFilePaths` in
 * order — a history file written *after* some are already loaded belongs
 * ahead of them, not appended to the end.
 */
const historyFileRecords = new Map<string, CaptureRecord[]>();
/** Message from a failed history file read, shown next to the button. */
let historyFileError = '';
/**
 * True while a read is in flight. Both entry points — the button and
 * the storage listener — go through `loadHistoryFilesInteractively`, so
 * this covers a click landing mid-capture as well as a double-click.
 */
let historyFileLoading = false;

/** History files we know about but haven't read yet. */
function unloadedHistoryFiles(): string[] {
  return historyFilePaths.filter((p) => !historyFileRecords.has(p));
}

/**
 * Loaded history files in display order: the current listing first, then
 * any loaded file that has dropped off it.
 *
 * A path can vanish from the listing without its records becoming
 * wrong — the file was deleted on disk after we read it, or a later
 * directory listing failed outright. Dropping those rows would make
 * captures disappear from the page for a reason that has nothing to
 * do with them. The strays go last; `Map` iterates in insertion
 * order, which is the newest-first order they were read in.
 */
function historyFileDisplayOrder(): string[] {
  const listed = new Set(historyFilePaths);
  const strays = [...historyFileRecords.keys()].filter((p) => !listed.has(p));
  return [...historyFilePaths, ...strays];
}

/**
 * The rows to render: the `log.json` records, then the loaded history files in
 * newest-file-first order. Cached rather than rebuilt per render,
 * since `render()` runs on every keystroke in the search box.
 */
let mergedRecords: CaptureRecord[] = [];

/**
 * Recompute `mergedRecords`: concatenate in file order, then drop
 * exact repeats.
 *
 * **No sort.** `historyFilePaths` is already newest-first by the
 * timestamp in each filename, which is true write order, and each
 * file's records are reversed out of append order. Sorting by `timestamp` would only
 * reshuffle things: a record appended later can carry an earlier
 * timestamp than one before it, and a session's repeat saves are
 * ordered by a millisecond the log invented for uniqueness
 * (`uniqueTimestamp`) rather than by when the user saved. The live log
 * has always been shown in append order; history files match it.
 *
 * **Dedup is exact-match only**, via `dedupeRecords`. Every save gets
 * its own timestamp, so what it's left catching is one record arriving
 * from both sources merged here — a batch that reached a history file
 * while the service worker died before the matching `log.json` trim.
 * Anything looser — keying on `timestamp` — merges the distinct
 * records of a single editing session and drops real captures; that
 * shipped once already.
 * The two copies land on opposite sides of the log / history-file
 * boundary, so the pass is global rather than adjacent-only.
 */
function rebuildMerged(): void {
  const all = [...records];
  for (const path of historyFileDisplayOrder()) {
    const loaded = historyFileRecords.get(path);
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
 * At most one row can match: every save has its own timestamp, and
 * `mergedRecords` is deduped on exactly this key, so a record that
 * reached the page from two sources has already collapsed into one.
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
 * Reopen's tooltip. Says *another* capture, since that is the one
 * thing a user could get wrong here — this adds a row rather than
 * editing the one they clicked.
 */
const REOPEN_TOOLTIP =
  'Reopen another capture, starting from this saved image, contents, and prompt.';

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
      btn.title = `Couldn't restore this capture: ${
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
 * The row's Restore / Reopen button hangs below the timestamp, on
 * both the parsed and unparseable paths — the row is actionable
 * either way.
 */
function dateCell(r: CaptureRecord): HTMLElement {
  const td = document.createElement('td');
  td.className = 'date-cell';
  const d = new Date(r.timestamp);
  if (Number.isNaN(d.getTime())) {
    td.textContent = r.timestamp;
    appendRowAction(td, r);
    return td;
  }
  td.append(d.toLocaleDateString());
  td.append(document.createElement('br'));
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = d.toLocaleTimeString();
  td.append(time);
  appendRowAction(td, r);
  return td;
}

/**
 * Send the reopen click to the SW, which reads this record's files
 * back off disk and opens a Capture page seeded from them (see
 * `background/capture-details.ts` → `reopenCapture`).
 *
 * Unlike Restore, this button stays on its row: reopening consumes
 * nothing, and the same record can be reopened again. So the button
 * comes back on both outcomes, and only a failure leaves a reason in
 * the tooltip.
 */
function reopenFromRow(btn: HTMLButtonElement, r: CaptureRecord): void {
  btn.disabled = true;
  btn.title = REOPEN_TOOLTIP;
  void (async () => {
    try {
      const resp = (await chrome.runtime.sendMessage({
        action: 'reopenCaptureFromHistory',
        record: r,
      })) as { ok?: boolean; error?: string } | undefined;
      if (!resp?.ok) throw new Error(resp?.error ?? 'The reopen did not go through.');
    } catch (err) {
      // Expected-and-handled: the reason goes in the tooltip. Not
      // `console.error` — Chrome promotes that onto the Errors page.
      console.info('[SeeWhatISee] history: reopen failed:', err);
      btn.title = `Couldn't reopen this capture: ${
        err instanceof Error ? err.message : String(err)}`;
    } finally {
      btn.disabled = false;
    }
  })();
}

/**
 * Add the row's button: Restore on the one restorable row, Reopen on
 * every other.
 *
 * One button, not two. Restore is strictly the better of the pair
 * where it applies — it brings back the live session, drawings still
 * undoable — so offering both on that row would only ask the user to
 * tell apart two things that do nearly the same thing. The Date column
 * is 100px wide besides.
 *
 * A record with no artifacts left to read still gets the button: what
 * it can't load, it degrades on (see `reopenCapture`), and the prompt
 * and URL are often the point.
 */
function appendRowAction(td: HTMLElement, r: CaptureRecord): void {
  const btn = document.createElement('button');
  btn.type = 'button';
  if (isRestorable(r)) {
    btn.className = 'btn restore-btn';
    btn.textContent = 'Restore';
    // A re-render mid-restore rebuilds this element; carry the
    // in-flight disable across it rather than handing back a live
    // button.
    btn.disabled = restoreInFlight;
    btn.title = RESTORE_TOOLTIP;
    btn.addEventListener('click', () => restoreFromRow(btn));
  } else {
    btn.className = 'btn reopen-btn';
    btn.textContent = 'Reopen';
    btn.title = REOPEN_TOOLTIP;
    btn.addEventListener('click', () => reopenFromRow(btn, r));
  }
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
 * An `<a>` pointing at one of our capture files, shared by the
 * Screenshot and Files columns so the two can't disagree about how a
 * file link behaves.
 */
function captureFileLink(url: string, filename: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noreferrer noopener';
  a.title = filename;
  return a;
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
  const link = captureFileLink(url, r.screenshot.filename);
  link.className = 'thumb-link';
  const img = document.createElement('img');
  img.className = 'thumb';
  img.src = url;
  img.alt = r.screenshot.filename;
  img.loading = 'lazy';
  // A thumbnail that can't load would otherwise render as a
  // broken-image icon with no explanation. Deletion is caught upstream
  // by `isDeleted`, so what reaches here is a file the download records
  // don't know about, or a decode failure. Swap just the <img> for the
  // filename and keep the surrounding <a>: the href is still the one useful thing
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
      const a = captureFileLink(url, artifact.filename);
      a.textContent = label;
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
 * A cell box that scrolls internally rather than stretching its row
 * (see `.scroll-box` in history.html).
 *
 * `tabindex="-1"` so a click lands focus on the box itself: Chrome
 * then routes the scrolling keys to it, which is what makes "click a
 * long URL, then Page Down" scroll that box instead of the table. -1
 * keeps it out of the Tab order — there is one box per cell and
 * tabbing through all of them to reach the next link would be worse
 * than not being able to tab to any.
 */
function makeScrollBox(extraClass?: string): HTMLElement {
  const box = document.createElement('div');
  box.className = extraClass ? `${extraClass} scroll-box` : 'scroll-box';
  box.tabIndex = -1;
  return box;
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
  const box = makeScrollBox();
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
  const box = makeScrollBox('prompt-box');
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
 * The "Load older captures" control, next to the capture count in the
 * toolbar.
 *
 * Hidden entirely when there's nothing more to offer — no history
 * files, or every one already read — so a user who never fills the
 * 100-entry buffer never sees it, and it disappears once every
 * history file has been read. A read failure leaves its file unread, so the
 * control stays up — carrying the message, with the button available
 * to retry.
 */
function renderOlder(): void {
  const remaining = unloadedHistoryFiles().length;
  // A failed read leaves its file unread, so `remaining` alone already
  // keeps this on screen after a failure; the `historyFileError` term is
  // belt-and-braces against a future failure mode that consumes the
  // file anyway.
  olderEl.hidden = remaining === 0 && !historyFileError;
  loadOlderBtn.disabled = historyFileLoading || remaining === 0;
  loadOlderBtn.textContent = historyFileLoading ? 'Loading…' : 'Load older captures';
  // The count lives in the tooltip rather than beside the button: it's
  // a file count, not a capture count, so on the toolbar row next to
  // "88 captures" it read as a contradiction.
  loadOlderBtn.title = remaining > 0
    ? 'Recent captures from log.json are shown by default.\n'
      + 'Older captures are stored in history-*.json '
      + `(${remaining} ${remaining === 1 ? 'file' : 'files'}).\n`
      + 'Click to load the history.'
    : '';
  // The note is for failures only — everything else this control has
  // to say is in the tooltip.
  olderNoteEl.textContent = historyFileError;
}

function render(): void {
  const terms = searchInput.value.toLowerCase().split(/\s+/).filter(Boolean);
  const all = mergedRecords;
  const shown = all.filter((r) => matches(r, terms));

  rowsEl.replaceChildren(...shown.map(buildRow));
  renderOlder();

  const hasAny = all.length > 0;
  // "No captures in the log yet. Capture something…" is the wrong
  // story when history-file captures are sitting right there unread — the
  // usual way to get here is deleting `log.json` on an account with
  // history files. The second notice points at the button instead of
  // denying they exist.
  //
  // The notice used to be suppressed outright in that case, on the
  // grounds that the "Load older captures" row sat right underneath
  // it. It doesn't any more — it's up in the toolbar — so saying
  // nothing would leave a blank page with no explanation at all.
  const historyFilesWaiting = unloadedHistoryFiles().length > 0;
  emptyEl.hidden = hasAny || historyFilesWaiting;
  emptyHistoryFilesEl.hidden = hasAny || !historyFilesWaiting;
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
}

// ─────────────────────────────── loading ─────────────────────────────

async function loadCaptureDir(): Promise<void> {
  try {
    // The cache / download-history lookup is free; nothing here
    // writes a file to learn the directory, which merely opening this
    // page shouldn't do. `null` — nothing captured yet — is expected
    // on a fresh install, and the empty state already says so.
    captureDir = await peekCaptureDirectory();
  } catch {
    captureDir = null;
  }
  // Nothing to browse until the directory is known, so the button
  // stays disabled (its markup state) until this resolves. The tooltip
  // — on the wrapper, since Chrome shows no tooltip for a disabled
  // control — carries the reason, and the resolved path once enabled.
  snapshotsDirBtn.disabled = captureDir === null;
  snapshotsDirWrap.title = captureDir === null
    ? 'No captures saved to disk yet, so there is no directory to open'
    : `Open the directory where capture files are stored:\n${captureDir}`;
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

async function loadHistoryFileList(): Promise<void> {
  try {
    historyFilePaths = captureDir !== null ? await listHistoryFiles(captureDir) : [];
  } catch {
    // Unreadable or missing directory — same outcome as having no
    // history files: the page shows `log.json` and doesn't offer
    // more.
    historyFilePaths = [];
  }
  // The merge walks this list, so the rows go stale the moment it
  // changes — a newly-written history file has to take its place among the
  // loaded ones now, not whenever some later load happens to rebuild.
  // Records already read are kept even if their path dropped off; see
  // `historyFileDisplayOrder`.
  rebuildMerged();
}

/**
 * Read every history file we haven't read yet and merge its records
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
 * even if others failed, and the paths that failed are returned. One
 * dead file (deleted between the listing and the read) must not veto
 * the history files that *are* readable — and it wouldn't heal on
 * retry, so all-or-nothing would lock the rest of the history out for
 * the session.
 */
async function loadHistoryFiles(): Promise<string[]> {
  const pending = unloadedHistoryFiles();
  if (pending.length === 0) return [];
  const results = await Promise.allSettled(pending.map(async (path) => {
    // A missing file can resolve non-ok — and that would otherwise look
    // like a successful read of an empty history file, silently dropping 50
    // captures off the page. `fetchImageInSW` checks `ok` on this same
    // scheme for the same reason.
    const res = await fetch(pathToFileUrl(path));
    if (!res.ok) throw new Error(`history file read failed: ${res.status}`);
    return await res.text();
  }));

  const failed: string[] = [];
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      failed.push(pending[i]);
      return;
    }
    // Reversed to match the page's newest-first order, the same way
    // `loadRecordsFromLog` reverses the append-ordered file.
    historyFileRecords.set(pending[i], parseLogText(result.value).reverse());
  });
  rebuildMerged();
  return failed;
}

/**
 * Read the pending history files and fold the outcome into the page state.
 * Shared by the button and the storage listener so both show the
 * loading state and report failures the same way — and so neither can
 * start a second read while one is in flight.
 */
async function loadHistoryFilesInteractively(): Promise<void> {
  if (historyFileLoading) return;
  historyFileLoading = true;
  historyFileError = '';
  renderOlder();
  try {
    const failed = await loadHistoryFiles();
    // The newly-loaded rows reference files we haven't asked about
    // yet, so refresh the "(deleted)" map alongside them.
    await loadFileExistence();
    if (failed.length > 0) {
      // Anything readable has already been merged in; this names what
      // is still missing rather than implying the whole load failed.
      // Named, not counted, so the user knows where to look — but a
      // directory that went away fails every file at once, and the
      // note is one inline span, so the list is capped.
      const shown = failed.slice(0, 3).join(', ');
      const more = failed.length - 3;
      historyFileError = more > 0
        ? `Couldn't read ${shown}, and ${more} more.`
        : `Couldn't read ${shown}.`;
    }
  } catch {
    // `loadHistoryFiles` reports per-file failures through its return
    // value, so reaching here means the read itself broke.
    historyFileError = "Couldn't read the history files.";
  }
  historyFileLoading = false;
  render();
}

loadOlderBtn.addEventListener('click', () => {
  void loadHistoryFilesInteractively();
});

/**
 * Bumped on every read of `log.json` so a slower read can tell a newer
 * one started while it was in flight and discard its own result —
 * the newer read sees the file the capture just wrote, and without
 * the check the stale one would overwrite the new rows.
 */
let recordsGeneration = 0;

/** Install `list` (newest first) as the recent records and re-merge. */
function setRecords(list: CaptureRecord[]): void {
  records = list;
  rebuildMerged();
}

/**
 * Load the recent records from `log.json` — on open, and again each
 * time a capture lands (the session note `recordCapture` leaves is
 * the cue; see the `storage.onChanged` listener below).
 *
 * With no known directory there is no file yet: nothing captured on
 * this profile, and the empty state says so. Otherwise whatever the
 * read finds is the answer: text (even empty) renders as the log, and
 * a failed fetch means the file isn't there — the log's state, so it
 * renders as empty rather than as an error. History files are
 * discovered independently (`loadHistoryFileList`), so a deleted or
 * emptied `log.json` still offers the older captures for loading.
 *
 * The page only displays; the capture path is the only writer.
 */
async function loadRecordsFromLog(): Promise<void> {
  if (captureDir === null) {
    setRecords([]);
    return;
  }
  const generation = ++recordsGeneration;
  const text = await readLogText(captureDir);
  // A newer read started while this one was in flight — a capture
  // landed — so its result is the fresher one; drop this.
  if (generation !== recordsGeneration) return;
  // The file is in append order; newest at the top.
  setRecords(text === null ? [] : parseLogText(text).reverse());
}

searchInput.addEventListener('input', render);

// Keep the page live: a capture taken while the History tab sits open
// leaves its session note (`recordCapture`) once `log.json` has been
// written, and re-reading the file is cheap enough to just do it
// wholesale.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !(LAST_CAPTURE_FILES_KEY in changes)) return;
  void (async () => {
    // A first-ever capture is also what makes the capture directory
    // resolvable, so retry that first.
    if (!captureDir) await loadCaptureDir();
    await loadRecordsFromLog();
    // The new capture's own files won't be in the existence map yet.
    await loadFileExistence();
    // A capture can also push the log over its cap and write a new
    // history file. Pick that up so the button's count stays right —
    // and read it straight away if the user has already opted in, so
    // records don't appear to vanish as they age out of `log.json`.
    await loadHistoryFileList();
    if (historyFileRecords.size > 0) {
      await loadHistoryFilesInteractively();
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

  // The toggle is required, so the page loads nothing without it:
  // every read below is a `file://` fetch Chrome would refuse, and
  // the dialog over the empty page is the whole answer — there is no
  // dismissing it short of leaving or flipping the toggle.
  if (!(await canReadFiles())) {
    showFileAccessDialog();
    return;
  }
  await Promise.all([
    loadFileExistence(),
    // Chained, not parallel: both the record load (reading `log.json`
    // itself when it can) and the history-file listing need the
    // directory `loadCaptureDir` resolves first.
    loadCaptureDir().then(() => Promise.all([loadRecordsFromLog(), loadHistoryFileList()])),
  ]);
  firstRenderDone = true;
  render();
})();
