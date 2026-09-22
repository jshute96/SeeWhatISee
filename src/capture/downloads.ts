// Capture-side download helpers — every write that lands a file
// on disk goes through here. Writes use `conflictAction:
// 'overwrite'` because `compactTimestamp` keeps capture filenames
// unique across captures (see `log-store.ts`), and the Capture
// page flow deliberately overwrites its pinned filename as the
// user edits highlights / re-copies. The one exception is the first
// `log.json` write on a profile that doesn't know its directory yet
// (`downloadArtifactUniquely`, for `claimNewLog` in `log-reconcile.ts`).

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
 * hence the reconcile in `log-reconcile.ts` that reads what is on disk
 * before overwriting.
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
export async function downloadArtifact(
  filename: string,
  url: string,
  conflictAction: chrome.downloads.FilenameConflictAction = 'overwrite',
): Promise<number> {
  return chrome.downloads.download({
    url,
    filename: `${DOWNLOAD_SUBDIR}/${filename}`,
    saveAs: false,
    // We rely on `compactTimestamp` giving unique filenames across
    // captures, so `'overwrite'` is safe everywhere: log.json
    // deliberately overwrites every time, and the Capture page flow
    // may rewrite the same pinned filename as the user edits
    // highlights / re-copies. The one `'uniquify'` caller is
    // `claimNewLog` (`log-reconcile.ts`), which *wants* to be told when
    // the file is already there.
    conflictAction,
  });
}

/**
 * `downloadArtifact`, but resolving only once the bytes are on disk —
 * and throwing, with a message naming the file, if they never get
 * there, or land somewhere else.
 *
 * `chrome.downloads.download` resolves the moment the download
 * *starts*, so a write Chrome then fails (the target is a directory,
 * the disk is full, a permission problem) would otherwise go
 * unnoticed: the capture would report success and log a record
 * pointing at a file that doesn't exist. Every capture-file write
 * goes through here so that can't happen. Chrome's own download
 * bubble shows the failure too, but it doesn't say which extension
 * write it was.
 *
 * **Landing elsewhere counts as failing.** When Chrome can't create
 * the path we asked for (the `SeeWhatISee/` folder isn't writable),
 * it doesn't error: it ignores `saveAs: false`, shows its Save As
 * dialog, and the file lands wherever that defaults to — the
 * Downloads root. There is no option to turn that off. A record
 * naming a file that isn't in the capture directory is a broken
 * record (History can't find it, copy-last gives a wrong path), so
 * the write is reported as failed, naming where the file went. The
 * stray file is left alone: the user chose to save it there.
 *
 * The message carries Chrome's `DownloadItem.error` code
 * (`FILE_FAILED`, `FILE_NO_SPACE`, …) rather than a translation:
 * they're rare, the code is what to search for, and the `?error=`
 * page shows it as-is.
 */
export async function downloadArtifactComplete(filename: string, url: string): Promise<number> {
  const { id, path } = await downloadArtifactLanded(filename, url, 'overwrite');
  // Right folder, different name. Not expected — `'overwrite'` never
  // uniquifies and the names are machine-made — but a record naming
  // a file that isn't there would be just as broken.
  if (basename(path) !== filename) {
    throw new ArtifactWriteError(
      joinCapturePath(parentDirectory(path), filename),
      `Chrome saved it as ${path} instead.`,
    );
  }
  return id;
}

/**
 * Write `filename` **without** overwriting: Chrome picks a sibling
 * name (`log (1).json`) when the file is already there. Resolves once
 * the bytes are on disk with the path Chrome chose — the caller
 * compares its basename to `filename` to learn whether the write
 * created the file or was deflected by an existing one. Throws
 * (`ArtifactWriteError`) if the write fails or lands outside a
 * `SeeWhatISee/` directory, as `downloadArtifactComplete` does.
 *
 * Only `claimNewLog` (`log-reconcile.ts`) uses this: writing the first
 * `log.json` this way is how a profile with no download history
 * learns its capture directory without a throwaway probe file.
 */
