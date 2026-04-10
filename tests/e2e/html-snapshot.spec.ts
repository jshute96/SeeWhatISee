import { test, expect } from '../fixtures/extension';
import { verifyHtmlCapture, type CaptureResult } from '../fixtures/files';

// Filename format: contents-YYYYMMDD-HHMMSS-mmm.html
const FILENAME_PATTERN = /^contents-\d{8}-\d{6}-\d{3}\.html$/;

test('savePageContents captures HTML and writes sidecar files', async ({
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
  expect(result.sidecarDownloadIds.latest).toBeGreaterThan(0);
  expect(result.sidecarDownloadIds.log).toBeGreaterThan(0);

  // The saved HTML should contain the fixture page's background color
  // and title, proving we captured the right page.
  await verifyHtmlCapture(sw, result, 'background: #800080', []);

  await page.close();
});
