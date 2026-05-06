// Pressed-state visual feedback on Capture-page Copy buttons.
//
// Background: clicking Copy kicks off an async SW round-trip
// (download → wait-for-complete → response) followed by a
// `navigator.clipboard.writeText`. A user who alt-tabs and pastes
// before the writeText lands sees the previous clipboard contents —
// reading like our Copy silently failed. The page holds `.pressed`
// on the clicked button for the entire async lifetime so the user
// is trained to wait for the button to pop back up.
//
// This spec asserts the class is added on click, persists for the
// duration of the async work, and is removed in `finally` even if
// the work throws.

import { test, expect } from '../fixtures/extension';
import { openDetailsFlow } from './details-helpers';

test.beforeEach(async () => {
  // captureVisibleTab is rate-limited (~2/s per window). Each test
  // here issues one capture; small cushion avoids quota trips.
  await new Promise((r) => setTimeout(r, 600));
});

// Slow the page's `navigator.clipboard.writeText` so the .pressed
// observation window is wide enough to be non-flaky regardless of
// SW round-trip / download speed.
async function slowClipboardWrites(page: import('@playwright/test').Page, delayMs: number): Promise<void> {
  await page.evaluate((ms) => {
    const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async (text: string) => {
      await new Promise((r) => setTimeout(r, ms));
      return orig(text);
    };
  }, delayMs);
}

test('copy URL button: .pressed class is held during async write and removed after', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await slowClipboardWrites(capturePage, 400);

  const btn = capturePage.locator('#copy-url-btn');
  await expect(btn).not.toHaveClass(/pressed/);

  // Click-and-don't-await: the async writeText is delayed 400ms
  // above, so .pressed should be observable for that window.
  await btn.click();

  // Assert .pressed is on within the delay window. Playwright polls
  // fast, well inside 400 ms.
  await expect(btn).toHaveClass(/\bpressed\b/);

  // Once the delayed writeText resolves, the finally block removes
  // .pressed. Allow the full delay + a margin.
  await expect(btn).not.toHaveClass(/\bpressed\b/, { timeout: 1500 });

  await openerPage.close();
});

test('copy screenshot button: .pressed class is held during async SW round-trip + write', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await slowClipboardWrites(capturePage, 400);

  const btn = capturePage.locator('#copy-screenshot-name');
  await expect(btn).not.toHaveClass(/pressed/);
  await btn.click();
  await expect(btn).toHaveClass(/\bpressed\b/);
  await expect(btn).not.toHaveClass(/\bpressed\b/, { timeout: 3000 });

  await openerPage.close();
});

test('copy button: .pressed is removed even if the async work throws', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Force writeText to reject so the inner fn throws. The `finally`
  // in `withPressed` should still remove the class.
  await capturePage.evaluate(() => {
    navigator.clipboard.writeText = async () => {
      throw new Error('synthetic clipboard failure');
    };
  });

  const btn = capturePage.locator('#copy-url-btn');
  await btn.click();
  // The synthetic failure resolves quickly — class should clear
  // back to absent within the default poll window.
  await expect(btn).not.toHaveClass(/\bpressed\b/);

  await openerPage.close();
});
