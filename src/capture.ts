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

const DOWNLOAD_SUBDIR = 'SeeWhatISee';

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

const LOG_STORAGE_KEY = 'captureLog';
// Cap the in-storage log so we don't grow unbounded and so rewriting
// log.json on every capture stays cheap (otherwise it's quadratic in the
// number of captures: each write copies the whole log). Oldest entries
// are evicted FIFO when the cap is exceeded.
const LOG_MAX_ENTRIES = 100;

export interface CaptureRecord {
  /** ISO 8601 UTC timestamp, e.g. "2026-04-08T20:30:12.345Z". */
  timestamp: string;
  /**
   * Bare filename of the captured PNG (no directory). Set on
   * screenshot captures — the immediate / delayed screenshot paths,
   * and the "Capture with details…" path when the user keeps the
   * screenshot.
   *
   * The embedded compact timestamp is in *local* time (chosen so
   * filenames sort the way the user expects when browsing the
   * directory) — note this differs from `timestamp` above, which is
   * UTC. The two refer to the same instant but will display different
   * dates near local midnight.
   */
  screenshot?: string;
  /**
   * Bare filename of the captured HTML file (no directory). Set on
   * HTML captures — the "Save html contents" menu entry, and the
   * "Capture with details…" path when the user keeps the HTML.
   */
  contents?: string;
  /**
   * User-entered prompt text from the "Capture with details…" flow,
   * trimmed. Omitted entirely when empty so the field's presence
   * implies there is something to act on.
   */
  prompt?: string;
  /**
   * Set to `true` only when the saved screenshot has user-drawn red
   * highlights (boxes / lines / dots) baked into it. Omitted when
   * absent so its presence is itself the signal: a downstream
   * consumer (the see-what-i-see skills) treats `highlights: true`
   * as "the user marked specific regions on this image — focus on
   * those, and any prompt is likely about them."
   *
   * Only meaningful on records that also have a `screenshot` field;
   * the capture page only sends the flag when an image was saved.
   */
  highlights?: true;
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
    contents: filename,
    url: active.url ?? '',
  };

  // Save the HTML first. The metadata files are downstream and
  // shouldn't be written if the content itself failed to save.
  const downloadId = await chrome.downloads.download({
    url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    filename: `${DOWNLOAD_SUBDIR}/${filename}`,
    saveAs: false,
  });

  const sidecarDownloadIds = await serializeWrite(async () => {
    const log = await appendToLog(record);
    const logId = await writeJsonFile('log.json', log.map((r) => serializeRecord(r)).join('\n') + '\n');
    return { log: logId };
  });

  return { downloadId, sidecarDownloadIds, filename, ...record };
}

export interface InMemoryCapture {
  screenshotDataUrl: string;
  html: string;
  url: string;
}

/**
 * Capture the visible tab's screenshot *and* full HTML without
 * writing anything to disk. Used by the "Capture with details…"
 * flow: the extension page previews the screenshot while the user
 * decides which artifacts to keep, then calls saveDetailedCapture
 * with the selected subset.
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

  const results = await chrome.scripting.executeScript({
    target: { tabId: active.id! },
    func: () => document.documentElement.outerHTML,
  });
  const html = results[0]?.result as string;
  if (!html) throw new Error('Failed to retrieve page contents');

  return { screenshotDataUrl, html, url: active.url ?? '' };
}

export interface SaveDetailedOptions {
  capture: InMemoryCapture;
  /** Save the screenshot PNG as part of this capture. */
  includeScreenshot: boolean;
  /** Save the captured HTML as part of this capture. */
  includeHtml: boolean;
  /**
   * Optional user-entered prompt. Trimmed by the caller; an empty
   * string is treated the same as omitting the field. Stored on the
   * sidecar record under `prompt` when non-empty.
   */
  prompt?: string;
  /**
   * True when `capture.screenshotDataUrl` already has user-drawn red
   * highlights baked into the PNG bytes. Causes the saved record to
   * carry `highlights: true`. Ignored unless `includeScreenshot` is
   * also true — there's no point flagging highlights on a record
   * that didn't save the image they're on.
   */
  hasHighlights?: boolean;
}

