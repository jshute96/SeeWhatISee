// Capture functions. Each one corresponds to a user-visible action
// (toolbar click, right-click context menu entries, future variations)
// and is responsible for grabbing the content and writing it (plus
// its metadata) to the standard download directory.
//
// Each capture writes two files into the download directory:
//   - screenshot-<timestamp>.png or contents-<timestamp>.html
//                                  — the content itself (unique per capture)
//   - log.json                     — newline-delimited JSON (one record per
//                                    line), regenerated each time from
//                                    chrome.storage.local
//
// We can't truly append to log.json from a Chrome extension (the downloads
// API only writes whole files; the SW has no filesystem access), so the
// authoritative log lives in chrome.storage.local and log.json is a
// snapshot of it written on every capture. If a user manually deletes
// log.json, the next capture will recreate it from storage.

export const DOWNLOAD_SUBDIR = 'SeeWhatISee';

/**
 * Sleep for `delayMs` milliseconds, showing a countdown on the toolbar
 * badge (e.g. "5", "4", "3", "2", "1") that ticks every second.
 * The badge is cleared when the countdown finishes.
 */
async function countdownSleep(delayMs: number): Promise<void> {
  const end = Date.now() + delayMs;
  await chrome.action.setBadgeBackgroundColor({ color: '#FF8C00' });

  const updateBadge = async (remaining: number) => {
    if (remaining > 0) {
      await chrome.action.setBadgeText({ text: String(remaining) });
    }
  };
  await updateBadge(Math.ceil(delayMs / 1000));

  // Poll at 250ms so the displayed number updates within a quarter-
  // second of each real second boundary.
  await new Promise<void>((resolve, reject) => {
    const id = setInterval(() => {
      const remaining = Math.ceil((end - Date.now()) / 1000);
      if (remaining <= 0) {
        clearInterval(id);
        chrome.action.setBadgeText({ text: '' }).then(resolve, reject);
      } else {
        updateBadge(remaining).catch((err) => {
          clearInterval(id);
          chrome.action.setBadgeText({ text: '' }).finally(() => reject(err));
        });
      }
    }, 250);
  });
}

export const LOG_STORAGE_KEY = 'captureLog';
// Cap the in-storage log so we don't grow unbounded and so rewriting
// log.json on every capture stays cheap (otherwise it's quadratic in the
// number of captures: each write copies the whole log). Oldest entries
// are evicted FIFO when the cap is exceeded.
const LOG_MAX_ENTRIES = 100;

/**
 * A saved file the capture flow wants to surface in `log.json`.
 * Wraps the bare basename (no directory; the downloads root sits
 * elsewhere) with optional metadata flags. Omitted flags carry the
 * "default / not-set" meaning — e.g. `isEdited` absent ≡ unedited
 * — so downstream consumers can ignore fields they don't care
 * about and presence is itself the signal.
 *
 * Used uniformly for artifacts that may be produced either as a
 * raw scrape or as a user-edited body: currently `contents` and
 * `selection`. Future editable artifact kinds should adopt the
 * same shape so the record is symmetrical across kinds.
 */
export interface Artifact {
  /** Bare basename of the file on disk (no directory segment). */
  filename: string;
  /**
   * `true` iff the user replaced the body via the corresponding
   * Edit dialog before the save that produced this record. Omitted
   * when the artifact is the raw scrape.
   */
  isEdited?: true;
}

/**
 * Screenshot record in `log.json`. Same filename-plus-optional-flag
 * shape as `Artifact`, but the flag means "user drew highlights on
 * this PNG" rather than "user edited this body" — distinct types
 * keep the semantics honest and let new kind-specific flags land
 * without a loose `{ [k: string]: unknown }` fallback.
 */
export interface ScreenshotArtifact {
  /** Bare basename of the PNG on disk (no directory segment). */
  filename: string;
  /**
   * `true` iff the saved PNG bytes carry user-drawn red highlights
   * (boxes / lines) baked in. Omitted on unannotated screenshots,
   * so presence is itself the signal — downstream consumers treat
   * `hasHighlights: true` as "the user marked specific regions on
   * this image; focus your description on those."
   */
  hasHighlights?: true;
}

