import { test, expect } from '../fixtures/extension';
import { verifyCapture, type CaptureResult } from '../fixtures/files';

// Filename format: screenshot-YYYYMMDD-HHMMSS-mmm.png — bare basename,
// no subdir prefix (the sidecar JSON resolves it against its own
// directory). Compact local-time stamp with millisecond precision; see
// compactTimestamp in src/capture.ts.
const FILENAME_PATTERN = /^screenshot-\d{8}-\d{6}-\d{3}\.png$/;

// Solid colors used by the fixture pages, paired with their RGB so the
// pixel-sampling helper can assert the captured PNG actually shows the
// page we think it shows. Keep these in sync with tests/fixtures/pages/.
const PURPLE: [number, number, number] = [0x80, 0x00, 0x80];
const GREEN: [number, number, number] = [0x00, 0xc0, 0x00];
const ORANGE: [number, number, number] = [0xff, 0x88, 0x00];

// chrome.tabs.captureVisibleTab is rate-limited to ~2 calls/sec per
// window (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND). Tests in this
// file each issue 1–2 captures and run back-to-back in the same
// persistent context, so without a small cushion at the start of each
// test we can blow the quota when one test's last capture lands close
// in time to the next test's first one. Sleeping unconditionally
// before every test costs ~600ms per test but keeps the suite
// order-independent and non-flaky.
test.beforeEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 600));
});

test('captures the visible tab and writes png + sidecar files', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Start from a clean capture log so the line-count assertions on
  // log.json are deterministic — chrome.storage.local persists across
  // tests in the same worker, and writeJsonFile re-renders the log
  // from storage on every capture, so leftover entries from earlier
  // tests would inflate the count.
  const sw0 = await getServiceWorker();
  await sw0.evaluate(() => chrome.storage.local.clear());

  const page = await extensionContext.newPage();
  await page.goto(`${fixtureServer.baseUrl}/purple.html`);
  // Make sure the page is the active tab so captureVisibleTab grabs it.
  await page.bringToFront();

  // ---- Capture #1 (purple) ----------------------------------------------
  const sw1 = await getServiceWorker();
  const result1 = await sw1.evaluate(async () => {
    const api = (self as unknown as {
      SeeWhatISee: { captureVisible: () => Promise<CaptureResult> };
    }).SeeWhatISee;
    return api.captureVisible();
  });

  expect(result1.downloadId).toBeGreaterThan(0);
  expect(result1.filename).toMatch(FILENAME_PATTERN);
  expect(result1.url).toBe(`${fixtureServer.baseUrl}/purple.html`);
  // ISO 8601 with milliseconds and trailing Z.
  expect(result1.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(result1.sidecarDownloadIds.latest).toBeGreaterThan(0);
  expect(result1.sidecarDownloadIds.log).toBeGreaterThan(0);

  // Single helper covers: PNG exists, PNG pixel color matches PURPLE,
  // latest.json equals the record, log.json's last line equals the
  // record (and ends with a trailing newline). Passing `[]` as the
  // baseline turns on the delta check, which here implies length 1.
  // Returns the parsed log.json records so we can pass them to the
  // next call as the baseline for the next delta check.
  const log1Records = await verifyCapture(sw1, result1, PURPLE, []);

  // ---- Capture #2 (orange) ----------------------------------------------
  // Navigate to a different color so we can confirm the second PNG is
  // actually the second page (not a stale read of the first).
  await page.goto(`${fixtureServer.baseUrl}/orange.html`);
  await page.bringToFront();
  // Stay under the captureVisibleTab quota (see beforeEach note).
  await page.waitForTimeout(600);

  const sw2 = await getServiceWorker();
  const result2 = await sw2.evaluate(async () => {
    const api = (self as unknown as {
      SeeWhatISee: { captureVisible: () => Promise<CaptureResult> };
    }).SeeWhatISee;
    return api.captureVisible();
  });

  expect(result2.url).toBe(`${fixtureServer.baseUrl}/orange.html`);
  expect(result2.filename).not.toBe(result1.filename);

  // Same helper, second call. Passing log1Records turns on the delta
  // check: log.json must now be exactly one line longer, the
  // previously-written lines byte-identical, and the new last line
  // equals result2's record.
  await verifyCapture(sw2, result2, ORANGE, log1Records);

  await page.close();
});

