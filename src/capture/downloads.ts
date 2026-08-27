// Capture-side download helpers — every write that lands a file
// on disk goes through here. All paths use `conflictAction:
// 'overwrite'` because `compactTimestamp` keeps capture filenames
// unique across captures (see `log-store.ts`), and the Capture
// page flow deliberately overwrites its pinned filename as the
// user edits highlights / re-copies.

import {
  type InMemoryCapture,
  type SelectionFormat,
  noSelectionContentMessage,
} from './types.js';
import { unpackText } from './packed-text.js';

/**
 * Subdirectory under the user's download root where every capture
 * file lands. Also the string the directory-discovery helpers below
 * (`searchCaptureDirectory`, the `waitForDownloadComplete` cache
 * refresh) match against, so the write path and the where-did-it-land
 * lookup can't disagree.
 */
export const DOWNLOAD_SUBDIR = 'SeeWhatISee';

/**
 * Filename prefix for the capture-log history files —
 * `history-<compactTimestamp>.json`, holding the older entries that
 * no longer fit in `log.json` (see `log-store.ts`).
 *
 * Lives here beside `DOWNLOAD_SUBDIR` because the writer
 * (`log-store.ts`) and the "find them again" search below have to
 * agree on it, and this module owns everything about where capture
 * files land.
 */
export const HISTORY_FILE_PREFIX = 'history-';

/**
 * Name of the capture log file. Every capture rewrites it, and it
 * is the one deliberately-reused filename in the capture directory —
 * hence the reconcile machinery in `log-reconcile.ts` that checks what
 * is on disk before overwriting.
 */
export const LOG_FILE_NAME = 'log.json';

/**
 * `chrome.storage.local` key holding the last known capture directory
 * (absolute OS-native path). Storage rather than a module variable so
 * every context (service worker, History page) sees the same answer
 * and it survives service-worker restarts — including after the user
 * clears Chrome's download history, which used to be the only index.
 */
export const CAPTURE_DIR_STORAGE_KEY = 'captureDirectory';

/**
 * Persist `dir` as the capture directory for `peekCaptureDirectory`.
 * Fire-and-forget: a lost write only costs a re-derivation later, and
 * no caller wants to fail its own work over a cache update.
 */
function rememberCaptureDirectory(dir: string): void {
  void (async () => {
    try {
      await chrome.storage.local.set({ [CAPTURE_DIR_STORAGE_KEY]: dir });
    } catch (err) {
      console.info('[SeeWhatISee] could not cache the capture directory:', err);
    }
  })();
}

/**
 * Low-level download primitive. Used by every other write site
 * (screenshot / html / selection / log.json). `filename` is the
 * bare basename — we prefix it with `DOWNLOAD_SUBDIR/` here so
 * callers don't have to remember.
 *
 * Returns the chrome.downloads id so callers (mostly tests) can
 * resolve it to an on-disk path via `waitForDownloadComplete`.
 */
export async function downloadArtifact(filename: string, url: string): Promise<number> {
  return chrome.downloads.download({
    url,
    filename: `${DOWNLOAD_SUBDIR}/${filename}`,
    saveAs: false,
    // We rely on `compactTimestamp` giving unique filenames across
    // captures, so `'overwrite'` is safe everywhere: log.json
    // deliberately overwrites every time, and the Capture page flow
    // may rewrite the same pinned filename as the user edits
    // highlights / re-copies.
    conflictAction: 'overwrite',
  });
}

/** Build a `data:` URL for an HTML body, percent-encoded. Exported
 *  so the SW-side HTML-only save paths (`savePageContents`) can
 *  produce the same URL shape as `downloadHtml`. */
