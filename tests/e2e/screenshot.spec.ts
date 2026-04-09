import { test, expect } from '../fixtures/extension';

// Filename format: screenshot-YYYYMMDD-HHMMSS-mmm.png — bare basename,
// no subdir prefix (the sidecar JSON resolves it against its own
// directory). Compact local-time stamp with millisecond precision; see
// compactTimestamp in src/capture.ts.
const FILENAME_PATTERN = /^screenshot-\d{8}-\d{6}-\d{3}\.png$/;

test('captures the visible tab via the service worker', async ({ extensionContext, getServiceWorker }) => {
  const page = await extensionContext.newPage();
  await page.goto('https://example.com');
  // Make sure the page is the active tab so captureVisibleTab grabs it.
  await page.bringToFront();

  const sw = await getServiceWorker();
  const result = await sw.evaluate(async () => {
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

  await page.close();
});

test('captureVisible(delayMs) sleeps before capturing', async ({ extensionContext, getServiceWorker }) => {
  const page = await extensionContext.newPage();
  await page.goto('https://example.com');
  await page.bringToFront();

  const sw = await getServiceWorker();
  const elapsedMs = await sw.evaluate(async () => {
    // See note above about why CaptureResult is redeclared inline.
    type CaptureResult = {
      downloadId: number;
      filename: string;
      timestamp: string;
      url: string;
    };
    const api = (self as unknown as {
      SeeWhatISee: {
        captureVisible: (delayMs?: number) => Promise<CaptureResult>;
      };
    }).SeeWhatISee;
    const start = performance.now();
    await api.captureVisible(200);
    return performance.now() - start;
  });

  // Lower bound: just under 200ms to absorb timer/clock granularity. The
  // delay must actually fire — a missing `await` on the setTimeout would
  // make this near-zero. Upper bound is generous so the test isn't flaky
  // on slow CI; we only care that we didn't accidentally sleep for
  // multiple seconds.
  expect(elapsedMs).toBeGreaterThanOrEqual(190);
  expect(elapsedMs).toBeLessThan(500);

  await page.close();
});

test('delayed capture records the new URL after a same-tab navigation', async ({
  extensionContext,
  getServiceWorker,
}) => {
  // Start on example.com, kick off a delayed capture, navigate the
  // same tab to example.org during the delay (driven from the test
  // side via page.goto, which awaits navigation completion), then
  // wait for the capture and verify the recorded URL is example.org.
  //
  // Driving the navigation from the test side rather than from inside
  // the SW means we get reliable "navigation has committed" semantics
  // for free — chrome.tabs.update resolves before commit, which makes
  // an SW-side navigation racy.
  const page = await extensionContext.newPage();
  await page.goto('https://example.com');
  await page.bringToFront();

  const sw = await getServiceWorker();
  // Don't await — the SW is now sleeping inside captureVisible(2000).
  const capturePromise = sw.evaluate(async () => {
    type CaptureResult = {
      downloadId: number;
      filename: string;
      timestamp: string;
      url: string;
    };
    const api = (self as unknown as {
      SeeWhatISee: { captureVisible: (delayMs?: number) => Promise<CaptureResult> };
    }).SeeWhatISee;
    return api.captureVisible(2000);
  });

  // Brief wait so the SW is definitely inside its setTimeout, then
  // navigate the same tab. page.goto returns once the navigation has
  // committed, so the new URL is observable to chrome.tabs.query
  // before we await the capture.
  await page.waitForTimeout(100);
  await page.goto('https://example.org');

  const result = await capturePromise;
  expect(result.url).toBe('https://example.org/');
  expect(result.filename).toMatch(FILENAME_PATTERN);

  await page.close();
});

test('delayed capture records the new tab URL after a tab switch', async ({
  extensionContext,
  getServiceWorker,
}) => {
  // Two tabs, switch active tab during the delay. Whole sequence
  // runs inside one serviceWorker.evaluate.
  const pageA = await extensionContext.newPage();
  await pageA.goto('https://example.com');
  const pageB = await extensionContext.newPage();
  await pageB.goto('https://example.org');

  const sw = await getServiceWorker();
  const result = await sw.evaluate(async () => {
    type CaptureResult = {
      downloadId: number;
      filename: string;
      timestamp: string;
      url: string;
    };
    const api = (self as unknown as {
      SeeWhatISee: { captureVisible: (delayMs?: number) => Promise<CaptureResult> };
    }).SeeWhatISee;

    const [tabA] = await chrome.tabs.query({ url: 'https://example.com/' });
    const [tabB] = await chrome.tabs.query({ url: 'https://example.org/' });
    if (tabA?.id == null || tabB?.id == null) {
      throw new Error('expected example.com and example.org tabs');
    }
    await chrome.tabs.update(tabA.id, { active: true });

    const capturePromise = api.captureVisible(800);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await chrome.tabs.update(tabB.id, { active: true });
    return capturePromise;
  });

  expect(result.url).toBe('https://example.org/');
  expect(result.filename).toMatch(FILENAME_PATTERN);

  await pageA.close();
  await pageB.close();
});

