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
  setEditorCode,
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

// ─── Error routing: surfaces in #ask-status, not the toolbar ────

test('details: saveDetails failure surfaces in #ask-status, leaves toolbar untouched, keeps the page open even on a plain click', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Force a failure inside the SW's `saveDetails` handler by
  // wiping the per-tab DetailsSession after the Capture page has
  // loaded. The handler's first step is `requireDetailsSession`
  // which now throws "Capture data missing …", and the new error-
  // routing contract says:
  //   - Page renders the message in #ask-status (not the toolbar).
  //   - Toolbar tooltip is left alone.
  //   - The Capture page stays open even when closeAfter was true
  //     (plain click, the default close-after-save path), so the
  //     user keeps the preview as a recovery surface.
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  // Snapshot the toolbar tooltip BEFORE the click so we can
  // assert it didn't change underneath us.
  const tooltipBefore = await sw.evaluate(() => chrome.action.getTitle({}));

  // Wipe the session entry for this Capture page tab. Storage key
  // mirrors `detailsStorageKey(tabId)` in the SW.
  await sw.evaluate(async () => {
    const entries = await chrome.storage.session.get(null);
    const keys = Object.keys(entries).filter((k) => k.startsWith('captureDetails_'));
    if (keys.length > 0) await chrome.storage.session.remove(keys);
  });

  // Plain click (closeAfter defaults to true). The save fails, so
  // the page must stay open and surface the error inline.
  await capturePage.locator('#capture').click();

  await expect(capturePage.locator('#ask-status')).toContainText(
    'Capture data missing',
    { timeout: 10_000 },
  );
  await expect(capturePage.locator('#ask-status')).toHaveClass(/ask-status-error/);
  expect(capturePage.isClosed()).toBe(false);

  const tooltipAfter = await sw.evaluate(() => chrome.action.getTitle({}));
  expect(tooltipAfter).toBe(tooltipBefore);
  expect(tooltipAfter).not.toContain('ERROR');

  await capturePage.close();
  await openerPage.close();
});

test('details: shift-click capture keeps the page open and the second capture reuses the same files', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Shift-clicking Capture writes the artifacts + log entry but
  // leaves the page open AND keeps the per-tab session intact, so a
  // second Capture click can run against the same staged content.
  // Both captures should reuse the same on-disk files (no edits in
  // between → unchanged revision → locked filename reused) and
  // log.json should hold two records pointing at the same names.
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Save HTML alongside the screenshot so we exercise both bump
  // paths (image + text artifact).
  await capturePage.locator('#cap-html').check();

  await capturePage.locator('#capture').click({ modifiers: ['Shift'] });
  await expect(capturePage.locator('#ask-status')).toHaveText('Saved.', {
    timeout: 10_000,
  });
  expect(capturePage.isClosed()).toBe(false);

  // Second capture, no edits in between. Status flips back to
  // "Saved." and the page stays open.
  await capturePage.locator('#capture').click({ modifiers: ['Shift'] });
  await expect(capturePage.locator('#ask-status')).toHaveText('Saved.', {
    timeout: 10_000,
  });
  expect(capturePage.isClosed()).toBe(false);

  const sw = await getServiceWorker();
  const logPath = await findCapturedDownload(sw, 'log.json');
  const lines = fs.readFileSync(logPath, 'utf8').trimEnd().split('\n');
  // Two log entries — one per save — with identical filenames since
  // nothing changed in between. `-1` would be a regression.
  const records: CaptureRecord[] = lines
    .slice(-2)
    .map((l) => JSON.parse(l));
  expect(records).toHaveLength(2);
  expect(records[0].screenshot?.filename).toBeDefined();
  expect(records[0].screenshot?.filename).toBe(records[1].screenshot?.filename);
  expect(records[0].contents?.filename).toBe(records[1].contents?.filename);
  expect(records[0].screenshot?.filename).not.toContain('-1.');
  expect(records[0].contents?.filename).not.toContain('-1.');

  await capturePage.close();
  await openerPage.close();
});

