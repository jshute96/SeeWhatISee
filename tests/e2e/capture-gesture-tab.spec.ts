// E2E coverage for gesture-tab targeting: a capture must land on the
// tab the user's gesture happened on, not on whatever
// `chrome.tabs.query({ lastFocusedWindow: true })` reports.
//
// The bug these guard against: with more than one window open, Chrome's
// last-focused bookkeeping can disagree with the window the toolbar
// click came from (it's driven by `windows.onFocusChanged`, which a
// window manager may not deliver when the user returns to Chrome across
// virtual desktops). The capture then silently targets the other
// window — wrong page captured, and the Capture page opens on a desktop
// the user isn't looking at. See `src/capture/target-tab.ts`.
//
// We don't need to reproduce Chrome's stale focus to test the fix: it's
// enough that `lastFocusedWindow` names a *different* window than the
// gesture's, which a second `chrome.windows.create` arranges directly.
//
// The first two tests run at delay 0, where the gesture tab always
// wins. The third covers the other half of the contract: a *delayed*
// capture must still follow focus to a window the user genuinely
// switches to during the countdown.

import { test, expect } from '../fixtures/extension';
import { resetCaptureState } from '../fixtures/files';

// The SW surface these tests drive. Every `sw.evaluate` body has to
// reach it inline — Playwright ships the function source across, so a
// Node-side accessor helper wouldn't exist on the worker.
interface GestureApi {
  setDefaultWithoutSelectionId: (id: string) => Promise<void>;
  handleActionClick: (tab?: chrome.tabs.Tab) => Promise<void>;
}

type SwGlobal = { SeeWhatISee: GestureApi };

/**
 * Open `url` in a second window and leave it as the last-focused one,
 * so the active-tab query resolves there rather than to the gesture's
 * window. Returns both window ids plus the gesture tab's id, and
 * asserts up front that the two really do disagree — otherwise the
 * test would pass without exercising anything.
 */
async function splitFocus(
  sw: import('@playwright/test').Worker,
  otherUrl: string,
): Promise<{ gestureTabId: number; gestureWindowId: number; otherWindowId: number }> {
  const ids = await sw.evaluate(async (url) => {
    const [gesture] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const other = await chrome.windows.create({ url, focused: true });
    // Poll rather than sleep a fixed amount: the new window's tab has
    // to finish committing before the query below sees it as the
    // last-focused window's active tab, and how long that takes
    // depends on how loaded the machine is.
    let nowActive: chrome.tabs.Tab | undefined;
    for (let i = 0; i < 100; i++) {
      [nowActive] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (nowActive?.windowId === other.id) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return {
      gestureTabId: gesture!.id!,
      gestureWindowId: gesture!.windowId,
      otherWindowId: other.id!,
      queriedWindowId: nowActive?.windowId,
    };
  }, otherUrl);

  // Precondition: the naive query now points at the *other* window.
  expect(ids.queriedWindowId).toBe(ids.otherWindowId);
  expect(ids.gestureWindowId).not.toBe(ids.otherWindowId);
  return ids;
}

async function closeWindow(
  sw: import('@playwright/test').Worker,
  windowId: number,
): Promise<void> {
  await sw.evaluate(async (id) => {
    try {
      await chrome.windows.remove(id);
    } catch {
      // Already gone — nothing to clean up.
    }
  }, windowId);
}

test('toolbar click records the gesture tab\'s URL, not the last-focused window\'s', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  await resetCaptureState(sw);
  await sw.evaluate(() =>
    (self as unknown as SwGlobal).SeeWhatISee.setDefaultWithoutSelectionId('save-url'),
  );

  const openerPage = await extensionContext.newPage();
  await openerPage.goto(`${fixtureServer.baseUrl}/purple.html`);
  await openerPage.bringToFront();

  const { gestureTabId, otherWindowId } = await splitFocus(
    sw,
    `${fixtureServer.baseUrl}/green.html`,
  );

  await sw.evaluate(async (tabId) => {
    await (self as unknown as SwGlobal).SeeWhatISee.handleActionClick(
      await chrome.tabs.get(tabId),
    );
  }, gestureTabId);

  const log = await sw.evaluate(async () => {
    const stored = await chrome.storage.local.get('captureLog');
    return (stored.captureLog ?? []) as { url?: string }[];
  });
  expect(log.length).toBeGreaterThan(0);
  expect(log[log.length - 1].url).toBe(`${fixtureServer.baseUrl}/purple.html`);

  await closeWindow(sw, otherWindowId);
  await openerPage.close();
});