export function htmlDataUrl(body: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(body)}`;
}

/**
 * Start a screenshot download. `screenshotOverride` is an optional
 * replacement data URL with the user's red highlights baked into
 * the PNG bytes; when omitted we write the original screenshot.
 */
export async function downloadScreenshot(
  capture: InMemoryCapture,
  screenshotOverride?: string,
): Promise<number> {
  return downloadArtifact(
    capture.screenshotFilename,
    screenshotOverride ?? capture.screenshotDataUrl,
  );
}

/**
 * Start an HTML download. The body is stable for the session unless
 * the user saves an edit in the Edit HTML dialog — callers cache the
 * result and rely on the `updateArtifact` handler to drop the cache
 * when the body changes (see `ensureHtmlDownloaded`).
 *
 * The file on disk is always the plain HTML, whatever form the
 * capture was holding: a `.html` an agent has to gunzip before
 * reading would defeat the point. Compression is a storage detail
 * and stops at this boundary.
 */
export async function downloadHtml(capture: InMemoryCapture): Promise<number> {
  const html = await unpackText(capture.html);
  return downloadArtifact(capture.contentsFilename, htmlDataUrl(html));
}

/**
 * MIME type to embed in the `data:` URL for each selection format.
 * HTML is served as `text/html` like the page-content snapshot;
 * text and markdown use `text/plain` / `text/markdown` so any
 * downstream tool that sniffs the MIME picks the right branch.
 */
const SELECTION_DATA_URL_MIME: Record<SelectionFormat, string> = {
  html: 'text/html',
  text: 'text/plain',
  markdown: 'text/markdown',
};

/**
 * Start a selection download in a specific format. Throws when the
 * capture doesn't carry a selection of that format — callers must
 * ensure `capture.selections` and `capture.selectionFilenames` are
 * populated first, and that the chosen format's body is non-empty.
 *
 * Appends a trailing newline when the body doesn't already end in
 * one. Selections are often a single run of text with no line
 * break, and shells / editors read terminator-stripped files more
 * comfortably.
 */
export async function downloadSelection(
  capture: InMemoryCapture,
  format: SelectionFormat,
): Promise<number> {
  if (!capture.selections || !capture.selectionFilenames) {
    throw new Error('No selection captured');
  }
  // Unpacked here for the same reason `downloadHtml` unpacks: the
  // file on disk is always plain text, whatever form storage held.
  const body = await unpackText(capture.selections[format]);
  if (body.trim().length === 0) {
    throw new Error(noSelectionContentMessage(format));
  }
  const withNewline = body.endsWith('\n') ? body : `${body}\n`;
  const mime = SELECTION_DATA_URL_MIME[format];
  const url = `data:${mime};charset=utf-8,${encodeURIComponent(withNewline)}`;
  return downloadArtifact(capture.selectionFilenames[format], url);
}

/**
 * Poll `chrome.downloads.search` until the given download reaches
 * `state === 'complete'`, then return its absolute on-disk path.
 * Used by background.ts when the Copy buttons need a paste-ready
 * path and can't return until the file is actually written.
 *
 * Polls at 50 ms; default timeout is 5 s, plenty for the data-URL
 * downloads the Capture page flow uses (PNGs and HTML, both essentially
 * synchronous on completion). Throws on `interrupted` or timeout
 * so the caller can surface a real error.
 */
export async function waitForDownloadComplete(
  downloadId: number,
  timeoutMs = 5000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (item?.state === 'complete' && item.filename) {
      // A completed write that landed directly inside a `SeeWhatISee/`
      // directory refreshes the cached capture directory — the same
      // structural rule as `searchCaptureDirectory`'s regex, including
      // requiring a separator before the segment so a (never expected)
      // relative path can't cache a bare `SeeWhatISee`. Save-as writes
      // into unrelated folders don't match, so they can't poison the
      // cache. This covers the writes awaited here — log writes,
      // history-file flushes, the probes — which is what keeps the
      // cache tracking a download root the user has since moved.
      const dir = parentDirectory(item.filename);
      if (new RegExp(`[/\\\\]${DOWNLOAD_SUBDIR}$`).test(dir)) rememberCaptureDirectory(dir);
      return item.filename;
    }
    if (item?.state === 'interrupted') {
      throw new Error(`Download ${downloadId} interrupted: ${item.error ?? 'unknown'}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Download ${downloadId} did not complete within ${timeoutMs}ms`);
}

/**
 * Derive the capture directory from download history: the most recent
 * file *we* wrote directly inside a `SeeWhatISee/` directory. `null`
 * when there is no such record (nothing captured yet, or the user
 * cleared Chrome's download history).
 *
 * - `byExtensionId` (checked client-side, since `DownloadQuery`
 *   doesn't accept it as a filter — it's a result-only field) is what
 *   rules out an unrelated `SeeWhatISee/` folder the user happens to
 *   keep elsewhere (e.g. `/tmp/SeeWhatISee/`).
 * - Any artifact answers, not just `log.json`: a capture writes its
 *   screenshot / HTML *before* `recordCapture` runs, so matching them
 *   too means the directory is known by the time the log is written on
 *   the very first capture.
 * - That includes a `probe-*.json` whose cleanup failed, and
 *   deliberately so: the probe is written into this very directory, so
 *   a leftover record still points at the right answer.
 * - The match is structural: our download, landing directly inside a
 *   directory named `SeeWhatISee/`. Every code-initiated write goes
 *   through `downloadArtifact`, which hardcodes that relative path, so
 *   it always matches. A `saveAs: true` write (the Capture page's
 *   Save-as buttons) lands wherever the user chose and so normally
 *   doesn't — unless they picked a folder literally named
 *   `SeeWhatISee`, the one way an unrelated directory can be adopted.
 */
async function searchCaptureDirectory(): Promise<string | null> {
  const candidates = await chrome.downloads.search({
    filenameRegex: `[/\\\\]${DOWNLOAD_SUBDIR}[/\\\\][^/\\\\]+$`,
    orderBy: ['-startTime'],
  });
  const ours = candidates.find((it) => it.byExtensionId === chrome.runtime.id && it.filename);
  // Strip the basename. `chrome.downloads.search().filename` is
  // documented to be the absolute path to a file (never ends in a
  // separator), so this always trims one segment.
  return ours?.filename ? parentDirectory(ours.filename) : null;
}

/**
 * The capture directory, if it can be known without writing anything:
 * the `chrome.storage.local` cache first, then download history (whose
 * answer is cached for next time). `null` when neither knows.
 *
 * For callers that must not write to the disk (the History page load,
 * and the reconcile — which reads `log.json` from the answer and
 * chooses its own probing). Use `getCaptureDirectory` when a
 * throwaway probe write is an acceptable last resort.
 */
export async function peekCaptureDirectory(): Promise<string | null> {
  const data = await chrome.storage.local.get(CAPTURE_DIR_STORAGE_KEY);
  const stored = data[CAPTURE_DIR_STORAGE_KEY];
  if (typeof stored === 'string' && stored) return stored;
  const found = await searchCaptureDirectory();
  if (found) rememberCaptureDirectory(found);
  return found;
}

/**
 * Resolve the absolute on-disk directory where this extension writes
 * its captures (`<downloads>/SeeWhatISee/`). The user's downloads root
 * is OS- and config-dependent and not exposed by any Chrome API, so
 * this falls through `peekCaptureDirectory` (storage cache, then
 * download history) and, when neither knows, learns the answer with a
 * throwaway probe download — which also creates the directory when
 * none existed yet.
 *
 * Throws only when the probe itself fails (downloads blocked or
 * erroring), so the caller can surface that on whatever surface it
 * owns (e.g. the icon/tooltip error channel for the More-submenu
 * entries).
 *
 * Lives here rather than next to its menu call sites because
 * directory discovery is shared — the service worker
 * (`background/context-menu.ts`) uses this, the History page and the
 * reconcile use `peekCaptureDirectory` — and `downloads.ts` is the
 * module that owns everything about where capture files land.
 */
export async function getCaptureDirectory(): Promise<string> {
  const known = await peekCaptureDirectory();
  if (known) return known;
  // The probe's completed write refreshes the cache on its way through
  // `waitForDownloadComplete`, so this happens at most once per
  // profile in practice.
  const probed = await probeCaptureDirectory();
  if (probed) return probed;
  throw new Error(
    `Could not locate the ${DOWNLOAD_SUBDIR} directory — writing a file there failed.`,
  );
}

/**
 * Which of our capture files are still on disk, keyed by bare
 * filename. Chrome tracks this per download record (`DownloadItem
 * .exists`), so we get a real answer without touching the filesystem
 * — and for artifacts like the HTML / selection files, where a link
 * has no load event to fail, it's the *only* answer available.
 *
 * A name absent from the map means "unknown", not "present". Callers
 * must render those normally rather than assuming deleted. Reasons a
 * name can be missing:
 *
 * - The user cleared their download history (chrome://downloads →
 *   Clear all), which drops the records without touching the files.
 * - `DownloadQuery.limit` defaults to 1000, so a very long capture
 *   history is truncated. `orderBy: ['-startTime']` makes that the
 *   *oldest* records, which are the least likely to be on screen.
 *
 * Keyed on the bare filename, ignoring the directory, which is safe
 * only because `compactTimestamp` makes every capture filename unique
 * (see `log-store.ts`). The one deliberately reused name, `log.json`,
 * is never rendered.
 *
 * `exists` can be stale on read — it's the `search()` call itself that
 * prompts Chrome to re-check, and the result arrives later as a
 * `downloads.onChanged` event. So a file deleted outside the browser
 * reads as present until that round-trip lands; callers wanting to
 * converge must listen for those deltas too.
 */
export async function getCaptureFileExistence(): Promise<Map<string, boolean>> {
  const items = await chrome.downloads.search({
    filenameRegex: `[/\\\\]${DOWNLOAD_SUBDIR}[/\\\\]`,
    orderBy: ['-startTime'],
  });
  const byName = new Map<string, boolean>();
  const seen = new Set<string>();
  for (const item of items) {
    if (item.byExtensionId !== chrome.runtime.id || !item.filename) continue;
    const base = item.filename.replace(/^.*[/\\]/, '');
    // Newest record wins per name: `conflictAction: 'overwrite'` means
    // a re-saved capture leaves several records pointing at one path,
    // and only the latest reflects the file that's there now.
    if (seen.has(base)) continue;
    seen.add(base);
    // An in-flight download legitimately reports `exists: false`, so
    // it can't answer the question — but it has still claimed the
    // name, and letting an older record answer instead would flag a
    // file that's being written right now as deleted. Leave it out of
    // the map, i.e. unknown.
    if (item.state !== 'complete') continue;
    byName.set(base, item.exists);
  }
  return byName;
}

/**
 * Read `log.json` from `directory`, or `null` if we can't.
 *
 * A missing file resolves non-ok rather than rejecting, which would
 * otherwise read as a successful load of an empty log and quietly
 * discard the user's history. `null` folds together denied (toggle
 * off), missing, and failed — callers that care disambiguate
 * themselves before concluding the file is gone: the reconcile
 * consults the download record, the History page fetches the
 * directory.
 */
export async function readLogText(directory: string): Promise<string | null> {
  try {
    const res = await fetch(pathToFileUrl(joinCapturePath(directory, LOG_FILE_NAME)));
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Absolute paths of the `history-*.json` history files, newest first,
 * found by reading the capture directory itself over `file://`. Needs
 * "Allow access to file URLs" — the same toggle reading the files
 * takes, so the caller (the History page) gates the whole
 * history-loading feature on it and only calls this when reads work.
 *
 * Fetching a directory URL returns the HTML listing Chrome generates
 * for `file://` directories. Its markup is a browser internal, so the
 * parse is deliberately loose — collect every `history-….json` token
 * anywhere in the page rather than parsing its rows:
 *
 * - A `Set` collapses each row's two appearances of the name (display
 *   text and href, identical for these all-ASCII names).
 * - The names embed `compactTimestamp` (see `log-store.ts`), so a
 *   lexicographic sort *is* chronological; descending = newest first,
 *   true write order. That holds because a history file is stamped
 *   with the moment it was written, not with a record inside it —
 *   record timestamps are pinned at capture time and are not in
 *   append order. (The stamps are local time, so a DST fall-back
 *   hour can sort out of order — accepted, it matches the filenames
 *   the user sees.)
 * - `res.ok` is deliberately NOT checked: Chrome hands the generated
 *   listing back with `status: 0`, so `ok` is false even on success.
 *   A directory that can't be read (missing, or the toggle off)
 *   rejects the fetch instead, which the caller treats as "nothing to
 *   offer".
 *
 * Unlike the `chrome.downloads`-based `getHistoryFilePaths` below,
 * this sees every file actually present *in the given directory*:
 * files whose download records were cleared, and files past
 * `DownloadQuery`'s 1000-record default limit. And a deleted file
 * simply isn't listed, so the stale `DownloadItem.exists` flag never
 * misleads it. The trade: it can only look where the caller points
 * it, so files stranded in an old downloads location are out of view
 * (download records knew their absolute paths). Matching every
 * `history-*.json` in the directory — not just ones we wrote — is the
 * same rule the skills' Python backend uses (`skills/SeeWhatISee.py`),
 * so the page and the scripts agree on what the history is.
 */
