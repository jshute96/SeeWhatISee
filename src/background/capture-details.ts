import {
  captureBothToMemory,
  captureImageToMemory,
  compactTimestamp,
  copyToClipboard,
  downloadHtml,
  downloadScreenshot,
  downloadSelection,
  imageExtensionFor,
  noSelectionContentMessage,
  recordDetailedCapture,
  waitForDownloadComplete,
  type EditableArtifactKind,
  type InMemoryCapture,
  type SelectionFormat,
} from '../capture.js';
import { clearCaptureError } from './error-reporting.js';
import {
  getCaptureDetailsDefaults,
  type CaptureDetailsDefaults,
} from './capture-page-defaults.js';

/**
 * Synthetic Capture-page defaults for the image-context flow. The
 * user's stored defaults are kept untouched (they're a global
 * preference for the toolbar / hotkey path); this object is what
 * gets shipped on the wire when the session was opened by the
 * image right-click. Rules:
 *
 *   - Save Screenshot: always true. The screenshot *is* the image
 *     the user just right-clicked.
 *   - Save HTML: always false. Page HTML wasn't even scraped — the
 *     Save HTML row will also be quiet-disabled by `htmlUnavailable`.
 *   - Save Selection: true. If a selection is present, it's likely
 *     a caption / context for the image — easy path is "save the
 *     image plus its caption together." When no selection exists
 *     the page leaves the master row disabled and the checkbox state
 *     never shows.
 *   - Selection format: inherited from the user's stored default
 *     (or fall back to whichever has content) so a Markdown-loving
 *     user doesn't get HTML for image-context selections either.
 *   - `defaultButton` / `promptEnter`: inherited from the user's
 *     stored defaults — image-flow shouldn't change which button
 *     is highlighted or how Enter behaves in the prompt.
 */
function imageFlowDefaults(user: CaptureDetailsDefaults): CaptureDetailsDefaults {
  return {
    withoutSelection: { screenshot: true, html: false },
    withSelection: {
      screenshot: true,
      html: false,
      selection: true,
      format: user.withSelection.format,
    },
    defaultButton: user.defaultButton,
    promptEnter: user.promptEnter,
  };
}

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
  /**
   * Per-artifact monotonic edit counters bumped by `applyArtifactEdit`
   * each time the user commits an edit in the corresponding dialog.
   * Used by the multi-capture filename strategy: each
   * `recordDetailedCapture` snapshots the current revision into
   * `saved.<artifact>.revision`, and the next save compares the
   * snapshot to the latest counter to decide whether to reuse the
   * locked filename or bump a `-N` suffix.
   *
   * Screenshot edits are tracked on the page side via the
   * `editVersion` integer the page passes through `ensureDownloaded`
   * / `saveDetails`, so there's no entry here for it — the same
   * counter plays the role for the bump logic.
   */
  revisions?: {
    html?: number;
    selection?: Partial<Record<SelectionFormat, number>>;
  };
  /**
   * Filenames + revisions snapshotted after a successful
   * `recordDetailedCapture`. Each entry says "this artifact was
   * written to disk under this name and that's now referenced by a
   * log.json record — treat the file as immutable." The next save
   * checks both fields:
   *   - same revision → reuse the locked filename (no re-download;
   *     the on-disk file is what the new log record points at too,
   *     so the user can drop multiple prompts referencing the same
   *     screenshot/HTML/selection without proliferating files).
   *   - different revision → user edited in between; bump a `-N`
   *     suffix on the saved filename, write a fresh file under the
   *     new name, and the new log record references the new name.
   *     The previous file stays on disk untouched.
   *
   * Per-artifact, only set if that artifact was actually included in
   * the previous Capture. Never cleared mid-session — once a file
   * is locked, it stays locked for the rest of this Capture-page
   * session even if the user toggles its checkbox off and on.
   */
  saved?: {
    screenshot?: { bumpIndex: number; revision: number };
    html?: { bumpIndex: number; revision: number };
    selections?: Partial<Record<SelectionFormat, { bumpIndex: number; revision: number }>>;
  };
  /**
   * Original (un-bumped) artifact filenames pinned at session
   * creation. The multi-capture bump strategy reads these to
   * produce stable `<base-stem>-N.<ext>` names — since
   * `capture.<x>Filename` gets mutated to the *current* desired
   * filename on each bump, parsing it for the trailing `-N` is
   * unreliable (the timestamp's millisecond suffix already looks
   * like a counter). `bumpedFilename(bases.<x>, bumpIndex)` is the
   * authoritative computation.
   */
  bases?: {
    screenshot?: string;
    contents?: string;
    selections?: Partial<Record<SelectionFormat, string>>;
  };
}