test('Capture page opens in the gesture tab\'s window, not the last-focused one', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  await resetCaptureState(sw);
  await sw.evaluate(() =>
    (self as unknown as SwGlobal).SeeWhatISee.setDefaultWithoutSelectionId('capture'),
  );

  const openerPage = await extensionContext.newPage();
  await openerPage.goto(`${fixtureServer.baseUrl}/purple.html`);
  await openerPage.bringToFront();

  const { gestureTabId, gestureWindowId, otherWindowId } = await splitFocus(
    sw,
    `${fixtureServer.baseUrl}/green.html`,
  );

  const capturePagePromise = extensionContext.waitForEvent('page', {
    predicate: (p) => p.url().endsWith('/capture.html'),
    timeout: 10000,
  });

  await sw.evaluate(async (tabId) => {
    await (self as unknown as SwGlobal).SeeWhatISee.handleActionClick(
      await chrome.tabs.get(tabId),
    );
  }, gestureTabId);

  const capturePage = await capturePagePromise;
  await capturePage.waitForLoadState('domcontentloaded');

  // The new tab must be a sibling of the page the click came from.
  // We find it by `openerTabId` rather than by URL: extension pages
  // come back from `tabs.query` with no `url` (that field needs the
  // `tabs` permission, and `<all_urls>` doesn't cover
  // `chrome-extension://`).
  const placement = await sw.evaluate(async (openerId) => {
    const tabs = await chrome.tabs.query({});
    const opened = tabs.find((t) => t.openerTabId === openerId);
    return { windowId: opened?.windowId, found: opened !== undefined };
  }, gestureTabId);
  expect(placement.found).toBe(true);
  expect(placement.windowId).toBe(gestureWindowId);

  // ...and it must describe the page the click came from. The
  // screenshot itself may be unavailable (the gesture window isn't
  // the focused one here), which is exactly why this asserts on the
  // recorded source URL rather than on pixels.
  await expect(capturePage.locator('#captured-url-text')).toHaveText(
    `${fixtureServer.baseUrl}/purple.html`,
  );

  await capturePage.close();
  await closeWindow(sw, otherWindowId);
  await openerPage.close();
});

test('a delayed capture still follows focus to a window opened during the countdown', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  await resetCaptureState(sw);

  const openerPage = await extensionContext.newPage();
  await openerPage.goto(`${fixtureServer.baseUrl}/purple.html`);
  await openerPage.bringToFront();

  const gestureTabId = await sw.evaluate(async () => {
    const [gesture] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return gesture!.id!;
  });

  // Start the delayed capture and *don't* await it — the point is to
  // move focus while its countdown is still running. `save-url` is
  // enough here: we only care which page gets recorded, and it
  // tolerates a screenshot failure.
  const capturing = sw.evaluate(async (tabId) => {
    await (
      self as unknown as {
        SeeWhatISee: {
          captureUrlOnly: (delayMs: number, tab?: chrome.tabs.Tab) => Promise<void>;
        };
      }
    ).SeeWhatISee.captureUrlOnly(2000, await chrome.tabs.get(tabId));
  }, gestureTabId);

  const otherWindowId = await sw.evaluate(async (url) => {
    const other = await chrome.windows.create({ url, focused: true });
    return other.id!;
  }, `${fixtureServer.baseUrl}/green.html`);

  await capturing;

  // The countdown ended with the *new* window focused, so that's what
  // the capture should describe — following focus is what the delay
  // is for.
  const log = await sw.evaluate(async () => {
    const stored = await chrome.storage.local.get('captureLog');
    return (stored.captureLog ?? []) as { url?: string }[];
  });
  expect(log.length).toBeGreaterThan(0);
  expect(log[log.length - 1].url).toBe(`${fixtureServer.baseUrl}/green.html`);

  await closeWindow(sw, otherWindowId);
  await openerPage.close();
});
