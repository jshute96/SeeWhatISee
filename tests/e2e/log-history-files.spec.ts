// End-to-end test for capture-log flushing: once the in-storage log
// goes past its cap, the oldest half is flushed to a
// `history-<timestamp>.json` file instead of being discarded.
//
// The unit tests (`tests/unit/log-history-files.test.mjs`) already cover
// which records land in which file against a stubbed `chrome`. What
// only a real browser can show is that the flush actually reaches disk
// through `chrome.downloads` as a second file alongside `log.json` —
// so this seeds a full log, runs one genuine capture, and reads both
// files back off the filesystem. The other tests close the loop from
// the History page's side: *Load older captures* finds and reads the
// flushed file back through the `file://` directory listing, and the
// page *opens* from `log.json` itself — the cache loses to the file,
// and a deleted or emptied file renders as the empty log it is.
//
// The seeded log is written to **both** `chrome.storage.local` and
// `log.json` on disk (`seedCaptureLog`). Storage alone would be
// discarded: the file is authoritative, so a capture on top of a
// storage-only seed reads an absent `log.json` and starts a new log.

import fs from 'node:fs';
import { test, expect } from '../fixtures/extension';
import {
  waitForDownloadPath,
  type CaptureResult,
  seedCaptureLog,
  resetCaptureState,
} from '../fixtures/files';
// Straight from the source, so lowering the cap changes what this test
// seeds instead of failing it in a way that reads as a product bug.
import { LOG_HISTORY_BATCH, LOG_MAX_ENTRIES } from '../../src/capture/log-store';

/**
 * Title prefix on the seeded records. Distinctive enough to pick our
 * history file out of whatever else the worker's profile has downloaded.
 */
const SEED_TITLE = 'log-history-seed';

/** Synthetic older captures, oldest first — the append order. */
function seedRecords(count: number): { timestamp: string; title: string }[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    title: `${SEED_TITLE} ${i}`,
  }));
}

/** Split a newline-delimited JSON file into records. */
function parseNdjson(text: string): { title?: string; timestamp?: string }[] {
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

test('a capture past the cap flushes the oldest entries to a history file', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  // A full log, so the capture below is the one that tips it over.
  await seedCaptureLog(sw, seedRecords(LOG_MAX_ENTRIES));

  const page = await extensionContext.newPage();
  await page.goto(`${fixtureServer.baseUrl}/purple.html`);
  await page.bringToFront();

  const result = await sw.evaluate(async () => {
    const api = (self as unknown as {
      SeeWhatISee: { captureVisible: () => Promise<CaptureResult> };
    }).SeeWhatISee;
    return api.captureVisible();
  });

  // ---- log.json keeps the tail -------------------------------------
  const logPath = await waitForDownloadPath(sw, result.logDownloadId);
  const logRecords = parseNdjson(fs.readFileSync(logPath, 'utf8'));
  expect(logRecords).toHaveLength(LOG_MAX_ENTRIES - LOG_HISTORY_BATCH + 1);
  expect(logRecords[0].title).toBe(`${SEED_TITLE} ${LOG_HISTORY_BATCH}`);
  // The capture that triggered the flush is still the last line.
  expect(logRecords[logRecords.length - 1].timestamp).toBe(result.timestamp);

  // ---- a separate history file holds the head ----------------------
  // Every download this profile has made, minus the two files this
  // capture is known to have written. Exactly one of the rest should
  // be the history file, identified by the seeded titles inside it.
  // Filtered by content rather than name so the assertion still says
  // *which records* landed in a history file, not merely that a
  // `history-*.json` appeared. The profile is a fresh temp dir per
  // worker, so the unfiltered list stays short.
  const otherIds = (await sw.evaluate(() => chrome.downloads.search({})))
    .map((d) => d.id)
    .filter((id) => id !== result.logDownloadId && id !== result.downloadId);

  const historyFiles: string[] = [];
  for (const id of otherIds) {
    const path = await waitForDownloadPath(sw, id);
    const text = fs.readFileSync(path, 'utf8');
    if (text.includes(`${SEED_TITLE} 0`)) historyFiles.push(text);
  }
  expect(historyFiles).toHaveLength(1);

  const movedOut = parseNdjson(historyFiles[0]);
  expect(movedOut).toHaveLength(LOG_HISTORY_BATCH);
  expect(movedOut[0].title).toBe(`${SEED_TITLE} 0`);
  expect(movedOut[LOG_HISTORY_BATCH - 1].title).toBe(`${SEED_TITLE} ${LOG_HISTORY_BATCH - 1}`);
  // Together the two files hold the whole history: no record is in
  // both, and none went missing.
  expect(movedOut.length + logRecords.length).toBe(LOG_MAX_ENTRIES + 1);

  await page.close();
  // Leave a clean log behind: storage persists across tests in a worker.
  await sw.evaluate(() => chrome.storage.local.remove('captureLog'));
});

