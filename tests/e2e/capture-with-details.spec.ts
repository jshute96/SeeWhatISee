// E2E coverage for the core "Capture page" flow: the
// save-option matrix (PNG only, HTML only, PNG+HTML, URL-only ±
// prompt) and the tab lifecycle (positioning next to the opener,
// returning focus on close).
//
// The rest of the Capture page flow surface lives in sibling specs:
//   - `capture-details-copy.spec.ts` — copy-filename buttons and
//     per-tab download-cache semantics.
//   - `capture-details-edit.spec.ts` — edit-html / edit-selection
//     dialogs, preview toggle, scrape-failure UX.
//   - `capture-paste.spec.ts`        — rich-text paste handling
//     (html→markdown / html-source routing, source-view short-
//     circuit, real CodeJar copy/paste round-trips).
//   - `capture-drawing.spec.ts`     — drawing tool palette
//     (Box/Line/Crop/Redact + Undo/Clear, crop-edge resize, bake-in).
//   - `toolbar-dispatch.spec.ts`    — toolbar `handleActionClick`,
//     click-with-selection routing, default-id migration,
//     copyLastSelectionFilename.

import fs from 'node:fs';
import { test, expect } from '../fixtures/extension';
import {
  CONTENTS_PATTERN,
  SCREENSHOT_PATTERN,
  configureAndCapture,
  findCapturedDownload,
  openDetailsFlow,
  readLatestRecord,
} from './details-helpers';
import { type CaptureRecord } from '../fixtures/files';

// chrome.tabs.captureVisibleTab is rate-limited (~2/s per window).
// Each test in this file issues one capture via startCaptureWithDetails;
// without a small cushion the suite occasionally trips the quota.
test.beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 600));
});

// ─── Save-option matrix ───────────────────────────────────────────

test('details: png only, no prompt, no highlights', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
  });

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(SCREENSHOT_PATTERN);
  expect(record.contents).toBeUndefined();
  expect(record.prompt).toBeUndefined();
  expect(record.screenshot?.hasHighlights).toBeUndefined();
  expect(record.url).toBe(`${fixtureServer.baseUrl}/purple.html`);
  expect(record.title).toBe('purple');

  // The PNG should exist and be non-empty.
  const pngPath = await findCapturedDownload(sw, '.png');
  expect(fs.statSync(pngPath).size).toBeGreaterThan(0);

  await openerPage.close();
});

test('details: html only with prompt', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await configureAndCapture(capturePage, {
    saveScreenshot: false,
    saveHtml: true,
    prompt: 'find the bug',
  });

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.screenshot).toBeUndefined();
  expect(record.contents?.filename).toMatch(CONTENTS_PATTERN);
  expect(record.prompt).toBe('find the bug');
  expect(record.url).toBe(`${fixtureServer.baseUrl}/purple.html`);
  expect(record.title).toBe('purple');

  // The HTML file should contain the fixture page's marker.
  const contentsPath = await findCapturedDownload(sw, '.html');
  const html = fs.readFileSync(contentsPath, 'utf8');
  expect(html).toContain('background: #800080');

  await openerPage.close();
});

test('details: png + html with prompt', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: true,
    prompt: 'compare these',
  });

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(SCREENSHOT_PATTERN);
  expect(record.contents?.filename).toMatch(CONTENTS_PATTERN);
  expect(record.prompt).toBe('compare these');
  expect(record.screenshot?.hasHighlights).toBeUndefined();
  // Both files share the same compact-timestamp suffix when written
  // by the detailed-capture path.
  const screenshotSuffix = record.screenshot!.filename.replace(/^screenshot-/, '').replace(/\.png$/, '');
  const contentsSuffix = record.contents!.filename.replace(/^contents-/, '').replace(/\.html$/, '');
  expect(screenshotSuffix).toBe(contentsSuffix);

  await openerPage.close();
});