/**
 * Kinds of captured body that the details page's Edit dialogs can
 * replace. Imported by both the SW (`background.ts`) for its
 * `updateArtifact` dispatch table and the details page
 * (`capture-page.ts`) for the `EDIT_KINDS` catalog — both sides
 * share this single definition so a new kind added in one file
 * can't silently go unhandled on the other.
 */
export type EditableArtifactKind = 'html' | 'selection';

export interface CaptureRecord {
  /** ISO 8601 UTC timestamp, e.g. "2026-04-08T20:30:12.345Z". */
  timestamp: string;
  /**
   * Captured screenshot artifact. Set on the immediate / delayed
   * screenshot paths, and on the "Capture with details…" path when
   * the user keeps the screenshot. Carries the bare PNG filename
   * plus an optional `hasHighlights: true` flag (see
   * `ScreenshotArtifact`).
   *
   * The embedded compact timestamp in `filename` is in *local* time
   * (chosen so filenames sort the way the user expects when browsing
   * the directory) — note this differs from `timestamp` above, which
   * is UTC. The two refer to the same instant but will display
   * different dates near local midnight.
   */
  screenshot?: ScreenshotArtifact;
  /**
   * Captured HTML artifact. Set on HTML captures — the "Save html
   * contents" menu entry, and the "Capture with details…" path when
   * the user keeps the HTML. Carries the bare filename (no
   * directory) plus an optional `isEdited: true` flag that appears
   * iff the user saved an edit via the Edit HTML dialog before
   * capture; the flag is omitted on an unedited scrape.
   */
  contents?: Artifact;
  /**
   * Captured selection artifact. Set by either `captureSelection()`
   * (the More → Capture selection shortcut) or the details flow
   * when the user kept the Save selection checkbox checked. Same
   * shape as `contents` — the optional `isEdited` flag tracks
   * whether the user edited via the Edit selection dialog before
   * capture.
   */
  selection?: Artifact;
  /**
   * User-entered prompt text from the "Capture with details…" flow,
   * trimmed. Omitted entirely when empty so the field's presence
   * implies there is something to act on.
   */
  prompt?: string;
  /** URL of the captured tab, or empty string if unavailable. */
  url: string;
}

export interface CaptureResult extends CaptureRecord {
  /**
   * Bare filename of the content file (PNG or HTML) written by this
   * specific capture. Denormalized copy of whichever of `screenshot`
   * / `contents` the underlying save path set — callers that don't
   * need to care which kind of capture ran can read this directly.
   * The detailed-capture path (which may write both files) doesn't
   * return a CaptureResult, so there's never ambiguity here.
   */
  filename: string;
  /** Download id of the content file (PNG or HTML). */
  downloadId: number;
  /**
   * Download id of the JSON sidecar (log.json) written alongside the
   * content file. Production callers (toolbar / context menu) ignore
   * this; it's primarily there so e2e tests can resolve the sidecar
   * to its on-disk path via chrome.downloads.search.
   */
  sidecarDownloadIds: {
    log: number;
  };
}

/**
 * Capture the currently visible region of the active tab in the
 * last-focused window.
 *
 * `delayMs` (default 0) sleeps for the given number of milliseconds
 * before capturing, so the user can activate hover states, open menus,
 * etc. during the wait. The await keeps the MV3 service worker alive
 * for the duration of the timer.
 *
 * We always resolve the active tab *after* the delay (rather than
 * caching the tab passed in by the action / contextMenus listeners)
 * so that:
 *   - the recorded `url` and the captured pixels always describe the
 *     same page, even if the user switched tabs / windows / popups
 *     during the delay;
 *   - delayed captures naturally follow focus to whatever window the
 *     user is now looking at.
 *
 * If the last-focused window isn't a regular browser window with an
 * active tab — e.g. DevTools is on top — the query returns `[]` and
 * we throw. Capturing a different window just so the call succeeds
 * would be confusing; the right fix from the user side is to focus
 * the real window first (or use a `delayMs` and switch focus during
 * the wait). The throw is downgraded to a `console.warn` by the
 * action / context-menu wrappers (and the targeted
 * `unhandledrejection` handler in background.ts catches the SW
 * devtools console invocation path) so it doesn't pollute the
 * chrome://extensions Errors page.
 *
 * Trade-off: the `activeTab` permission grant from a toolbar gesture
 * applies to the tab that was active at gesture time. If the user
 * switches to a different `chrome://` page during a delayed capture,
 * the new tab isn't covered by `activeTab` (and `<all_urls>` doesn't
 * cover `chrome://`), so the capture will fail. For normal http(s)
 * pages this isn't an issue.
 */
