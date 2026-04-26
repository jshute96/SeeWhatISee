import { selectionMarkdownBody } from './markdown.js';
import { scrapePageStateInPage, type PageScrapeResult } from './scrape-page-state.js';

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
 * Which serialization format a saved selection file uses. A single
 * capture only ever writes one format (we can't tell which the user
 * wants without asking, and the More menu / details page make that
 * choice explicit), so the record carries exactly one of these.
 *
 *   - `'html'`     — raw `innerHTML` of the range, wrapped in `<div>`.
 *   - `'text'`     — `window.getSelection().toString()` — what the
 *                    user sees visually, with line breaks preserved.
 *   - `'markdown'` — HTML fed through `htmlToMarkdown` so nested
 *                    structure (headings, lists, links, tables)
 *                    survives in a reader-friendly form.
 */
export type SelectionFormat = 'html' | 'text' | 'markdown';

/**
 * Record-side selection artifact. Extends `Artifact` with a
 * `format` field so downstream consumers can tell at a glance which
 * bytes the file carries without inferring from the extension.
 */
export interface SelectionArtifact extends Artifact {
  format: SelectionFormat;
}

/**
 * File-extension suffix used for each selection format on disk.
 * Centralized so the filename computation and any downstream
 * validation (e.g. shell scripts) stay in one place.
 */
export const SELECTION_EXTENSIONS: Record<SelectionFormat, string> = {
  html: 'html',
  text: 'txt',
  markdown: 'md',
};

/**
 * Canonical error message for a per-format empty selection body.
 * Every site that throws (`captureSelection`, `downloadSelection`,
 * `ensureSelectionDownloaded`) and the SW's `SUPPRESSED_UNHANDLED`
 * list both go through this helper so wording stays in lock-step —
 * rewording the message at one site without updating the suppress
 * list would otherwise silently leak the failure into the
 * chrome://extensions Errors console.
 */
export function noSelectionContentMessage(format: SelectionFormat): string {
  return `No selection ${format} content`;
}

/**
 * Screenshot record in `log.json`. Same filename-plus-optional-flags
 * shape as `Artifact`, but the flags describe different "things the
 * user did to this PNG" rather than a single "edited" bit —
 * distinct types let new kind-specific flags land without a loose
 * `{ [k: string]: unknown }` fallback.
 *
 * The three edit flags are independent (any combination can appear)
 * and only the ones that apply are emitted — presence is the signal.
 */
export interface ScreenshotArtifact {
  /** Bare basename of the PNG on disk (no directory segment). */
  filename: string;
  /**
   * `true` iff the saved PNG bytes carry un-converted red highlights
   * (boxes / lines) baked in. Rectangles that the user converted to
   * redactions or crops do *not* count — those get their own flags
   * below. Downstream consumers treat `hasHighlights: true` as "the
   * user marked specific regions on this image; focus your
   * description on those."
   */
  hasHighlights?: true;
  /**
   * `true` iff the saved PNG bytes carry at least one opaque black
   * redaction rectangle baked in. Downstream consumers should treat
   * these regions as deliberately hidden by the user.
   */
  hasRedactions?: true;
  /**
   * `true` iff the saved PNG was cropped to a user-selected region
   * (the saved bytes cover only that region, not the full capture).
   */
  isCropped?: true;
}

/**
 * Kinds of captured body that the details page's Edit dialogs can
 * replace. Imported by both the SW (`background.ts`) for its
 * `updateArtifact` dispatch table and the details page
 * (`capture-page.ts`) for the `EDIT_KINDS` catalog — both sides
 * share this single definition so a new kind added in one file
 * can't silently go unhandled on the other.
 *
 * The three `selection*` kinds are independent editable mirrors:
 * the user can edit each selection format separately on the details
 * page, but only the format chosen for save ends up in `log.json`.
 */
