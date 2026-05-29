// Capture entry points and record orchestration — the SW-side hub
// every "save a thing" path funnels through. Each exported entry
// point corresponds to a user-visible action (toolbar click, right-
// click menu, hotkey) and produces a `CaptureRecord` written to
// `log.json` via the helpers in `./capture/`.
//
// Sibling modules under `src/capture/`:
//   - `recompress.ts` — PNG→JPEG recompress for oversized screenshots
//   - `downloads.ts`  — `chrome.downloads` plumbing (PNG/HTML/sel + log)
//   - `log-store.ts`  — `chrome.storage.local` log + `log.json` mirror
//   - `image-source.ts` — image right-click / bare-image-tab paths
//
// Each capture writes two files into the download directory:
//   - screenshot-<timestamp>.{png,jpg} or contents-<timestamp>.html
//                                  — the content itself (unique per capture).
//                                    Screenshots default to `.png`; the
//                                    capture-time PNG→JPEG recompress and the
//                                    sticky source format (right-click /
//                                    upload image flows) can promote it to
//                                    `.jpg`.
//   - log.json                     — newline-delimited JSON (one record per
//                                    line), regenerated each time from
//                                    chrome.storage.local
//
// We can't truly append to log.json from a Chrome extension (the downloads
// API only writes whole files; the SW has no filesystem access), so the
// authoritative log lives in chrome.storage.local and log.json is a
// snapshot of it written on every capture. If a user manually deletes
// log.json, the next capture will recreate it from storage.

import { selectionMarkdownBody } from './markdown.js';
import { scrapePageStateInPage, type PageScrapeResult } from './scrape-page-state.js';
import { maybeRecompressLargeScreenshot } from './capture/recompress.js';
import {
  downloadArtifact,
  downloadSelection,
  htmlDataUrl,
} from './capture/downloads.js';
import {
  appendToLog,
  compactTimestamp,
  serializeRecord,
  serializeWrite,
  writeJsonFile,
} from './capture/log-store.js';
import {
  captureImageTabToMemory,
  fetchImageBytes,
  probeActiveTabImage,
} from './capture/image-source.js';
import {
  noSelectionContentMessage,
  SELECTION_EXTENSIONS,
  type Artifact,
  type BuildInMemoryCaptureInput,
  type CaptureRecord,
  type CaptureResult,
  type InMemoryCapture,
  type SaveDetailedOptions,
  type ScreenshotArtifact,
  type SelectionArtifact,
  type SelectionBodies,
  type SelectionFormat,
} from './capture/types.js';

/**
 * Sleep for `delayMs` milliseconds, showing a countdown on the toolbar
 * badge (e.g. "3", "2", "1" for the standard 3s delay) that ticks
 * every second. The badge is cleared when the countdown finishes.
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
 * the wait). The throw is caught by the action / context-menu
 * wrappers (and the targeted `unhandledrejection` handler in
 * background.ts catches the SW devtools console invocation path),
 * so it surfaces on the friendly error page rather than as an
 * unhandled rejection.
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

  // When the tab is a bare image (file:// or http(s):// directly
  // pointing at a PNG / JPG / etc.), grab the source image bytes
  // instead of a re-encoded screenshot of Chrome's image viewer.
  // The on-disk extension follows the source MIME so a JPEG stays a
  // `.jpg`. See `probeActiveTabImage` for the detection rule.
  const imageTab = await probeActiveTabImage(active);
  if (imageTab && active.id !== undefined) {
    const { dataUrl, ext } = await fetchImageBytes(active.id, imageTab.url);
    return saveCapture(dataUrl, imageTab.url, imageTab.title, ext);
  }

  const pngDataUrl = await chrome.tabs.captureVisibleTab(active.windowId, { format: 'png' });
  const { dataUrl, ext } = await maybeRecompressLargeScreenshot(pngDataUrl);
  return saveCapture(dataUrl, active.url ?? '', active.title ?? '', ext);
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
    title: active.title ?? '',
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
 * Grab the current selection on the given tab in all three storage
 * formats (HTML fragment, plain text, markdown). Returns `null` when
 * nothing is selected (no ranges, or only collapsed ranges whose
 * cloned fragment is empty).
 *
 * The page side produces `html` + `text`; the SW side renders
 * `markdown` via `selectionMarkdownBody`. Running the converter in
 * the SW (rather than inlining it into the `func`) keeps the
 * page-context footprint small and lets the converter live in its
 * own unit-tested module.
 *
 * Empty `text` / `markdown` stay as empty strings — the UI greys out
 * those format options rather than failing the whole scrape. An
 * image-only selection, for example, has non-empty HTML but empty
 * text; picking "Save as text" would error out, but "Save as HTML"
 * or "Save as markdown" still works.
 *
 * Exported so background.ts can reuse it as a lightweight "does this
 * tab have a selection?" probe when dispatching the toolbar click —
 * the return value is coerced to a boolean and the formatted bodies
 * are discarded.
 */
