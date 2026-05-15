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

/**
 * Subdirectory under the user's download root where every capture
 * file lands. Exported so the More-submenu "Open snapshots
 * directory" entry can build its filter regex against the same
 * string.
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
 */
export async function downloadHtml(capture: InMemoryCapture): Promise<number> {
  return downloadArtifact(capture.contentsFilename, htmlDataUrl(capture.html));
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
  const body = capture.selections[format];
  if (!body || body.trim().length === 0) {
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