// The read side of the same story: the file the flush wrote comes back
// through the History page. `listHistoryFiles` finds it by listing the
// capture directory over `file://` (the harness grants file access to
// a `--load-extension` build), so this is the one place *Load older
// captures* is exercised with something real to load.
test('the History page loads the flushed captures back from disk', async ({
  extensionContext,
  extensionId,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  // Clean slate: the test above leaves its own history file in this
  // worker's profile, which would make the file count here — and the
  // flush's collision-guarded filename — nondeterministic.
  await resetCaptureState(sw);
  await seedCaptureLog(sw, seedRecords(LOG_MAX_ENTRIES));

  const page = await extensionContext.newPage();
  await page.goto(`${fixtureServer.baseUrl}/purple.html`);
  await page.bringToFront();
  const result = await sw.evaluate(async () => {
    const api = (self as unknown as {
      SeeWhatISee: { captureVisible: () => Promise<CaptureResult> };
    }).SeeWhatISee;
    return api.captureVisible();
  });
  // The flush is awaited to completion before `log.json` is written
  // (a record must not leave the log before the history file carrying
  // it is on disk), so the log landing means the history file is
  // there for the directory listing to find.
  await waitForDownloadPath(sw, result.logDownloadId);
  await page.close();

  const history = await extensionContext.newPage();
  await history.goto(`chrome-extension://${extensionId}/history.html`);
  await expect(history.locator('#count')).not.toBeEmpty();

  // The log kept the tail; the button offers the flushed head, with
  // the file count in its tooltip.
  await expect(history.locator('#rows tr'))
    .toHaveCount(LOG_MAX_ENTRIES - LOG_HISTORY_BATCH + 1);
  const loadOlder = history.locator('#load-older');
  await expect(loadOlder).toBeVisible();
  await expect(loadOlder).toBeEnabled();
  await expect(loadOlder).toHaveAttribute('title', /\(1 file\)/);

  await loadOlder.click();

  // Every seeded capture is back on screen — read from the real file
  // on disk, newest-first, with the oldest seed closing the table.
  const rows = history.locator('#rows tr');
  await expect(rows).toHaveCount(LOG_MAX_ENTRIES + 1);
  await expect(rows.last()).toContainText(`${SEED_TITLE} 0`);
  // Nothing left to offer and nothing failed, so the control leaves.
  await expect(history.locator('#older')).toBeHidden();
  await expect(history.locator('#older-note')).toBeEmpty();

  await history.close();
  await sw.evaluate(() => chrome.storage.local.remove('captureLog'));
});

// The page opens from `log.json` itself, not the storage cache — the
// file is the authoritative log. The headline divergence is a wiped
// cache (reinstall, cleared site data): the page must show the file's
// records, not an empty log.
test('the History page opens from log.json, not the storage cache', async ({
  extensionContext,
  extensionId,
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  await resetCaptureState(sw);
  // Writes the same records to storage *and* disk...
  await seedCaptureLog(sw, seedRecords(20));
  // ...then replaces the cache with a single decoy. The file must
  // win outright: its rows on screen, the decoy off it — an
  // implementation that merged cache into file would show 21. The
  // `log.json` download record keeps the directory discoverable.
  await sw.evaluate(() => chrome.storage.local.set({
    captureLog: [{ timestamp: '2027-01-01T00:00:00.000Z', title: 'cache-decoy' }],
  }));

  const history = await extensionContext.newPage();
  await history.goto(`chrome-extension://${extensionId}/history.html`);
  await expect(history.locator('#count')).not.toBeEmpty();

  await expect(history.locator('#rows tr')).toHaveCount(20);
  await expect(history.locator('#rows tr').last()).toContainText(`${SEED_TITLE} 0`);
  await expect(history.locator('#rows')).not.toContainText('cache-decoy');

  // And the decoy is still in storage: the page is a viewer — cache
  // repair stays with the capture path's reconcile.
  const stored = await sw.evaluate(async () => {
    const data = await chrome.storage.local.get('captureLog');
    return data.captureLog as { title?: string }[];
  });
  expect(stored).toHaveLength(1);
  expect(stored[0].title).toBe('cache-decoy');

  await history.close();
  await resetCaptureState(sw);
});

// A `log.json` the user emptied or deleted renders as what it is — an
// empty log — instead of ghost rows from the stale cache. The history
// files are discovered independently of the log, so the flushed
// captures must still be one click away either way.
test('an emptied or deleted log.json shows empty, with history files still loadable', async ({
  extensionContext,
  extensionId,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  await resetCaptureState(sw);
  await seedCaptureLog(sw, seedRecords(LOG_MAX_ENTRIES));

  const page = await extensionContext.newPage();
  await page.goto(`${fixtureServer.baseUrl}/purple.html`);
  await page.bringToFront();
  const result = await sw.evaluate(async () => {
    const api = (self as unknown as {
      SeeWhatISee: { captureVisible: () => Promise<CaptureResult> };
    }).SeeWhatISee;
    return api.captureVisible();
  });
  const logPath = await waitForDownloadPath(sw, result.logDownloadId);
  await page.close();

  // The storage cache still holds the post-flush records; the checks
  // below only mean anything if the page is ignoring it.
  for (const wipe of [
    () => fs.writeFileSync(logPath, ''),
    () => fs.rmSync(logPath),
  ]) {
    wipe();
    const history = await extensionContext.newPage();
    await history.goto(`chrome-extension://${extensionId}/history.html`);
    // No `#count` wait here — it renders as empty text for an empty
    // log. The notice appearing *is* the rendered state: the second
    // empty-state points at the history files rather than denying they
    // exist.
    await expect(history.locator('#empty-history-files')).toBeVisible();
    await expect(history.locator('#empty')).toBeHidden();
    await expect(history.locator('#rows tr')).toHaveCount(0);

    // And the button delivers them.
    const loadOlder = history.locator('#load-older');
    await expect(loadOlder).toBeVisible();
    await expect(loadOlder).toHaveAttribute('title', /\(1 file\)/);
    await loadOlder.click();
    await expect(history.locator('#rows tr')).toHaveCount(LOG_HISTORY_BATCH);
    await expect(history.locator('#older-note')).toBeEmpty();

    await history.close();
  }
  // Full reset, not just the storage key: this test ends with a
  // deleted `log.json`, a stray history file, and live download
  // records for both — residue that would steer a later spec's
  // directory discovery in this worker's shared profile.
  await resetCaptureState(sw);
});
