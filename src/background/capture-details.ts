import {
  captureBothToMemory,
  downloadHtml,
  downloadScreenshot,
  downloadSelection,
  noSelectionContentMessage,
  recordDetailedCapture,
  waitForDownloadComplete,
  type EditableArtifactKind,
  type InMemoryCapture,
  type SelectionFormat,
} from '../capture.js';
import { runWithErrorReporting } from './error-reporting.js';
import { getCaptureDetailsDefaults } from './capture-page-defaults.js';

// "Capture page" flow. We grab both the screenshot and
// the HTML up-front (so the user can decide which to save without
// worrying that the page will have changed in the meantime) and
// stash them under a per-tab key in chrome.storage.session.
// The capture.html extension page fetches its data by sending a
// runtime message; we match sender.tab.id to the stored key.
//
// Storage lives in `session` rather than a module-level Map because
// the MV3 service worker can be torn down between the menu click
// and the user clicking Capture on the page — session storage is
// in-memory but survives SW idle-out.
//
// We wrap the InMemoryCapture so we can also remember the opener
// tab id for re-focusing on close. Re-reading
// `chrome.tabs.get(detailsTabId).openerTabId` later isn't reliable —
// `Tab.openerTabId` is one of the fields Chrome strips when the
// extension lacks the `tabs` permission, and `<all_urls>` host
// permission doesn't cover our own `chrome-extension://` details
// tab. Stashing it at create time sidesteps the gap.
const DETAILS_STORAGE_PREFIX = 'captureDetails_';

export interface DetailsSession {
  capture: InMemoryCapture;
  // Tab id of the page the user captured from, so we can re-focus
  // it when the Capture page tab closes. Optional: the active-tab
  // lookup can in principle return no id (chrome:// pages, races).
  openerTabId?: number;
  // Per-artifact download tracking.
  //
  // The page's Copy-filename buttons materialize the file on demand
  // so the clipboard always carries a real on-disk path. Subsequent
  // clicks (and the eventual Capture click) reuse the cached path
  // unless something has invalidated it:
  //   - `screenshot.editVersion` is the page's monotonically
  //     incrementing edit counter at download time. A change in
  //     edit count means the user drew / undid / cleared a
  //     highlight, so the next request re-downloads with the new
  //     baked-in PNG.
  //   - HTML / selection invalidate only when the user saves an edit
  //     in the corresponding Edit dialog — handled by the generic
  //     `updateArtifact` message (see `applyArtifactEdit`).
  downloads?: {
    screenshot?: { downloadId: number; editVersion: number; path: string };
    html?: { downloadId: number; path: string };
    // Selection follows the same cache + invalidation policy as
    // `html`: unconditional until the user saves an edit via the
    // Edit selection dialog, which fires `updateArtifact` and drops
    // this entry so the next Copy / Capture re-materializes the
    // edited body under the same pinned `selectionFilenames[fmt]`.
    // Keyed per format because the Capture page exposes independent
    // Copy + Edit controls for each of HTML / text / markdown and
    // any of them can have a file materialized.
    selections?: Partial<Record<SelectionFormat, { downloadId: number; path: string }>>;
  };
  /**
   * Sticky per-artifact "was edited" flags. Set by the
   * `updateArtifact` handler when the user saves in the
   * corresponding dialog, and forwarded to `recordDetailedCapture`
   * at save time so the sidecar record's `contents` / `selection`
   * artifact object carries `isEdited: true`. Never cleared within
   * a session — once the body is the user's edit, it stays the
   * user's edit for any later save.
   *
   * `selectionEdited` is per-format so the Edit-markdown dialog
   * doesn't mark the HTML version as edited (or vice versa); the
   * save path reads only the flag for whichever format is being
   * written.
   */
  htmlEdited?: boolean;
  selectionEdited?: Partial<Record<SelectionFormat, boolean>>;
}

export function detailsStorageKey(tabId: number): string {
  return `${DETAILS_STORAGE_PREFIX}${tabId}`;
}