export async function listHistoryFiles(directory: string): Promise<string[]> {
  const res = await fetch(pathToFileUrl(directory));
  const html = await res.text();
  const names = new Set(html.match(HISTORY_FILE_TOKEN) ?? []);
  return [...names].sort().reverse().map((name) => joinCapturePath(directory, name));
}

/**
 * Token pattern for history-file names in the listing — loose about
 * the surrounding markup, strict about the name itself:
 *
 * - The middle takes digits and hyphens only, the shape of the
 *   machine-generated stamps we write. A word-y `history-notes.json`
 *   is someone else's file — and the chronological-by-name sort below
 *   only holds for fixed-width digit stamps anyway.
 * - The lookbehind and lookahead reject names that merely *contain*
 *   one — `old-history-….json` (a user's stray rename),
 *   `….json.crdownload` (an interrupted download Chrome left behind)
 *   — which would otherwise list a file that isn't really there and
 *   report a read failure that never heals.
 *
 * `SeeWhatISee.py`'s `history_files()` applies the same name rule to
 * the same directory; keep the two in step.
 */
const HISTORY_FILE_TOKEN = new RegExp(
  `(?<![\\w-])${HISTORY_FILE_PREFIX}[\\d-]*\\.json(?![\\w.])`,
  'g',
);

