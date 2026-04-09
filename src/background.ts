import { captureVisible } from './capture.js';

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
    console.error('[SeeWhatISee] capture failed:', err);
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
const MENU_ITEMS: { id: string; title: string; delayMs: number }[] = [
  { id: 'capture-now', title: 'Take screenshot', delayMs: 0 },
  { id: 'capture-delayed-2s', title: 'Take screenshot in 2s', delayMs: 2000 },
  { id: 'capture-delayed-5s', title: 'Take screenshot in 5s', delayMs: 5000 },
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
      chrome.contextMenus.create({
        id: item.id,
        title: item.title,
        contexts: ['action'],
      });
    }
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  const item = MENU_ITEMS.find((m) => m.id === info.menuItemId);
  if (!item) return;
  try {
    await captureVisible(item.delayMs);
  } catch (err) {
    console.error('[SeeWhatISee] context menu capture failed:', err);
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
};