export async function startCaptureWithDetails(delayMs = 0): Promise<void> {
  // Capture both artifacts *before* opening the new tab so we
  // snapshot the user's current page (not the empty capture.html
  // tab). captureBothToMemory queries the active tab itself, after
  // the optional delay, so delayed details captures follow focus /
  // hover state the same way delayed screenshots do.
  const data = await captureBothToMemory(delayMs);

  // Re-query the active tab so we can position the Capture page tab
  // immediately to its right and remember it as the opener. The
  // tab strip hasn't moved between captureBothToMemory's query
  // and now (no async user input in between), so this resolves to
  // the same tab the screenshot came from.
  //
  // We also tried `index: active.index` (left of the opener) on
  // the theory that Chrome's "activate the right neighbor on
  // close" behavior would naturally restore focus to the opener
  // and let us drop the explicit re-activation in `saveDetails`.
  // It didn't pan out: in the headless Playwright tests, after
  // closing a programmatically-opened tab Chrome activates the
  // tab two positions to the right of the closed slot in the
  // original ordering, not the immediate right neighbor. The
  // e2e test caught this. We stick with right-of-active position
  // + explicit re-activation in the finally block.
  //
  // openerTabId helps Chrome group the new tab visually with
  // its opener; it has no role in close-time activation.
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const createProps: chrome.tabs.CreateProperties = {
    url: chrome.runtime.getURL('capture.html'),
  };
  if (active?.index !== undefined) createProps.index = active.index + 1;
  if (active?.id !== undefined) createProps.openerTabId = active.id;

  const tab = await chrome.tabs.create(createProps);
  if (tab.id === undefined) {
    throw new Error('Failed to open Capture page tab');
  }
  const session: DetailsSession = {
    capture: data,
    openerTabId: active?.id,
  };
  await chrome.storage.session.set({ [detailsStorageKey(tab.id)]: session });
}

interface GetDetailsMessage {
  action: 'getDetailsData';
}
/**
 * Keys the page can use on `EnsureDownloadedMessage.kind`. The three
 * `selection*` kinds are the same strings as the editable-artifact
 * kinds so the page doesn't juggle two separate enums; see
 * `WIRE_TO_SELECTION_FORMAT` below for the format-side reverse
 * lookup.
 */
type EnsureDownloadedKind =
  | 'screenshot'
  | 'html'
  | 'selectionHtml'
  | 'selectionText'
  | 'selectionMarkdown';

/**
 * Reverse lookup from the wire kind string to a `SelectionFormat`.
 * Keeps the `kind === 'selection…' ? format : undefined` branches
 * off the message handlers.
 */
const WIRE_TO_SELECTION_FORMAT: Partial<Record<EnsureDownloadedKind, SelectionFormat>> = {
  selectionHtml: 'html',
  selectionText: 'text',
  selectionMarkdown: 'markdown',
};