/**
 * Absolute paths of the `history-*.json` files according to
 * `chrome.downloads` records, newest first.
 *
 * Two callers, neither of which uses the directory listing above:
 *
 * - The flush's filename-collision guard (`log-store.ts`), which runs
 *   during a capture with or without file reads and is best-effort
 *   anyway: the names it protects are millisecond timestamps, so the
 *   gaps below are acceptable there.
 * - The History page with the file-access toggle off, where this is
 *   the only index — enough to keep the Load-older button on screen
 *   as a pointer at the feature, even though the reads themselves
 *   will wait for the toggle.
 *
 * With file reads available, the History page uses `listHistoryFiles`
 * instead, which doesn't depend on download history surviving.
 *
 * - Clearing download history hides files that are still on disk.
 * - `DownloadQuery.limit` defaults to 1000 records, and every capture
 *   file (not just history files) counts toward it; overflow drops
 *   the *oldest* records first.
 *
 * Records for files Chrome knows are deleted are skipped — nothing on
 * disk to collide with — as are duplicates from a re-written name,
 * keeping the newest record per path.
 */
export async function getHistoryFilePaths(): Promise<string[]> {
  const items = await chrome.downloads.search({
    filenameRegex: `[/\\\\]${DOWNLOAD_SUBDIR}[/\\\\]${HISTORY_FILE_PREFIX}[^/\\\\]*\\.json$`,
    orderBy: ['-startTime'],
  });
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item.byExtensionId !== chrome.runtime.id || !item.filename) continue;
    if (item.state !== 'complete' || item.exists === false) continue;
    if (seen.has(item.filename)) continue;
    seen.add(item.filename);
    paths.push(item.filename);
  }
  return paths;
}