export async function captureVisible(delayMs = 0): Promise<CaptureResult> {
  if (delayMs > 0) {
    await countdownSleep(delayMs);
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active) throw new Error('No active tab found to capture');

  const dataUrl = await chrome.tabs.captureVisibleTab(active.windowId, { format: 'png' });
  return saveCapture(dataUrl, active.url ?? '');
}

/**
 * Save the full HTML of the active tab in the last-focused window.
 *
 * Uses `chrome.scripting.executeScript` to grab
 * `document.documentElement.outerHTML` from the page. The result is
 * saved as an HTML file alongside screenshots in the same download
 * directory, and recorded in log.json exactly like a
 * screenshot capture — the only difference is the filename extension.
 *
 * `delayMs` (default 0) behaves the same as `captureVisible`'s delay:
 * the SW awaits a timer, and the active-tab lookup happens *after*
 * the wait so the scrape follows focus changes / navigations during
 * the delay.
 *
 * Requires the `scripting` permission in the manifest.
 */
export async function savePageContents(delayMs = 0): Promise<CaptureResult> {
  if (delayMs > 0) {
    await countdownSleep(delayMs);
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active) throw new Error('No active tab found to capture');

  const results = await chrome.scripting.executeScript({
    target: { tabId: active.id! },
    func: () => document.documentElement.outerHTML,
  });
  const html = results[0]?.result as string;
  if (!html) throw new Error('Failed to retrieve page contents');

  const now = new Date();
  const filename = `contents-${compactTimestamp(now)}.html`;
  const record: CaptureRecord = {
    timestamp: now.toISOString(),
    contents: { filename },
    url: active.url ?? '',
  };

  // Save the HTML first. The metadata files are downstream and
  // shouldn't be written if the content itself failed to save.
  const downloadId = await downloadArtifact(filename, htmlDataUrl(html));

  const sidecarDownloadIds = await serializeWrite(async () => {
    const log = await appendToLog(record);
    const logId = await writeJsonFile('log.json', log.map((r) => serializeRecord(r)).join('\n') + '\n');
    return { log: logId };
  });

  return { downloadId, sidecarDownloadIds, filename, ...record };
}

/**
 * Scrape the HTML of the current selection on the given tab. Returns
 * `null` when nothing is selected (no ranges, or only collapsed
 * ranges whose cloned fragment is empty).
 *
 * Walks every range (Firefox supports multi-range; Chromium normally
 * returns a single range but the API surface is the same) and
 * concatenates their cloned contents into one throwaway `<div>` so
 * `innerHTML` gives us the combined markup.
 *
 * We guard on the *fragment* being empty rather than
 * `sel.toString().length` so image-only selections (`<img>` with no
 * accompanying text) still count as real captures — `toString`
 * returns just the text content and would otherwise drop them.
 */
async function scrapeSelection(tabId: number): Promise<string | null> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const container = document.createElement('div');
      for (let i = 0; i < sel.rangeCount; i++) {
        container.appendChild(sel.getRangeAt(i).cloneContents());
      }
      const html = container.innerHTML;
      return html.length === 0 ? null : html;
    },
  });
  return (results[0]?.result as string | null | undefined) ?? null;
}

