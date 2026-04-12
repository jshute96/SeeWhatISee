import {
  captureBothToMemory,
  captureVisible,
  clearCaptureLog,
  saveDetailedCapture,
  savePageContents,
  type InMemoryCapture,
} from './capture.js';

// User-visible error reporting for failed captures.
//
// The service worker has no modal-dialog API. We surface failures on
// two `chrome.action` channels so the user can see both *that*
// something failed and *what* failed, without requesting a noisy
// permission like `notifications`:
//   - The icon itself is the glanceable signal: we swap in a
//     pre-rendered "error" variant of each icon size (small red `!`
//     painted in the bottom-right corner) until the *next*
//     successful capture restores the originals. We deliberately
//     avoid `chrome.action.setBadgeText` because Chrome's badge pill
//     is uncomfortably large relative to the icon and there's no
//     API to shrink it; `setIcon` gives us pixel-level control.
//   - The tooltip (action title) is the reference channel: hovering
//     the icon shows the default tooltip plus a second line with
//     the last error message, so the user can go back and read
//     *what* failed without digging through the devtools console.
//
// Both calls are fire-and-forget: a follow-on error here shouldn't
// mask the original capture error. Logged to console but not
// re-thrown.
//
// Icon paths (relative to the extension root) for the normal and
// error states. Same three sizes as in the manifest's
// `action.default_icon`; the error variants are committed alongside
// the base icons in `src/icons/` and produced by
// `scripts/generate-error-icons.mjs` (re-run only when the base
// icons change).
const NORMAL_ICON_PATHS = {
  16: 'icons/icon-16.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png',
};
const ERROR_ICON_PATHS = {
  16: 'icons/icon-error-16.png',
  48: 'icons/icon-error-48.png',
  128: 'icons/icon-error-128.png',
};

async function reportCaptureError(err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  console.warn('[SeeWhatISee] capture failed:', err);
  try {
    await chrome.action.setIcon({ path: ERROR_ICON_PATHS });
  } catch (iconErr) {
    console.warn('[SeeWhatISee] failed to set error icon:', iconErr);
  }
  try {
    // Base tooltip is whichever CAPTURE_ACTIONS entry the user has
    // picked as the default click action (falls back to capture-now).
    // Second line shows the error. Chrome's toolbar tooltip honors
    // embedded newlines on macOS / Windows / most Linux DEs.
    const baseTitle = await getDefaultActionTooltip();
    await chrome.action.setTitle({
      title: `${baseTitle}\nLast error: ${message}`,
    });
  } catch (titleErr) {
    console.warn('[SeeWhatISee] failed to set error tooltip:', titleErr);
  }
}

async function clearCaptureError(): Promise<void> {
  try {
    await chrome.action.setIcon({ path: NORMAL_ICON_PATHS });
  } catch (err) {
    console.warn('[SeeWhatISee] failed to restore normal icon:', err);
  }
  try {
    // Dynamic: reflects the user's currently selected default
    // click action, not a hardcoded manifest string.
    await chrome.action.setTitle({ title: await getDefaultActionTooltip() });
  } catch (err) {
    console.warn('[SeeWhatISee] failed to reset tooltip:', err);
  }
}

/**
 * Run a capture-like action with unified error reporting. A
 * successful run clears any lingering error state (restores the
 * normal icon + default tooltip); a failure swaps in the error
 * icon variant and appends a `Last error: …` line to the tooltip.
 * Used by every user-initiated capture path (toolbar click,
 * context-menu entries).
 */
async function runWithErrorReporting(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    await clearCaptureError();
  } catch (err) {
    await reportCaptureError(err);
  }
}

// Targeted suppression for one specific user-actionable failure.
// Manually poking captureVisible from the SW devtools console (e.g.
// `SeeWhatISee.captureVisible()` while DevTools itself is the focused
// window) makes the active-tab lookup fail; without this handler, that
// rejection bubbles up as unhandled and Chrome promotes it onto the
// chrome://extensions Errors page, looking like an extension bug.
//
// We deliberately match on the error message rather than swallowing
// every unhandled rejection: a blanket catch would also silence
// genuine bugs (failed downloads, storage quota errors, future
// listener bodies that forget their try/catch) — and the Errors page
// is the only async signal most developers have. Anything we don't
// recognize is left alone so it still surfaces.
const SUPPRESSED_UNHANDLED = [
  'No active tab found to capture',
  'Failed to retrieve page contents',
  'saveDetailedCapture called with nothing to save',
];
self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  const message = String((event.reason as Error)?.message ?? event.reason);
  if (SUPPRESSED_UNHANDLED.some((s) => message.includes(s))) {
    console.warn('[SeeWhatISee] capture failed:', event.reason);
    event.preventDefault();
  }
});