export async function scrapeSelection(
  tabId: number,
  pageUrl: string,
): Promise<SelectionBodies | null> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: scrapePageStateInPage,
    args: [false],
  });
  const scraped = results[0]?.result as PageScrapeResult | undefined;
  if (!scraped || !scraped.selection) {
    // Only log when the user *had* a range but we couldn't recover
    // anything from it — the "no selection at all" case
    // (`rangeCount === 0`) is the common, benign result of every
    // toolbar click on a page with nothing selected and would
    // otherwise spam the SW console.
    if (scraped && (scraped.diag.rangeCount as number) > 0) {
      console.log('[SeeWhatISee] selection scrape empty:', scraped.diag);
    }
    return null;
  }
  return {
    // HTML stays byte-identical to what the page serialized — a
    // user opening the file in a browser (via a saved page, a
    // pipe into viewer, etc.) is the authoritative read and no
    // rewriting is safe to do universally. Markdown, by contrast,
    // has to stand alone: pass `pageUrl` so `selectionMarkdownBody`
    // can resolve relative `<a href>` / `<img src>` to absolute URLs
    // when it falls through to `htmlToMarkdown`.
    html: scraped.selection.html,
    text: scraped.selection.text,
    markdown: selectionMarkdownBody(scraped.selection.html, scraped.selection.text, pageUrl),
  };
}

/**
 * Build the per-format selection filenames for a capture pinned at
 * the given timestamp. All three share the same compact-timestamp
 * suffix so files written from the same capture sort together
 * regardless of which format the user ended up saving.
 */
function selectionFilenamesFor(ts: string): Record<SelectionFormat, string> {
  return {
    html: `selection-${ts}.${SELECTION_EXTENSIONS.html}`,
    text: `selection-${ts}.${SELECTION_EXTENSIONS.text}`,
    markdown: `selection-${ts}.${SELECTION_EXTENSIONS.markdown}`,
  };
}

/**
 * Capture the user's current text selection in a specific format
 * (HTML, text, or markdown), save it under the matching extension,
 * and record its filename in `log.json` under `selection` with the
 * format field set.
 *
 * Throws `No text selected` when there is no selected text on the
 * page, and `No selection text content` / `No selection markdown
 * content` when the requested format would produce an empty file
 * (e.g. asking for text on an image-only selection). Surfaces
 * through the normal icon/tooltip error channel so the user sees
 * *why* the capture was rejected and can retry with a different
 * format.
 */