/**
 * Join `dir` and `name` using whichever separator `dir` already uses.
 * `chrome.downloads.search` returns OS-native paths — backslashes on
 * Windows, forward slashes elsewhere — so reusing the existing
 * separator keeps the result paste-ready in the user's OS shell /
 * file manager.
 */
export function joinCapturePath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  return `${dir}${sep}${name}`;
}

/**
 * Turn an OS-native absolute path into a properly-encoded `file://`
 * URL. Normalizes Windows backslashes to forward slashes, prepends a
 * leading `/` for Windows paths like `C:/Users/…` so the URL parser
 * sees an absolute path, and lets `new URL` percent-encode anything
 * weird (spaces in user names, `#`, `?`, non-ASCII characters).
 */
export function pathToFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return new URL(`file://${normalized.startsWith('/') ? '' : '/'}${normalized}`).href;
}

/**
 * The newest **completed** `log.json` download record written by this
 * extension, or `null` when there is none.
 *
 * This record is our only memory of the log file that survives
 * `chrome.storage.local` being wiped, so the reconcile in
 * `log-reconcile.ts` leans on it for both "is the file still there"
 * (`exists`) and "how big was it when we wrote it" (`logRecordSize`).
 *
 * Records from a *different* extension id are skipped, same as
 * everywhere else here. That hides the log file written by a previous
 * unpacked load of this extension (whose id changes on every reload)
 * — those fall through to the existence probe instead, which is the
 * conservative answer.
 */