// Capture actions surfaced to the user. Each entry appears both as
// a top-level context-menu entry (for one-off invocation) and as a
// radio entry inside the "Set default click action" submenu (where the
// user picks which one runs on a plain left-click on the toolbar
// icon). The tooltip is what `chrome.action.setTitle` shows on the
// icon when the given action is the current default — e.g. picking
// "Take screenshot in 2s" updates the hover text so the user knows
// what a click is about to do.
//
// Keep `capture-now` first: it's the default fallback when nothing
// is stored yet, and its tooltip matches the manifest's
// `action.default_title` so the hover text is correct during the
// brief window between a fresh install and the first tooltip
// refresh from `refreshActionTooltip()`.
interface CaptureAction {
  /** Stable id — used as the menu item id, the submenu child id
   * (with a prefix), and the storage value. */
  id: string;
  /** Short label shown in the context menu. */
  title: string;
  /** Tooltip shown on the toolbar icon when this action is the
   * current default. */
  tooltip: string;
  /** Runs when the user picks this action (either from the top-level
   * menu entry or via a toolbar click when it's the default). */
  run: () => Promise<unknown>;
}

const CAPTURE_ACTIONS: CaptureAction[] = [
  {
    id: 'capture-now',
    title: 'Take screenshot',
    tooltip: 'SeeWhatISee — Capture visible tab',
    run: () => captureVisible(0),
  },
  {
    id: 'capture-delayed-2s',
    title: 'Take screenshot in 2s',
    tooltip: 'SeeWhatISee — Capture visible tab in 2s',
    run: () => captureVisible(2000),
  },
  {
    id: 'save-page-contents',
    title: 'Save html contents',
    tooltip: 'SeeWhatISee — Save HTML contents',
    run: () => savePageContents(),
  },
  {
    id: 'capture-with-details',
    title: 'Capture with details...',
    tooltip: 'SeeWhatISee — Capture with details',
    run: () => startCaptureWithDetails(),
  },
];

const DEFAULT_CLICK_ACTION_KEY = 'defaultClickAction';
const DEFAULT_CLICK_PARENT_ID = 'default-click-parent';
// Child radio items under "Set default click action" use this prefix on
// their ids so the onClicked handler can tell "pick this default"
// clicks apart from the top-level "run this now" entries, which
// share the CAPTURE_ACTIONS ids verbatim.
const DEFAULT_CLICK_CHILD_PREFIX = 'set-default-';

function findCaptureAction(id: string | undefined): CaptureAction | undefined {
  return CAPTURE_ACTIONS.find((a) => a.id === id);
}

async function getDefaultClickActionId(): Promise<string> {
  const stored = await chrome.storage.local.get(DEFAULT_CLICK_ACTION_KEY);
  const id = stored[DEFAULT_CLICK_ACTION_KEY];
  // Fall back to the first action if storage is empty or holds a
  // stale id (e.g. after a release that renamed an action).
  return typeof id === 'string' && findCaptureAction(id)
    ? id
    : CAPTURE_ACTIONS[0]!.id;
}

async function getDefaultClickAction(): Promise<CaptureAction> {
  const id = await getDefaultClickActionId();
  return findCaptureAction(id) ?? CAPTURE_ACTIONS[0]!;
}

async function getDefaultActionTooltip(): Promise<string> {
  return (await getDefaultClickAction()).tooltip;
}

/**
 * Persist a new default click action and update the toolbar
 * tooltip to match. Safe to call from the contextMenus onClicked
 * handler — Chrome has already auto-flipped the radio's visual
 * state by the time we run, so we only need to mirror it to
 * storage and refresh the title.
 */
async function setDefaultClickActionId(id: string): Promise<void> {
  if (!findCaptureAction(id)) {
    throw new Error(`Unknown capture action id: ${id}`);
  }
  await chrome.storage.local.set({ [DEFAULT_CLICK_ACTION_KEY]: id });
  await refreshActionTooltip();
}

/**
 * Update `chrome.action.setTitle` to match the currently selected
 * default click action. Called after the preference changes and on
 * service-worker install/startup so a stale title from a previous
 * session doesn't linger.
 */