interface EnsureDownloadedMessage {
  action: 'ensureDownloaded';
  /** Which artifact the page wants on disk and a path for. */
  kind: EnsureDownloadedKind;
  /**
   * Page's monotonically-incrementing edit counter at the moment of
   * this request. Only meaningful for `kind === 'screenshot'`; the
   * SW's per-tab cache compares it against the version of the last
   * download and re-downloads on mismatch. HTML messages send 0 (or
   * omit) — the SW never invalidates the HTML cache.
   */
  editVersion?: number;
  /**
   * Highlight-baked PNG data URL, sent only when `kind ===
   * 'screenshot'` and `edits.length > 0` on the page. Used as the
   * download body when a re-download fires. Ignored when the cache
   * matches and we return the existing path.
   */
  screenshotOverride?: string;
}
interface UpdateArtifactMessage {
  action: 'updateArtifact';
  /** Which captured body to replace. */
  kind: EditableArtifactKind;
  /**
   * Full replacement body. Sent by the Capture page when the user
   * saves an edit in the corresponding Edit dialog.
   */
  value: string;
}
interface SaveDetailsMessage {
  action: 'saveDetails';
  screenshot: boolean;
  html: boolean;
  /**
   * Which selection format the user picked on the Capture page, or
   * `null` when no selection is being saved. The three "Save
   * selection as …" rows are mutually exclusive so at most one is
   * ever set.
   */
  selectionFormat: SelectionFormat | null;
  prompt: string;
  /**
   * True when at least one red rectangle or line (from the Box /
   * Line tools) is on the preview. Causes the saved record's
   * screenshot artifact to carry `hasHighlights: true` (only when
   * `screenshot` is also true — see capture.ts). Redactions / crops
   * are separate edit kinds and get their own flags.
   */
  highlights: boolean;
  /**
   * True when the baked PNG contains at least one redaction
   * rectangle. Causes the saved record's screenshot artifact to
   * carry `hasRedactions: true` (only when `screenshot` is also
   * true).
   */
  hasRedactions: boolean;
  /**
   * True when the baked PNG was cropped to a user-selected region.
   * Causes the saved record's screenshot artifact to carry
   * `isCropped: true` (only when `screenshot` is also true).
   */
  isCropped: boolean;
  /** Edit counter — same meaning as on `EnsureDownloadedMessage`. */
  editVersion?: number;
  /**
   * Optional replacement screenshot data URL with the user's
   * highlights baked into the PNG bytes. The Capture page sends this
   * only when the user both drew highlights and chose to save the
   * screenshot — otherwise the original (un-annotated) capture in
   * session storage is used as-is.
   */
  screenshotOverride?: string;
}
type DetailsMessage =
  | GetDetailsMessage
  | EnsureDownloadedMessage
  | UpdateArtifactMessage
  | SaveDetailsMessage;

/**
 * Read the per-tab DetailsSession out of session storage. Returns
 * `undefined` when the entry is missing (e.g. the user closed the
 * Capture page tab between message dispatch and handler, or the SW was
 * torn down and lost the in-memory link). Most callers wrap this
 * with `requireDetailsSession` to throw; `getDetailsData` calls it
 * directly so it can no-op silently and let the page render a
 * blank state instead of surfacing an error.
 */
async function loadDetailsSession(tabId: number): Promise<DetailsSession | undefined> {
  const key = detailsStorageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return stored[key] as DetailsSession | undefined;
}

/**
 * Throwing wrapper around `loadDetailsSession`. Use this from
 * handlers that can't sensibly proceed without a session (the
 * `ensureDownloaded` and `saveDetails` paths).
 */
async function requireDetailsSession(tabId: number): Promise<DetailsSession> {
  const session = await loadDetailsSession(tabId);
  if (!session) throw new Error('Capture data missing for Capture page tab');
  return session;
}

/**
 * Persist a (possibly mutated) DetailsSession back to session
 * storage under the same per-tab key. Used after we update the
 * `downloads` cache so future Copy / Capture clicks can reuse the
 * already-downloaded files.
 */
async function saveDetailsSession(tabId: number, session: DetailsSession): Promise<void> {
  await chrome.storage.session.set({ [detailsStorageKey(tabId)]: session });
}

/**
 * Shared skeleton for the ensure*Downloaded helpers. All three (and
 * any future ones) follow the same shape:
 *
 *   1. Load session.
 *   2. Precondition check (optional) — throw if the capture
 *      doesn't carry what the artifact needs.
 *   3. Cache hit? Return the cached path immediately. The "is this
 *      cache entry still valid?" decision is parameterized via
 *      `getCachedPath` so the screenshot path can compare
 *      `editVersion` and invalidate, while html/selection just
 *      accept any existing entry.
 *   4. Start the download + wait for it to complete.
 *   5. Re-read the session and either (a) commit the new entry or
 *      (b) defer to a newer entry another concurrent call wrote
 *      while our download was in flight. `shouldCommit` lets the
 *      screenshot branch override this when our version is still
 *      as fresh as the committed one.
 *   6. Return the on-disk path.
 *
 * Concurrency caveat: the read-modify-write on `session.downloads`
 * is *not* atomic across artifacts. Two concurrent calls for
 * *different* artifacts (e.g. screenshot + html completing close
 * together) each re-read session independently, and the later
 * writer can clobber the earlier one's just-committed entry. In
 * practice the user latency between clicking Copy and clicking
 * Capture (or drawing highlights) is orders of magnitude larger
 * than download completion, so this window doesn't occur — but if
 * the helper is ever used from a path that issues truly concurrent
 * multi-artifact downloads, add a mutex here.
 */
