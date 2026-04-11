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
// Matches the manifest's `action.default_title` — kept in sync
// manually because we need to restore exactly this string as the
// tooltip after a successful capture clears the error state.
const DEFAULT_ACTION_TITLE = 'SeeWhatISee — capture visible tab';

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
    // Second line shows the error. Chrome's toolbar tooltip honors
    // embedded newlines on macOS / Windows / most Linux DEs.
    await chrome.action.setTitle({
      title: `${DEFAULT_ACTION_TITLE}\nLast error: ${message}`,
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
    await chrome.action.setTitle({ title: DEFAULT_ACTION_TITLE });
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

// Toolbar icon click → capture the visible tab.
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
chrome.action.onClicked.addListener(async () => {
  // runWithErrorReporting downgrades rejection to console.warn +
  // user-visible icon swap + tooltip "Last error:" line, so
  // user-actionable failures like "No active tab found to capture"
  // don't get promoted onto the chrome://extensions Errors page.
  await runWithErrorReporting(() => captureVisible());
});

// Right-click context menu on the toolbar action. Created on
// install/update; Chrome persists the entries across service worker
// restarts so we don't need to recreate them on every wakeup.
//
// Note that the "Take screenshot" entry is functionally identical to a
// plain left-click — listed in the menu for discoverability so users
// don't have to know that left-click also captures. The delay (if any)
// is handled by captureVisible itself; this file just maps menu items
// to delayMs values.
interface MenuItem {
  id: string;
  /** 'separator' for a horizontal divider, 'normal' (default) for a clickable entry. */
  type?: 'normal' | 'separator';
  /** Label shown in the menu. Required for normal items, ignored for separators. */
  title?: string;
  /** For screenshot items: delay before capture. Absent for non-screenshot actions. */
  delayMs?: number;
  /** Handler for non-screenshot items. If absent, the item is a screenshot capture. */
  action?: () => Promise<unknown>;
}

// Note: chrome.contextMenus entries have no per-item tooltip field —
// the `title` is the only user-visible text. The intended tooltip for
// "Clear Chrome history" ("Erase capture log from Chrome storage") is
// preserved here as documentation of intent so the title can stay
// short in the menu.
const MENU_ITEMS: MenuItem[] = [
  { id: 'capture-now', title: 'Take screenshot', delayMs: 0 },
  { id: 'capture-delayed-2s', title: 'Take screenshot in 2s', delayMs: 2000 },
  { id: 'capture-delayed-5s', title: 'Take screenshot in 5s', delayMs: 5000 },
  { id: 'save-page-contents', title: 'Save html contents', action: () => savePageContents() },
  { id: 'capture-with-details', title: 'Capture with details...', action: () => startCaptureWithDetails() },
  { id: 'sep-clear', type: 'separator' },
  { id: 'clear-log', title: 'Clear Chrome history', action: () => clearCaptureLog() },
];

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

chrome.runtime.onInstalled.addListener(() => {
  // removeAll first because onInstalled fires on `install`, `update`,
  // and `chrome_update`. On the update paths the previously-created
  // menu entries are still in Chrome's persisted extension state, and
  // calling `create` with the same id would throw "Cannot create item
  // with duplicate id". `removeAll` is a clean wipe that handles all
  // three cases identically.
  chrome.contextMenus.removeAll(() => {
    for (const item of MENU_ITEMS) {
      // `title` is required by the contextMenus API for normal items
      // but must be omitted for separators. Build the properties
      // object conditionally rather than passing `title: undefined`.
      const props: chrome.contextMenus.CreateProperties = {
        id: item.id,
        type: item.type ?? 'normal',
        contexts: ['action'],
      };
      if (item.title !== undefined) props.title = item.title;
      chrome.contextMenus.create(props);
    }
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  const item = MENU_ITEMS.find((m) => m.id === info.menuItemId);
  if (!item) return;
  // Every user-initiated menu entry flows through runWithErrorReporting
  // for uniform error surfacing. For the "Clear Chrome history" entry
  // that's arguably a category error — it isn't a capture — but in
  // practice the same feedback channels (error icon + tooltip) still
  // make sense for telling the user it failed, and on success clearing
  // the error state is harmless.
  await runWithErrorReporting(() => {
    if (item.action) return item.action();
    return captureVisible(item.delayMs ?? 0);
  });
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
};