export async function downloadArtifactUniquely(
  filename: string,
  url: string,
): Promise<{ id: number; path: string }> {
  return downloadArtifactLanded(filename, url, 'uniquify');
}

async function downloadArtifactLanded(
  filename: string,
  url: string,
  conflictAction: chrome.downloads.FilenameConflictAction,
): Promise<{ id: number; path: string }> {
  const id = await downloadArtifact(filename, url, conflictAction);
  let path: string;
  try {
    path = await waitForDownloadComplete(id);
  } catch (err) {
    throw new ArtifactWriteError(await describeCaptureFile(filename), downloadFailureReason(err));
  }
  if (!isCaptureDirectory(parentDirectory(path))) {
    throw new ArtifactWriteError(
      await describeCaptureFile(filename),
      `Chrome saved it to ${path} instead. (Is the ${DOWNLOAD_SUBDIR} folder writable?)`,
    );
  }
  return { id, path };
}

/**
 * How to name a capture file in a message: its full path when the
 * capture directory is known, else where it would be under Chrome's
 * default download folder — so the user knows where to look either
 * way. Never throws.
 */
export async function describeCaptureFile(filename: string): Promise<string> {
  const dir = await peekCaptureDirectory().catch(() => null);
  return dir ? joinCapturePath(dir, filename) : `Downloads/${DOWNLOAD_SUBDIR}/${filename}`;
}

/**
 * A capture-file write Chrome couldn't finish. `path` is the file as
 * `describeCaptureFile` names it and `reason` a sentence (or
 * sentences) saying why; they're kept separately from the message so
 * a caller that reports the failure under its own heading
 * (`recordCapture`, for `log.json`) can reuse them without re-parsing
 * the text.
 */
export class ArtifactWriteError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`Couldn't write ${path}: ${reason}`);
    this.name = 'ArtifactWriteError';
  }
}

/**
 * The part of a `waitForDownloadComplete` failure worth showing a
 * user, as a sentence: Chrome's error code from an interrupted
 * download, or the timeout. Its messages are written for the
 * developer console.
 */
function downloadFailureReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const interrupted = /interrupted: (.+)$/.exec(raw);
  if (interrupted) return `download failed (${interrupted[1]}).`;
  if (/did not complete within/.test(raw)) return 'the download did not finish.';
  return /[.!?)]$/.test(raw) ? raw : `${raw}.`;
}

/** Build a `data:` URL for an HTML body, percent-encoded. Exported
 *  so the SW-side HTML-only save paths (`savePageContents`) can
 *  produce the same URL shape as `downloadHtml`. */