/**
 * Capture the HTML of the user's current text selection on the
 * active tab, save it as `selection-<timestamp>.html` alongside
 * other captures, and record its filename in `log.json` under
 * `selection`.
 *
 * Throws `No text selected` when there is no selected text on the
 * page. Surfaces through the normal icon/tooltip error channel so
 * the user sees *why* the capture was rejected.
 */
export async function captureSelection(delayMs = 0): Promise<CaptureRecord> {
  if (delayMs > 0) {
    await countdownSleep(delayMs);
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active) throw new Error('No active tab found to capture');

  const html = await scrapeSelection(active.id!);
  if (!html) throw new Error('No text selected');

  const now = new Date();
  const filename = `selection-${compactTimestamp(now)}.html`;
  const record: CaptureRecord = {
    timestamp: now.toISOString(),
    selection: { filename },
    url: active.url ?? '',
  };

  // Reuse the details-flow helper so the trailing-newline logic
  // lives in one place. We build a minimal InMemoryCapture to pass
  // through — only `selection` and `selectionFilename` are read.
  const asCapture: InMemoryCapture = {
    screenshotDataUrl: '',
    html: '',
    url: record.url,
    timestamp: record.timestamp,
    screenshotFilename: '',
    contentsFilename: '',
    selection: html,
    selectionFilename: filename,
  };
  // Save the selection file first. The sidecar is downstream and
  // shouldn't be written if the content itself failed to save.
  await downloadSelection(asCapture);

  await serializeWrite(async () => {
    const log = await appendToLog(record);
    await writeJsonFile('log.json', log.map((r) => serializeRecord(r)).join('\n') + '\n');
  });

  return record;
}

export interface InMemoryCapture {
  screenshotDataUrl: string;
  html: string;
  url: string;
  /**
   * ISO 8601 UTC timestamp of the moment the capture was taken
   * (right after `chrome.tabs.captureVisibleTab` returned). Pinning
   * this here — rather than re-stamping at save time — means the
   * record's `timestamp` and the filename's embedded local time both
   * describe the *capture moment*, not whenever the user got around
   * to clicking Save in the details flow.
   */
  timestamp: string;
  /**
   * Filename the screenshot will be written under if the user saves
   * it. Computed from `timestamp` so the capture-with-details page
   * can show / copy the exact name before the file lands on disk.
   */
  screenshotFilename: string;
  /**
   * Filename the HTML snapshot will be written under if the user
   * saves it. Same reason as `screenshotFilename`.
   */
  contentsFilename: string;
  /**
   * HTML of the page selection at capture time, when the user had
   * anything selected. Undefined when no selection existed — the
   * details page uses that to grey out / uncheck the "Save
   * selection" checkbox and disable its Copy button.
   */
  selection?: string;
  /**
   * Filename the selection file will be written under if the user
   * saves it. Only meaningful when `selection` is also set; the two
   * fields are populated together. Shares the same compact
   * timestamp suffix as `screenshotFilename` / `contentsFilename`.
   */
  selectionFilename?: string;
}

/**
 * Capture the visible tab's screenshot *and* full HTML without
 * writing anything to disk. Used by the "Capture with details…"
 * flow: the extension page previews the screenshot while the user
 * decides which artifacts to keep. The page can also pre-download
 * individual artifacts via the SW's `ensure…Downloaded` helpers
 * (Copy-filename buttons); `recordDetailedCapture` then writes the
 * sidecar referencing whichever artifacts were materialized.
 *
 * The active-tab query happens once and both the screenshot and the
 * HTML scrape target that tab, so the two artifacts are guaranteed
 * to describe the same page. If the user switches tabs during the
 * details flow, the tab identifier we capture here is stable.
 *
 * `delayMs` (default 0) sleeps before the active-tab lookup so the
 * user can activate hover states / open menus before the capture
 * freezes. Same semantics as `captureVisible`'s delay — focus
 * follows wherever the user ends up by the time the timer fires.
 */