async function refreshActionTooltip(): Promise<void> {
  try {
    await chrome.action.setTitle({ title: await getDefaultActionTooltip() });
  } catch (err) {
    console.warn('[SeeWhatISee] failed to refresh action tooltip:', err);
  }
}

// Toolbar icon click → run whichever capture action is the current
// default. Default (on fresh install or if storage is wiped) is
// `capture-now`, matching the pre-submenu behavior.
//
// The click counts as a user gesture, which is what makes the `activeTab`
// permission (declared in manifest.json) kick in for the current tab —
// including restricted URLs like chrome:// pages, where `<all_urls>` host
// permission alone is not enough. Don't drop `activeTab` from the manifest
// without testing on chrome://extensions or you'll silently re-break this.
//
// We deliberately don't pass the listener's `tab` arg through to
// captureVisible — instead captureVisible re-queries the active tab
// itself, so the immediate and delayed paths share one resolution
// strategy (active tab in the last-focused window).
//
// runWithErrorReporting downgrades rejection to console.warn +
// user-visible icon swap + tooltip "Last error:" line, so
// user-actionable failures like "No active tab found to capture"
// don't get promoted onto the chrome://extensions Errors page.
//
// Extracted from the listener body so tests can drive the dispatch
// directly via `self.SeeWhatISee.handleActionClick()` — Playwright
// has no way to trigger `chrome.action.onClicked` from outside.
async function handleActionClick(): Promise<void> {
  await runWithErrorReporting(async () => {
    const action = await getDefaultClickAction();
    await action.run();
  });
}

chrome.action.onClicked.addListener(handleActionClick);

// Right-click context menu on the toolbar action. Structure:
//
//   Take screenshot
//   Take screenshot in 2s
//   Save html contents
//   Capture with details...
//   Set default click action  ▸   (submenu)
//       • Take screenshot           (radio group, exactly one checked)
//       • Take screenshot in 2s
//       • Save html contents
//       • Capture with details...
//   Clear log history
//
// Chrome allows an extension up to 6 top-level items in the action
// context menu — above that, Chrome collapses the overflow under a
// parent item named after the extension, which is ugly. The menu
// above is exactly 6: four CAPTURE_ACTIONS entries + the submenu
// parent + clear-log. No separator, for the same reason. Adding
// another top-level entry means pushing something into a submenu.
//
// The top-level action entries and the submenu radio entries are
// both built from the same CAPTURE_ACTIONS array so their ids,
// titles, and run functions can't drift out of sync.
//
// The registration runs on `chrome.runtime.onInstalled`; Chrome
// persists the entries across service-worker restarts so we don't
// have to recreate them on every wakeup.
//
// Note that the "Take screenshot" entry is functionally identical to
// a plain left-click when `capture-now` is the default action —
// listed in the menu for discoverability so users don't have to
// know left-click also captures.
const CLEAR_LOG_MENU_ID = 'clear-log';

// "Capture with details…" flow. We grab both the screenshot and
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

interface DetailsSession {
  capture: InMemoryCapture;
  // Tab id of the page the user captured from, so we can re-focus
  // it when the details tab closes. Optional: the active-tab
  // lookup can in principle return no id (chrome:// pages, races).
  openerTabId?: number;
}

function detailsStorageKey(tabId: number): string {
  return `${DETAILS_STORAGE_PREFIX}${tabId}`;
}

async function startCaptureWithDetails(): Promise<void> {
  // Capture both artifacts *before* opening the new tab so we
  // snapshot the user's current page (not the empty capture.html
  // tab). captureBothToMemory queries the active tab itself.
  const data = await captureBothToMemory();

  // Re-query the active tab so we can position the details tab
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
    throw new Error('Failed to open capture details tab');
  }
  const session: DetailsSession = { capture: data, openerTabId: active?.id };
  await chrome.storage.session.set({ [detailsStorageKey(tab.id)]: session });
}

interface GetDetailsMessage {
  action: 'getDetailsData';
}
interface SaveDetailsMessage {
  action: 'saveDetails';
  screenshot: boolean;
  html: boolean;
  prompt: string;
  /**
   * True when the user drew at least one highlight on the preview.
   * Causes the saved record to carry `highlights: true` (only when
   * `screenshot` is also true — see capture.ts).
   */
  highlights: boolean;
  /**
   * Optional replacement screenshot data URL with the user's
   * highlights baked into the PNG bytes. The capture page sends this
   * only when the user both drew highlights and chose to save the
   * screenshot — otherwise the original (un-annotated) capture in
   * session storage is used as-is.
   */
  screenshotOverride?: string;
}
type DetailsMessage = GetDetailsMessage | SaveDetailsMessage;