async function ensureArtifactDownloaded<T extends { downloadId: number; path: string }>(
  tabId: number,
  options: {
    /** Returns the path of a still-valid cached entry, or
     * `undefined` to force a fresh download. */
    getCachedPath: (session: DetailsSession) => string | undefined;
    /** Throws if the session state can't support this artifact. */
    precondition?: (session: DetailsSession) => void;
    /** Start the actual download. */
    startDownload: (capture: InMemoryCapture) => Promise<number>;
    /** Build the cache entry object for the downloaded file. */
    makeCacheEntry: (downloadId: number, path: string) => T;
    /**
     * Decide whether our just-completed download should win over a
     * cache entry another concurrent call (or an edit handler) may
     * have committed / dropped while we were waiting. Gets both
     * the re-read session and the current per-kind cache entry:
     *   - html / selection: `!fresh && freshSession[kind]Edited ===
     *     wasEditedAtStart` — refuse to commit when an edit landed
     *     during our download (our on-disk bytes are pre-edit).
     *   - screenshot: `!fresh || our editVersion >= fresh.editVersion`.
     */
    shouldCommit: (fresh: T | undefined, freshSession: DetailsSession) => boolean;
    /** Read the currently committed cache entry (if any) out of the
     * session. Used to feed `shouldCommit` and to detect mid-flight
     * writes that invalidate our completed download. */
    getCurrentEntry: (session: DetailsSession) => T | undefined;
    /** Commit the new cache entry under the right key. Selection
     * artifacts nest under `downloads.selections[format]`, which
     * a flat key can't express — hence the callback. */
    setCacheEntry: (session: DetailsSession, entry: T) => void;
  },
): Promise<string> {
  const session = await requireDetailsSession(tabId);
  if (options.precondition) options.precondition(session);

  const cachedPath = options.getCachedPath(session);
  if (cachedPath !== undefined) return cachedPath;

  const downloadId = await options.startDownload(session.capture);
  const path = await waitForDownloadComplete(downloadId);

  const fresh = await requireDetailsSession(tabId);
  const freshCached = options.getCurrentEntry(fresh);
  if (options.shouldCommit(freshCached, fresh)) {
    fresh.downloads = fresh.downloads ?? {};
    options.setCacheEntry(fresh, options.makeCacheEntry(downloadId, path));
    await saveDetailsSession(tabId, fresh);
  }
  return path;
}

/**
 * Materialize the screenshot file on disk if needed and return its
 * absolute on-disk path. Cache key is `editVersion`: a change means
 * the user drew / undid / cleared a highlight, so the on-disk PNG
 * is stale and we re-download with the page's freshly baked-in
 * override. Same-version reads hit the cache.
 *
 * Concurrency: a fast user clicking Copy → drawing → clicking Copy
 * again can interleave two in-flight downloads on the same tab. The
 * `shouldCommit` predicate keeps a slow v1 download from clobbering
 * a v2 entry that's already landed; the wait-for-complete latency
 * is the only window where this matters.
 */
export async function ensureScreenshotDownloaded(
  tabId: number,
  editVersion: number,
  screenshotOverride: string | undefined,
): Promise<string> {
  return ensureArtifactDownloaded(tabId, {
    getCachedPath: (s) => {
      const c = s.downloads?.screenshot;
      return c && c.editVersion === editVersion ? c.path : undefined;
    },
    startDownload: (capture) => downloadScreenshot(capture, screenshotOverride),
    makeCacheEntry: (downloadId, path) => ({ downloadId, editVersion, path }),
    shouldCommit: (fresh) => !fresh || editVersion >= fresh.editVersion,
    getCurrentEntry: (s) => s.downloads?.screenshot,
    setCacheEntry: (s, entry) => {
      s.downloads!.screenshot = entry;
    },
  });
}