export function htmlDataUrl(body: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(body)}`;
}

/** Build a `data:` URL for a JSON (or NDJSON) text body, percent-encoded. */
export function jsonDataUrl(text: string): string {
  return `data:application/json;charset=utf-8,${encodeURIComponent(text)}`;
}

/**
 * Write the screenshot file. `screenshotOverride` is an optional
 * replacement data URL with the user's red highlights baked into
 * the PNG bytes; when omitted we write the original screenshot.
 *
 * This and the two writers below resolve once the file is on disk
 * and throw if Chrome couldn't write it — see
 * `downloadArtifactComplete`.
 */
export async function downloadScreenshot(
  capture: InMemoryCapture,
  screenshotOverride?: string,
): Promise<number> {
  return downloadArtifactComplete(
    capture.screenshotFilename,
    screenshotOverride ?? capture.screenshotDataUrl,
  );
}

/**
 * Write the HTML file. The body is stable for the session unless
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
  return downloadArtifactComplete(capture.contentsFilename, htmlDataUrl(html));
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
 * Write the selection file in a specific format. Throws when the
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
  return downloadArtifactComplete(capture.selectionFilenames[format], url);
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
      // directory refreshes the cached capture directory. This covers
      // the writes awaited here — capture files, log writes,
      // history-file flushes — which is what keeps the cache tracking
      // a download root the user has since moved, and what teaches a
      // fresh profile its directory from its first `log.json` write.
      const dir = parentDirectory(item.filename);
      if (isCaptureDirectory(dir)) rememberCaptureDirectory(dir);
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
 * The capture directory, if it is known: the `chrome.storage.local`
 * cache first, then download history (whose answer is cached for next
 * time). `null` when neither knows — a profile that has never written
 * a capture file, or one whose download history and extension storage
 * have both been cleared.
 *
 * Nothing here writes to learn the answer. The one path that needs
 * the directory *and* is about to write anyway — recording a capture
 * — learns it from that write (`claimNewLog`, `log-reconcile.ts`);
 * everything else (the History page, reopen, the watch-status reads,
 * the copy-last menu items) just reports there is nothing yet.
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
 * Whether `dir` is a directory our writes land in: one named
 * `SeeWhatISee`, with a separator before the name so a (never
 * expected) relative path can't match a bare `SeeWhatISee`. The same
 * structural rule as `searchCaptureDirectory`'s regex. A Save-as
 * write into an unrelated folder doesn't match, so it can neither
 * poison the directory cache nor pass for a completed capture write.
 */
function isCaptureDirectory(dir: string): boolean {
  return new RegExp(`[/\\\\]${DOWNLOAD_SUBDIR}$`).test(dir);
}

/**
 * Whether `file://` reads are available. The toggle lives in
 * `chrome://extensions`, is off by default, and flipping it reloads
 * the extension — so this is a fresh answer every service-worker life.
 * The extension requires it (`file-access.ts`); this is what every
 * entry point's check reads.
 *
 * Guarded rather than called bare: `chrome.extension` is a legacy
 * namespace, and a missing method should read as "off" — the dialog
 * that explains the toggle — instead of failing whatever asked.
 */
export async function canReadFiles(): Promise<boolean> {
  try {
    if (typeof chrome.extension?.isAllowedFileSchemeAccess !== 'function') return false;
    return await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    return false;
  }
}

/**
 * Read `log.json` from `directory`, or `null` if we can't.
 *
 * A missing file resolves non-ok rather than rejecting, which would
 * otherwise read as a successful load of an empty log and quietly
 * discard the user's history. `null` folds together denied (toggle
 * off), missing, and failed — the reconcile lists the directory
 * (`listCaptureDirectory`) before concluding the file is gone; the
 * History page shows an empty log either way.
 */
export async function readLogText(directory: string): Promise<string | null> {
  return readCaptureFileText(directory, LOG_FILE_NAME);
}

/**
 * Read one file out of the capture directory over `file://`, or `null`
 * if we can't — missing, denied (toggle off), or a failed read all fold
 * together, and callers that need to tell them apart disambiguate
 * themselves.
 *
 * `no-store` because one caller polls the same path every 250ms while
 * waiting for a watcher to exit; a cached hit there would read as "the
 * file is still present" and report a stop that worked as failed.
 */