export async function getLogFileRecord(): Promise<LogFileRecordLookup> {
  // Started *before* the search, because the search is what triggers
  // the existence re-check and the answer comes back as an event —
  // registering afterwards can miss it. See `startExistsWatch`.
  const watch = startExistsWatch();
  let record: chrome.downloads.DownloadItem | null;
  try {
    record = await readLogFileRecord();
  } catch (err) {
    watch.stop();
    throw err;
  }
  return {
    record,
    async confirmExists() {
      if (!record) return false;
      if (record.exists === false) return false;
      // No delta means Chrome's re-check agreed with the record, which
      // at this point has already said the file is there.
      const fresh = await watch.settle(record.id, existsRecheckTimeoutMs);
      return fresh ?? true;
    },
    release: () => watch.stop(),
  };
}

/**
 * A `log.json` record plus the means to find out whether its file is
 * *really* still there.
 *
 * Split in two because the answer is expensive and usually irrelevant.
 * `exists` only decides anything on the paths that can't read the file
 * — so a capture that reads `log.json` successfully (the permission is
 * on, which is also how the e2e harness runs) never pays for the
 * re-check at all. Call `release()` when done; `confirmExists()` is
 * meaningless afterwards.
 */
export interface LogFileRecordLookup {
  record: chrome.downloads.DownloadItem | null;
  /**
   * Whether the file is still on disk, waiting out Chrome's re-check
   * rather than trusting the record's stale `exists`. `false` when
   * there is no record at all.
   */
  confirmExists(): Promise<boolean>;
  /** Drop the `onChanged` listener. Safe to call more than once. */
  release(): void;
}

/**
 * How long to wait for Chrome's existence re-check to report back
 * before taking the record's own `exists` at face value.
 *
 * The check is a file stat in the browser process, so the answer lands
 * in milliseconds when it lands at all — and when the file is still
 * there it never lands, because `onChanged` only fires on a *change*.
 * So a `confirmExists()` on a live file waits this out in full, which
 * is why the reconcile only calls it where the answer changes what it
 * does. See `startExistsWatch`.
 */
let existsRecheckTimeoutMs = 300;

/** Test seam — lets the unit tests drive this without real waiting. */
export function _setExistsRecheckTimeoutForTest(ms: number): void {
  existsRecheckTimeoutMs = ms;
}

async function readLogFileRecord(): Promise<chrome.downloads.DownloadItem | null> {
  let ours = await ourLogRecords();
  // **A write still in flight has to be waited out, not skipped.**
  // `chrome.downloads.download` resolves when the download *starts*,
  // so a capture can return before its `log.json` is on disk — and
  // two captures in quick succession put us here mid-write. Answering
  // from the previous completed record would describe the file as it
  // was *before* that write: its size no longer matches the log, which
  // reads as tampering, and a `file://` read of the same moment can
  // catch a half-written file and be adopted as the truth.
  if (ours[0] && ours[0].state === 'in_progress') {
    try {
      await waitForDownloadComplete(ours[0].id);
    } catch (err) {
      // Interrupted or slower than the timeout. Fall through to the
      // newest record that *did* complete — the same conservative
      // answer we'd have given without this wait.
      console.info('[SeeWhatISee] log.json write did not settle:', err);
    }
    ours = await ourLogRecords();
  }
  return ours.find((item) => item.state === 'complete') ?? null;
}