/**
 * Build the `shouldCommit` predicate used by `ensureHtmlDownloaded`
 * / `ensureSelectionDownloaded`. Closes over the pre-download value
 * of the artifact's sticky "edited" flag so the predicate can
 * refuse to commit when an Edit-dialog save landed while our
 * download was in flight — if it committed blindly, the on-disk
 * file would hold pre-edit bytes but the eventual sidecar's
 * `isEdited: true` would claim otherwise.
 *
 * The `readEdited` callback lets callers point at either the flat
 * `htmlEdited` flag or the per-format `selectionEdited[format]`
 * entry without the helper having to know the shape.
 */
function editableShouldCommit(
  readEdited: (session: DetailsSession) => boolean,
  wasEditedAtStart: boolean,
): (fresh: unknown, freshSession: DetailsSession) => boolean {
  return (fresh, freshSession) => {
    if (fresh) return false;
    return readEdited(freshSession) === wasEditedAtStart;
  };
}

/**
 * Materialize the HTML file on disk if needed and return its
 * absolute on-disk path. The cache is unconditional until the user
 * saves an edit in the Edit HTML dialog — the `updateArtifact`
 * handler drops the cache entry so the next call re-downloads with
 * the edited body under the same pinned `contentsFilename`.
 *
 * Throws when the capture carries an `htmlError` (scrape failed at
 * capture time). Under normal use the page's Save HTML checkbox and
 * Copy / Edit buttons are disabled in that case, so this branch is
 * unreachable; it's a belt-and-suspenders guard so a stale page
 * message can't write an empty HTML file.
 */
export async function ensureHtmlDownloaded(tabId: number): Promise<string> {
  // Snapshot the sticky edited flag so the commit predicate can
  // detect an Edit-dialog save landing mid-flight and skip committing
  // a cache entry whose on-disk file holds pre-edit bytes.
  const pre = await requireDetailsSession(tabId);
  const wasEdited = pre.htmlEdited === true;
  return ensureArtifactDownloaded(tabId, {
    precondition: (s) => {
      if (s.capture.htmlError) {
        throw new Error(`HTML not captured: ${s.capture.htmlError}`);
      }
    },
    getCachedPath: (s) => s.downloads?.html?.path,
    startDownload: downloadHtml,
    makeCacheEntry: (downloadId, path) => ({ downloadId, path }),
    shouldCommit: editableShouldCommit((s) => s.htmlEdited === true, wasEdited),
    getCurrentEntry: (s) => s.downloads?.html,
    setCacheEntry: (s, entry) => {
      s.downloads!.html = entry;
    },
  });
}

/**
 * Materialize the selection file on disk if needed and return its
 * absolute on-disk path. Cache + invalidation policy mirrors
 * `ensureHtmlDownloaded`: unconditional until the user saves in the
 * Edit selection dialog, with the same pre-start snapshot of
 * `selectionEdited` protecting a mid-flight download from
 * committing a stale cache entry.
 *
 * Throws when the capture carries a `selectionError` (scrape failed
 * at capture time) or when no selection was present. Under normal
 * use the page's Save selection checkbox and Copy / Edit buttons are
 * disabled in both cases, so this branch is unreachable; it's a
 * belt-and-suspenders guard so a stale page message can't write an
 * empty file.
 */
