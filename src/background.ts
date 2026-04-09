import { captureVisible } from './capture.js';

// Toolbar icon click → capture the visible tab.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await captureVisible(tab.windowId);
  } catch (err) {
    console.error('[SeeWhatISee] capture failed:', err);
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
