// End-to-end test for capture-log flushing: once the in-storage log
// goes past its cap, the oldest half is flushed to a
// `history-<timestamp>.json` file instead of being discarded.
//
// The unit tests (`tests/unit/log-history-files.test.mjs`) already cover
// which records land in which file against a stubbed `chrome`. What
// only a real browser can show is that the flush actually reaches disk
// through `chrome.downloads` as a second file alongside `log.json` —
// so this seeds a full log, runs one genuine capture, and reads both
// files back off the filesystem.
//
// The seeded log is written to **both** `chrome.storage.local` and
// `log.json` on disk (`seedCaptureLog`). Storage alone would be
// discarded: the file is authoritative, so a capture on top of a
// storage-only seed reads an absent `log.json` and starts a new log.

import fs from 'node:fs';
import { test, expect } from '../fixtures/extension';
import { waitForDownloadPath, type CaptureResult, seedCaptureLog } from '../fixtures/files';
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