export async function ensureSelectionDownloaded(
  tabId: number,
  format: SelectionFormat,
): Promise<string> {
  const pre = await requireDetailsSession(tabId);
  const wasEdited = pre.selectionEdited?.[format] === true;
  return ensureArtifactDownloaded(tabId, {
    precondition: (s) => {
      if (s.capture.selectionError) {
        throw new Error(`Selection not captured: ${s.capture.selectionError}`);
      }
      if (!s.capture.selections || !s.capture.selectionFilenames) {
        throw new Error('No selection was captured');
      }
      const body = s.capture.selections[format];
      if (!body || body.trim().length === 0) {
        throw new Error(noSelectionContentMessage(format));
      }
    },
    getCachedPath: (s) => s.downloads?.selections?.[format]?.path,
    startDownload: (capture) => downloadSelection(capture, format),
    makeCacheEntry: (downloadId, path) => ({ downloadId, path }),
    shouldCommit: editableShouldCommit(
      (s) => s.selectionEdited?.[format] === true,
      wasEdited,
    ),
    getCurrentEntry: (s) => s.downloads?.selections?.[format],
    setCacheEntry: (s, entry) => {
      s.downloads!.selections = { ...(s.downloads!.selections ?? {}), [format]: entry };
    },
  });
}

/**
 * Per-kind spec driving the generic `updateArtifact` handler. Each
 * entry says how to commit the edited body to the session and how
 * to drop the matching `session.downloads` entry so the next Copy /
 * Capture re-materializes under the same pinned filename.
 *
 * The three `selection*` kinds mirror the `SelectionFormat` values:
 * each writes its own slot under `capture.selections[fmt]` + flips
 * `session.selectionEdited[fmt] = true` + drops
 * `session.downloads.selections[fmt]`. A selection-markdown edit
 * doesn't touch the HTML or text bodies — on the Capture page each
 * format row has its own Edit dialog.
 *
 * New editable artifact kinds add one entry here (and one to the
 * `EditableArtifactKind` literal union); the handler loop and the
 * surrounding session bookkeeping stay untouched.
 */
interface EditableArtifactSpec {
  /** Write the edited body into the right slot on the session. */
  write: (session: DetailsSession, value: string) => void;
  /** Drop the matching `session.downloads` entry so the next
   *  materialization re-downloads with the edited body. */
  dropDownload: (session: DetailsSession) => void;
}

function selectionEditableSpec(format: SelectionFormat): EditableArtifactSpec {
  return {
    write: (s, v) => {
      if (s.capture.selections) s.capture.selections[format] = v;
      s.selectionEdited = { ...(s.selectionEdited ?? {}), [format]: true };
    },
    dropDownload: (s) => {
      if (s.downloads?.selections && format in s.downloads.selections) {
        const copy = { ...s.downloads.selections };
        delete copy[format];
        s.downloads = { ...s.downloads, selections: copy };
      }
    },
  };
}

const EDITABLE_ARTIFACTS: Record<EditableArtifactKind, EditableArtifactSpec> = {
  html: {
    write: (s, v) => {
      s.capture.html = v;
      s.htmlEdited = true;
    },
    dropDownload: (s) => {
      if (s.downloads?.html) {
        const copy = { ...s.downloads };
        delete copy.html;
        s.downloads = copy;
      }
    },
  },
  selectionHtml: selectionEditableSpec('html'),
  selectionText: selectionEditableSpec('text'),
  selectionMarkdown: selectionEditableSpec('markdown'),
};

/**
 * Which `capture.*Error` field guards a given editable kind. HTML
 * gates on its own scrape error; every selection format currently
 * gates on the shared `selectionError` because today's
 * `captureBothToMemory` produces all three bodies from one
 * `executeScript` call, so a failure is shared by all formats. If
 * per-format scrape errors ever land (each format failing
 * independently), this map becomes a per-format lookup —
 * `selectionHtmlError` / `selectionTextError` / etc. on
 * `InMemoryCapture`.
 */
const EDIT_GUARD_ERROR: Record<EditableArtifactKind, 'htmlError' | 'selectionError'> = {
  html: 'htmlError',
  selectionHtml: 'selectionError',
  selectionText: 'selectionError',
  selectionMarkdown: 'selectionError',
};

