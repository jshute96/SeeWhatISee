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
 * derive it by searching `chrome.downloads.search` for our `log.json`
 * record (every capture overwrites it, so the most recent match points
 * at the live directory — even on a fresh SW load where in-memory
 * state is empty).
 *
 * - Pinning the search to `log.json` rather than any file under a
 *   `SeeWhatISee/` folder avoids false matches in same-named
 *   directories the user happens to use (e.g. `/tmp/SeeWhatISee/`).
 * - `byExtensionId` is checked client-side (the `DownloadQuery` type
 *   doesn't accept it as a filter — it's a result-only field) as a
 *   second guard against an unrelated `log.json` in such a folder.
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
    filenameRegex: `[/\\\\]${DOWNLOAD_SUBDIR}[/\\\\]log\\.json$`,
    orderBy: ['-startTime'],
  });
  const ours = candidates.find((it) => it.byExtensionId === chrome.runtime.id);
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