/**
 * Watches for `exists` transitions while Chrome re-checks downloads.
 *
 * **`DownloadItem.exists` is stale on read.** Chrome does not watch the
 * filesystem; `search()` *triggers* an existence re-check, but the
 * search that triggered it still returns the old value — the refreshed
 * one arrives afterwards as a `downloads.onChanged` delta.
 *
 * Reading `exists` straight off a search result therefore reports a
 * `log.json` the user deleted this session as still present. The
 * capture then reads `insync`, rewrites the file from the browser copy,
 * and the deletion is undone — and because the file is back, the *next*
 * capture sees nothing wrong either. The damage is self-concealing,
 * which is why this waits rather than leaving it to the next capture.
 *
 * Start the watch before the triggering `search()`, then `settle()` on
 * the id you care about.
 */
interface ExistsWatch {
  /**
   * Resolve once Chrome reports an `exists` transition for `id`, or
   * after `timeoutMs`. `undefined` means nothing was reported — the
   * re-check agreed with what the record already said.
   */
  settle(id: number, timeoutMs: number): Promise<boolean | undefined>;
  stop(): void;
}

function startExistsWatch(): ExistsWatch {
  const seen = new Map<number, boolean>();
  const waiters = new Map<number, (value: boolean | undefined) => void>();
  const onChanged = (delta: chrome.downloads.DownloadDelta): void => {
    if (!delta.exists) return;
    const current = delta.exists.current === true;
    seen.set(delta.id, current);
    // A delta that lands before anyone asks is kept in `seen`, so the
    // order of arrival vs. `settle()` doesn't matter.
    waiters.get(delta.id)?.(current);
  };
  chrome.downloads.onChanged.addListener(onChanged);
  return {
    settle(id, timeoutMs) {
      const already = seen.get(id);
      if (already !== undefined) return Promise.resolve(already);
      return new Promise<boolean | undefined>((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          resolve(undefined);
        }, timeoutMs);
        waiters.set(id, (value) => {
          clearTimeout(timer);
          waiters.delete(id);
          resolve(value);
        });
      });
    },
    stop() {
      chrome.downloads.onChanged.removeListener(onChanged);
      for (const [id, resolve] of waiters) {
        // Nothing more is coming; unblock anyone still waiting rather
        // than leaving a promise pending for its full timeout.
        // `undefined`, not `false` — "Chrome told us nothing", which
        // keeps the record's own value. Reporting `false` here would
        // read as a deletion and start a new log over a live one.
        waiters.delete(id);
        resolve(undefined);
      }
    },
  };
}

/** Our own `log.json` download records, newest first. */
async function ourLogRecords(): Promise<chrome.downloads.DownloadItem[]> {
  const items = await chrome.downloads.search({
    filenameRegex: `[/\\\\]${DOWNLOAD_SUBDIR}[/\\\\]${LOG_FILE_NAME.replace('.', '\\.')}$`,
    orderBy: ['-startTime'],
  });
  return items.filter((item) => item.byExtensionId === chrome.runtime.id && !!item.filename);
}

/**
 * Byte size of the file a download record wrote.
 *
 * **This is the size at download time.** Chrome re-checks `exists` on
 * demand but never re-stats the file, so this says what *we* last
 * wrote — it cannot detect a user's edit to `log.json`. The reconcile
 * uses it to spot storage that has lost its contents, not tampering.
 *
 * `fileSize` is the authoritative field but reads `-1` (or 0) while
 * unknown, in which case the received-byte count is the best answer
 * available.
 */
export function logRecordSize(item: chrome.downloads.DownloadItem): number {
  return item.fileSize > 0 ? item.fileSize : item.bytesReceived;
}