/**
 * Apply an Edit-dialog save to the given session: replace the body
 * + set the sticky edited flag + drop the corresponding download
 * cache so the next Copy / Capture re-downloads with the edited
 * content at the pinned filename. Mutates `session` in place;
 * caller must persist via `saveDetailsSession`.
 *
 * Throws when the matching `*Error` is set on the capture (scrape
 * failed at capture time). Under normal use the page-side Edit
 * button is disabled in that case, so the message never arrives;
 * the throw is a defense-in-depth guard so a stray `updateArtifact`
 * can't write content the SW would then refuse to materialize via
 * its `ensure*Downloaded` precondition — leaving the sticky edit
 * flag set on a body the user can never actually save.
 */
function applyArtifactEdit(
  session: DetailsSession,
  kind: EditableArtifactKind,
  value: string,
): void {
  const reason = session.capture[EDIT_GUARD_ERROR[kind]];
  if (reason) {
    throw new Error(`Cannot edit ${kind}: ${reason}`);
  }
  const spec = EDITABLE_ARTIFACTS[kind];
  spec.write(session, value);
  spec.dropDownload(session);
}

/**
 * Install the runtime.onMessage + tabs.onRemoved listeners that
 * drive the Capture page (data fetch, artifact materialization,
 * edit saves, final save-and-close, session cleanup on tab close).
 */