export function detailsStorageKey(tabId: number): string {
  return `${DETAILS_STORAGE_PREFIX}${tabId}`;
}

/**
 * Splice a `-N` index into a filename's stem (between the
 * basename and the extension). `bumpIndex === 0` returns the
 * unmodified base — that's the "first save, no bump yet" case.
 *
 *   `bumpedFilename('selection.md', 0)`              → 'selection.md'
 *   `bumpedFilename('selection-2026-04.md', 1)`      → 'selection-2026-04-1.md'
 *   `bumpedFilename('contents-20260503-080215-130.html', 2)`
 *                                                    → 'contents-20260503-080215-130-2.html'
 *
 * Always splices from the original base — never tries to parse a
 * trailing `-N` out of an already-bumped name. That would be
 * ambiguous against the millisecond suffix in our timestamp format
 * (`YYYYMMDD-HHMMSS-MMM`).
 */
function bumpedFilename(base: string, bumpIndex: number): string {
  if (bumpIndex === 0) return base;
  const lastDot = base.lastIndexOf('.');
  const stem = lastDot < 0 ? base : base.slice(0, lastDot);
  const ext = lastDot < 0 ? '' : base.slice(lastDot);
  return `${stem}-${bumpIndex}${ext}`;
}

/**
 * Compute the filename a save / copy of this artifact should land
 * at right now. The bump rule:
 *
 *   - No `saved` entry yet → first save. Use the base filename
 *     pinned at capture time.
 *   - `saved.revision` matches the artifact's current revision →
 *     unchanged since the lock; reuse the previously-locked
 *     filename (`bumpedFilename(base, saved.bumpIndex)`) so multiple
 *     captures referencing the same body all point at the same
 *     on-disk file.
 *   - `saved.revision` differs → user edited between saves; bump
 *     `bumpIndex + 1` so the previous file stays immutable on disk.
 */
function nextSaveFilename(
  base: string,
  saved: { bumpIndex: number; revision: number } | undefined,
  currentRevision: number,
): string {
  if (!saved) return base;
  return bumpedFilename(base, nextBumpIndex(saved, currentRevision));
}

/**
 * Pick the bumpIndex the next save / lock should use given the
 * previous lock and the artifact's current revision. Same revision
 * → reuse (no edit since the last save); diverged → +1 (user
 * edited; need a fresh `-N` filename so the previous one stays
 * immutable). Pulled out because the saveDetails post-save block
 * applies the same rule to all three artifact kinds.
 */
function nextBumpIndex(
  prev: { bumpIndex: number; revision: number } | undefined,
  currentRevision: number,
): number {
  if (!prev) return 0;
  return prev.revision === currentRevision ? prev.bumpIndex : prev.bumpIndex + 1;
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
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  await openCapturePageWithSession(data, active);
}

/**
 * Image-context-menu sibling of `startCaptureWithDetails`. Builds an
 * `InMemoryCapture` whose screenshot is the right-clicked image
 * (instead of `captureVisibleTab`) and opens the Capture page
 * positioned next to the source tab — same flow downstream, no
 * image-aware branches in the page itself.
 */