test('details: url-only (no screenshot, no html) with prompt', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await configureAndCapture(capturePage, {
    saveScreenshot: false,
    saveHtml: false,
    prompt: 'what runs on this host?',
  });

  const sw = await getServiceWorker();
  // No content file was written this capture, so `findCapturedDownload`
  // for '.png' / '.html' would miss. Pull the log file directly.
  const logPath = await findCapturedDownload(sw, 'log.json');
  const lines = fs.readFileSync(logPath, 'utf8').trimEnd().split('\n');
  const record: CaptureRecord = JSON.parse(lines[lines.length - 1]);
  expect(record.screenshot).toBeUndefined();
  expect(record.contents).toBeUndefined();
  expect(record.prompt).toBe('what runs on this host?');
  expect(record.url).toBe(`${fixtureServer.baseUrl}/purple.html`);
  expect(record.title).toBe('purple');

  await openerPage.close();
});

test('details: url-only with no prompt', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await configureAndCapture(capturePage, {
    saveScreenshot: false,
    saveHtml: false,
  });

  const sw = await getServiceWorker();
  const logPath = await findCapturedDownload(sw, 'log.json');
  const lines = fs.readFileSync(logPath, 'utf8').trimEnd().split('\n');
  const record: CaptureRecord = JSON.parse(lines[lines.length - 1]);
  expect(record.screenshot).toBeUndefined();
  expect(record.contents).toBeUndefined();
  expect(record.prompt).toBeUndefined();
  expect(record.url).toBe(`${fixtureServer.baseUrl}/purple.html`);
  expect(record.title).toBe('purple');

  await openerPage.close();
});

// ─── Prompt paste behaviour ──────────────────────────────────────

test('details: pasting HTML into the prompt converts to markdown', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  // Synthesize a regular Ctrl+V paste: clipboardData carries both
  // text/html (rich) and text/plain (flat) — capture-page.ts should
  // pick the html branch and run it through htmlToMarkdown.
  const pasted = await capturePage.evaluate(() => {
    const input = document.getElementById('prompt-text') as HTMLTextAreaElement;
    input.focus();
    const dt = new DataTransfer();
    dt.setData('text/html', '<p>Hello <b>world</b></p>');
    dt.setData('text/plain', 'Hello world');
    input.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    }));
    return input.value;
  });
  expect(pasted).toBe('Hello **world**');

  // Now simulate Ctrl+Shift+V "paste as plain text": Chrome strips
  // formatting before firing, so only text/plain is present. The
  // handler should fall through to the default paste path — but
  // since we're dispatching synthetically (no default behaviour),
  // we just verify our handler didn't preventDefault and didn't
  // mutate the value. In production the browser's default will
  // then insert the plain text after our listener returns.
  const afterPlainPaste = await capturePage.evaluate(() => {
    const input = document.getElementById('prompt-text') as HTMLTextAreaElement;
    input.value = '';
    input.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', 'just text');
    const ev = new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(ev);
    return { value: input.value, prevented: ev.defaultPrevented };
  });
  // Our handler short-circuits with no preventDefault, leaving the
  // browser's native plain-text paste to run normally.
  expect(afterPlainPaste.prevented).toBe(false);
  expect(afterPlainPaste.value).toBe('');

  await capturePage.close();
  await openerPage.close();
});

test('details: prompt paste strips browser-added inline styles + bare spans', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  // Mirrors what Chrome puts on the clipboard when copying a
  // rendered fragment from a page like GitHub: every element gets
  // an inline `style="..."` populated from computed styles, and
  // whitespace runs end up wrapped in bare `<span> </span>`. The
  // selection-capture path produces neither — `cleanCopiedHtml`
  // normalizes the clipboard payload so the markdown matches what
  // the user would see if they captured the same selection
  // directly.
  const pasted = await capturePage.evaluate(() => {
    const input = document.getElementById('prompt-text') as HTMLTextAreaElement;
    input.focus();
    const dt = new DataTransfer();
    dt.setData(
      'text/html',
      '<!--StartFragment-->' +
      '<h4 style="margin: 24px 0; font-weight: 600;">' +
      '<em style="box-sizing: border-box;">Capture</em>' +
      '<span> </span>page' +
      '</h4>' +
      '<p style="color: rgb(31, 35, 40);">' +
      'Body with <strong style="font-weight: 600;">bold</strong>.' +
      '</p>' +
      '<!--EndFragment-->',
    );
    dt.setData('text/plain', 'Capture page\nBody with bold.');
    input.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: dt, bubbles: true, cancelable: true,
    }));
    return input.value;
  });
  expect(pasted).toBe('#### *Capture* page\n\nBody with **bold**.');

  await capturePage.close();
  await openerPage.close();
});

