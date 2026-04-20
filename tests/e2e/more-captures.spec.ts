// E2E coverage for the two More-submenu capture shortcuts:
// `captureUrlOnly` (details flow with neither file checked) and
// `captureBoth` (details flow with both files checked). Both are
// thin wrappers that go through the same details-flow helpers
// (`captureBothToMemory`, `recordDetailedCapture`), so these tests
// mainly pin the wiring — i.e. that the two shortcut entry points
// end up writing the same kind of log record the details UI would
// produce for those checkbox combinations.

import fs from 'node:fs';
import type { Worker } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { type CaptureRecord, waitForDownloadPath } from '../fixtures/files';

const SCREENSHOT_PATTERN = /^screenshot-\d{8}-\d{6}-\d{3}\.png$/;
const CONTENTS_PATTERN = /^contents-\d{8}-\d{6}-\d{3}\.html$/;

// chrome.tabs.captureVisibleTab is rate-limited (~2/s per window).
// Each test here takes at least one screenshot (captureBoth always;
// captureUrlOnly also goes through captureBothToMemory). Cushion the
// start so adjacent tests don't trip the quota.
test.beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 600));
});

// Spy on `chrome.downloads.download` so we can map requested filenames
// to download ids — same pattern as capture-with-details.spec.ts.
// Returns the most recent download whose requested filename ends with
// `suffix`, resolved to its on-disk path.
async function findCapturedDownload(sw: Worker, suffix: string): Promise<string> {
  const id = await sw.evaluate((sfx) => {
    interface SpyState { __seeDl?: { id: number; name: string }[] }
    const list = (self as unknown as SpyState).__seeDl ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].name.endsWith(sfx)) return list[i].id;
    }
    throw new Error(
      `no captured download ending in ${sfx}; have: ${list.map((d) => d.name).join(', ')}`,
    );
  }, suffix);
  return await waitForDownloadPath(sw, id);
}

async function readLatestRecord(sw: Worker): Promise<CaptureRecord> {
  const logPath = await findCapturedDownload(sw, 'log.json');
  const lines = fs.readFileSync(logPath, 'utf8').trimEnd().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

// Install the download spy and trigger `fn` on `self.SeeWhatISee` in
// one evaluate block so an SW idle-out between install and use can't
// lose the patch.
async function runWithSpy(
  sw: Worker,
  fnName: 'captureUrlOnly' | 'captureBoth',
): Promise<void> {
  await sw.evaluate(async (name) => {
    interface SpyState {
      __seeDl?: { id: number; name: string }[];
      __seeDlOrig?: typeof chrome.downloads.download;
    }
    const g = self as unknown as SpyState;
    if (!g.__seeDlOrig) {
      g.__seeDlOrig = chrome.downloads.download.bind(chrome.downloads);
      (chrome.downloads as { download: typeof chrome.downloads.download }).download =
        (async (opts: chrome.downloads.DownloadOptions) => {
          const id = await g.__seeDlOrig!(opts);
          if (typeof id === 'number') {
            g.__seeDl!.push({ id, name: opts.filename ?? '' });
          }
          return id;
        }) as typeof chrome.downloads.download;
    }
    g.__seeDl = [];

    await (
      self as unknown as {
        SeeWhatISee: Record<string, () => Promise<void>>;
      }
    ).SeeWhatISee[name]();
  }, fnName);
}

test('captureUrlOnly records url + timestamp only, no files', async ({
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
  await runWithSpy(sw, 'captureUrlOnly');

  const record = await readLatestRecord(sw);
  expect(record.screenshot).toBeUndefined();
  expect(record.contents).toBeUndefined();
  expect(record.prompt).toBeUndefined();
  expect(record.screenshot?.hasHighlights).toBeUndefined();
  expect(record.url).toBe(`${fixtureServer.baseUrl}/purple.html`);
  expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  // No PNG or HTML was written in this capture: the only downloads
  // should be `log.json`.
  const names = await sw.evaluate(() => {
    interface SpyState { __seeDl?: { id: number; name: string }[] }
    return ((self as unknown as SpyState).__seeDl ?? []).map((d) => d.name);
  });
  expect(names.every((n) => n.endsWith('log.json'))).toBe(true);

  await page.close();
});

test('captureBoth writes PNG + HTML + log record referencing both', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw0 = await getServiceWorker();
  await sw0.evaluate(() => chrome.storage.local.clear());

  const page = await extensionContext.newPage();
  await page.goto(`${fixtureServer.baseUrl}/green.html`);
  await page.bringToFront();

  const sw = await getServiceWorker();
  await runWithSpy(sw, 'captureBoth');

  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(SCREENSHOT_PATTERN);
  expect(record.contents?.filename).toMatch(CONTENTS_PATTERN);
  expect(record.prompt).toBeUndefined();
  expect(record.screenshot?.hasHighlights).toBeUndefined();
  expect(record.url).toBe(`${fixtureServer.baseUrl}/green.html`);

  // Both artifact files should be on disk and non-empty, and the HTML
  // should actually contain the fixture page's marker.
  const pngPath = await findCapturedDownload(sw, '.png');
  expect(fs.statSync(pngPath).size).toBeGreaterThan(0);

  const htmlPath = await findCapturedDownload(sw, '.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  expect(html).toContain('background: #00c000');

  // Both files share the same compact-timestamp suffix since they
  // came from one captureBothToMemory call.
  const screenshotStem = record.screenshot!.filename.replace(/^screenshot-|\.png$/g, '');
  const contentsStem = record.contents!.filename.replace(/^contents-|\.html$/g, '');
  expect(screenshotStem).toBe(contentsStem);

  await page.close();
});