test('captureVisible(delayMs) sleeps before capturing', async ({
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
        captureVisible: (delayMs?: number) => Promise<CaptureResult>;
      };
    }).SeeWhatISee;
    const start = performance.now();
    const result = await api.captureVisible(200);
    return { elapsedMs: performance.now() - start, result };
  });

  // Lower bound: just under 200ms to absorb timer/clock granularity. The
  // delay must actually fire — a missing `await` on the setTimeout would
  // make this near-zero. Upper bound is generous so the test isn't flaky
  // on slow CI; we only care that we didn't accidentally sleep for
  // multiple seconds.
  expect(elapsedMs).toBeGreaterThanOrEqual(190);
  expect(elapsedMs).toBeLessThan(500);

  // No prevLogRecords arg → skip the delta/length check (chrome.storage
  // is dirty from earlier tests in this worker, so we don't know the
  // baseline). All other on-disk + pixel checks still run.
  await verifyCapture(sw, result, GREEN);

  await page.close();
});

test('delayed capture records the new URL after a same-tab navigation', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Start on green, kick off a delayed capture, navigate the same tab
  // to orange during the delay (driven from the test side via
  // page.goto, which awaits navigation completion), then wait for the
  // capture and verify the recorded URL *and* the captured pixels are
  // the orange page. The pixel check is what makes this test bite —
  // it would catch a regression where the URL is updated but the
  // captured frame is the pre-navigation page.
  //
  // Driving the navigation from the test side rather than from inside
  // the SW means we get reliable "navigation has committed" semantics
  // for free — chrome.tabs.update resolves before commit, which makes
  // an SW-side navigation racy.
  const page = await extensionContext.newPage();
  await page.goto(`${fixtureServer.baseUrl}/green.html`);
  await page.bringToFront();

  const sw = await getServiceWorker();
  // Don't await — the SW is now sleeping inside captureVisible(2000).
  const capturePromise = sw.evaluate(async () => {
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
  await page.goto(`${fixtureServer.baseUrl}/orange.html`);

  const result = await capturePromise;
  expect(result.url).toBe(`${fixtureServer.baseUrl}/orange.html`);
  expect(result.filename).toMatch(FILENAME_PATTERN);

  await verifyCapture(sw, result, ORANGE);

  await page.close();
});

test('delayed capture records the new tab URL after a tab switch', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Two tabs, switch active tab during the delay. Whole sequence
  // runs inside one serviceWorker.evaluate.
  const pageA = await extensionContext.newPage();
  await pageA.goto(`${fixtureServer.baseUrl}/green.html`);
  const pageB = await extensionContext.newPage();
  await pageB.goto(`${fixtureServer.baseUrl}/orange.html`);

  const sw = await getServiceWorker();
  const greenUrl = `${fixtureServer.baseUrl}/green.html`;
  const orangeUrl = `${fixtureServer.baseUrl}/orange.html`;
  const result = await sw.evaluate(
    async ({ greenUrl, orangeUrl }) => {
      const api = (self as unknown as {
        SeeWhatISee: { captureVisible: (delayMs?: number) => Promise<CaptureResult> };
      }).SeeWhatISee;

      const [tabA] = await chrome.tabs.query({ url: greenUrl });
      const [tabB] = await chrome.tabs.query({ url: orangeUrl });
      if (tabA?.id == null || tabB?.id == null) {
        throw new Error('expected green and orange tabs');
      }
      await chrome.tabs.update(tabA.id, { active: true });

      const capturePromise = api.captureVisible(800);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await chrome.tabs.update(tabB.id, { active: true });
      return capturePromise;
    },
    { greenUrl, orangeUrl },
  );

  expect(result.url).toBe(orangeUrl);
  expect(result.filename).toMatch(FILENAME_PATTERN);

  await verifyCapture(sw, result, ORANGE);

  await pageA.close();
  await pageB.close();
});