/** Strip the basename from an absolute path, leaving its directory. */
export function parentDirectory(path: string): string {
  return path.replace(/[/\\][^/\\]+$/, '');
}

/**
 * Delete a download's file *and* forget the record, so a throwaway
 * write leaves no trace in the capture directory or the user's
 * download history. Best-effort: a failure here is cosmetic (a stray
 * file the rest of the extension ignores), never a reason to fail the
 * capture that triggered it.
 */
async function discardDownload(downloadId: number): Promise<void> {
  try {
    await chrome.downloads.removeFile(downloadId);
  } catch (err) {
    console.info('[SeeWhatISee] could not remove probe file:', err);
  }
  try {
    await chrome.downloads.erase({ id: downloadId });
  } catch (err) {
    console.info('[SeeWhatISee] could not erase probe record:', err);
  }
}

/**
 * **Directory probe.** Write a throwaway file to learn where our
 * captures land, then delete it. The last resort when nothing else
 * knows the directory — no cached answer, no usable download record.
 * Used by `getCaptureDirectory` and by the reconcile in
 * `log-reconcile.ts`, where knowing the directory upgrades us to
 * reading the real `log.json`.
 *
 * Deliberately *not* a zero-byte `log.json`: writing that when no file
 * existed would leave an empty log file behind, and an empty file we
 * wrote is exactly what the reconcile reads as "this log was cleared,
 * start over" — the probe would manufacture the state it is trying to
 * observe. A unique throwaway name can't collide with anything, so it
 * observes without disturbing.
 *
 * The name matches neither `log.json` nor the `history-*.json` glob,
 * so nothing else in the extension (or in `SeeWhatISee.py`) reads it
 * even in the window before it is deleted, or if the delete fails.
 *
 * Returns `null` if anything goes wrong; the caller falls back to the
 * record-only path.
 */
export async function probeCaptureDirectory(): Promise<string | null> {
  try {
    const id = await downloadArtifact(
      `probe-${Date.now()}.json`,
      'data:application/json;charset=utf-8,%7B%7D%0A',
    );
    const path = await waitForDownloadComplete(id);
    await discardDownload(id);
    return parentDirectory(path);
  } catch (err) {
    console.info('[SeeWhatISee] capture-directory probe failed:', err);
    return null;
  }
}

/** Outcome of `probeLogFile`. */
export interface LogFileProbe {
  /** True when a file already occupied `log.json`, so ours was renamed. */
  collided: boolean;
  /** The capture directory, learned from wherever the write landed. */
  directory: string;
  /** Download id of the write — only meaningful when it did not collide. */
  downloadId: number;
}

/**
 * **Existence probe.** Write `payload` with `conflictAction:
 * 'uniquify'` to discover whether `log.json` already exists, without
 * being able to read it.
 *
 * Used only when we have no `log.json` download record *and* can't
 * read files — with read access, a failed `fetch` is a better
 * existence test and costs no file churn.
 *
 * - **No collision:** nothing was there, so `payload` is exactly what
 *   should be in the file and the write is already done.
 * - **Collision:** Chrome renames ours to `log (1).json`. That file is
 *   deleted and the caller prompts the user, so `payload` never lands
 *   — which is why the caller can pass the fresh-start payload
 *   unconditionally.
 *
 * Collision is detected by comparing the resolved basename to
 * `log.json` rather than by parsing a ` (1)` suffix, whose format
 * isn't contractual.
 *
 * Never used for `history-*.json`: those names are unique by
 * timestamp, so they have nothing to discover.
 */
export async function probeLogFile(payload: string): Promise<LogFileProbe> {
  const id = await chrome.downloads.download({
    url: `data:application/json;charset=utf-8,${encodeURIComponent(payload)}`,
    filename: `${DOWNLOAD_SUBDIR}/${LOG_FILE_NAME}`,
    saveAs: false,
    conflictAction: 'uniquify',
  });
  const path = await waitForDownloadComplete(id);
  const directory = parentDirectory(path);
  const collided = path.slice(directory.length + 1) !== LOG_FILE_NAME;
  if (collided) await discardDownload(id);
  return { collided, directory, downloadId: id };
}