export type EditableArtifactKind =
  | 'html'
  | 'selectionHtml'
  | 'selectionText'
  | 'selectionMarkdown';

export interface CaptureRecord {
  /** ISO 8601 UTC timestamp, e.g. "2026-04-08T20:30:12.345Z". */
  timestamp: string;
  /**
   * Captured screenshot artifact. Set on the immediate / delayed
   * screenshot paths, and on the "Capture with details…" path when
   * the user keeps the screenshot. Carries the bare PNG filename
   * plus optional `hasHighlights` / `hasRedactions` / `isCropped`
   * flags (see `ScreenshotArtifact`).
   *
   * The embedded compact timestamp in `filename` is in *local* time
   * (chosen so filenames sort the way the user expects when browsing
   * the directory) — note this differs from `timestamp` above, which
   * is UTC. The two refer to the same instant but will display
   * different dates near local midnight.
   */
  screenshot?: ScreenshotArtifact;
  /**
   * Captured HTML artifact. Set on HTML captures — the "Save HTML
   * contents" menu entry, and the "Capture with details…" path when
   * the user keeps the HTML. Carries the bare filename (no
   * directory) plus an optional `isEdited: true` flag that appears
   * iff the user saved an edit via the Edit HTML dialog before
   * capture; the flag is omitted on an unedited scrape.
   */
  contents?: Artifact;
  /**
   * Captured selection artifact. Set by either `captureSelection()`
   * (the More → Capture selection shortcuts — one per format) or
   * the details flow when the user picked a selection format to
   * save. Carries the bare filename, the chosen `format` (so
   * downstream consumers can dispatch without parsing the
   * extension), and an optional `isEdited: true` flag set when the
   * user edited that format's body via the Edit selection dialog
   * before capture. A single capture only ever writes one selection
   * file — selecting "Save as markdown" excludes the text / HTML
   * versions from the log, even though all three were scraped into
   * memory.
   */
  selection?: SelectionArtifact;
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
 * Shape returned from the page-side selection scrape. All three
 * formats are computed in one `executeScript` round-trip so the
 * More-menu selection-format shortcuts and the details flow share
 * the same scraped view of the page.
 *
 *   - `html`     — `innerHTML` of the selected range fragment, used
 *                  as the source of truth for the other two formats
 *                  and as the "Save selection as HTML" payload.
 *   - `text`     — `window.getSelection().toString()`, which matches
 *                  what the user visually sees selected (respects
 *                  line breaks in block elements).
 *   - `markdown` — produced by `selectionMarkdownBody(html, text,
 *                  pageUrl)` in the SW after the scrape returns
 *                  (keeps the converter a pure function,
 *                  unit-testable without a DOM). Either short-
 *                  circuits to the verbatim text (when the
 *                  selection is itself markdown source) or runs
 *                  `htmlToMarkdown(html, pageUrl)`. See
 *                  `looksLikeMarkdownSource` in `src/markdown.ts`
 *                  for the detection rule.
 */
export interface SelectionBodies {
  html: string;
  text: string;
  markdown: string;
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
  };