export async function captureSelection(
  format: SelectionFormat = 'html',
  delayMs = 0,
): Promise<CaptureRecord> {
  if (delayMs > 0) {
    await countdownSleep(delayMs);
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active) throw new Error('No active tab found to capture');

  const bodies = await scrapeSelection(active.id!, active.url ?? '');
  if (!bodies) throw new Error('No text selected');
  const body = bodies[format];
  if (!body || body.trim().length === 0) {
    // Format-specific empty: e.g. text-only scrape on an image, or
    // markdown that collapsed to whitespace. Spell out which format
    // was missing so the toolbar error line is actionable.
    throw new Error(noSelectionContentMessage(format));
  }

  const now = new Date();
  const ts = compactTimestamp(now);
  const filenames = selectionFilenamesFor(ts);
  const filename = filenames[format];
  const record: CaptureRecord = {
    timestamp: now.toISOString(),
    selection: { filename, format },
    url: active.url ?? '',
    title: active.title ?? '',
  };

  // Reuse the Capture page flow helper so the trailing-newline logic
  // lives in one place. We build a minimal InMemoryCapture to pass
  // through — only `selections`, `selectionFilenames`, and the
  // chosen `format` are read.
  const asCapture: InMemoryCapture = {
    screenshotDataUrl: '',
    html: '',
    url: record.url,
    title: record.title,
    timestamp: record.timestamp,
    screenshotFilename: '',
    screenshotOriginalExt: 'png',
    contentsFilename: '',
    selections: bodies,
    selectionFilenames: filenames,
  };
  // Save the selection file first. The sidecar is downstream and
  // shouldn't be written if the content itself failed to save.
  await downloadSelection(asCapture, format);

  await serializeWrite(async () => {
    const log = await appendToLog(record);
    await writeJsonFile('log.json', log.map((r) => serializeRecord(r)).join('\n') + '\n');
  });

  return record;
}

/**
 * Capture the visible tab's screenshot *and* full HTML without
 * writing anything to disk. Used by the "Capture page"
 * flow: the extension page previews the screenshot while the user
 * decides which artifacts to keep. The page can also pre-download
 * individual artifacts via the SW's `ensure…Downloaded` helpers
 * (Copy-filename buttons); `recordDetailedCapture` then writes the
 * sidecar referencing whichever artifacts were materialized.
 *
 * The active-tab query happens once and both the screenshot and the
 * HTML scrape target that tab, so the two artifacts are guaranteed
 * to describe the same page. If the user switches tabs during the
 * Capture page flow, the tab identifier we capture here is stable.
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

  // Image-tab short-circuit: when the tab is showing a bare image
  // file directly, treat it like the upload-image flow. We use the
  // source bytes (no `captureVisibleTab` re-encode), skip the HTML
  // scrape, and ignore any selection — same shape the Capture page
  // already renders for uploads. See `probeActiveTabImage`.
  const imageTab = await probeActiveTabImage(active);
  if (imageTab) {
    return captureImageTabToMemory(active, imageTab.url, imageTab.title);
  }

  let screenshotDataUrl = '';
  let screenshotExt: 'png' | 'jpg' = 'png';
  let screenshotError: string | undefined;
  try {
    const pngDataUrl = await chrome.tabs.captureVisibleTab(active.windowId, {
      format: 'png',
    });
    const recompressed = await maybeRecompressLargeScreenshot(pngDataUrl);
    screenshotDataUrl = recompressed.dataUrl;
    screenshotExt = recompressed.ext;
  } catch (err) {
    // Handled: stash the message in `screenshotError` and carry on
    // with the scrape.
    console.info('[SeeWhatISee] captureVisibleTab failed:', err);
    screenshotError = err instanceof Error ? err.message : String(err);
  }

  const scrape = await scrapeTabState(active, { includeHtml: true });

  // Pin the capture moment + filenames here so the Capture page can
  // show / copy the exact filename the file will land at, even if
  // the user waits minutes before clicking Save.
  const now = new Date();
  const ts = compactTimestamp(now);
  const capture = buildInMemoryCapture({
    screenshotDataUrl,
    screenshotExt,
    html: scrape.html,
    selectionRaw: scrape.selectionRaw,
    pageUrl: active.url ?? '',
    pageTitle: active.title ?? '',
    timestamp: now,
    ts,
  });
  if (scrape.htmlError !== undefined) capture.htmlError = scrape.htmlError;
  if (scrape.selectionError !== undefined) capture.selectionError = scrape.selectionError;
  if (screenshotError !== undefined) capture.screenshotError = screenshotError;
  return capture;
}

/**
 * Run `scrapePageStateInPage` against the given tab and decode its
 * result into the shape `captureBothToMemory` (full HTML + selection)
 * and `captureImageToMemory` (selection only) both consume.
 *
 * `includeHtml` flips the `outerHTML` serialization in the page-side
 * worker — `false` skips it, which the image-context flow uses to
 * avoid a multi-megabyte round-trip on long pages.
 *
 * Restricted URLs (chrome://, Web Store, etc.) where `executeScript`
 * can't inject surface as `htmlError` / `selectionError` rather than
 * throwing, so callers can still hand back a partial
 * `InMemoryCapture` and let the Capture page disable the affected
 * rows. When `includeHtml: false` the helper never sets `htmlError`
 * (no failure to report — HTML wasn't asked for); a scrape failure
 * in that mode comes back as `selectionError` only.
 */
