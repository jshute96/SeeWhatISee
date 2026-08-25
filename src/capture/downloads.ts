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
 * file lands. Also the string `getCaptureDirectory` below builds its
 * `log.json` filter regex from, so the write path and the
 * where-did-it-land lookup can't disagree.
 */
export const DOWNLOAD_SUBDIR = 'SeeWhatISee';

/**
 * Filename prefix for the capture-log archive files —
 * `history-<compactTimestamp>.json`, holding the older entries that
 * no longer fit in `log.json` (see `log-store.ts`).
 *
 * Lives here beside `DOWNLOAD_SUBDIR` because the writer
 * (`log-store.ts`) and the "find them again" search below have to
 * agree on it, and this module owns everything about where capture
 * files land.
 */
export const ARCHIVE_FILE_PREFIX = 'history-';

/**
 * Name of the capture-log sidecar. Every capture rewrites it, and it
 * is the one deliberately-reused filename in the capture directory —
 * hence the reconcile machinery in `log-reconcile.ts` that checks what
 * is on disk before overwriting.
 */
export const LOG_FILE_NAME = 'log.json';

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
    if (item?.state === 'complete' && item.filename) return item.filename;
    if (item?.state === 'interrupted') {
      throw new Error(`Download ${downloadId} interrupted: ${item.error ?? 'unknown'}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Download ${downloadId} did not complete within ${timeoutMs}ms`);
}

/**
 * Resolve the absolute on-disk directory where this extension writes
 * its captures (`<downloads>/SeeWhatISee/`). The user's downloads root
 * is OS- and config-dependent and not exposed by any Chrome API, so we
 * derive it by searching `chrome.downloads.search` for the most recent
 * file *we* wrote under a `SeeWhatISee/` directory — even on a fresh
 * SW load where in-memory state is empty.
 *
 * - `byExtensionId` (checked client-side, since `DownloadQuery`
 *   doesn't accept it as a filter — it's a result-only field) is what
 *   rules out an unrelated `SeeWhatISee/` folder the user happens to
 *   keep elsewhere (e.g. `/tmp/SeeWhatISee/`).
 * - Any artifact answers, not just `log.json`: a capture writes its
 *   screenshot / HTML *before* `recordCapture` runs, so matching them
 *   too means the directory is known by the time the log is written on
 *   the very first capture. That is what keeps the directory probe in
 *   `log-reconcile.ts` a rare fallback rather than a routine cost.
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
 *
 * Throws when no capture has happened yet so the caller can surface
 * a "capture once first" message on whatever surface it owns (the
 * icon/tooltip error channel for the More-submenu entries, an inline
 * banner on the History page).
 *
 * Lives here rather than next to its menu call sites because both the
 * service worker (`background/context-menu.ts`) and the History page
 * (`history.ts`) need it, and `downloads.ts` is the module that owns
 * everything about where capture files land.
 */
export async function getCaptureDirectory(): Promise<string> {
  const candidates = await chrome.downloads.search({
    filenameRegex: `[/\\\\]${DOWNLOAD_SUBDIR}[/\\\\][^/\\\\]+$`,
    orderBy: ['-startTime'],
  });
  const ours = candidates.find((it) => it.byExtensionId === chrome.runtime.id && it.filename);
  const fullPath = ours?.filename;
  if (!fullPath) {
    throw new Error(
      `No captures yet — capture something first to create the ${DOWNLOAD_SUBDIR} directory.`,
    );
  }
  // Strip the basename. `chrome.downloads.search().filename` is
  // documented to be the absolute path to a file (never ends in a
  // separator), so this always trims one segment.
  return fullPath.replace(/[/\\][^/\\]+$/, '');
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
 * Absolute paths of the `history-*.json` archive files we've written,
 * newest first — the on-disk tail of the capture log that no longer
 * fits in `chrome.storage.local` (see `log-store.ts`).
 *
 * Found through `chrome.downloads` rather than by listing the
 * directory, because an extension has no directory listing: the
 * download records are the only index of what we wrote. Consequences
 * worth knowing:
 *
 * - Clearing download history hides archives that are still on disk.
 *   They come back into view on their own only if re-downloaded, so
 *   the History page's "load older" offer simply shrinks — it never
 *   claims records are gone.
 * - `DownloadQuery.limit` defaults to 1000 records, and every capture
 *   file (not just archives) counts toward it. A history long enough
 *   to hit that loses its *oldest* archives from the listing first,
 *   which are the ones a reader is least likely to want.
 *
 * Records for files Chrome knows are deleted are skipped — fetching
 * them would just fail — as are duplicates from a re-written name,
 * keeping the newest record per path.
 */
export async function getArchiveFilePaths(): Promise<string[]> {
  const items = await chrome.downloads.search({
    filenameRegex: `[/\\\\]${DOWNLOAD_SUBDIR}[/\\\\]${ARCHIVE_FILE_PREFIX}[^/\\\\]*\\.json$`,
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
 * This record is our only memory of the sidecar that survives
 * `chrome.storage.local` being wiped, so the reconcile in
 * `log-reconcile.ts` leans on it for both "is the file still there"
 * (`exists`) and "how big was it when we wrote it" (`logRecordSize`).
 *
 * Records from a *different* extension id are skipped, same as
 * everywhere else here. That hides the sidecar written by a previous
 * unpacked load of this extension (whose id changes on every reload)
 * — those fall through to the existence probe instead, which is the
 * conservative answer.
 */
export async function getLogFileRecord(): Promise<chrome.downloads.DownloadItem | null> {
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
 * captures land, then delete it. Used when we can read files but have
 * no download record to derive the directory from — knowing the
 * directory upgrades us to reading the real `log.json`, which beats
 * inferring anything from a record we don't have.
 *
 * Deliberately *not* a zero-byte `log.json`: writing that when no file
 * existed would leave an empty sidecar behind, and an empty file we
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
