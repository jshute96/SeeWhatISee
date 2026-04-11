// Helpers for verifying captures landed on disk and contain the right
// pixels. Used by the e2e tests in tests/e2e/.
//
// We resolve on-disk paths via chrome.downloads.search rather than
// Playwright's context-level `download` event, because Playwright's
// download event only fires for downloads initiated by a *page*
// (a click → navigation that the browser treats as an attachment).
// chrome.downloads.download calls made from the MV3 service worker
// don't surface as page downloads, so the event never fires for
// SeeWhatISee's PNG / sidecar saves.
//
// chrome.downloads.search *does* see them, but the `filename` field
// it returns is the actual on-disk path Playwright uses for its
// download interception storage — typically a UUID under a temp dir,
// not the path the extension requested. That's still useful: we want
// the bytes, not the name. Tests should not assert on basenames here.

import fs from 'node:fs';
import { PNG } from 'pngjs';
import { expect, type Worker } from '@playwright/test';
// Type-only import from the extension source. `import type` is erased
// at compile time, so this creates no runtime dependency on src/ — the
// test runner never tries to load capture.js. Importing the real
// declarations (rather than redeclaring them here) means the tests
// fail to compile if the production type drifts, which is exactly the
// drift detector we want.
import type { CaptureRecord, CaptureResult } from '../../src/capture.js';

export type { CaptureRecord, CaptureResult };

/**
 * Wait for `chrome.downloads` to report the given downloadId as
 * complete and return the absolute on-disk path. Polls inside the
 * service worker so we don't have to bridge polling state across the
 * SW <-> test boundary. chrome.downloads.download resolves on download
 * *start*, not on completion, so this poll is what callers use as the
 * "file is fully written" barrier.
 */