export async function scrapeTabState(
  tab: chrome.tabs.Tab,
  options: { includeHtml: boolean },
): Promise<{
  html: string;
  selectionRaw: { html: string; text: string } | null;
  htmlError?: string;
  selectionError?: string;
}> {
  let html = '';
  let selectionRaw: { html: string; text: string } | null = null;
  let htmlError: string | undefined;
  let selectionError: string | undefined;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      func: scrapePageStateInPage,
      args: [options.includeHtml],
    });
    const scraped = results[0]?.result as PageScrapeResult | undefined;
    if (!scraped) {
      // Whole scrape didn't come back — that's a failure either way.
      const reason = 'Failed to retrieve page contents';
      if (options.includeHtml) htmlError = reason;
      selectionError = reason;
    } else if (options.includeHtml && !scraped.html) {
      // Asked for HTML, scrape returned but the body is empty.
      htmlError = 'Failed to retrieve page contents';
      selectionError = htmlError;
    } else {
      html = options.includeHtml ? scraped.html : '';
      selectionRaw = scraped.selection;
      // See `scrapeSelection` for the gating rationale — only log
      // when there *was* a range but we couldn't recover from it.
      if (selectionRaw === null && (scraped.diag.rangeCount as number) > 0) {
        console.log('[SeeWhatISee] selection scrape empty:', scraped.diag);
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (options.includeHtml) htmlError = reason;
    selectionError = reason;
  }
  return { html, selectionRaw, htmlError, selectionError };
}

export function buildInMemoryCapture(input: BuildInMemoryCaptureInput): InMemoryCapture {
  const capture: InMemoryCapture = {
    screenshotDataUrl: input.screenshotDataUrl,
    html: input.html,
    url: input.pageUrl,
    title: input.pageTitle,
    timestamp: input.timestamp.toISOString(),
    screenshotFilename: `screenshot-${input.ts}.${input.screenshotExt}`,
    screenshotOriginalExt: input.screenshotExt,
    contentsFilename: `contents-${input.ts}.html`,
  };
  if (input.selectionRaw !== null) {
    capture.selections = {
      html: input.selectionRaw.html,
      text: input.selectionRaw.text,
      markdown: selectionMarkdownBody(
        input.selectionRaw.html,
        input.selectionRaw.text,
        input.pageUrl,
      ),
    };
    capture.selectionFilenames = selectionFilenamesFor(input.ts);
  }
  return capture;
}


/**
 * Build an `Artifact` object for inclusion in a `CaptureRecord`.
 * Keeps the `isEdited` flag conditional at a single site — the two
 * call paths (contents and selection) would otherwise duplicate
 * the same "set iff truthy" conditional.
 *
 * Wire-format constraint: the shell consumer of `log.json` in
 * `skills/SeeWhatISee.sh` (propagated verbatim into both install
 * trees by `skills/generate-skills.py`) anchors its sed rewrites on
 * `"filename"` appearing *first* inside the artifact object.
 * `JSON.stringify` preserves insertion order, so the object literal
 * here must keep `filename` before `isEdited`. If another caller
 * ever builds an `Artifact` via a spread / `Object.assign`, preserve
 * the same ordering (or update that consumer to stop relying on it).
 */