chrome.runtime.onMessage.addListener((msg: DetailsMessage, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return false;

  if (msg.action === 'getDetailsData') {
    void (async () => {
      const key = detailsStorageKey(tabId);
      const stored = await chrome.storage.session.get(key);
      const session = stored[key] as DetailsSession | undefined;
      // The page only needs the capture itself, not the opener id
      // bookkeeping — keep the wire shape unchanged.
      sendResponse(session?.capture);
    })();
    return true; // keep the message channel open for the async response
  }

  if (msg.action === 'saveDetails') {
    void runWithErrorReporting(async () => {
      const key = detailsStorageKey(tabId);
      const stored = await chrome.storage.session.get(key);
      const session = stored[key] as DetailsSession | undefined;
      if (!session) throw new Error('Capture data missing for details tab');
      const capture = session.capture;
      // Swap in the highlight-baked PNG when the page sent one. We
      // shallow-clone so we don't mutate the session-storage object
      // (still owned by Chrome until we remove it in the finally block
      // below) and so a re-read elsewhere wouldn't see the override.
      const captureForSave: InMemoryCapture = msg.screenshotOverride
        ? { ...capture, screenshotDataUrl: msg.screenshotOverride }
        : capture;
      try {
        await saveDetailedCapture({
          capture: captureForSave,
          includeScreenshot: msg.screenshot,
          includeHtml: msg.html,
          prompt: msg.prompt,
          hasHighlights: msg.highlights,
        });
      } finally {
        // Always clean up the stored capture and close the tab, even
        // if saveDetailedCapture throws: the stashed data is no longer
        // useful and the user can click the menu item again to retry.
        //
        // Trade-off: on failure the details tab disappears out from
        // under the user, and the only visible signal is the usual
        // error-icon / tooltip swap from runWithErrorReporting. That's
        // consistent with every other capture path (they all fail
        // silently on-screen and surface the error on the toolbar),
        // and leaving the tab open on failure would strand a
        // now-stale preview the user would have to close by hand.
        await chrome.storage.session.remove(key);
        // Re-activate the opener (the page the user captured from)
        // *before* removing the details tab.
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
            // details flow, just log and proceed with the close.
            console.warn('[SeeWhatISee] failed to focus opener tab:', err);
          }
        }
        try {
          await chrome.tabs.remove(tabId);
        } catch (err) {
          console.warn('[SeeWhatISee] failed to close details tab:', err);
        }
      }
    });
    // No response expected — background closes the tab when done.
    return false;
  }

  return false;
});

// If the user closes a details tab manually (without clicking
// Capture), drop its stashed data so session storage doesn't grow
// until the browser restarts.
chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.remove(detailsStorageKey(tabId));
});

async function installContextMenu(): Promise<void> {
  // Read the current default up front so each submenu radio child
  // can be created with the correct initial `checked` value —
  // `removeAll` wipes Chrome's per-item state along with the
  // entries themselves, so we can't rely on persisted state.
  const defaultId = await getDefaultClickActionId();

  // Top-level entries: run the action immediately when clicked.
  for (const action of CAPTURE_ACTIONS) {
    chrome.contextMenus.create({
      id: action.id,
      title: action.title,
      contexts: ['action'],
    });
  }

  // Submenu parent. Chrome automatically renders a ▸ indicator
  // because the entry has children (set via parentId below).
  chrome.contextMenus.create({
    id: DEFAULT_CLICK_PARENT_ID,
    title: 'Set default click action',
    contexts: ['action'],
  });

  // Radio children. Consecutive radio items with the same
  // `parentId` form a mutually exclusive group: Chrome handles the
  // check/uncheck flip on click; our onClicked listener just
  // persists the new choice. We set the initial `checked` state
  // from storage here so the right entry shows up pre-selected
  // after a fresh install / update.
  for (const action of CAPTURE_ACTIONS) {
    chrome.contextMenus.create({
      id: DEFAULT_CLICK_CHILD_PREFIX + action.id,
      parentId: DEFAULT_CLICK_PARENT_ID,
      type: 'radio',
      title: action.title,
      checked: action.id === defaultId,
      contexts: ['action'],
    });
  }

  // Clear history. Not grouped with the submenu radios — it's a
  // one-shot action at the root, not a preference.
  //
  // No separator above this: we're at Chrome's
  // `ACTION_MENU_TOP_LEVEL_LIMIT = 6` cap, and separators count
  // against it. Adding one silently drops a real entry — Chrome
  // reports the failure via `chrome.runtime.lastError` on the
  // offending create() call, which our loop never checks, so the
  // overflow is invisible until someone notices a missing menu
  // item. See docs/chrome-extension.md for the full story.
  chrome.contextMenus.create({
    id: CLEAR_LOG_MENU_ID,
    title: 'Clear log history',
    contexts: ['action'],
  });
}

