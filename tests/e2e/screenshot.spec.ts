import { test, expect } from '../fixtures/extension';
import { waitForCaptureQuota } from '../fixtures/capture-quota';
import { verifyCapture, type CaptureResult, resetCaptureState } from '../fixtures/files';

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

test('captures the visible tab and writes png + sidecar file', async ({
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
  await resetCaptureState(sw0);

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
  expect(result1.sidecarDownloadIds.log).toBeGreaterThan(0);

  // Single helper covers: PNG exists, PNG pixel color matches PURPLE,
  // log.json's last line equals the record (and ends with a trailing
  // newline). Passing `[]` as the
  // baseline turns on the delta check, which here implies length 1.
  // Returns the parsed log.json records so we can pass them to the
  // next call as the baseline for the next delta check.
  const log1Records = await verifyCapture(sw1, result1, PURPLE, []);

  // ---- Capture #2 (orange) ----------------------------------------------
  // Navigate to a different color so we can confirm the second PNG is
  // actually the second page (not a stale read of the first).
  await page.goto(`${fixtureServer.baseUrl}/orange.html`);
  await page.bringToFront();
  // Stay under the captureVisibleTab quota — sleeps only the time
  // actually needed (typically 0 ms here, since the goto and
  // bringToFront have already eaten most of the 1 s window).
  const sw2 = await getServiceWorker();
  await waitForCaptureQuota(sw2);

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
  // multiple seconds. The cushion also has to absorb a possible
  // capture-quota backoff retry (~1 s in the worst case) since the
  // SW-side patch can interpose silently — see
  // `tests/fixtures/capture-quota.ts`.
  expect(elapsedMs).toBeGreaterThanOrEqual(190);
  expect(elapsedMs).toBeLessThan(2000);

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

test('deleting log.json starts a fresh log instead of resurrecting the buffer', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // The headline behavior of disk authority: the file on disk decides
  // what the log is. Deleting it is a supported gesture, and the next
  // capture must not put the old records back from storage.
  const sw0 = await getServiceWorker();
  await resetCaptureState(sw0);

  const page = await extensionContext.newPage();
  await page.goto(`${fixtureServer.baseUrl}/purple.html`);
  await page.bringToFront();

  // Capture #1 (purple): log grows to one record.
  const sw1 = await getServiceWorker();
  const result1 = await sw1.evaluate(async () => {
    const api = (self as unknown as {
      SeeWhatISee: { captureVisible: () => Promise<CaptureResult> };
    }).SeeWhatISee;
    return api.captureVisible();
  });
  const log1 = await verifyCapture(sw1, result1, PURPLE, []);
  expect(log1).toHaveLength(1);

  // Capture #2 (orange): two records. Two rather than one so the
  // assertion below can tell "started over" from "dropped the last
  // entry".
  await page.goto(`${fixtureServer.baseUrl}/orange.html`);
  await page.bringToFront();
  const sw2 = await getServiceWorker();
  await waitForCaptureQuota(sw2); // stay under captureVisibleTab rate limit
  const result2 = await sw2.evaluate(async () => {
    const api = (self as unknown as {
      SeeWhatISee: { captureVisible: () => Promise<CaptureResult> };
    }).SeeWhatISee;
    return api.captureVisible();
  });
  const log2 = await verifyCapture(sw2, result2, ORANGE, log1);
  expect(log2).toHaveLength(2);
  // Storage still holds both — that's the buffer we're proving does
  // *not* come back.
  const sw3 = await getServiceWorker();
  const buffered = await sw3.evaluate(
    async () => ((await chrome.storage.local.get('captureLog')).captureLog as unknown[]).length,
  );
  expect(buffered).toBe(2);

  // Delete log.json the way a user would, via the download record.
  // `chrome.downloads.removeFile` is Chrome deleting its own file, so
  // the record's `exists` flips immediately — no waiting on the
  // delayed re-check a deletion outside the browser would need.
  await sw3.evaluate(async () => {
    const [item] = await chrome.downloads.search({
      filenameRegex: '[/\\\\]SeeWhatISee[/\\\\]log\\.json$',
      orderBy: ['-startTime'],
    });
    await chrome.downloads.removeFile(item.id);
  });

  // Capture #3 (green): exactly one record — the new one.
  await page.goto(`${fixtureServer.baseUrl}/green.html`);
  await page.bringToFront();
  const sw4 = await getServiceWorker();
  await waitForCaptureQuota(sw4);
  const result3 = await sw4.evaluate(async () => {
    const api = (self as unknown as {
      SeeWhatISee: { captureVisible: () => Promise<CaptureResult> };
    }).SeeWhatISee;
    return api.captureVisible();
  });

  // `[]` as the baseline asserts length 1: the two pre-deletion
  // entries are gone from the file *and* from storage.
  const log3 = await verifyCapture(sw4, result3, GREEN, []);
  expect(log3).toHaveLength(1);
  expect(log3[0].screenshot?.filename).toBe(result3.filename);

  await page.close();
});

test('a storage wipe is healed from log.json rather than truncating it', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // The other side of disk authority: when the buffer loses its
  // contents (an extension reinstall, or cleared site data) the file
  // is what puts them back — the next capture must not truncate
  // log.json to the one record storage still knows about.
  //
  // This exercises the read path, which is the branch this harness can
  // reach: Chrome grants file access to a `--load-extension` build, so
  // `log.json` is readable. The no-read branches — where a size
  // mismatch blocks the write and the user is prompted — are covered
  // in tests/unit/log-reconcile.test.mjs.
  const sw0 = await getServiceWorker();
  await resetCaptureState(sw0);

  const page = await extensionContext.newPage();
  await page.goto(`${fixtureServer.baseUrl}/purple.html`);
  await page.bringToFront();

  const sw1 = await getServiceWorker();
  const result1 = await sw1.evaluate(async () => {
    const api = (self as unknown as {
      SeeWhatISee: { captureVisible: () => Promise<CaptureResult> };
    }).SeeWhatISee;
    return api.captureVisible();
  });
  const log1 = await verifyCapture(sw1, result1, PURPLE, []);

  // Wipe only the buffer, leaving log.json and its download record.
  const sw2 = await getServiceWorker();
  await sw2.evaluate(() => chrome.storage.local.remove('captureLog'));

  await page.goto(`${fixtureServer.baseUrl}/orange.html`);
  await page.bringToFront();
  await waitForCaptureQuota(sw2);
  const result2 = await sw2.evaluate(async () => {
    const api = (self as unknown as {
      SeeWhatISee: { captureVisible: () => Promise<CaptureResult> };
    }).SeeWhatISee;
    return api.captureVisible();
  });

  // Both records are in the file: the purple one came back from disk,
  // not from storage, which had forgotten it.
  const log2 = await verifyCapture(sw2, result2, ORANGE, log1);
  expect(log2).toHaveLength(2);
  expect(log2[0].screenshot?.filename).toBe(result1.filename);

  // And the buffer is repopulated from the file, so the History page
  // and the Copy-last-… entries see the whole log again.
  const sw3 = await getServiceWorker();
  const buffered = await sw3.evaluate(
    async () => ((await chrome.storage.local.get('captureLog')).captureLog as unknown[]).length,
  );
  expect(buffered).toBe(2);

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
