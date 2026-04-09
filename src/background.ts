import { captureVisible } from './capture.js';

// Toolbar icon click → capture the visible tab.
//
// The click counts as a user gesture, which is what makes the `activeTab`
// permission (declared in manifest.json) kick in for the current tab —
// including restricted URLs like chrome:// pages, where `<all_urls>` host
// permission alone is not enough. Don't drop `activeTab` from the manifest
// without testing on chrome://extensions or you'll silently re-break this.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    // Pass the tab through so captureVisible has the URL for the metadata
    // record without re-querying.
    await captureVisible(tab);
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
