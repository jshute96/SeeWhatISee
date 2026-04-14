import { test, expect } from '../fixtures/extension';
import { verifyHtmlCapture, type CaptureResult } from '../fixtures/files';

// Filename format: contents-YYYYMMDD-HHMMSS-mmm.html
const FILENAME_PATTERN = /^contents-\d{8}-\d{6}-\d{3}\.html$/;

test('savePageContents captures HTML and writes sidecar file', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw0 = await getServiceWorker();
  await sw0.evaluate(() => chrome.storage.local.clear());

  const page = await extensionContext.newPage();
  await page.goto(`${fixtureServer.baseUrl}/purple.html`);
  await page.bringToFront();

  const sw = await getServiceWorker();
  const result = await sw.evaluate(async () => {
    const api = (self as unknown as {
      SeeWhatISee: { savePageContents: () => Promise<CaptureResult> };
    }).SeeWhatISee;
    return api.savePageContents();
  });

  expect(result.downloadId).toBeGreaterThan(0);
  expect(result.filename).toMatch(FILENAME_PATTERN);
  expect(result.url).toBe(`${fixtureServer.baseUrl}/purple.html`);
  expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(result.sidecarDownloadIds.log).toBeGreaterThan(0);

  // The saved HTML should contain the fixture page's background color
  // and title, proving we captured the right page.
  await verifyHtmlCapture(sw, result, 'background: #800080', []);

  await page.close();
});

test('savePageContents(delayMs) sleeps before scraping', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const page = await extensionContext.newPage();
  await page.goto(`${fixtureServer.baseUrl}/green.html`);
  await page.bringToFront();

  const sw = await getServiceWorker();
  const { elapsedMs, result } = await sw.evaluate(async () => {
    const api = (self as unknown as {
      SeeWhatISee: {
        savePageContents: (delayMs?: number) => Promise<CaptureResult>;
      };
    }).SeeWhatISee;
    const start = performance.now();
    const result = await api.savePageContents(200);
    return { elapsedMs: performance.now() - start, result };
  });

  // Timer must actually fire before the scrape. A missing `await`
  // on the setTimeout would make this near-zero.
  expect(elapsedMs).toBeGreaterThanOrEqual(190);
  expect(elapsedMs).toBeLessThan(500);
  expect(result.filename).toMatch(FILENAME_PATTERN);
  expect(result.url).toBe(`${fixtureServer.baseUrl}/green.html`);

  // No baseline arg → skip the delta/length check (storage is
  // dirty from earlier tests in the worker). All other on-disk
  // checks still run.
  await verifyHtmlCapture(sw, result, 'background: #00c000');

  await page.close();
});