export async function captureBothToMemory(delayMs = 0): Promise<InMemoryCapture> {
  if (delayMs > 0) {
    await countdownSleep(delayMs);
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active) throw new Error('No active tab found to capture');

  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(active.windowId, {
    format: 'png',
  });

  // Grab the HTML and the selection in a single scripting round-trip.
  // Two separate `executeScript` calls would double the IPC cost and
  // widen the window during which the tab could be torn down between
  // the two reads. Running both in one `func` also means the two
  // snapshots observe the same DOM state. Selection logic mirrors
  // `scrapeSelection` (executeScript `func`s must be self-contained —
  // they're stringified into the page context and can't call SW-side
  // helpers).
  const results = await chrome.scripting.executeScript({
    target: { tabId: active.id! },
    func: () => {
      const html = document.documentElement.outerHTML;
      const sel = window.getSelection();
      let selection: string | null = null;
      if (sel && sel.rangeCount > 0) {
        const container = document.createElement('div');
        for (let i = 0; i < sel.rangeCount; i++) {
          container.appendChild(sel.getRangeAt(i).cloneContents());
        }
        const inner = container.innerHTML;
        if (inner.length > 0) selection = inner;
      }
      return { html, selection };
    },
  });
  const scraped = results[0]?.result as { html: string; selection: string | null } | undefined;
  if (!scraped || !scraped.html) throw new Error('Failed to retrieve page contents');
  const { html, selection } = scraped;

  // Pin the capture moment + filenames here so the details page can
  // show / copy the exact filename the file will land at, even if
  // the user waits minutes before clicking Save.
  const now = new Date();
  const ts = compactTimestamp(now);
  const capture: InMemoryCapture = {
    screenshotDataUrl,
    html,
    url: active.url ?? '',
    timestamp: now.toISOString(),
    screenshotFilename: `screenshot-${ts}.png`,
    contentsFilename: `contents-${ts}.html`,
  };
  if (selection !== null) {
    capture.selection = selection;
    capture.selectionFilename = `selection-${ts}.html`;
  }
  return capture;
}

export interface SaveDetailedOptions {
  capture: InMemoryCapture;
  /** Save the screenshot PNG as part of this capture. */
  includeScreenshot: boolean;
  /** Save the captured HTML as part of this capture. */
  includeHtml: boolean;
  /**
   * Save the captured page selection as `selection-<timestamp>.html`.
   * Ignored when `capture.selection` is unset (no selection existed
   * at capture time).
   */
  includeSelection: boolean;
  /**
   * Optional user-entered prompt. Trimmed by the caller; an empty
   * string is treated the same as omitting the field. Stored on the
   * sidecar record under `prompt` when non-empty.
   */
  prompt?: string;
  /**
   * True when `capture.screenshotDataUrl` already has user-drawn red
   * highlights baked into the PNG bytes. Causes the saved record's
   * `screenshot` artifact object to carry `hasHighlights: true`.
   * Ignored unless `includeScreenshot` is also true — there's no
   * point flagging highlights on a record that didn't save the
   * image they're on.
   */
  hasHighlights?: boolean;
  /**
   * True when the user replaced the captured HTML via the Edit HTML
   * dialog before saving. Causes the record's `contents` artifact
   * object to carry `isEdited: true`. Ignored unless `includeHtml`
   * is also true — the flag only makes sense on a record that
   * actually saved the HTML file.
   */
  htmlEdited?: boolean;
  /**
   * True when the user replaced the captured selection via the Edit
   * selection dialog before saving. Causes the record's `selection`
   * artifact object to carry `isEdited: true`. Ignored unless
   * `includeSelection` is also true.
   */
  selectionEdited?: boolean;
}

/**
 * Start a download into the SeeWhatISee capture directory and
 * return the `chrome.downloads` id. Single funnel for every
 * artifact a capture writes (PNG, HTML, selection, log.json) —
 * shared behavior (subdir prefix, no Save-As prompt, `'overwrite'`
 * on conflict) lives here.
 *
 * Resolves as soon as Chrome has *started* the download — callers
 * that need the file on disk pair this with
 * `waitForDownloadComplete`.
 */