  // Reuse the details-flow helper so the trailing-newline logic
  // lives in one place. We build a minimal InMemoryCapture to pass
  // through — only `selections`, `selectionFilenames`, and the
  // chosen `format` are read.
  const asCapture: InMemoryCapture = {
    screenshotDataUrl: '',
    html: '',
    url: record.url,
    timestamp: record.timestamp,
    screenshotFilename: '',
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

export interface InMemoryCapture {
  screenshotDataUrl: string;
  /**
   * Full HTML of the captured tab. Empty string when scraping failed
   * — `htmlError` is then set with the reason. The details page uses
   * the error field (not the empty string) to decide whether to
   * grey out the Save HTML checkbox.
   */
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
   * The user's page selection at capture time, rendered in all
   * three storage formats (HTML fragment, plain text, and
   * markdown). Undefined when no selection existed — the details
   * page uses that to grey out / uncheck every "Save selection as
   * …" row and disable their Copy / Edit buttons. A given format's
   * entry may be an empty string even when `selections` is set
   * (e.g. an image-only selection has non-empty `html` but empty
   * `text`); each format row on the details page is gated
   * independently on its per-format emptiness.
   */
  selections?: SelectionBodies;
  /**
   * Filenames each selection format will be written under if the
   * user saves it. All three share the same compact timestamp
   * suffix as `screenshotFilename` / `contentsFilename` so files
   * written from the same capture sort together regardless of
   * which format ended up on disk. Populated together with
   * `selections`.
   */
  selectionFilenames?: Record<SelectionFormat, string>;
  /**
   * Reason HTML could not be captured (e.g. restricted URL where
   * `chrome.scripting.executeScript` can't inject). Set only when
   * scraping failed — the details page reads this to disable + flag
   * the Save HTML row with an error icon while still opening the
   * details flow so the user can add a URL-only / screenshot-only
   * record with any prompt or highlights they want.
   */
  htmlError?: string;
  /**
   * Reason the page selection could not be captured. In practice
   * this fires together with `htmlError` (selection is scraped in
   * the same `executeScript` call) but is kept as a separate field
   * so the UI can distinguish "no selection existed" from
   * "couldn't even check for a selection". Only "no selection
   * existed" leaves both `selection` and `selectionError` unset.
   */
  selectionError?: string;
  /**
   * Reason screenshot could not be captured (e.g. restricted URL
   * like the Web Store where extensions aren't allowed to capture).
   * Set only when captureVisibleTab failed — the details page reads
   * this to flag the screenshot row/preview with an error icon.
   */
  screenshotError?: string;
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

  let screenshotDataUrl = '';
  let screenshotError: string | undefined;
  try {
    screenshotDataUrl = await chrome.tabs.captureVisibleTab(active.windowId, {
      format: 'png',
    });
  } catch (err) {
    console.warn('[SeeWhatISee] captureVisibleTab failed:', err);
    screenshotError = err instanceof Error ? err.message : String(err);
  }

  // Grab the HTML and the selection in a single scripting round-trip
  // via the shared `scrapePageStateInPage` worker — see its doc
  // comment for the selection branch breakdown and the rationale for
  // bundling HTML and selection together.
  //
  // Scraping can fail on restricted URLs (chrome://, the Web Store,
  // etc.) where extensions aren't allowed to inject scripts. We catch
  // those failures and still return a valid `InMemoryCapture` with the
  // screenshot + URL so the details page can open — it just disables
  // the Save HTML / Save selection rows and surfaces the error via an
  // icon tooltip. The screenshot + prompt + highlights remain usable
  // so the user isn't locked out of the flow entirely.
  let html = '';
  let selectionRaw: { html: string; text: string } | null = null;
  let htmlError: string | undefined;
  let selectionError: string | undefined;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: active.id! },
      func: scrapePageStateInPage,
      args: [true],
    });
    const scraped = results[0]?.result as PageScrapeResult | undefined;
    if (!scraped || !scraped.html) {
      htmlError = 'Failed to retrieve page contents';
      selectionError = htmlError;
    } else {
      html = scraped.html;
      selectionRaw = scraped.selection;
      // See `scrapeSelection` for the gating rationale — only log
      // when there *was* a range but we couldn't recover from it.
      if (selectionRaw === null && (scraped.diag.rangeCount as number) > 0) {
        console.log('[SeeWhatISee] selection scrape empty:', scraped.diag);
      }
    }
  } catch (err) {
    htmlError = err instanceof Error ? err.message : String(err);
    selectionError = htmlError;
  }

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
  if (selectionRaw !== null) {
    // HTML stays byte-identical to the scrape (see `scrapeSelection`
    // for why); markdown goes through `selectionMarkdownBody` which
    // either passes through markdown-source text verbatim or runs
    // `htmlToMarkdown` with `pageUrl` so relative hrefs / srcs
    // resolve to absolute.
    capture.selections = {
      html: selectionRaw.html,
      text: selectionRaw.text,
      markdown: selectionMarkdownBody(selectionRaw.html, selectionRaw.text, active.url ?? ''),
    };
    capture.selectionFilenames = selectionFilenamesFor(ts);
  }
  if (htmlError !== undefined) capture.htmlError = htmlError;
  if (selectionError !== undefined) capture.selectionError = selectionError;
  if (screenshotError !== undefined) capture.screenshotError = screenshotError;
  return capture;
}

