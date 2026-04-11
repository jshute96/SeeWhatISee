import { captureVisible, clearCaptureLog, savePageContents } from './capture.js';

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
  try {
    await captureVisible();
  } catch (err) {
    // console.warn (rather than console.error) so user-actionable
    // failures like "No active tab found to capture" don't get
    // promoted onto the chrome://extensions Errors page. They're
    // still visible in the SW devtools console for debugging.
    console.warn('[SeeWhatISee] capture failed:', err);
  }
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
  { id: 'sep-clear', type: 'separator' },
  { id: 'clear-log', title: 'Clear Chrome history', action: () => clearCaptureLog() },
];

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
  try {
    if (item.action) {
      await item.action();
    } else {
      await captureVisible(item.delayMs ?? 0);
    }
  } catch (err) {
    // See action.onClicked above for why this is warn, not error.
    console.warn('[SeeWhatISee] context menu action failed:', err);
  }
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
  clearCaptureLog,
};
