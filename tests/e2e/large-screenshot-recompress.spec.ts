import fs from 'node:fs';
import { test, expect } from '../fixtures/extension';
import { waitForCaptureQuota } from '../fixtures/capture-quota';
import { waitForDownloadPath, type CaptureResult } from '../fixtures/files';

// Capture-time recompress: when captureVisibleTab returns a PNG
// larger than the threshold, we re-encode as JPEG and use the JPEG
// if it's ≥10% smaller. Production threshold is 2 MiB, which is
// painful to reach with a fixture page — so these tests drop it via
// the `_setLargeScreenshotThresholdForTest` seam exposed on
// `self.SeeWhatISee`.

const JPG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

type RecompressApi = {
  captureVisible: () => Promise<CaptureResult>;
  _setLargeScreenshotThresholdForTest: (bytes: number | null) => void;
};

test.describe('capture-time PNG → JPEG recompress', () => {
  test.afterEach(async ({ getServiceWorker }) => {
    // Always restore the production default so a leaked low
    // threshold can't bleed into later tests in the same worker.
    const sw = await getServiceWorker();
    await sw.evaluate(() => {
      const api = (self as unknown as { SeeWhatISee: RecompressApi }).SeeWhatISee;
      api._setLargeScreenshotThresholdForTest(null);
    });
  });

  test('gradient page over threshold → JPEG wins, file saved as .jpg', async ({
    extensionContext,
    fixtureServer,
    getServiceWorker,
  }) => {
    const sw0 = await getServiceWorker();
    await sw0.evaluate(() => chrome.storage.local.clear());

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gradient.html`);
    await page.bringToFront();

    const sw = await getServiceWorker();
    await waitForCaptureQuota(sw);
    // 1 KiB threshold — any real screenshot blows past this, so the
    // recompress path runs every time. A smooth gradient is exactly
    // the case JPEG crushes PNG on, so the savings floor is also met.
    const result = await sw.evaluate(async () => {
      const api = (self as unknown as { SeeWhatISee: RecompressApi }).SeeWhatISee;
      api._setLargeScreenshotThresholdForTest(1024);
      return api.captureVisible();
    });

    expect(result.filename).toMatch(/\.jpg$/);
    expect(result.screenshot?.filename).toMatch(/\.jpg$/);

    const filePath = await waitForDownloadPath(sw, result.downloadId);
    const bytes = fs.readFileSync(filePath);
    expect(bytes.subarray(0, 3).equals(JPG_SIGNATURE)).toBe(true);

    await page.close();
  });

  test('solid-color page over threshold → JPEG not smaller, keeps .png', async ({
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
    await waitForCaptureQuota(sw);
    // Force the recompress to run, but a solid-color PNG is already
    // near the theoretical minimum (RLE-style runs compress to a few
    // hundred bytes) while the JPEG of the same image carries the
    // standard DCT-header overhead — so the JPEG won't beat the PNG
    // by the required 10% and we should keep the PNG.
    const result = await sw.evaluate(async () => {
      const api = (self as unknown as { SeeWhatISee: RecompressApi }).SeeWhatISee;
      api._setLargeScreenshotThresholdForTest(1);
      return api.captureVisible();
    });

    expect(result.filename).toMatch(/\.png$/);
    expect(result.screenshot?.filename).toMatch(/\.png$/);

    const filePath = await waitForDownloadPath(sw, result.downloadId);
    const bytes = fs.readFileSync(filePath);
    expect(bytes.subarray(0, 4).equals(PNG_SIGNATURE)).toBe(true);

    await page.close();
  });

  test('small capture under threshold → recompress skipped, .png kept', async ({
    extensionContext,
    fixtureServer,
    getServiceWorker,
  }) => {
    const sw0 = await getServiceWorker();
    await sw0.evaluate(() => chrome.storage.local.clear());

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/gradient.html`);
    await page.bringToFront();

    const sw = await getServiceWorker();
    await waitForCaptureQuota(sw);
    // Threshold higher than any test-viewport PNG → short-circuit
    // before the JPEG encode even happens. Gradient page is the
    // worst case for "PNG stays PNG" (JPEG would win on this image)
    // — passing here proves the threshold is honored.
    const result = await sw.evaluate(async () => {
      const api = (self as unknown as { SeeWhatISee: RecompressApi }).SeeWhatISee;
      api._setLargeScreenshotThresholdForTest(50 * 1024 * 1024);
      return api.captureVisible();
    });

    expect(result.filename).toMatch(/\.png$/);

    const filePath = await waitForDownloadPath(sw, result.downloadId);
    const bytes = fs.readFileSync(filePath);
    expect(bytes.subarray(0, 4).equals(PNG_SIGNATURE)).toBe(true);

    await page.close();
  });
});
