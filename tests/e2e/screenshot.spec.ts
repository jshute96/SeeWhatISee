import { test, expect } from '../fixtures/extension';

// Filename format: screenshot-YYYYMMDD-HHMMSS-mmm.png — bare basename,
// no subdir prefix (the sidecar JSON resolves it against its own
// directory). Compact local-time stamp with millisecond precision; see
// compactTimestamp in src/capture.ts.
const FILENAME_PATTERN = /^screenshot-\d{8}-\d{6}-\d{3}\.png$/;

test('captures the visible tab via the service worker', async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.goto('https://example.com');
  // Make sure the page is the active tab so captureVisibleTab grabs it.
  await page.bringToFront();

  const result = await serviceWorker.evaluate(async () => {
    // CaptureResult is redeclared inline (rather than imported from
    // src/capture.ts) because Playwright serializes this function body
    // and runs it inside the service worker realm, where module imports
    // from the test source tree aren't available.
    type CaptureResult = {
      downloadId: number;
      filename: string;
      timestamp: string;
      url: string;
    };
    // `SeeWhatISee` is attached to `self` in src/background.ts.
    const api = (self as unknown as {
      SeeWhatISee: { captureVisible: () => Promise<CaptureResult> };
    }).SeeWhatISee;
    return api.captureVisible();
  });

  expect(result.downloadId).toBeGreaterThan(0);
  expect(result.filename).toMatch(FILENAME_PATTERN);
  expect(result.url).toBe('https://example.com/');
  // ISO 8601 with milliseconds and trailing Z.
  expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
