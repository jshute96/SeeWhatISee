// Tests for the file-access requirement: the service-worker gate in
// `runWithErrorReporting` (`background/error-reporting.ts`) and the
// dialog every extension page opens when the toggle is off
// (`capture/file-access-dialog.ts`).
//
// The toggle itself can't be flipped from a test (it lives in
// `chrome://extensions`, and changing it reloads the extension), and
// the harness runs with it on. So `isAllowedFileSchemeAccess` is
// overridden — inside one `sw.evaluate` for the worker, via an init
// script for the pages — the same seam `history-page.spec.ts` uses.

import { type Page } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { openDetailsFlow } from './details-helpers';
import { resetCaptureState, seedCaptureLog } from '../fixtures/files';

interface GateApi {
  runWithErrorReporting: (fn: () => Promise<unknown>) => Promise<void>;
}

async function blockFileAccess(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(chrome.extension, 'isAllowedFileSchemeAccess', {
      configurable: true,
      value: async () => false,
    });
  });
}

test('runWithErrorReporting refuses to run the action with file access off', async ({
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  // Override, spy on `tabs.create`, run, and read back in a single
  // evaluate so a worker restart can't lose the state in between.
  const result = await sw.evaluate(async () => {
    const ext = chrome.extension as { isAllowedFileSchemeAccess: () => Promise<boolean> };
    const origAllowed = ext.isAllowedFileSchemeAccess;
    const origCreate = chrome.tabs.create.bind(chrome.tabs);
    const created: chrome.tabs.CreateProperties[] = [];
    Object.defineProperty(chrome.extension, 'isAllowedFileSchemeAccess', {
      configurable: true,
      value: async () => false,
    });
    (chrome.tabs as { create: typeof chrome.tabs.create }).create = (async (
      props: chrome.tabs.CreateProperties,
    ) => {
      created.push(props);
      return { id: 999, index: 0 } as chrome.tabs.Tab;
    }) as typeof chrome.tabs.create;
    let ran = false;
    try {
      const api = (self as unknown as { SeeWhatISee: GateApi }).SeeWhatISee;
      await api.runWithErrorReporting(async () => {
        ran = true;
      });
      const url = created[0]?.url ?? '';
      const params = new URLSearchParams(url.split('?')[1] ?? '');
      return { ran, tabs: created.length, error: params.get('error') ?? '' };
    } finally {
      Object.defineProperty(chrome.extension, 'isAllowedFileSchemeAccess', {
        configurable: true,
        value: origAllowed,
      });
      (chrome.tabs as { create: typeof chrome.tabs.create }).create = origCreate;
    }
  });
  // The action never starts: nothing is captured or written on a
  // profile that can't read its own log.
  expect(result.ran).toBe(false);
  expect(result.tabs).toBe(1);
  expect(result.error).toContain('Allow access to file URLs');
});

test('the error page shows the file-access dialog when the toggle is off', async ({
  extensionContext,
  extensionId,
}) => {
  const page = await extensionContext.newPage();
  await blockFileAccess(page);
  await page.goto(
    `chrome-extension://${extensionId}/capture.html?error=${encodeURIComponent('x')}`,
  );
  const dialog = page.locator('#file-access-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Allow access to file URLs');
  // The settings link carries the real toggle location for hover /
  // copy-link, even though the click itself goes through tabs.create.
  await expect(dialog.locator('#file-access-settings')).toHaveAttribute(
    'href',
    `chrome://extensions/?id=${extensionId}`,
  );
  // Esc doesn't dismiss it: there is nothing usable behind it.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
});

test('the Capture page suspends its Alt shortcuts behind the dialog', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // A live page with the toggle off is only reachable if the toggle
  // flips after the gate let the page open, but the shortcut handler
  // guards on any open modal, so Alt+C can't start a save from behind
  // a dialog that says nothing works.
  const { capturePage } = await openDetailsFlow(extensionContext, fixtureServer, getServiceWorker);
  // The override has to be in place before the page script runs, so
  // it's installed as an init script and the live page reloaded (the
  // per-tab session survives a reload).
  await blockFileAccess(capturePage);
  await capturePage.reload();
  await expect(capturePage.locator('#file-access-dialog')).toBeVisible();
  const saveHtml = capturePage.locator('#cap-html');
  const before = await saveHtml.isChecked();
  await capturePage.keyboard.press('Alt+h');
  expect(await saveHtml.isChecked()).toBe(before);
  await capturePage.close();
});

test('the History page shows the file-access dialog and loads nothing', async ({
  extensionContext,
  extensionId,
  getServiceWorker,
}) => {
  // Reachable without the service worker's gate — the Options page's
  // History button opens the page directly — so the page has to
  // enforce the toggle itself.
  const sw = await getServiceWorker();
  await seedCaptureLog(sw, [
    { timestamp: '2026-01-02T03:04:05.000Z', url: 'https://example.com/a', title: 'A' },
  ]);
  const page = await extensionContext.newPage();
  await blockFileAccess(page);
  await page.goto(`chrome-extension://${extensionId}/history.html`);
  await expect(page.locator('#file-access-dialog')).toBeVisible();
  // No degraded table behind the dialog: the seeded record is not
  // rendered and the count line stays empty.
  await expect(page.locator('#rows tr')).toHaveCount(0);
  await expect(page.locator('#count')).toBeEmpty();
  await resetCaptureState(sw);
});

test('no dialog with the toggle on', async ({ extensionContext, extensionId }) => {
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/history.html`);
  await expect(page.locator('#rows')).toBeAttached();
  await expect(page.locator('#file-access-dialog')).toHaveCount(0);
});