test('details: edit between shift-clicks → second capture writes a new -1 file and references it', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // After Capture locks a file, the next save with edited content
  // must NOT trample the locked file — it writes a fresh `-N` name
  // and the new log record points at the new file. The original
  // file stays on disk untouched.
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  await capturePage.locator('#cap-html').check();

  // First capture — locks both filenames.
  await capturePage.locator('#capture').click({ modifiers: ['Shift'] });
  await expect(capturePage.locator('#ask-status')).toHaveText('Saved.', {
    timeout: 10_000,
  });

  // Edit the HTML body via the Edit-HTML dialog so the next save
  // sees a diverged revision.
  await capturePage.locator('#edit-html').click();
  await setEditorCode(
    capturePage.locator('#edit-html-textarea'),
    '<html><body><p>edited body</p></body></html>',
  );
  await capturePage.locator('#edit-html-save').click();
  await expect(capturePage.locator('#edit-html-dialog')).toHaveJSProperty(
    'open',
    false,
  );

  // Second capture against the edited HTML.
  await capturePage.locator('#capture').click({ modifiers: ['Shift'] });
  await expect(capturePage.locator('#ask-status')).toHaveText('Saved.', {
    timeout: 10_000,
  });

  const sw = await getServiceWorker();
  const logPath = await findCapturedDownload(sw, 'log.json');
  const lines = fs.readFileSync(logPath, 'utf8').trimEnd().split('\n');
  const records: CaptureRecord[] = lines
    .slice(-2)
    .map((l) => JSON.parse(l));

  // HTML filename diverges across the two saves — second carries
  // `-1` before the extension. Screenshot is unchanged so its
  // filename stays the same.
  expect(records[0].contents?.filename).toBeDefined();
  expect(records[1].contents?.filename).toBeDefined();
  expect(records[0].contents?.filename).not.toBe(records[1].contents?.filename);
  expect(records[1].contents?.filename).toMatch(/-1\.html$/);
  expect(records[0].screenshot?.filename).toBe(records[1].screenshot?.filename);

  // The base file from the first capture stays on disk untouched
  // (the bump means the second save lands at a different name).
  // The SW spy in `__seeDl` records every download by intended
  // filename, so two distinct contents-*.html entries means two
  // distinct files were written rather than one being overwritten.
  // (chrome.downloads.search reports random uuids as the basename
  // under headless test profiles, so it's not usable here for
  // filename assertions.)
  const downloadedBasenames = await sw.evaluate(() => {
    interface SpyState { __seeDl?: { id: number; name: string }[] }
    return ((self as unknown as SpyState).__seeDl ?? [])
      .map((d) => d.name.split(/[\\/]/).pop() ?? '');
  });
  expect(downloadedBasenames).toEqual(
    expect.arrayContaining([
      records[0].contents!.filename,
      records[1].contents!.filename,
    ]),
  );

  await capturePage.close();
  await openerPage.close();
});

// ─── Click modifier coverage ─────────────────────────────────────

test('details: ctrl-click capture closes the page (matches plain click default)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Ctrl-click is the explicit "close after the action" modifier.
  // For Capture that lines up with the plain-click default, but
  // pinning it here keeps the chord working if the default ever
  // changes (and is the symmetric counterpart of ctrl-click Ask,
  // which is the more interesting one).
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  await Promise.all([
    capturePage.waitForEvent('close'),
    capturePage.locator('#capture').click({ modifiers: ['Control'] }),
  ]);
  expect(capturePage.isClosed()).toBe(true);

  await openerPage.close();
});

test('details: shift+ctrl chord on capture keeps the page open (shift wins)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Documented chord precedence: shift wins over ctrl, leaning
  // toward the safer "don't disappear the preview" outcome.
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  await capturePage.locator('#capture').click({ modifiers: ['Shift', 'Control'] });
  await expect(capturePage.locator('#ask-status')).toHaveText('Saved.', {
    timeout: 10_000,
  });
  expect(capturePage.isClosed()).toBe(false);

  await capturePage.close();
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

// ─── Stale-page guard ─────────────────────────────────────────────

// Opening capture.html directly (no SW-side session for the tab) used
// to leave a half-rendered page with non-functional Capture / Ask
// buttons. The page now detects the empty `getDetailsData` response,
// hides every `[data-capture-main]` block, and reveals the
// #missing-session-error pane. The header (with Options) stays
// visible so the user has a working escape hatch.
test('details: direct load with no session shows error pane', async ({
  extensionContext,
  extensionId,
}) => {
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/capture.html`);

  const errorPane = page.locator('#missing-session-error');
  await expect(errorPane).toBeVisible();

  // Every main-content block is hidden (the `hidden` attribute is
  // set, so Playwright's `toBeHidden` resolves true).
  const mainBlocks = page.locator('[data-capture-main]');
  const count = await mainBlocks.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    await expect(mainBlocks.nth(i)).toBeHidden();
  }

  // Header is still visible — Options remains reachable.
  await expect(page.locator('#options-btn')).toBeVisible();

  await page.close();
});