async function downloadArtifact(filename: string, url: string): Promise<number> {
  return chrome.downloads.download({
    url,
    filename: `${DOWNLOAD_SUBDIR}/${filename}`,
    saveAs: false,
    // We rely on `compactTimestamp` giving unique filenames across
    // captures (see `compactTimestamp` below), so `'overwrite'` is
    // safe everywhere: log.json deliberately overwrites every time,
    // and the details flow may rewrite the same pinned filename as
    // the user edits highlights / re-copies.
    conflictAction: 'overwrite',
  });
}

/** Build a `data:` URL for an HTML body, percent-encoded. */
function htmlDataUrl(body: string): string {
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
 * Start a selection-HTML download. Throws when the capture doesn't
 * carry a selection — callers must ensure `capture.selection` and
 * `capture.selectionFilename` are populated first.
 *
 * Appends a trailing newline when the selection doesn't already end
 * in one. The selection is a DOM fragment — often a single run of
 * text with no line break — and shells / editors read terminator-
 * stripped files more comfortably.
 */
export async function downloadSelection(capture: InMemoryCapture): Promise<number> {
  if (!capture.selection || !capture.selectionFilename) {
    throw new Error('No selection captured');
  }
  const body = capture.selection.endsWith('\n') ? capture.selection : `${capture.selection}\n`;
  return downloadArtifact(capture.selectionFilename, htmlDataUrl(body));
}

/**
 * Poll `chrome.downloads.search` until the given download reaches
 * `state === 'complete'`, then return its absolute on-disk path.
 * Used by background.ts when the Copy buttons need a paste-ready
 * path and can't return until the file is actually written.
 *
 * Polls at 50 ms; default timeout is 5 s, plenty for the data-URL
 * downloads the details flow uses (PNGs and HTML, both essentially
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
 * Append a log entry for a "Capture with details…" result.
 * Assumes the screenshot / HTML files (when included) have already
 * been downloaded by the caller via `downloadScreenshot` /
 * `downloadHtml` — this only writes the sidecar, no file IO for
 * the artifacts themselves.
 *
 * Saves with neither file are allowed: the record still carries
 * `timestamp`, `url`, and any `prompt`, so a downstream agent can
 * act on just the URL (and prompt) without ever reading a file.
 */
/**
 * Build an `Artifact` object for inclusion in a `CaptureRecord`.
 * Keeps the `isEdited` flag conditional at a single site — the two
 * call paths (contents and selection) would otherwise duplicate
 * the same "set iff truthy" conditional.
 *
 * Wire-format constraint: the shell consumers of `log.json` in
 * `plugin/scripts/_common.sh` and `.gemini/scripts/_common.sh`
 * anchor their sed/grep rewrites on `"filename"` appearing *first*
 * inside the artifact object. `JSON.stringify` preserves insertion
 * order, so the object literal here must keep `filename` before
 * `isEdited`. If another caller ever builds an `Artifact` via a
 * spread / `Object.assign`, preserve the same ordering (or update
 * those consumers to stop relying on it).
 */
function artifact(filename: string, edited?: boolean): Artifact {
  return edited ? { filename, isEdited: true } : { filename };
}

/**
 * Build a `ScreenshotArtifact` object for inclusion in a
 * `CaptureRecord`. Same wire-format constraint as `artifact()`:
 * `filename` must appear before `hasHighlights` so the shell
 * consumers in `plugin/scripts/_common.sh` and
 * `.gemini/scripts/_common.sh` can anchor their rewrites on
 * `"filename"` being the first key inside the object.
 */
function screenshotArtifact(filename: string, hasHighlights?: boolean): ScreenshotArtifact {
  return hasHighlights ? { filename, hasHighlights: true } : { filename };
}

export async function recordDetailedCapture(opts: SaveDetailedOptions): Promise<CaptureRecord> {
  // Timestamp + filenames were pinned at capture time (see
  // captureBothToMemory) so they describe when the screenshot was
  // *taken*, not when the user clicked Save — and so the filenames
  // shown / copied on the details page exactly match what hits disk.
  const record: CaptureRecord = {
    timestamp: opts.capture.timestamp,
    url: opts.capture.url,
  };
  if (opts.includeScreenshot) {
    record.screenshot = screenshotArtifact(opts.capture.screenshotFilename, opts.hasHighlights);
  }
  if (opts.includeHtml) {
    record.contents = artifact(opts.capture.contentsFilename, opts.htmlEdited);
  }
  if (opts.includeSelection && opts.capture.selectionFilename) {
    record.selection = artifact(opts.capture.selectionFilename, opts.selectionEdited);
  }
  if (opts.prompt && opts.prompt.length > 0) {
    record.prompt = opts.prompt;
  }

  await serializeWrite(async () => {
    const log = await appendToLog(record);
    await writeJsonFile('log.json', log.map((r) => serializeRecord(r)).join('\n') + '\n');
  });

  return record;
}

async function saveCapture(dataUrl: string, url: string): Promise<CaptureResult> {
  // Compute one Date and derive both the filename's compact timestamp and
  // the record's ISO timestamp from it, so the two can never drift.
  const now = new Date();
  // `filename` in the record is the bare basename so it resolves against
  // whichever directory the sidecar is read from. The downloads API needs
  // the full subdir-qualified path, which we build separately.
  const filename = `screenshot-${compactTimestamp(now)}.png`;
  const record: CaptureRecord = {
    timestamp: now.toISOString(),
    screenshot: { filename },
    url,
  };

  // Save the screenshot first. The metadata files are downstream and
  // shouldn't be written if the image itself failed to save.
  //
  // Note: chrome.downloads.download resolves as soon as the download
  // *starts*, not when the file is fully on disk. For our tiny PNG /
  // JSON payloads via data: URLs that's effectively immediate, but
  // strictly speaking we never observe the completion event. If we ever
  // see partial files or interleaving in log.json, the fix is to wait
  // on chrome.downloads.onChanged for state === 'complete' before
  // returning. Overkill for v1.
  const downloadId = await downloadArtifact(filename, dataUrl);

  // Update the running log in storage and rewrite the JSON sidecar files.
  // Serialized via writeChain so two rapid captures can't race on the
  // storage read-modify-write.
  const sidecarDownloadIds = await serializeWrite(async () => {
    const log = await appendToLog(record);
    const logId = await writeJsonFile('log.json', log.map((r) => serializeRecord(r)).join('\n') + '\n');
    return { log: logId };
  });

  return { downloadId, sidecarDownloadIds, filename, ...record };
}

/**
 * Erase the in-storage capture log *and* overwrite the on-disk
 * `log.json` with an empty file so downstream consumers (the
 * see-what-i-see skills, `watch.sh`, etc.) immediately see an
 * empty log instead of the stale previous snapshot. Reachable from
 * the More → Clear log history menu entry and exposed on
 * `self.SeeWhatISee` for the devtools console.
 *
 * Goes through `serializeWrite` so it can't race with a capture
 * that's in the middle of its read-modify-write of the same
 * storage key or its own rewrite of `log.json`.
 *
 * Returns the `chrome.downloads` id of the empty `log.json` write so
 * tests can resolve it to an on-disk path and assert the file is
 * actually zero bytes. Production callers ignore the return.
 */
export async function clearCaptureLog(): Promise<number> {
  return await serializeWrite(async () => {
    await chrome.storage.local.remove(LOG_STORAGE_KEY);
    return await writeJsonFile('log.json', '');
  });
}

async function appendToLog(record: CaptureRecord): Promise<CaptureRecord[]> {
  const data = await chrome.storage.local.get(LOG_STORAGE_KEY);
  const log: CaptureRecord[] = data[LOG_STORAGE_KEY] ?? [];
  log.push(record);
  // Drop oldest entries past the cap. `splice` handles the case where the
  // log was already over-cap (e.g. cap was lowered) by trimming all excess
  // in one shot.
  if (log.length > LOG_MAX_ENTRIES) {
    log.splice(0, log.length - LOG_MAX_ENTRIES);
  }
  await chrome.storage.local.set({ [LOG_STORAGE_KEY]: log });
  return log;
}

/**
 * Write a JSON sidecar to the download dir, overwriting any existing file.
 * `text` is the pre-formatted JSON to write (callers use serializeRecord
 * to guarantee canonical key order). Returns the chrome.downloads
 * download id, which tests use to resolve the on-disk path.
 */
async function writeJsonFile(name: string, text: string): Promise<number> {
  return downloadArtifact(
    name,
    `data:application/json;charset=utf-8,${encodeURIComponent(text)}`,
  );
}

/**
 * Stringify a CaptureRecord with a stable, explicit key order.
 *
 * `chrome.storage.local` does not guarantee that object key insertion
 * order survives the serialize/deserialize roundtrip, so an entry that
 * comes back out of storage may have its keys in a different order than
 * when we wrote it. To keep log.json grep-friendly and diff-stable, we
 * never just `JSON.stringify(record)`; we rebuild a fresh object with
 * keys in the canonical order at the call site.
 *
 * `indent` maps directly to JSON.stringify's third argument: 0 for
 * compact NDJSON-style output, 2 for human-readable.
 */
function serializeRecord(r: CaptureRecord, indent = 0): string {
  // Build the output object field by field so optional entries are
  // *absent* (not `undefined`) when unset — JSON.stringify drops
  // undefined values, but writing them explicitly is noisier. Fixed
  // key order keeps log.json diff-stable.
  const ordered: Record<string, unknown> = { timestamp: r.timestamp };
  // `screenshot` / `contents` / `selection` are all artifact objects
  // (`{ filename, <flag>? }`) — emitted as-is so `JSON.stringify`
  // handles the nested shape and the optional per-kind flag
  // (`hasHighlights` / `isEdited`) naturally.
  if (r.screenshot !== undefined) ordered.screenshot = r.screenshot;
  if (r.contents !== undefined) ordered.contents = r.contents;
  if (r.selection !== undefined) ordered.selection = r.selection;
  if (r.prompt !== undefined) ordered.prompt = r.prompt;
  ordered.url = r.url;
  return JSON.stringify(ordered, null, indent);
}

// Simple in-memory mutex: every storage-touching write goes through this
// promise chain so a second captureVisible() call started before the first
// finishes its read-modify-write can't lose entries. The chain is reset if
// the service worker is torn down, but that only happens when there is no
// in-flight work to lose.
let writeChain: Promise<unknown> = Promise.resolve();
function serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
  // `then(fn, fn)` runs `fn` whether the previous chain link fulfilled
  // or rejected — i.e. a prior failure doesn't permanently poison
  // subsequent writes. `fn` ignores its argument so it doesn't care
  // which side it was called from. The .catch() below additionally
  // absorbs any rejection from `next` itself before assigning back to
  // writeChain, so the chain stored on the module is always a fulfilled
  // promise that future writes can safely .then() off of. The original
  // rejection still propagates to *this* caller via `return next`.
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => undefined);
  return next;
}

/**
 * Format a Date as `YYYYMMDD-HHMMSS-mmm` in the local timezone.
 *
 * Used as the unique suffix in capture filenames
 * (`screenshot-*.png`, `contents-*.html`, `selection-*.html`) so
 * they sort lexicographically by capture time and stay short /
 * shell-safe.
 *
 * **Uniqueness assumption.** The rest of the extension assumes
 * different captures produce different `compactTimestamp` values
 * and treats that as the filename-uniqueness guarantee — so writes
 * can use `conflictAction: 'overwrite'` uniformly without worrying
 * about clobbering an unrelated capture. Two captures inside the
 * same millisecond would break this. It hasn't come up (user-
 * driven clicks can't happen that fast, and the details flow
 * pins a single timestamp per session), so we don't guard against
 * it.
 *
 * Example: a capture taken at 2026-04-08 20:30:12.345 local time
 * produces `20260408-203012-345`.
 */
function compactTimestamp(d: Date): string {
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const pad3 = (n: number) => String(n).padStart(3, '0');
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}` +
    `-${pad3(d.getMilliseconds())}`
  );
}