export function installDetailsMessageHandlers(): void {
  chrome.runtime.onMessage.addListener((msg: DetailsMessage, sender, sendResponse) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return false;

    if (msg.action === 'getDetailsData') {
      void (async () => {
        // Page on first load shouldn't error if the SW lost its
        // session — let it render a blank state instead. Hence the
        // non-throwing `loadDetailsSession`, unlike the
        // `requireDetailsSession` call in `saveDetails`.
        const session = await loadDetailsSession(tabId);
        if (!session) {
          sendResponse(undefined);
          return;
        }
        // Forward the fields the page actually renders or mirrors:
        // the preview image, the captured URL, the HTML body (for
        // byte counting + the Edit HTML dialog), and the three
        // selection bodies (for the Edit-selection dialogs and for
        // enabling each Save-selection-as-… row — presence of a
        // non-empty string in the matching format plays the role
        // the old `hasSelection` flag did). File paths are not sent
        // here; they come back via the on-demand `ensureDownloaded`
        // round-trip when a Copy button is clicked.
        //
        // `htmlError` / `selectionError` propagate any scrape failure
        // from `captureBothToMemory` so the page can grey out the
        // corresponding rows and show an error icon with the reason.
        //
        // `capturePageDefaults` carries the user's stored Save-
        // checkbox preferences (split by selection-presence). The
        // page applies the matching branch on first paint, so the
        // initial state of the screenshot / HTML / selection
        // checkboxes + the format radio reflects what the user picked
        // on the Options page — independent of the with-selection
        // click default.
        const capturePageDefaults = await getCaptureDetailsDefaults();
        sendResponse({
          screenshotDataUrl: session.capture.screenshotDataUrl,
          html: session.capture.html,
          selections: session.capture.selections,
          url: session.capture.url,
          htmlError: session.capture.htmlError,
          selectionError: session.capture.selectionError,
          screenshotError: session.capture.screenshotError,
          capturePageDefaults,
        });
      })();
      return true;
    }

    if (msg.action === 'ensureDownloaded') {
      void (async () => {
        try {
          let path: string;
          if (msg.kind === 'screenshot') {
            path = await ensureScreenshotDownloaded(
              tabId,
              msg.editVersion ?? 0,
              msg.screenshotOverride,
            );
          } else if (msg.kind === 'html') {
            path = await ensureHtmlDownloaded(tabId);
          } else {
            const format = WIRE_TO_SELECTION_FORMAT[msg.kind];
            if (!format) {
              throw new Error(`Unknown ensureDownloaded kind: ${String(msg.kind)}`);
            }
            path = await ensureSelectionDownloaded(tabId, format);
          }
          sendResponse({ path });
        } catch (err) {
          sendResponse({ error: err instanceof Error ? err.message : String(err) });
        }
      })();
      return true;
    }

    if (msg.action === 'updateArtifact') {
      void (async () => {
        try {
          const session = await requireDetailsSession(tabId);
          applyArtifactEdit(session, msg.kind, msg.value);
          await saveDetailsSession(tabId, session);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ error: err instanceof Error ? err.message : String(err) });
        }
      })();
      return true;
    }

    if (msg.action === 'saveDetails') {
      void runWithErrorReporting(async () => {
        const key = detailsStorageKey(tabId);
        const session = await requireDetailsSession(tabId);
        try {
          // Each artifact runs through the same `ensure…Downloaded`
          // helper as the Copy buttons. Files the user already
          // pre-downloaded via Copy (with the same `editVersion` for
          // screenshots) hit the cache and are not re-written.
          if (msg.screenshot) {
            await ensureScreenshotDownloaded(
              tabId,
              msg.editVersion ?? 0,
              msg.screenshotOverride,
            );
          }
          if (msg.html) {
            await ensureHtmlDownloaded(tabId);
          }
          if (msg.selectionFormat) {
            await ensureSelectionDownloaded(tabId, msg.selectionFormat);
          }
          await recordDetailedCapture({
            capture: session.capture,
            includeScreenshot: msg.screenshot,
            includeHtml: msg.html,
            selectionFormat: msg.selectionFormat ?? undefined,
            prompt: msg.prompt,
            hasHighlights: msg.highlights,
            hasRedactions: msg.hasRedactions,
            isCropped: msg.isCropped,
            htmlEdited: session.htmlEdited,
            // Only the chosen selection format's edit flag matters for
            // the sidecar — edits to other formats stay on disk but
            // never land in `log.json` because they weren't picked
            // for save.
            selectionEdited:
              msg.selectionFormat !== null
                ? session.selectionEdited?.[msg.selectionFormat] === true
                : undefined,
          });
        } finally {
          // Always clean up the stored capture and close the tab, even
          // if recordDetailedCapture throws: the stashed data is no longer
          // useful and the user can click the menu item again to retry.
          //
          // Trade-off: on failure the Capture page tab disappears out from
          // under the user, and the only visible signal is the usual
          // error-icon / tooltip swap from runWithErrorReporting. That's
          // consistent with every other capture path (they all fail
          // silently on-screen and surface the error on the toolbar),
          // and leaving the tab open on failure would strand a
          // now-stale preview the user would have to close by hand.
          await chrome.storage.session.remove(key);
          // Re-activate the opener (the page the user captured from)
          // *before* removing the Capture page tab.
          //
          // We tested removing this and relying on Chrome's natural
          // close behavior. Chrome's pick is not reliably the right
          // neighbor — in headless Playwright tests it activated the
          // tab two positions right of the closed slot, not the
          // immediate right neighbor. The e2e test pins this down.
          //
          // Order matters: activate first, then remove. If we removed
          // first, Chrome would briefly flash its own pick before
          // our update could land.
          const openerTabId = session.openerTabId;
          if (openerTabId !== undefined) {
            try {
              await chrome.tabs.update(openerTabId, { active: true });
            } catch (err) {
              // Best-effort: if the opener was closed during the
              // Capture page flow, just log and proceed with the close.
              console.warn('[SeeWhatISee] failed to focus opener tab:', err);
            }
          }
          try {
            await chrome.tabs.remove(tabId);
          } catch (err) {
            console.warn('[SeeWhatISee] failed to close Capture page tab:', err);
          }
        }
      });
      // No response expected — background closes the tab when done.
      return false;
    }

    return false;
  });

  // If the user closes a Capture page tab manually (without clicking
  // Capture), drop its stashed data so session storage doesn't grow
  // until the browser restarts.
  chrome.tabs.onRemoved.addListener((tabId) => {
    void chrome.storage.session.remove(detailsStorageKey(tabId));
  });
}