export async function startCaptureWithDetailsFromImage(
  tab: chrome.tabs.Tab,
  srcUrl: string,
): Promise<void> {
  const data = await captureImageToMemory(tab, srcUrl);
  await openCapturePageWithSession(data, tab);
}

/**
 * Open the Capture page tab next to `opener` and stash the
 * `InMemoryCapture` under the new tab's session-storage key so the
 * page can fetch it via `getDetailsData`. Shared by
 * `startCaptureWithDetails` (toolbar / hotkey path) and
 * `startCaptureWithDetailsFromImage` (image right-click path) so the
 * tab placement, opener bookkeeping, and session-storage key are
 * identical between paths.
 *
 * Also tested removing the right-of-active positioning and relying on
 * Chrome's natural "activate the right neighbor on close" behavior to
 * restore focus to the opener. It didn't pan out: in the headless
 * Playwright tests, after closing a programmatically-opened tab
 * Chrome activates the tab two positions to the right of the closed
 * slot in the original ordering, not the immediate right neighbor.
 * The e2e test caught this. We stick with right-of-active position +
 * explicit re-activation in the `saveDetails` finally block.
 *
 * `openerTabId` helps Chrome group the new tab visually with its
 * opener; it has no role in close-time activation.
 */
async function openCapturePageWithSession(
  data: InMemoryCapture,
  opener: chrome.tabs.Tab | undefined,
): Promise<void> {
  const createProps: chrome.tabs.CreateProperties = {
    url: chrome.runtime.getURL('capture.html'),
  };
  if (opener?.index !== undefined) createProps.index = opener.index + 1;
  if (opener?.id !== undefined) createProps.openerTabId = opener.id;

  const tab = await chrome.tabs.create(createProps);
  if (tab.id === undefined) {
    throw new Error('Failed to open Capture page tab');
  }
  const session: DetailsSession = {
    capture: data,
    openerTabId: opener?.id,
    // Snapshot the original (un-bumped) artifact filenames so the
    // multi-capture filename strategy can produce stable
    // `<base>-1.<ext>` names even after `capture.<x>Filename` gets
    // mutated by the bump. Pinned here once at session creation
    // and never touched again — `saved.<x>.bumpIndex` is the
    // counter; the base supplies the stem + extension.
    bases: {
      screenshot: data.screenshotFilename,
      contents: data.contentsFilename,
      selections: data.selectionFilenames
        ? { ...data.selectionFilenames }
        : undefined,
    },
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

  /**
   * Optional flag to indicate whether the screenshot currently carries active
   * highlights/edits, even if screenshotOverride is undefined due to caching.
   * Keeps the JPG -> PNG extension sync robust across subsequent copy clicks.
   */
  hasEdits?: boolean;
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
  /**
   * Default `true` — close the Capture page tab after the save
   * finishes (matches the long-standing Capture-button behavior).
   * The Capture page sends `false` for shift-click, which keeps the
   * tab open so the user can immediately Ask, retake, or hand-edit
   * without the page disappearing under them. The session storage
   * for this tab is dropped either way; staying open just means the
   * user keeps the preview they're already looking at.
   */
  closeAfter?: boolean;
}
interface CloseCapturePageMessage {
  /**
   * Standalone close request from the Capture page. Used by the
   * Ask path when the user ctrl-clicks Ask: the SW closes this tab
   * and re-activates the opener using the same dance saveDetails
   * does on its happy path. Sent only after a successful Ask so the
   * user doesn't lose access to the preview on a failure.
   */
  action: 'closeCapturePage';
}
interface InitializeUploadSessionMessage {
  action: 'initializeUploadSession';
  dataUrl: string;
  filename: string;
  mimeType: string;
}
interface CopyToClipboardMessage {
  action: 'copyToClipboard';
  text: string;
}
type DetailsMessage =
  | GetDetailsMessage
  | EnsureDownloadedMessage
  | UpdateArtifactMessage
  | SaveDetailsMessage
  | CloseCapturePageMessage
  | InitializeUploadSessionMessage
  | CopyToClipboardMessage;

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
 * Close the Capture page tab. Used by the saveDetails happy path
 * and the standalone closeCapturePage handler.
 *
 * `focusOpener` controls whether we first activate the opener tab
 * (the page the user originally captured from):
 *   - `true` for saveDetails — the user just saved a record and
 *     has no reason to stay on a tab that's about to vanish, so
 *     dropping them back on the source page is the natural next
 *     step. Chrome's own close-time pick isn't reliably the right
 *     neighbor (in headless Playwright tests it activates the tab
 *     two positions right of the closed slot), hence the explicit
 *     re-activation. Order matters: activate first, then remove —
 *     removing first would let Chrome briefly flash its own pick.
 *   - `false` for the Ask ctrl-click path — `sendToAi` already
 *     focused the provider tab so the user can watch the answer
 *     stream in. Re-activating the opener here would yank focus
 *     back to the original screenshot tab, which defeats the
 *     point of the close-and-watch gesture.
 */
async function closeCapturePageTab(
  tabId: number,
  openerTabId: number | undefined,
  focusOpener: boolean,
): Promise<void> {
  if (focusOpener && openerTabId !== undefined) {
    try {
      await chrome.tabs.update(openerTabId, { active: true });
    } catch (err) {
      // Best-effort: if the opener was closed during the Capture
      // page flow, just log and proceed with the close.
      console.warn('[SeeWhatISee] failed to focus opener tab:', err);
    }
  }
  try {
    await chrome.tabs.remove(tabId);
  } catch (err) {
    console.warn('[SeeWhatISee] failed to close Capture page tab:', err);
  }
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
 * Re-pin `capture.<artifact>Filename` to whatever
 * `nextSaveFilename` says it should be right now, given the
 * artifact's current revision and any locked filename from a
 * previous `recordDetailedCapture`. Drops the matching
 * `downloads.<artifact>` cache entry when the filename changes so
 * the next `ensureArtifactDownloaded` call re-materializes under
 * the new name. No-op when nothing's changed.
 *
 * Persists eagerly because the follow-on `ensureArtifactDownloaded`
 * re-loads the session via `requireDetailsSession`.
 */
async function rebumpFilenameIfLocked(
  tabId: number,
  adapter: {
    getBase: (s: DetailsSession) => string | undefined;
    getCurrentFilename: (s: DetailsSession) => string;
    setCurrentFilename: (s: DetailsSession, name: string) => void;
    getSaved: (s: DetailsSession) => { bumpIndex: number; revision: number } | undefined;
    getCurrentRevision: (s: DetailsSession) => number;
    dropCache: (s: DetailsSession) => void;
  },
): Promise<void> {
  const session = await requireDetailsSession(tabId);
  // No lock yet → never any bump to apply; the current filename
  // already is the base. Early-returning here means the
  // `getBase ?? getCurrentFilename` fallback never has to make a
  // judgment call about what to splice a `-N` into. (The fallback
  // would matter if `bases.<x>` were missing while `saved.<x>`
  // existed — but every path that writes `saved` was preceded by a
  // session that pinned `bases` at creation, so the two go together.)
  const saved = adapter.getSaved(session);
  if (!saved) return;
  const base = adapter.getBase(session) ?? adapter.getCurrentFilename(session);
  const desired = nextSaveFilename(base, saved, adapter.getCurrentRevision(session));
  if (desired === adapter.getCurrentFilename(session)) return;
  adapter.setCurrentFilename(session, desired);
  adapter.dropCache(session);
  await saveDetailsSession(tabId, session);
}

/**
 * Materialize the screenshot file on disk if needed and return its
 * absolute on-disk path. Cache key is `editVersion`: a change means
 * the user drew / undid / cleared a highlight, so the on-disk PNG
 * is stale and we re-download with the page's freshly baked-in
 * override. Same-version reads hit the cache.
 *
 * Multi-capture filename strategy: before the cache check, re-pin
 * `capture.screenshotFilename` via `rebumpFilenameIfLocked` so a
 * second save against locked-then-edited bytes lands at a fresh
 * `-N` filename rather than overwriting the previously-recorded
 * file. The screenshot's revision is the page-supplied
 * `editVersion` (no separate counter — the page already
 * monotonically bumps it on every edit).
 *
 * Concurrency: a fast user clicking Copy → drawing → clicking Copy
 * again can interleave two in-flight downloads on the same tab. The
 * `shouldCommit` predicate keeps a slow v1 download from clobbering
 * a v2 entry that's already landed; the wait-for-complete latency
 * is the only window where this matters.
 *
 * The pre-rewrite of `screenshotFilename` below is its own non-atomic
 * read-modify-write on session, separate from the re-read inside
 * `ensureArtifactDownloaded`. Two concurrent calls with different
 * override states could in theory write bytes from override A under
 * a filename derived from override B; the cache `shouldCommit`
 * predicate still picks the right winner for `recordDetailedCapture`,
 * so `log.json` stays correct, but a stray on-disk file may carry
 * mismatched bytes. Real users can't click fast enough to hit this;
 * a per-tab mutex would close it if needed.
 */
export async function ensureScreenshotDownloaded(
  tabId: number,
  editVersion: number,
  screenshotOverride: string | undefined,
  hasEdits = false,
): Promise<string> {
  // Re-pin the filename for any previous lock (multi-capture bump
  // strategy) before we sync its extension below — order matters:
  // bumpedFilename splices `-N` into the stem while preserving the
  // existing extension, so doing the bump first and the extension
  // rewrite second produces the right `<stem>-N.png` for an
  // override-on-edit save against an originally-non-PNG image.
  await rebumpFilenameIfLocked(tabId, {
    getBase: (s) => s.bases?.screenshot,
    getCurrentFilename: (s) => s.capture.screenshotFilename,
    setCurrentFilename: (s, name) => { s.capture.screenshotFilename = name; },
    getSaved: (s) => s.saved?.screenshot,
    getCurrentRevision: () => editVersion,
    dropCache: (s) => {
      if (s.downloads?.screenshot) {
        const copy = { ...s.downloads };
        delete copy.screenshot;
        s.downloads = copy;
      }
    },
  });
  // Sync the filename's extension to the bytes we're about to write.
  // The Capture-page bake (`renderHighlightedPng` →
  // `canvas.toDataURL('image/png')`) always produces PNG, so when an
  // override is present the on-disk file must end in `.png`. With no
  // override we write the original bytes verbatim and the filename
  // reverts to the pre-bake extension (tracked in
  // `screenshotOriginalExt`). Doing the rewrite before download — and
  // persisting the session — keeps `recordDetailedCapture` (which
  // reads `capture.screenshotFilename`) in sync with the actual bytes
  // even when the user toggles edits between Copy and Capture clicks.
  const pre = await requireDetailsSession(tabId);
  const targetExt = (screenshotOverride || hasEdits) ? 'png' : pre.capture.screenshotOriginalExt;
  // Skip the rewrite if `screenshotOriginalExt` is empty — currently
  // unreachable (every constructor sets it) but the regex would
  // otherwise produce a trailing-dot filename.
  if (targetExt) {
    const targetFilename = pre.capture.screenshotFilename.replace(
      /\.[^.]+$/,
      `.${targetExt}`,
    );
    if (targetFilename !== pre.capture.screenshotFilename) {
      pre.capture.screenshotFilename = targetFilename;
      await saveDetailsSession(tabId, pre);
    }
  }
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
  await rebumpFilenameIfLocked(tabId, {
    getBase: (s) => s.bases?.contents,
    getCurrentFilename: (s) => s.capture.contentsFilename,
    setCurrentFilename: (s, name) => { s.capture.contentsFilename = name; },
    getSaved: (s) => s.saved?.html,
    getCurrentRevision: (s) => s.revisions?.html ?? 0,
    dropCache: (s) => {
      if (s.downloads?.html) {
        const copy = { ...s.downloads };
        delete copy.html;
        s.downloads = copy;
      }
    },
  });
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
  await rebumpFilenameIfLocked(tabId, {
    getBase: (s) => s.bases?.selections?.[format],
    getCurrentFilename: (s) => s.capture.selectionFilenames?.[format] ?? '',
    setCurrentFilename: (s, name) => {
      if (!s.capture.selectionFilenames) return;
      s.capture.selectionFilenames = {
        ...s.capture.selectionFilenames,
        [format]: name,
      };
    },
    getSaved: (s) => s.saved?.selections?.[format],
    getCurrentRevision: (s) => s.revisions?.selection?.[format] ?? 0,
    dropCache: (s) => {
      if (s.downloads?.selections?.[format]) {
        const copy = { ...s.downloads.selections };
        delete copy[format];
        s.downloads = { ...s.downloads, selections: copy };
      }
    },
  });
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
      // Bump the per-format revision so a subsequent save can tell
      // the body has changed since the last `recordDetailedCapture`
      // and pick a fresh `-N` filename. The `saved` snapshot frozen
      // at the previous save's revision is the comparison baseline;
      // see nextSaveFilename above.
      const before = s.revisions?.selection?.[format] ?? 0;
      s.revisions = {
        ...(s.revisions ?? {}),
        selection: {
          ...(s.revisions?.selection ?? {}),
          [format]: before + 1,
        },
      };
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
      // Same rationale as selectionEditableSpec — bump the html
      // revision so the next save knows the body has diverged from
      // whatever the last `recordDetailedCapture` locked.
      const before = s.revisions?.html ?? 0;
      s.revisions = { ...(s.revisions ?? {}), html: before + 1 };
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
  // Image-flow sessions never scrape page HTML, so a stray
  // `updateArtifact { kind: 'html' }` would otherwise quietly seed
  // `capture.html` from `''` to whatever the user typed — and then
  // `ensureHtmlDownloaded` would happily materialize it. The
  // page-side Edit HTML button is disabled on `htmlUnavailable`, so
  // this is unreachable in practice; the guard is defense-in-depth
  // matching the `*Error` guard below.
  if (kind === 'html' && session.capture.htmlUnavailable === true) {
    throw new Error('Cannot edit html: HTML was not captured');
  }
  // Selection-edit on a session that never scraped a selection at
  // all (no `selections`, no `selectionError`). The body-write
  // helper short-circuits in this case but still flips the
  // sticky `selectionEdited[fmt]` flag, which would then ride on a
  // record whose ensureSelectionDownloaded precondition correctly
  // refuses to materialize the file. Refuse the edit upfront so
  // the flag never lands. Same image-flow no-selection scenario
  // as the html guard above.
  if (kind !== 'html' && !session.capture.selections) {
    throw new Error('Cannot edit selection: no selection was captured');
  }
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
        //
        // Image-context sessions get a synthetic defaults object that
        // overrides Save HTML to false (it's not even captured) and
        // checks Save Selection by default if a selection was scraped
        // — the right-clicked image plus its caption is the
        // expected pairing in this flow. The user's own
        // `capturePageDefaults` is preserved for the toolbar /
        // hotkey path.
        //
        // Gated on `imageUrl` (the user-facing field that names the
        // flow) rather than `htmlUnavailable` (an implementation
        // detail of how it's currently realized). A future flow that
        // sets `imageUrl` without skipping HTML — or vice versa —
        // would otherwise drift coherence between the wire defaults
        // and the page's row-level handling.
        const isImageFlow = session.capture.imageUrl !== undefined;
        const userDefaults = await getCaptureDetailsDefaults();
        const capturePageDefaults = isImageFlow
          ? imageFlowDefaults(userDefaults)
          : userDefaults;
        sendResponse({
          screenshotDataUrl: session.capture.screenshotDataUrl,
          html: session.capture.html,
          selections: session.capture.selections,
          url: session.capture.url,
          title: session.capture.title,
          htmlError: session.capture.htmlError,
          selectionError: session.capture.selectionError,
          screenshotError: session.capture.screenshotError,
          // Image-context flag the page reads to disable Save HTML
          // quietly (no error icon — the absence is intentional, not
          // a failure).
          htmlUnavailable: session.capture.htmlUnavailable,
          imageUrl: session.capture.imageUrl,
          capturePageDefaults,
        });
      })();
      return true;
    }

    if (msg.action === 'initializeUploadSession') {
      void (async () => {
        try {
          const { dataUrl, filename, mimeType } = msg;
          const now = new Date();
          const ts = compactTimestamp(now);
          const ext = imageExtensionFor(mimeType, filename);
          
          const capture: InMemoryCapture = {
            screenshotDataUrl: dataUrl,
            html: '',
            url: `file:${filename}`,
            title: filename,
            timestamp: now.toISOString(),
            screenshotFilename: `screenshot-${ts}.${ext}`,
            screenshotOriginalExt: ext,
            contentsFilename: `contents-${ts}.html`,
            htmlUnavailable: true,
          };
          
          const session: DetailsSession = {
            capture,
            bases: {
              screenshot: capture.screenshotFilename,
              contents: capture.contentsFilename,
            }
          };
          
          await chrome.storage.session.set({ [detailsStorageKey(tabId)]: session });
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ error: err instanceof Error ? err.message : String(err) });
        }
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
              msg.hasEdits === true,
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
      // The Capture page is alive and has a status slot — surface
      // failures there rather than via the toolbar icon. This handler
      // therefore does NOT go through `runWithErrorReporting`: the
      // page is the right error sink because it can show the message
      // in context next to the buttons that produced it. We still
      // call `clearCaptureError()` on success so a previous toolbar
      // error from a non-page path (toolbar click, context menu)
      // gets cleared by the next healthy save.
      //
      // On failure we also keep the page open regardless of
      // `closeAfter` — the user needs the preview as a recovery
      // surface and should be able to read the error before
      // dismissing.
      void (async () => {
        try {
          // Pre-flight session read just to confirm the page has
          // something to save against and to capture the openerTabId
          // for the close path. The post-save `saved.<x>` writes
          // re-load the session so they pick up any in-flight
          // mutations the ensure*Downloaded helpers may have made.
          const session = await requireDetailsSession(tabId);
          // Each artifact runs through the same `ensure…Downloaded`
          // helper as the Copy buttons. Files the user already
          // pre-downloaded via Copy (with the same `editVersion`
          // for screenshots) hit the cache and are not re-written.
          // The helpers also re-pin the artifact filename via
          // `rebumpFilenameIfLocked` so a save after a previous
          // capture+edit lands at a fresh `-N` name rather than
          // overwriting the locked file.
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
          // Re-load after the ensure*Downloaded calls so we pass
          // their (possibly bumped or extension-rewritten) filenames
          // to recordDetailedCapture. The local `session` captured at
          // the top of this handler is otherwise stale — both the
          // multi-capture bump and the screenshot extension rewrite
          // mutate `capture.<x>Filename` in place.
          const postEnsure = await requireDetailsSession(tabId);
          await recordDetailedCapture({
            capture: postEnsure.capture,
            includeScreenshot: msg.screenshot,
            includeHtml: msg.html,
            selectionFormat: msg.selectionFormat ?? undefined,
            prompt: msg.prompt,
            hasHighlights: msg.highlights,
            hasRedactions: msg.hasRedactions,
            isCropped: msg.isCropped,
            htmlEdited: postEnsure.htmlEdited,
            // Only the chosen selection format's edit flag matters
            // for the sidecar — edits to other formats stay on
            // disk but never land in `log.json` because they
            // weren't picked for save.
            selectionEdited:
              msg.selectionFormat !== null
                ? postEnsure.selectionEdited?.[msg.selectionFormat] === true
                : undefined,
          });
          // Lock each saved artifact: snapshot the bumpIndex +
          // revision the file was written under, so the next save
          // can tell whether to reuse the same on-disk file
          // (revision unchanged → same bumpIndex) or bump
          // `bumpIndex + 1` (revision diverged). Re-load to fold in
          // any mid-save edits via the dialog. The bumpIndex
          // carried forward is whatever produced the *current*
          // capture.<x>Filename — either the previous save's index
          // (when nothing changed since the last save) or that +1
          // (when the user edited and the rebump fired).
          const postSave = await requireDetailsSession(tabId);
          postSave.saved = postSave.saved ?? {};
          if (msg.screenshot) {
            const rev = msg.editVersion ?? 0;
            postSave.saved.screenshot = {
              bumpIndex: nextBumpIndex(postSave.saved.screenshot, rev),
              revision: rev,
            };
          }
          if (msg.html) {
            const rev = postSave.revisions?.html ?? 0;
            postSave.saved.html = {
              bumpIndex: nextBumpIndex(postSave.saved.html, rev),
              revision: rev,
            };
          }
          if (msg.selectionFormat && postSave.capture.selectionFilenames) {
            const fmt = msg.selectionFormat;
            const rev = postSave.revisions?.selection?.[fmt] ?? 0;
            postSave.saved.selections = {
              ...(postSave.saved.selections ?? {}),
              [fmt]: {
                bumpIndex: nextBumpIndex(postSave.saved.selections?.[fmt], rev),
                revision: rev,
              },
            };
          }
          await saveDetailsSession(tabId, postSave);
          sendResponse({ ok: true });
          await clearCaptureError();
          if (msg.closeAfter !== false) {
            // Closing path: drop the session storage along the way.
            // The `tabs.onRemoved` listener would do this anyway —
            // we just don't have to wait for it.
            await chrome.storage.session.remove(detailsStorageKey(tabId));
            await closeCapturePageTab(tabId, session.openerTabId, true);
          }
          // Stay-open path (shift-click): keep the session intact so
          // the user can iterate / retake / re-save. Filename
          // `saved` snapshots above ensure subsequent saves don't
          // trample the on-disk file we just locked.
        } catch (err) {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
          // Don't toolbar-report — the page surfaced the error in
          // its status slot. Don't close even when `closeAfter` was
          // set — the user keeps the page as a recovery surface
          // (Copy / Download buttons are still there) and to read
          // the error without it disappearing. Don't drop the
          // session either — the user might fix the offending
          // artifact and try again.
        }
      })();
      return true;
    }

    if (msg.action === 'copyToClipboard') {
      void (async () => {
        try {
          await copyToClipboard(msg.text);
          
          // Record for E2E test clipboard spy
          interface SWState { __seeClip?: string[] }
          const g = self as unknown as SWState;
          g.__seeClip = g.__seeClip ?? [];
          g.__seeClip.push(msg.text);

          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ error: err instanceof Error ? err.message : String(err) });
        }
      })();
      return true;
    }

    if (msg.action === 'closeCapturePage') {
      void (async () => {
        const key = detailsStorageKey(tabId);
        // Drop the stashed capture before we close — same lifecycle
        // as the saveDetails path. Skipped silently if the entry's
        // already gone.
        await chrome.storage.session.remove(key);
        // `focusOpener: false` — this path fires only after Ask
        // ctrl-click, by which point `sendToAi` has already focused
        // the destination provider tab. Re-activating the opener
        // here would steal focus back to the original screenshot
        // tab and the user would lose sight of the answer landing.
        // The opener id is therefore unused, which is why this
        // handler skips the session lookup the saveDetails path
        // does for it.
        await closeCapturePageTab(tabId, undefined, false);
      })();
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
