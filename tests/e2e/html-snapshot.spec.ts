import { test, expect } from '../fixtures/extension';
import * as fs from 'node:fs';
import type { Worker } from '@playwright/test';
import { verifyHtmlCapture, waitForDownloadPath, type CaptureResult, resetCaptureState } from '../fixtures/files';
import { DOCTYPE_CASES } from './doctype-cases';

// Filename format: contents-YYYYMMDD-HHMMSS-mmm.html
const FILENAME_PATTERN = /^contents-\d{8}-\d{6}-\d{3}\.html$/;

test('savePageContents captures HTML and writes the log file', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw0 = await getServiceWorker();
  await resetCaptureState(sw0);

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
  expect(result.logDownloadId).toBeGreaterThan(0);

  // The saved HTML starts like a Chrome-saved page: the page's own
  // doctype, then the `saved from url=` line naming the right page.
  const url = `${fixtureServer.baseUrl}/purple.html`;
  const len = String(url.length).padStart(4, '0');
  await verifyHtmlCapture(
    sw,
    result,
    `<!DOCTYPE html>\n<!-- saved from url=(${len})${url} -->\n<html>`,
    [],
  );

  await page.close();
});

test('savePageContents(delayMs) sleeps before scraping', async ({
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
        savePageContents: (delayMs?: number) => Promise<CaptureResult>;
      };
    }).SeeWhatISee;
    const start = performance.now();
    const result = await api.savePageContents(200);
    return { elapsedMs: performance.now() - start, result };
  });

  // Timer must actually fire before the scrape. A missing `await`
  // on the setTimeout would make this near-zero.
  expect(elapsedMs).toBeGreaterThanOrEqual(190);
  expect(elapsedMs).toBeLessThan(500);
  expect(result.filename).toMatch(FILENAME_PATTERN);
  expect(result.url).toBe(`${fixtureServer.baseUrl}/green.html`);

  // No baseline arg → skip the delta/length check (storage is
  // dirty from earlier tests in the worker). All other on-disk
  // checks still run.
  await verifyHtmlCapture(sw, result, 'background: #00c000');

  await page.close();
});

/** On-disk path of the most recent download whose name ends in `name`. */
async function savedPath(sw: Worker, name: string): Promise<string> {
  const id = await sw.evaluate(async (n) => {
    const items = await chrome.downloads.search({ orderBy: ['-startTime'] });
    return items.find((d) => d.filename.endsWith(n))!.id;
  }, name);
  return waitForDownloadPath(sw, id);
}

// Saved page HTML and selection HTML both start with the page's own
// doctype (or none). Only the page HTML gets the `saved from url=` line.
for (const { name, doctype } of DOCTYPE_CASES) {
  test(`saved HTML files keep the page doctype: ${name}`, async ({
    extensionContext,
    fixtureServer,
    getServiceWorker,
  }) => {
    const sw0 = await getServiceWorker();
    await resetCaptureState(sw0);

    const page = await extensionContext.newPage();
    const url = `${fixtureServer.baseUrl}/purple.html`;
    await page.goto(url);
    await page.setContent(`${doctype}<html><body><p id="p">hello</p></body></html>`);
    await page.evaluate(() => {
      window.getSelection()!.selectAllChildren(document.getElementById('p')!);
    });
    await page.bringToFront();

    const sw = await getServiceWorker();
    const { contentsFile, selectionFile } = await sw.evaluate(async () => {
      const api = (self as unknown as {
        SeeWhatISee: {
          savePageContents: () => Promise<{ filename: string }>;
          captureSelection: (f: 'html') => Promise<{ selection?: { filename: string } }>;
        };
      }).SeeWhatISee;
      const contents = await api.savePageContents();
      const sel = await api.captureSelection('html');
      return { contentsFile: contents.filename, selectionFile: sel.selection!.filename };
    });

    const prefix = doctype ? `${doctype}\n` : '';
    const len = String(url.length).padStart(4, '0');
    const contents = fs.readFileSync(await savedPath(sw, contentsFile), 'utf8');
    expect(contents.startsWith(
      `${prefix}<!-- saved from url=(${len})${url} -->\n<html>`,
    )).toBe(true);

    const selection = fs.readFileSync(await savedPath(sw, selectionFile), 'utf8');
    expect(selection).toBe(`${prefix}hello\n`);

    await page.close();
  });
}