chrome.runtime.onInstalled.addListener(() => {
  // removeAll first because onInstalled fires on `install`, `update`,
  // and `chrome_update`. On the update paths the previously-created
  // menu entries are still in Chrome's persisted extension state, and
  // calling `create` with the same id would throw "Cannot create item
  // with duplicate id". `removeAll` is a clean wipe that handles all
  // three cases identically.
  chrome.contextMenus.removeAll(() => {
    void installContextMenu();
  });
  // Also make sure the icon tooltip reflects the stored default
  // after an update — the old build may have written a title that's
  // no longer accurate.
  void refreshActionTooltip();
});

// Browser restart: onInstalled doesn't fire, but we still want the
// tooltip to match the stored preference. Chrome persists the
// `chrome.action.setTitle` value across restarts, so this is a
// belt-and-suspenders refresh in case anything has fallen out of
// sync (e.g. a storage write that raced the previous shutdown).
chrome.runtime.onStartup.addListener(() => {
  void refreshActionTooltip();
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  const id = String(info.menuItemId);

  // "Set default click action" submenu: a radio click just persists
  // the new preference. Deliberately not routed through
  // runWithErrorReporting — flipping a setting isn't a capture,
  // and painting the error icon on a failed storage write would
  // be misleading.
  //
  // On a storage-write failure Chrome has already auto-flipped the
  // radio UI to the new selection, but the stored id and the
  // toolbar tooltip will still reflect the *old* one. The radio
  // snaps back to the old choice on the next install/update when
  // installContextMenu re-reads storage. We accept that small UX
  // drift rather than trying to un-flip the radio (no API for it),
  // and just log the failure.
  if (id.startsWith(DEFAULT_CLICK_CHILD_PREFIX)) {
    const actionId = id.slice(DEFAULT_CLICK_CHILD_PREFIX.length);
    try {
      await setDefaultClickActionId(actionId);
    } catch (err) {
      console.warn('[SeeWhatISee] failed to set default click action:', err);
    }
    return;
  }

  // Top-level capture entry: run its action.
  const action = findCaptureAction(id);
  if (action) {
    await runWithErrorReporting(() => action.run());
    return;
  }

  // Clear history. Routed through runWithErrorReporting for
  // consistency with the capture paths: on success the error
  // state is cleared, and on failure the same icon/tooltip
  // channels tell the user something went wrong.
  if (id === CLEAR_LOG_MENU_ID) {
    await runWithErrorReporting(() => clearCaptureLog());
    return;
  }

  // Fallthrough: a click on a menu item we don't recognize.
  // Shouldn't happen in the current menu, but if a future
  // contextMenus.create call adds an id without a matching branch
  // above, this warning makes the drop visible in the SW console
  // instead of silently doing nothing.
  console.warn('[SeeWhatISee] unhandled context menu id:', id);
});

// Expose capture functions on the service worker global so they can be
// invoked from:
//   - Playwright tests via `serviceWorker.evaluate(() => self.SeeWhatISee.captureVisible())`
//   - the service worker devtools console for manual debugging
//
// Each future menu variation (full page, element, etc.) should be added here
// as a new entry so it stays callable from tests without additional plumbing.
(self as unknown as { SeeWhatISee: Record<string, unknown> }).SeeWhatISee = {
  captureVisible,
  savePageContents,
  captureBothToMemory,
  saveDetailedCapture,
  startCaptureWithDetails,
  clearCaptureLog,
  reportCaptureError,
  clearCaptureError,
  runWithErrorReporting,
  handleActionClick,
  getDefaultClickActionId,
  setDefaultClickActionId,
  refreshActionTooltip,
};