export async function readCaptureFileText(
  directory: string,
  name: string,
): Promise<string | null> {
  try {
    const res = await fetch(pathToFileUrl(joinCapturePath(directory, name)),
                            { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * The names of the entries in the capture directory, read over
 * `file://`. The filesystem's own answer to "is this file there?" —
 * what the reconcile asks after a failed `log.json` read, and what the
 * History page's `(deleted)` markers come from.
 *
 * Fetching a directory URL returns the HTML listing Chrome generates
 * for `file://` directories: one `<script>addRow("name", …)</script>`
 * per entry, the name as a JSON string literal. The markup is a
 * browser internal, but that call shape has held for well over a
 * decade, and reading the name out of it is the only way to get an
 * exact one — a token scan over the page can't tell `log.json` from
 * a `log (1).json` row's href or a `….json.crdownload`.
 *
 * - `res.ok` is deliberately NOT checked: Chrome hands the generated
 *   listing back with `status: 0`, so `ok` is false even on success.
 * - **Rejects** when the directory can't be read — it doesn't exist,
 *   or the toggle is off. Callers decide what that means: for the
 *   reconcile a missing directory is a deleted log; for the History
 *   page it's "nothing to offer".
 * - `cache: 'no-store'`, for the same reason as `readCaptureFileText`:
 *   this is re-read after every capture and must see the new file.
 *
 * Why the filesystem and not `chrome.downloads`: the download records
 * know only the files we wrote, only while the user keeps their
 * download history, only up to `DownloadQuery`'s 1000-record default —
 * and their `exists` flag is **never refreshed** by a `search()`,
 * despite the API docs implying otherwise (probed in the e2e harness:
 * a file deleted on disk read as present indefinitely). The listing is
 * the directory as it is. Its one limit is that it looks only where
 * the caller points it.
 */
export async function listCaptureDirectory(directory: string): Promise<Set<string>> {
  const res = await fetch(pathToFileUrl(directory), { cache: 'no-store' });
  const html = await res.text();
  const names = new Set<string>();
  for (const m of html.matchAll(LISTING_ROW)) {
    try {
      names.add(JSON.parse(m[1]) as string);
    } catch {
      // Not a string literal after all — skip the row rather than the
      // whole listing.
    }
  }
  return names;
}

/**
 * One row of Chrome's directory listing: `addRow(` followed by the
 * entry's name as a JSON string literal (captured with its quotes, so
 * `JSON.parse` undoes the escaping Chrome applied).
 */
const LISTING_ROW = /addRow\(("(?:[^"\\]|\\.)*")/g;

/**
 * Absolute paths of the `history-*.json` history files, newest first,
 * found by listing the capture directory. Used by the History page and
 * by the flush's collision guard in `log-store.ts`.
 *
 * - Only stamp-shaped names count (`HISTORY_FILE_NAME`): a word-y
 *   `history-notes.json` is someone else's file — and the
 *   chronological-by-name sort only holds for fixed-width digit stamps
 *   anyway. `SeeWhatISee.py`'s `history_files()` applies the same rule
 *   to the same directory; keep the two in step. Matching every such
 *   file, not just ones we wrote, is what keeps the page and the
 *   scripts agreeing on what the history is.
 * - The names embed `compactTimestamp` (see `log-store.ts`), so a
 *   lexicographic sort *is* chronological; descending = newest first,
 *   true write order. That holds because a history file is stamped
 *   with the moment it was written, not with a record inside it —
 *   record timestamps are pinned at capture time and are not in
 *   append order. (The stamps are local time, so a DST fall-back
 *   hour can sort out of order — accepted, it matches the filenames
 *   the user sees.)
 * - Rejects when the directory can't be listed (see
 *   `listCaptureDirectory`), which callers treat as "nothing to offer".
 */
export async function listHistoryFiles(directory: string): Promise<string[]> {
  return historyFilesAmong(directory, await listCaptureDirectory(directory));
}

/**
 * `listHistoryFiles` for a listing already in hand — the History page
 * lists the directory once for both the history files and its
 * `(deleted)` markers, and this keeps the two views from being read
 * at different moments.
 */
export function historyFilesAmong(directory: string, names: Iterable<string>): string[] {
  return [...names]
    .filter((n) => HISTORY_FILE_NAME.test(n))
    .sort()
    .reverse()
    .map((name) => joinCapturePath(directory, name));
}

/** A history file's name: the prefix, a digits-and-hyphens stamp, `.json`. */
const HISTORY_FILE_NAME = new RegExp(`^${HISTORY_FILE_PREFIX}[\\d-]*\\.json$`);

/**
 * Whether `name` is one of the log files — `log.json` or a history
 * file — as opposed to a capture file. What a record's `filename` must
 * never be taken for: a hand-edited record naming `log.json` as its
 * screenshot would otherwise have the log read as an image, or deleted
 * as a capture file.
 */
export function isLogFileName(name: string): boolean {
  return name === LOG_FILE_NAME || HISTORY_FILE_NAME.test(name);
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

/** Our own download records for the capture file `name`, newest first. */
async function ourRecordsOf(name: string): Promise<chrome.downloads.DownloadItem[]> {
  const items = await chrome.downloads.search({
    filenameRegex: `[/\\\\]${DOWNLOAD_SUBDIR}[/\\\\]${escapeRegExp(name)}$`,
    orderBy: ['-startTime'],
  });
  return items.filter((item) => item.byExtensionId === chrome.runtime.id && !!item.filename);
}

/** `s` with every regex metacharacter escaped, for use in `filenameRegex`. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Drop the download records for the log file `name` — `log.json` by
 * default, or a `history-*.json` a deletion rewrote — older than
 * `keepId`.
 *
 * `keepId` is a `DownloadItem.id` — Chrome's own persistent handle for
 * one download, as returned by `chrome.downloads.download`, unique
 * within the profile and stable across service-worker and browser
 * restarts. **Not a position in any list**, so the search below finds
 * it rather than indexing to it, and "older" is decided by the list's
 * `-startTime` order, never by comparing ids.
 *
 * Every capture rewrites the same `log.json` (and every deletion from
 * a history file rewrites that file), so without this the user's
 * download history fills up with one row per write, all pointing at
 * the same file. Only the newest is of any use to the
 * user; nothing in the extension reads these records — the file
 * itself is read, and the capture directory comes from
 * `peekCaptureDirectory`, which matches any of our download records.
 *
 * Records only: the file itself stays where it is. Best-effort, and
 * never a reason to fail the capture that triggered it.
 *
 * Call this only once the `keepId` write has landed. Erasing the older
 * records while the new one is still in flight (or after it failed)
 * would leave the download list describing a file that isn't there.
 *
 * **Strictly older records only.** Every `log.json` write today goes
 * through `serializeWrite` in the service worker, so a newer record
 * shouldn't exist while this runs — but should one ever appear, it
 * describes the file next, so this leaves it alone. A `keepId` no
 * longer in the list says nothing about which of the rest are older,
 * so that prunes nothing.
 */
export async function pruneOldLogRecords(keepId: number, name = LOG_FILE_NAME): Promise<void> {
  try {
    // Newest first, so everything past the kept record is older.
    const ours = await ourRecordsOf(name);
    const keepAt = ours.findIndex((item) => item.id === keepId);
    if (keepAt < 0) return;
    // In parallel: the first prune on an old profile can face every
    // row that profile ever accumulated, and the capture doesn't
    // return until they're gone. `eraseDownloadRecord` swallows its
    // own failures, so one stuck row can't take the rest with it.
    await Promise.all(ours.slice(keepAt + 1).map((item) => eraseDownloadRecord(item.id)));
  } catch (err) {
    console.info('[SeeWhatISee] could not prune old log.json records:', err);
  }
}

/** Strip the basename from an absolute path, leaving its directory. */
export function parentDirectory(path: string): string {
  return path.replace(/[/\\][^/\\]+$/, '');
}

/** The last segment of an absolute path: the bare filename. */
export function basename(path: string): string {
  return path.slice(path.search(/[^/\\]*$/));
}

/**
 * Delete a download's file *and* forget the record, so a write that
 * turned out to be unwanted leaves no trace in the capture directory
 * or the user's download history. Best-effort: a failure here is
 * cosmetic (a stray file the rest of the extension ignores), never a
 * reason to fail the capture that triggered it.
 */
export async function discardDownload(downloadId: number): Promise<void> {
  try {
    await chrome.downloads.removeFile(downloadId);
  } catch (err) {
    console.info('[SeeWhatISee] could not remove unwanted file:', err);
  }
  await eraseDownloadRecord(downloadId);
}

/**
 * Forget a download record, leaving the file alone.
 *
 * For writes the user has no reason to see afterwards: it takes the
 * row out of Chrome's download list (and so out of the download
 * bubble's contents), while the file stays on disk for whoever the
 * write was for. Best-effort — a record we couldn't erase is cosmetic.
 */
export async function eraseDownloadRecord(downloadId: number): Promise<void> {
  try {
    await chrome.downloads.erase({ id: downloadId });
  } catch (err) {
    console.info('[SeeWhatISee] could not erase download record:', err);
  }
}