// ─── Tab lifecycle ────────────────────────────────────────────────

test('details: tab opens next to opener and returns focus on close', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Clean up any leftover tabs from earlier tests in the same
  // worker — they confuse close-time tab activation analysis.
  for (const p of extensionContext.pages()) {
    try {
      await p.close();
    } catch {
      /* ignore */
    }
  }

  // Three tabs total so the opener has neighbors on both sides
  // and the Capture page tab can't accidentally satisfy the
  // "right-neighbor" assertion by being at the end of the strip.
  // Distinct colors make it easy to tell which tab Chrome
  // activates if a regression bites.
  const leftDistractor = await extensionContext.newPage();
  await leftDistractor.goto(`${fixtureServer.baseUrl}/green.html`);

  const opener = await extensionContext.newPage();
  await opener.goto(`${fixtureServer.baseUrl}/orange.html`);

  const rightDistractor = await extensionContext.newPage();
  await rightDistractor.goto(`${fixtureServer.baseUrl}/purple.html`);

  // Make the opener the active tab. We use chrome.tabs.update
  // from the SW rather than Playwright's `bringToFront`, because
  // bringToFront in headless mode doesn't always update Chrome's
  // tab activation history — and that history is what Chrome's
  // close-time tab picker reads from.
  const sw0 = await getServiceWorker();
  const openerIndex = await sw0.evaluate(async (orangeUrl) => {
    const all = await chrome.tabs.query({});
    const tab = all.find((t) => t.url === orangeUrl);
    if (!tab?.id) throw new Error(`no tab matching ${orangeUrl}`);
    await chrome.tabs.update(tab.id, { active: true });
    return tab.index!;
  }, `${fixtureServer.baseUrl}/orange.html`);

  const capturePagePromise = extensionContext.waitForEvent('page', {
    predicate: (p) => p.url().endsWith('/capture.html'),
    timeout: 5000,
  });
  const sw = await getServiceWorker();
  await sw.evaluate(async () => {
    await (
      self as unknown as {
        SeeWhatISee: { startCaptureWithDetails: () => Promise<void> };
      }
    ).SeeWhatISee.startCaptureWithDetails();
  });
  const capturePage = await capturePagePromise;
  await capturePage.waitForLoadState('domcontentloaded');

  // Verify the Capture page tab is at openerIndex + 1, i.e. immediately
  // to the right of the opener. We can't filter `chrome.tabs.query`
  // by `url` (that needs the `tabs` permission, which the manifest
  // deliberately omits), so we look the tab up via its session-
  // storage key.
  const detailsIndex = await sw.evaluate(async () => {
    const stored = await chrome.storage.session.get(null);
    const key = Object.keys(stored).find((k) => k.startsWith('captureDetails_'));
    if (!key) throw new Error('no captureDetails_ key in session storage');
    const tabId = Number(key.slice('captureDetails_'.length));
    const tab = await chrome.tabs.get(tabId);
    return tab.index;
  });
  // The Capture page tab opens immediately to the right of the opener
  // (`index: active.index + 1` in startCaptureWithDetails).
  expect(detailsIndex).toBe(openerIndex + 1);

  await Promise.all([
    capturePage.waitForEvent('close'),
    capturePage.locator('#capture').click(),
  ]);

  // After close, the active tab should be the opener (orange.html),
  // because the saveDetails finally block explicitly re-activates
  // it. Chrome's natural pick on close is unreliable across
  // layouts, so the assertion bites if anyone tries to drop the
  // explicit `chrome.tabs.update` in background.ts.
  const sw2 = await getServiceWorker();
  const activeUrl = await sw2.evaluate(async () => {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return t.url;
  });
  expect(activeUrl).toBe(`${fixtureServer.baseUrl}/orange.html`);

  await opener.close();
  await leftDistractor.close();
  await rightDistractor.close();
});