export async function waitForDownloadPath(sw: Worker, downloadId: number): Promise<string> {
  return await sw.evaluate(async (id) => {
    for (let i = 0; i < 50; i++) {
      const [item] = await chrome.downloads.search({ id });
      if (item && item.state === 'complete' && item.filename) return item.filename;
      if (item && item.state === 'interrupted') {
        throw new Error(`download ${id} interrupted: ${item.error ?? 'unknown'}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`download ${id} did not complete within timeout`);
  }, downloadId);
}

/**
 * Sample a single pixel from `pngPath` and return [r, g, b, a] in
 * 0..255. Defaults to (10, 10), which is comfortably inside the
 * fixture body for any reasonable viewport.
 *
 * Pure-Node PNG decode via pngjs — no browser, no canvas, no
 * same-origin gymnastics. PNG.sync.read returns a single buffer of
 * RGBA bytes laid out row-major; the pixel at (x, y) starts at
 * `(y * width + x) * 4`.
 */
export function pixelColorAt(
  pngPath: string,
  x = 10,
  y = 10,
): [number, number, number, number] {
  const png = PNG.sync.read(fs.readFileSync(pngPath));
  const i = (y * png.width + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
}

/**
 * Loose RGB equality with a small tolerance per channel. PNG round-trip
 * is lossless, but a colored CSS background can be antialiased against
 * the (white) page edges; sampling well inside the body avoids the
 * worst of it, but a few-LSB tolerance keeps the test from getting
 * cute about display gamma or color profile differences across hosts.
 */
export function expectColorClose(
  actual: [number, number, number, number],
  expected: [number, number, number],
  tolerance = 8,
): void {
  for (let i = 0; i < 3; i++) {
    if (Math.abs(actual[i] - expected[i]) > tolerance) {
      throw new Error(
        `pixel mismatch on channel ${i}: got rgba(${actual.join(',')}), expected ~rgb(${expected.join(',')}) (tol ${tolerance})`,
      );
    }
  }
}

/**
 * One-stop verification for an HTML snapshot capture:
 *
 *   - the HTML file exists and contains `expectedSubstring`
 *   - latest.json's content equals the capture record
 *   - log.json's last line equals the capture record
 *   - if `prevLogRecords` is given, log.json grew by exactly one line
 *
 * Returns the parsed log.json records for chaining (same as verifyCapture).
 */
export async function verifyHtmlCapture(
  sw: Worker,
  result: CaptureResult,
  expectedSubstring: string,
  prevLogRecords?: CaptureRecord[],
): Promise<CaptureRecord[]> {
  const [htmlPath, latestPath, logPath] = await Promise.all([
    waitForDownloadPath(sw, result.downloadId),
    waitForDownloadPath(sw, result.sidecarDownloadIds.latest),
    waitForDownloadPath(sw, result.sidecarDownloadIds.log),
  ]);

  // HTML file: on disk, non-empty, contains the expected content.
  expect(fs.existsSync(htmlPath)).toBe(true);
  const html = fs.readFileSync(htmlPath, 'utf8');
  expect(html.length).toBeGreaterThan(0);
  expect(html).toContain(expectedSubstring);

  const expectedRecord: CaptureRecord = {
    timestamp: result.timestamp,
    contents: result.contents,
    url: result.url,
  };

  const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  expect(latest).toEqual(expectedRecord);

  const logLines = fs.readFileSync(logPath, 'utf8').split('\n');
  expect(logLines[logLines.length - 1]).toBe('');
  const logRecords: CaptureRecord[] = logLines.slice(0, -1).map((l) => JSON.parse(l));
  expect(logRecords[logRecords.length - 1]).toEqual(expectedRecord);

  if (prevLogRecords !== undefined) {
    expect(logRecords).toHaveLength(prevLogRecords.length + 1);
    expect(logRecords.slice(0, prevLogRecords.length)).toEqual(prevLogRecords);
  }

  return logRecords;
}

/**
 * One-stop verification that a capture landed on disk consistently:
 *
 *   - the PNG exists, is non-empty, and shows the expected pixel color
 *   - latest.json's content equals the capture record
 *   - log.json's last line equals the capture record (and has the
 *     trailing newline writeJsonFile is supposed to add)
 *   - if `prevLogRecords` is given, log.json grew by exactly one line
 *     and the previous lines are byte-identical (delta check — catches
 *     "log got truncated" and "log forgot the new entry" without doing
 *     a redundant whole-file comparison every time)
 *
 * Returns the parsed log.json records so the caller can chain calls:
 *
 *     const log1 = await verifyCapture(sw, result1, PURPLE);
 *     // ... second capture ...
 *     const log2 = await verifyCapture(sw, result2, ORANGE, log1);
 *
 * `prevLogRecords` defaults to `undefined`, which skips the
 * delta/length check. Tests that don't care about the log delta (or
 * that don't know it because chrome.storage is dirty from earlier
 * tests in the same worker) can just omit it and still get every
 * other assertion.
 */
export async function verifyCapture(
  sw: Worker,
  result: CaptureResult,
  expectedColor: [number, number, number],
  prevLogRecords?: CaptureRecord[],
): Promise<CaptureRecord[]> {
  // Resolve all three on-disk paths in parallel — they're independent
  // chrome.downloads.search polls and the sidecars are written
  // concurrently anyway, so serializing the polls just inflates
  // wall-clock time (and inflates the error budget when one is slow).
  const [pngPath, latestPath, logPath] = await Promise.all([
    waitForDownloadPath(sw, result.downloadId),
    waitForDownloadPath(sw, result.sidecarDownloadIds.latest),
    waitForDownloadPath(sw, result.sidecarDownloadIds.log),
  ]);

  // PNG: on disk, non-empty, shows the right color.
  expect(fs.existsSync(pngPath)).toBe(true);
  expect(fs.statSync(pngPath).size).toBeGreaterThan(0);
  expectColorClose(pixelColorAt(pngPath), expectedColor);

  // The record we expect to find written into both sidecars. Built
  // here in canonical key order so toEqual diffs read sensibly when
  // an assertion fails.
  const expectedRecord: CaptureRecord = {
    timestamp: result.timestamp,
    screenshot: result.screenshot,
    url: result.url,
  };

  // latest.json: full content equality (it only ever holds one record).
  const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  expect(latest).toEqual(expectedRecord);

  // log.json: NDJSON. Always check the trailing newline + last record.
  // The .split('\n') of a file ending in '\n' has '' as its last
  // element; everything before that is the actual records.
  const logLines = fs.readFileSync(logPath, 'utf8').split('\n');
  expect(logLines[logLines.length - 1]).toBe('');
  const logRecords: CaptureRecord[] = logLines.slice(0, -1).map((l) => JSON.parse(l));
  expect(logRecords[logRecords.length - 1]).toEqual(expectedRecord);

  if (prevLogRecords !== undefined) {
    expect(logRecords).toHaveLength(prevLogRecords.length + 1);
    expect(logRecords.slice(0, prevLogRecords.length)).toEqual(prevLogRecords);
  }

  return logRecords;
}