function artifact(filename: string, edited?: boolean): Artifact {
  return edited ? { filename, isEdited: true } : { filename };
}

/**
 * Selection-specific artifact builder. Same wire-format constraint
 * as `artifact()` — `filename` first — plus a trailing `format`
 * field so downstream consumers know how to interpret the bytes
 * without having to sniff the extension.
 */
function selectionArtifactOf(
  filename: string,
  format: SelectionFormat,
  edited?: boolean,
): SelectionArtifact {
  return edited
    ? { filename, format, isEdited: true }
    : { filename, format };
}

/**
 * Build a `ScreenshotArtifact` object for inclusion in a
 * `CaptureRecord`. Same wire-format constraint as `artifact()`:
 * `filename` must appear first (before any edit flags) so the shell
 * consumer in `skills/SeeWhatISee.sh` (propagated verbatim into both
 * install trees by `skills/generate-skills.py`) can anchor its
 * rewrites on `"filename"` being the first key inside the object.
 *
 * Flags are only emitted when true, so the object shape stays
 * minimal on un-edited captures.
 */
function screenshotArtifact(
  filename: string,
  flags?: { hasHighlights?: boolean; hasRedactions?: boolean; isCropped?: boolean },
): ScreenshotArtifact {
  const a: ScreenshotArtifact = { filename };
  if (flags?.hasHighlights) a.hasHighlights = true;
  if (flags?.hasRedactions) a.hasRedactions = true;
  if (flags?.isCropped) a.isCropped = true;
  return a;
}

export async function recordDetailedCapture(opts: SaveDetailedOptions): Promise<CaptureRecord> {
  // Timestamp + filenames were pinned at capture time (see
  // captureBothToMemory) so they describe when the screenshot was
  // *taken*, not when the user clicked Save — and so the filenames
  // shown / copied on the Capture page exactly match what hits disk.
  const record: CaptureRecord = {
    timestamp: opts.capture.timestamp,
    url: opts.capture.url,
    title: opts.capture.title,
  };
  if (opts.includeScreenshot) {
    record.screenshot = screenshotArtifact(opts.capture.screenshotFilename, {
      hasHighlights: opts.hasHighlights,
      hasRedactions: opts.hasRedactions,
      isCropped: opts.isCropped,
    });
  }
  // `imageUrl` rides on the InMemoryCapture for the image-context flow
  // and is forwarded to the record independently of `includeScreenshot`
  // — the user's intent is "remember which image I picked," and that
  // shouldn't get dropped just because they unchecked Save Screenshot
  // before clicking Capture.
  if (opts.capture.imageUrl) {
    record.imageUrl = opts.capture.imageUrl;
  }
  if (opts.includeHtml) {
    record.contents = artifact(opts.capture.contentsFilename, opts.htmlEdited);
  }
  if (opts.selectionFormat && opts.capture.selectionFilenames) {
    const fmt = opts.selectionFormat;
    record.selection = selectionArtifactOf(
      opts.capture.selectionFilenames[fmt],
      fmt,
      opts.selectionEdited,
    );
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

export async function saveCapture(
  dataUrl: string,
  url: string,
  title: string,
  ext = 'png',
  imageUrl?: string,
): Promise<CaptureResult> {
  // Compute one Date and derive both the filename's compact timestamp and
  // the record's ISO timestamp from it, so the two can never drift.
  const now = new Date();
  // `filename` in the record is the bare basename so it resolves against
  // whichever directory the sidecar is read from. The downloads API needs
  // the full subdir-qualified path, which we build separately. `ext`
  // defaults to `png` for the tab-screenshot path; the image-context
  // save path passes the MIME-derived extension of the source image and
  // an `imageUrl` carrying the original right-clicked URL.
  const filename = `screenshot-${compactTimestamp(now)}.${ext}`;
  const record: CaptureRecord = {
    timestamp: now.toISOString(),
    screenshot: { filename },
    url,
    title,
  };
  if (imageUrl) record.imageUrl = imageUrl;

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