export interface SaveDetailedOptions {
  capture: InMemoryCapture;
  /** Save the screenshot PNG as part of this capture. */
  includeScreenshot: boolean;
  /** Save the captured HTML as part of this capture. */
  includeHtml: boolean;
  /**
   * Save one of the captured selection formats as
   * `selection-<timestamp>.{html,txt,md}`. `undefined` means "don't
   * save a selection." Only one format is ever written per capture;
   * the details page's three Save-selection-as-… rows are mutually
   * exclusive. Ignored when `capture.selections` is unset (no
   * selection existed at capture time) or the chosen format's body
   * is empty.
   */
  selectionFormat?: SelectionFormat;
  /**
   * Optional user-entered prompt. Trimmed by the caller; an empty
   * string is treated the same as omitting the field. Stored on the
   * sidecar record under `prompt` when non-empty.
   */
  prompt?: string;
  /**
   * True when `capture.screenshotDataUrl` has at least one
   * un-converted red rectangle / line baked into the PNG bytes.
   * Causes the saved record's `screenshot` artifact object to carry
   * `hasHighlights: true`. Ignored unless `includeScreenshot` is
   * also true — there's no point flagging highlights on a record
   * that didn't save the image they're on.
   */
  hasHighlights?: boolean;
  /**
   * True when the baked PNG contains at least one redaction
   * rectangle. Causes the saved record's `screenshot` artifact to
   * carry `hasRedactions: true`. Same `includeScreenshot` gating as
   * `hasHighlights`.
   */
  hasRedactions?: boolean;
  /**
   * True when the baked PNG was cropped to a user-selected region.
   * Causes the saved record's `screenshot` artifact to carry
   * `isCropped: true`. Same `includeScreenshot` gating as above.
   */
  isCropped?: boolean;
  /**
   * True when the user replaced the captured HTML via the Edit HTML
   * dialog before saving. Causes the record's `contents` artifact
   * object to carry `isEdited: true`. Ignored unless `includeHtml`
   * is also true — the flag only makes sense on a record that
   * actually saved the HTML file.
   */
  htmlEdited?: boolean;
  /**
   * True when the user replaced the captured selection body for the
   * format named in `selectionFormat` via the Edit selection dialog
   * before saving. Causes the record's `selection` artifact object
   * to carry `isEdited: true`. Ignored unless `selectionFormat` is
   * also set.
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
 * consumers in `plugin/scripts/_common.sh` and
 * `.gemini/scripts/_common.sh` can anchor their rewrites on
 * `"filename"` being the first key inside the object.
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
  // shown / copied on the details page exactly match what hits disk.
  const record: CaptureRecord = {
    timestamp: opts.capture.timestamp,
    url: opts.capture.url,
  };
  if (opts.includeScreenshot) {
    record.screenshot = screenshotArtifact(opts.capture.screenshotFilename, {
      hasHighlights: opts.hasHighlights,
      hasRedactions: opts.hasRedactions,
      isCropped: opts.isCropped,
    });
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
  // (`{ filename, <flags>? }`) — emitted as-is so `JSON.stringify`
  // handles the nested shape and the optional per-kind flags
  // (`hasHighlights` / `hasRedactions` / `isCropped` on screenshots,
  // `isEdited` on contents/selection) naturally.
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