/**
 * Save a "Capture with details…" result: writes the screenshot
 * and/or HTML files requested by `opts`, plus a log.json record
 * that references whichever artifacts were saved and includes the
 * prompt (when non-empty). Reuses the
 * same `compactTimestamp` for both artifacts so they share a
 * basename suffix and the record timestamps match exactly.
 *
 * Callers must ensure at least one of `includeScreenshot` /
 * `includeHtml` is true; we throw if both are false rather than
 * writing an empty record.
 */
export async function saveDetailedCapture(opts: SaveDetailedOptions): Promise<CaptureRecord> {
  if (!opts.includeScreenshot && !opts.includeHtml) {
    throw new Error('saveDetailedCapture called with nothing to save');
  }

  const now = new Date();
  const ts = compactTimestamp(now);
  const record: CaptureRecord = {
    timestamp: now.toISOString(),
    url: opts.capture.url,
  };

  // Write the requested artifact files in parallel. Errors here
  // propagate out before we touch the sidecars, same as the legacy
  // paths: we never want a sidecar to reference a file that didn't
  // land on disk. Same download-start-vs-on-disk caveat as
  // saveCapture: chrome.downloads.download resolves on download
  // start, not completion; overkill to wait on onChanged for our
  // tiny data-URL payloads.
  const writes: Promise<unknown>[] = [];
  if (opts.includeScreenshot) {
    const filename = `screenshot-${ts}.png`;
    record.screenshot = filename;
    if (opts.hasHighlights) record.highlights = true;
    writes.push(
      chrome.downloads.download({
        url: opts.capture.screenshotDataUrl,
        filename: `${DOWNLOAD_SUBDIR}/${filename}`,
        saveAs: false,
      }),
    );
  }
  if (opts.includeHtml) {
    const filename = `contents-${ts}.html`;
    record.contents = filename;
    writes.push(
      chrome.downloads.download({
        url: `data:text/html;charset=utf-8,${encodeURIComponent(opts.capture.html)}`,
        filename: `${DOWNLOAD_SUBDIR}/${filename}`,
        saveAs: false,
      }),
    );
  }
  await Promise.all(writes);

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
    screenshot: filename,
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
  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename: `${DOWNLOAD_SUBDIR}/${filename}`,
    saveAs: false,
  });

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
 * Erase the in-storage capture log. The on-disk `log.json` is left
 * alone — it will be overwritten with the (now single-record) log
 * the next time a capture is saved. Exposed on `self.SeeWhatISee`
 * for the devtools console; the right-click menu entry that used
 * to drive this is currently hidden (see TODO.md).
 *
 * Goes through `serializeWrite` so it can't race with a capture
 * that's in the middle of its read-modify-write of the same
 * storage key.
 */
export async function clearCaptureLog(): Promise<void> {
  await serializeWrite(async () => {
    await chrome.storage.local.remove(LOG_STORAGE_KEY);
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
  return await chrome.downloads.download({
    url: `data:application/json;charset=utf-8,${encodeURIComponent(text)}`,
    filename: `${DOWNLOAD_SUBDIR}/${name}`,
    saveAs: false,
    // Required so log.json gets replaced rather than ending up
    // as `log (1).json`, `log (2).json`, ...
    conflictAction: 'overwrite',
  });
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
  if (r.screenshot !== undefined) ordered.screenshot = r.screenshot;
  if (r.highlights !== undefined) ordered.highlights = r.highlights;
  if (r.contents !== undefined) ordered.contents = r.contents;
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
 * Used as the unique suffix in capture filenames (both
 * `screenshot-*.png` and `contents-*.html`) so they sort
 * lexicographically by capture time and stay short / shell-safe. The
 * trailing `-mmm` is milliseconds; including them makes filenames
 * effectively unique without any extra dedup state.
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
