// E2E coverage for the edit dialogs on the Capture page — page
// contents HTML, selection HTML, selection text, selection
// markdown — plus the shared Edit/Preview toggle wiring and the
// graceful UX for a failed HTML/selection scrape (restricted URLs).
//
// What's tested here:
//   - Copy → edit → copy-overwrites → capture-is-no-op for both
//     the HTML and selection-HTML edit dialogs.
//   - Whitespace-only selection collapses the Save-selection group.
//   - Cancel leaves the capture untouched; Save with no changes is
//     a no-op; the `isEdited` flag is sticky across multiple edits.
//   - Preview toggle: sandboxed blob iframe, base target=_blank,
//     <script>/<meta refresh> stripping, malformed HTML recovery,
//     markdown rendering, script stripping in raw HTML inside md.
//   - HTML scrape failure still opens the Capture page with the
//     right rows disabled + error icons, and still allows a
//     url-only/prompt-only capture.
//
// Rich-text paste tests (paste-into-editors, source-view
// short-circuit, real copy/paste round-trips) live in
// `capture-paste.spec.ts`.


import fs from 'node:fs';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import {
  CONTENTS_PATTERN,
  SCREENSHOT_PATTERN,
  configureAndCapture,
  countDownloadsBySuffix,
  dragRect,
  findAllCapturedDownloads,
  findCapturedDownload,
  getEditorCode,
  installClipboardSpy,
  openDetailsFlow,
  readLatestRecord,
  seedSelection,
  setEditorCode,
  waitForClipboardWrites,
} from './details-helpers';
import { waitForDownloadPath } from '../fixtures/files';

// chrome.tabs.captureVisibleTab is rate-limited (~2/s per window).
// Each test in this file issues one capture via
// startCaptureWithDetails; without a small cushion the suite
// occasionally trips the quota.
test.beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 600));
});

test('details: edit-html dialog — copy, edit, copy-overwrites, capture is no-op', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await installClipboardSpy(capturePage);
  const sw = await getServiceWorker();

  // Step 1: Copy the HTML once *before* editing. The SW materializes
  // the raw scrape under the pinned `contents-*.html` filename and
  // puts its on-disk path on the clipboard. One download recorded.
  await capturePage.locator('#copy-html-name').click();
  await waitForClipboardWrites(capturePage, 1);
  expect(await countDownloadsBySuffix(sw, '.html')).toBe(1);

  // Step 2: Open the edit dialog and replace the body. The textarea
  // is seeded with the original capture — the fixture's purple
  // marker — and we swap it for a unique marker we can grep for.
  expect(await capturePage.locator('#edit-html-dialog').evaluate(
    (d) => (d as HTMLDialogElement).open,
  )).toBe(false);
  await capturePage.locator('#edit-html').click();
  expect(await capturePage.locator('#edit-html-dialog').evaluate(
    (d) => (d as HTMLDialogElement).open,
  )).toBe(true);
  const prefill = await getEditorCode(capturePage.locator('#edit-html-textarea'));
  expect(prefill).toContain('background: #800080');

  const EDITED = '<!doctype html><html><body>edited by test 42</body></html>';
  await setEditorCode(capturePage.locator('#edit-html-textarea'), EDITED);
  await capturePage.locator('#edit-html-save').click();
  await expect(capturePage.locator('#edit-html-dialog')).toHaveJSProperty(
    'open',
    false,
  );
  // The HTML-size badge reflects the new (much shorter) body.
  const sizeText = await capturePage.locator('#html-size-badge').innerText();
  expect(sizeText).toMatch(/^HTML · \d+ B$/);

  // Step 3: Copy again *after* editing. The edit invalidated the
  // cache, so the SW re-downloads — count goes to 2. The two
  // downloads must request the *same* pinned basename (production
  // overwrites in place via conflictAction: 'overwrite'), even
  // though the Playwright harness rewrites each temp path.
  await capturePage.locator('#copy-html-name').click();
  await waitForClipboardWrites(capturePage, 2);
  expect(await countDownloadsBySuffix(sw, '.html')).toBe(2);

  const htmlDownloads = await findAllCapturedDownloads(sw, 'contents-');
  expect(htmlDownloads).toHaveLength(2);
  expect(htmlDownloads[0].name).toBe(htmlDownloads[1].name);

  // The second download carries the edited bytes; the first
  // download's file still holds the original scrape since the
  // Playwright fixture gives each write its own UUID path.
  const firstPath = await waitForDownloadPath(sw, htmlDownloads[0].id);
  const secondPath = await waitForDownloadPath(sw, htmlDownloads[1].id);
  expect(fs.readFileSync(firstPath, 'utf8')).toContain('background: #800080');
  const editedBytes = fs.readFileSync(secondPath, 'utf8');
  expect(editedBytes).toContain('edited by test 42');
  expect(editedBytes).not.toContain('background: #800080');

  // Step 4: Capture with Save HTML on. The post-edit Copy already
  // wrote the edited file, so the SW's per-tab cache short-circuits
  // — no third download. Log records the pinned filename + edited
  // flag.
  await configureAndCapture(capturePage, {
    saveScreenshot: false,
    saveHtml: true,
  });
  expect(await countDownloadsBySuffix(sw, '.html')).toBe(2);

  const record = await readLatestRecord(sw);
  expect(record.contents?.filename).toMatch(CONTENTS_PATTERN);
  expect(record.contents?.isEdited).toBe(true);

  await openerPage.close();
});

// Whitespace-only variant: the scraped fragment's `innerHTML` is
// non-empty (so the SW sends us a `selections` object), but every
// format trims to empty. The Capture page must collapse the whole
// selection group to disabled + unchecked, not leave the master
// enabled with three dead radios underneath.
async function seedWhitespaceOnlySelection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const span = document.createElement('span');
    span.id = 'sel-seed';
    span.textContent = '   \n\t  ';
    document.body.appendChild(span);
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel!.removeAllRanges();
    sel!.addRange(range);
  });
}

test('details: whitespace-only selection disables the whole Save selection group', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    seedWhitespaceOnlySelection,
  );

  // Master checkbox stays disabled + unchecked, with the shared
  // selection-error icon explaining why.
  const selectionBox = capturePage.locator('#cap-selection');
  await expect(selectionBox).toBeDisabled();
  await expect(selectionBox).not.toBeChecked();
  await expect(capturePage.locator('#row-selection')).toHaveClass(/has-error/);
  await expect(capturePage.locator('#error-selection')).toHaveAttribute(
    'title',
    /Selection has no saveable content/,
  );

  // The whole format group is hidden; the per-format rows don't
  // surface at all so the user sees only the master's explanation.
  await expect(capturePage.locator('.selection-formats')).toBeHidden();

  await openerPage.close();
});

test('details: size badges track edit changes (HTML + Selection)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    seedSelection,
  );

  // Both pills paint with their initial sizes — HTML from the page
  // scrape, Selection from whichever format `loadData` picked first.
  // `[1-9]\d*` (instead of `\d+`) catches a degenerate empty seed
  // that would otherwise pass as `0 B`.
  await expect(capturePage.locator('#html-size-badge'))
    .toHaveText(/^HTML · [1-9]\d*\s*\S+$/);
  await expect(capturePage.locator('#selection-size-badge'))
    .toHaveText(/^Selection · [1-9]\d*\s*\S+$/);

  // Selection pill describes what was *captured*, not what's being
  // saved — toggling the master "Save selection" off should leave
  // the pill visible with its previous size (mirrors the HTML pill,
  // which doesn't hide when "Save HTML" is unchecked).
  const beforeUncheck = await capturePage.locator('#selection-size-badge').innerText();
  await capturePage.locator('#cap-selection').uncheck();
  await expect(capturePage.locator('#selection-size-badge')).toBeVisible();
  await expect(capturePage.locator('#selection-size-badge')).toHaveText(beforeUncheck);
  await capturePage.locator('#cap-selection').check();

  // Editing the HTML body updates the HTML pill to the new byte
  // count. The Edit dialog's Save commits `captured.html`, which
  // the badge's `formatBytes(...)` then reads on the post-save hook.
  const EDITED_HTML = '<!doctype html><html><body>x</body></html>';
  await capturePage.locator('#edit-html').click();
  await setEditorCode(capturePage.locator('#edit-html-textarea'), EDITED_HTML);
  await capturePage.locator('#edit-html-save').click();
  await expect(capturePage.locator('#edit-html-dialog')).toHaveJSProperty('open', false);
  await expect(capturePage.locator('#html-size-badge'))
    .toHaveText(`HTML · ${EDITED_HTML.length} B`);

  // Switch to the text radio so the Selection-text edit below is the
  // *active* format — the badge mirrors whichever radio is currently
  // checked, so editing a non-active format wouldn't move the
  // displayed value.
  await capturePage.locator('#cap-selection-text').check();

  // Editing the active selection body updates the Selection pill.
  // A single-character body gives a deterministic "1 B" target.
  await capturePage.locator('#edit-selection-text-btn').click();
  await setEditorCode(capturePage.locator('#edit-selection-text-textarea'), 'A');
  await capturePage.locator('#edit-selection-text-save').click();
  await expect(capturePage.locator('#edit-selection-text-dialog'))
    .toHaveJSProperty('open', false);
  await expect(capturePage.locator('#selection-size-badge'))
    .toHaveText('Selection · 1 B');

  await openerPage.close();
});

test('details: edit-selection dialog — copy, edit, copy-overwrites, capture is no-op', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    seedSelection,
  );
  await installClipboardSpy(capturePage);
  const sw = await getServiceWorker();

  // The Save-selection-as-HTML row was enabled by loadData (the SW
  // saw our seeded selection and the HTML format always has content
  // when the selection is non-empty), so the pencil button is
  // clickable rather than stuck in its disabled default state.
  // Pick HTML explicitly — this test exercises the HTML edit /
  // save flow, so we don't rely on which format loadData picked as
  // the initial default.
  await expect(capturePage.locator('#edit-selection-html-btn')).toBeEnabled();
  await capturePage.locator('#cap-selection-html').check();
  await expect(capturePage.locator('#cap-selection-html')).toBeChecked();

  // Step 1: Copy the selection HTML before editing — SW writes the
  // raw selection scrape under the pinned `selection-*.html` filename.
  await capturePage.locator('#copy-selection-html-name').click();
  await waitForClipboardWrites(capturePage, 1);
  expect(await countDownloadsBySuffix(sw, '.html')).toBe(1);

  // Step 2: Open the dialog and replace the selection body. The
  // textarea is seeded with what the SW scraped, which contains
  // our fixture's injected text.
  await capturePage.locator('#edit-selection-html-btn').click();
  expect(await capturePage.locator('#edit-selection-html-dialog').evaluate(
    (d) => (d as HTMLDialogElement).open,
  )).toBe(true);
  const prefill = await getEditorCode(
    capturePage.locator('#edit-selection-html-textarea'),
  );
  expect(prefill).toContain('hello selection world');

  const EDITED = '<p>selection edited by test 99</p>';
  await setEditorCode(
    capturePage.locator('#edit-selection-html-textarea'),
    EDITED,
  );
  await capturePage.locator('#edit-selection-html-save').click();
  await expect(capturePage.locator('#edit-selection-html-dialog')).toHaveJSProperty(
    'open',
    false,
  );

  // Step 3: Copy again → cache invalidated, second download fires,
  // pinned filename unchanged, new bytes on disk.
  await capturePage.locator('#copy-selection-html-name').click();
  await waitForClipboardWrites(capturePage, 2);
  expect(await countDownloadsBySuffix(sw, '.html')).toBe(2);

  const selDownloads = await findAllCapturedDownloads(sw, 'selection-');
  expect(selDownloads).toHaveLength(2);
  expect(selDownloads[0].name).toBe(selDownloads[1].name);

  const firstPath = await waitForDownloadPath(sw, selDownloads[0].id);
  const secondPath = await waitForDownloadPath(sw, selDownloads[1].id);
  expect(fs.readFileSync(firstPath, 'utf8')).toContain('hello selection world');
  const editedBytes = fs.readFileSync(secondPath, 'utf8');
  expect(editedBytes).toContain('selection edited by test 99');
  expect(editedBytes).not.toContain('hello selection world');

  // Step 4: Capture with Save selection as HTML on (default-checked
  // when a selection was detected). Cache hit → no third download.
  // Log's `selection` artifact carries `format: 'html'` and
  // `isEdited: true`.
  await configureAndCapture(capturePage, {
    saveScreenshot: false,
    saveHtml: false,
  });
  expect(await countDownloadsBySuffix(sw, '.html')).toBe(2);

  const record = await readLatestRecord(sw);
  expect(record.selection?.filename).toBeDefined();
  expect(record.selection?.format).toBe('html');
  expect(record.selection?.isEdited).toBe(true);

  await openerPage.close();
});

test('details: edit-selection cancel leaves the captured selection untouched', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    seedSelection,
  );

  // The edit flow under test targets the HTML selection body;
  // pick that format explicitly so we don't depend on which format
  // loadData chose as the initial default.
  await capturePage.locator('#cap-selection-html').check();

  await capturePage.locator('#edit-selection-html-btn').click();
  await setEditorCode(
    capturePage.locator('#edit-selection-html-textarea'),
    'DISCARDED NONSENSE',
  );
  await capturePage.locator('#edit-selection-html-cancel').click();
  await expect(capturePage.locator('#edit-selection-html-dialog')).toHaveJSProperty(
    'open',
    false,
  );

  await configureAndCapture(capturePage, {
    saveScreenshot: false,
    saveHtml: false,
  });

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  // No edit actually landed, so the sidecar's selection object
  // must not carry the sticky `isEdited` flag.
  expect(record.selection?.isEdited).toBeUndefined();

  const selPath = await findCapturedDownload(sw, '.html');
  const body = fs.readFileSync(selPath, 'utf8');
  expect(body).toContain('hello selection world');
  expect(body).not.toContain('DISCARDED NONSENSE');

  await openerPage.close();
});

test('details: edit-html cancel leaves the captured HTML untouched', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Open the dialog, type garbage, then hit Cancel. The captured
  // body on the SW side must be unchanged — the ensuing HTML save
  // should write the original fixture HTML, not our edits.
  await capturePage.locator('#edit-html').click();
  await setEditorCode(
    capturePage.locator('#edit-html-textarea'),
    'DISCARDED NONSENSE',
  );
  await capturePage.locator('#edit-html-cancel').click();
  expect(await capturePage.locator('#edit-html-dialog').evaluate(
    (d) => (d as HTMLDialogElement).open,
  )).toBe(false);

  await configureAndCapture(capturePage, {
    saveScreenshot: false,
    saveHtml: true,
  });

  const sw = await getServiceWorker();
  const contentsPath = await findCapturedDownload(sw, '.html');
  const html = fs.readFileSync(contentsPath, 'utf8');
  expect(html).toContain('background: #800080');
  expect(html).not.toContain('DISCARDED NONSENSE');

  await openerPage.close();
});

test('details: edit-html save-with-no-changes is a no-op (no SW round-trip, no isEdited flag)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await installClipboardSpy(capturePage);
  const sw = await getServiceWorker();

  // Pre-download the HTML so we have a baseline cache entry to watch.
  await capturePage.locator('#copy-html-name').click();
  await waitForClipboardWrites(capturePage, 1);
  expect(await countDownloadsBySuffix(sw, '.html')).toBe(1);

  // Open the dialog, touch nothing, click Save. The no-op guard
  // should skip the SW round-trip — so the cache stays committed
  // and no second download fires.
  await capturePage.locator('#edit-html').click();
  await capturePage.locator('#edit-html-save').click();
  await expect(capturePage.locator('#edit-html-dialog')).toHaveJSProperty('open', false);
  expect(await countDownloadsBySuffix(sw, '.html')).toBe(1);

  // Capture: still a cache hit, still no download; the sidecar must
  // NOT carry `isEdited: true` since no real edit happened.
  await configureAndCapture(capturePage, { saveScreenshot: false, saveHtml: true });
  expect(await countDownloadsBySuffix(sw, '.html')).toBe(1);

  const record = await readLatestRecord(sw);
  expect(record.contents?.filename).toMatch(CONTENTS_PATTERN);
  expect(record.contents?.isEdited).toBeUndefined();

  await openerPage.close();
});

test('details: edit → edit → save keeps isEdited: true across multiple dialog opens', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // First edit cycle: replace body with marker A.
  await capturePage.locator('#edit-html').click();
  await setEditorCode(
    capturePage.locator('#edit-html-textarea'),
    '<html><body>first edit A</body></html>',
  );
  await capturePage.locator('#edit-html-save').click();
  await expect(capturePage.locator('#edit-html-dialog')).toHaveJSProperty('open', false);

  // Reopen: the dialog should seed from the edited body, not the
  // original scrape. Replace again with marker B.
  await capturePage.locator('#edit-html').click();
  const seededFromFirstEdit = await getEditorCode(
    capturePage.locator('#edit-html-textarea'),
  );
  expect(seededFromFirstEdit).toContain('first edit A');
  await setEditorCode(
    capturePage.locator('#edit-html-textarea'),
    '<html><body>second edit B</body></html>',
  );
  await capturePage.locator('#edit-html-save').click();
  await expect(capturePage.locator('#edit-html-dialog')).toHaveJSProperty('open', false);

  await configureAndCapture(capturePage, { saveScreenshot: false, saveHtml: true });

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  // Sticky across multiple edit cycles — one Save already flipped
  // the flag, and a later Save can't unset it.
  expect(record.contents?.isEdited).toBe(true);

  const contentsPath = await findCapturedDownload(sw, '.html');
  const html = fs.readFileSync(contentsPath, 'utf8');
  expect(html).toContain('second edit B');
  expect(html).not.toContain('first edit A');

  await openerPage.close();
});

// All three previewable Edit dialogs (page contents HTML, selection
// HTML, selection markdown) expose the Edit/Preview toggle. The
// preview wiring is identical, so we run the same matrix of
// assertions for each kind — opening via the kind-specific pencil
// button and asserting against the kind-specific DOM ids. The
// selection variants need a seeded selection so their rows (and
// pencils) come out enabled. Markdown gets a markdown-shaped input
// that still renders an <h1> so the shared assertions apply.
interface PreviewCase {
  kind: 'html' | 'selection-html' | 'selection-markdown';
  openBtnId: string;
  slug: string;
  /** Optional opener hook to inject a live selection. */
  beforeCapture?: (page: Page) => Promise<void>;
  /** Produce the textarea body for this case. HTML kinds get an
   *  HTML fragment; markdown gets markdown source. Both must render
   *  an `<h1>` containing `marker` plus a link so the shared
   *  assertions (h1 text, base target=_blank) all apply. */
  makeInput: (marker: string) => string;
}

const PREVIEW_CASES: PreviewCase[] = [
  {
    kind: 'html',
    openBtnId: '#edit-html',
    slug: 'html',
    makeInput: (m) =>
      `<html><body><h1>${m}</h1><a href="foo.html">link</a></body></html>`,
  },
  {
    kind: 'selection-html',
    openBtnId: '#edit-selection-html-btn',
    slug: 'selection-html',
    beforeCapture: seedSelection,
    makeInput: (m) =>
      `<html><body><h1>${m}</h1><a href="foo.html">link</a></body></html>`,
  },
  {
    kind: 'selection-markdown',
    openBtnId: '#edit-selection-markdown-btn',
    slug: 'selection-markdown',
    beforeCapture: seedSelection,
    makeInput: (m) => `# ${m}\n\n[link](foo.html)\n`,
  },
];

for (const c of PREVIEW_CASES) {
  test(`details: ${c.kind} edit dialog preview mode renders the current textarea via a sandboxed iframe`, async ({
    extensionContext,
    fixtureServer,
    getServiceWorker,
  }) => {
    const { openerPage, capturePage } = await openDetailsFlow(
      extensionContext,
      fixtureServer,
      getServiceWorker,
      'purple.html',
      c.beforeCapture,
    );

    const editBtnSel = `#edit-${c.slug}-mode-edit`;
    const previewBtnSel = `#edit-${c.slug}-mode-preview`;
    const textareaSel = `#edit-${c.slug}-textarea`;
    const iframeSel = `#edit-${c.slug}-preview`;

    await capturePage.locator(c.openBtnId).click();

    // Edit is selected by default; Preview is not. The iframe is
    // hidden, the textarea visible.
    await expect(capturePage.locator(editBtnSel)).toHaveClass(/selected/);
    await expect(capturePage.locator(previewBtnSel)).not.toHaveClass(/selected/);
    await expect(capturePage.locator(textareaSel)).toBeVisible();
    await expect(capturePage.locator(iframeSel)).toBeHidden();

    // Replace the body with a unique marker so we can check it
    // renders via the preview iframe. HTML kinds get HTML; the
    // markdown kind gets markdown — both produce an <h1> containing
    // the marker and a link, so the downstream assertions are
    // shared.
    const MARKER = `preview-marker-${c.slug}-9817`;
    await setEditorCode(capturePage.locator(textareaSel), c.makeInput(MARKER));

    // Flip to Preview. The iframe shows, the toggle's selected state
    // flips. The editor stays in the DOM (kept as layout anchor)
    // but is hidden via `visibility: hidden`, so its bounding box
    // persists — the dialog's dimensions can't jump across modes.
    await capturePage.locator(previewBtnSel).click();
    await expect(capturePage.locator(previewBtnSel)).toHaveClass(/selected/);
    await expect(capturePage.locator(editBtnSel)).not.toHaveClass(/selected/);
    await expect(capturePage.locator(iframeSel)).toBeVisible();
    expect(await capturePage.locator(textareaSel).evaluate(
      (el) => getComputedStyle(el).visibility,
    )).toBe('hidden');

    // The iframe uses a blob: URL (srcdoc has an attribute size limit
    // that truncates large captures), with sandbox tokens that allow
    // popups but deny scripts / same-origin / forms / top navigation.
    const src = await capturePage.locator(iframeSel).getAttribute('src');
    expect(src).toMatch(/^blob:/);
    const sandboxTokens = await capturePage.locator(iframeSel)
      .getAttribute('sandbox');
    expect(sandboxTokens).toBe('allow-popups allow-popups-to-escape-sandbox');

    // The rendered iframe actually shows the marker content, the
    // injected <base> is in <head> with href + target=_blank, and a
    // forced <meta charset="utf-8"> is in place so non-ASCII content
    // doesn't mojibake under the blob's default charset.
    const iframe = capturePage.frameLocator(iframeSel);
    await expect(iframe.locator('h1')).toHaveText(MARKER);
    await expect(iframe.locator('head meta[charset="utf-8"]')).toHaveCount(1);
    const baseAttrs = await iframe.locator('head > base').first().evaluate(
      (el) => ({
        href: el.getAttribute('href') ?? '',
        target: el.getAttribute('target') ?? '',
      }),
    );
    expect(baseAttrs.target).toBe('_blank');
    expect(baseAttrs.href).toMatch(/^http:\/\//);

    // Flip back to Edit: textarea is visible again, edits are
    // preserved, iframe's src is dropped so we're not retaining the
    // blob.
    await capturePage.locator(editBtnSel).click();
    await expect(capturePage.locator(textareaSel)).toBeVisible();
    await expect(capturePage.locator(iframeSel)).toBeHidden();
    expect(await getEditorCode(capturePage.locator(textareaSel)))
      .toContain(MARKER);
    expect(await capturePage.locator(iframeSel).getAttribute('src'))
      .toBeNull();

    await openerPage.close();
  });
}

test('details: preview strips <script> and <meta http-equiv=refresh>', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Input with two known hijack vectors: inline script (neutralized
  // by the iframe sandbox anyway, but we strip for defense in depth)
  // and a meta refresh that would otherwise navigate the iframe to
  // an attacker URL without any script needed.
  const MARKER = 'safe-marker-8842';
  const HOSTILE = `
    <html><head>
      <meta http-equiv="refresh" content="0; url=https://evil.example/">
      <meta http-equiv="REFRESH" content="1">
      <meta http-equiv="Content-Type" content="text/html">
    </head><body>
      <h1>${MARKER}</h1>
      <script>document.body.innerHTML = 'pwned'</script>
      <script src="https://evil.example/beacon.js"></script>
    </body></html>
  `;
  await capturePage.locator('#edit-html').click();
  await setEditorCode(capturePage.locator('#edit-html-textarea'), HOSTILE);
  await capturePage.locator('#edit-html-mode-preview').click();

  const iframe = capturePage.frameLocator('#edit-html-preview');
  // Marker content still renders.
  await expect(iframe.locator('h1')).toHaveText(MARKER);
  // Both <script> tags removed (inline + src).
  await expect(iframe.locator('script')).toHaveCount(0);
  // Both <meta http-equiv=refresh> tags removed (case-insensitive
  // match covers the uppercase variant). The benign Content-Type
  // meta is also stripped because `buildPreviewHtml` removes any
  // Content-Type-style meta before injecting its own charset — so
  // the only http-equiv meta left is ours (if any). In practice
  // there is none, since we inject `<meta charset>` not http-equiv.
  await expect(iframe.locator('meta[http-equiv="refresh" i]')).toHaveCount(0);

  await openerPage.close();
});

test('details: preview tolerates malformed HTML and still renders content', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Deliberately broken input: unclosed tags, mismatched close tags,
  // stray `<span>` close, a truncated comment, and a mismatched
  // quote. DOMParser's `text/html` mode + the browser's tolerant
  // parser recover to something sensible; the preview should still
  // display the marker text instead of going blank.
  const MARKER = 'malformed-marker-5523';
  const BROKEN = `<p>before<div><h1>${MARKER}</h1></span>after</p><!--oops`;
  await capturePage.locator('#edit-html').click();
  await setEditorCode(capturePage.locator('#edit-html-textarea'), BROKEN);
  await capturePage.locator('#edit-html-mode-preview').click();

  const iframe = capturePage.frameLocator('#edit-html-preview');
  // H1 still rendered.
  await expect(iframe.locator('h1')).toHaveText(MARKER);
  // Neighboring text nodes survived the recovery.
  await expect(iframe.locator('body')).toContainText('before');
  await expect(iframe.locator('body')).toContainText('after');

  await openerPage.close();
});

test('details: non-HTML edit dialogs (selection text) have no Preview toggle', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // The toggle is rendered hidden by default in the template and
  // only revealed by `setMode(..)` for previewable kinds, so it's
  // enough to assert the selection-text dialog's toggle stays
  // hidden — no need to open the dialog or seed a selection.
  const toggle = capturePage.locator(
    '#edit-selection-text-dialog .edit-dialog-mode-toggle',
  );
  await expect(toggle).toBeHidden();

  await openerPage.close();
});

test('details: selection-markdown preview renders markdown syntax as HTML', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    seedSelection,
  );

  // Markdown input exercising the syntax we most care about:
  // heading, strong, link, and a code fence. marked renders these
  // to <h1>/<strong>/<a>/<pre><code>; the iframe sandbox + our
  // buildPreviewHtml sanitizer keep any embedded raw HTML from
  // executing.
  const MARKER = 'md-preview-marker-7321';
  const MD = [
    `# ${MARKER}`,
    '',
    'Some **bold** text and a [link](https://example.test/).',
    '',
    '```',
    'code block',
    '```',
  ].join('\n');
  await capturePage.locator('#edit-selection-markdown-btn').click();
  await setEditorCode(capturePage.locator('#edit-selection-markdown-textarea'), MD);
  await capturePage.locator('#edit-selection-markdown-mode-preview').click();

  const iframe = capturePage.frameLocator('#edit-selection-markdown-preview');
  await expect(iframe.locator('h1')).toHaveText(MARKER);
  await expect(iframe.locator('strong')).toHaveText('bold');
  const link = iframe.locator('a[href="https://example.test/"]');
  await expect(link).toHaveText('link');
  await expect(iframe.locator('pre code')).toContainText('code block');

  // Confirm we're going through the same blob + sandbox pipeline as
  // the HTML previews so <base target="_blank"> still opens links
  // in a new tab.
  const src = await capturePage.locator('#edit-selection-markdown-preview')
    .getAttribute('src');
  expect(src).toMatch(/^blob:/);
  const baseTarget = await iframe.locator('head > base').first().evaluate(
    (el) => el.getAttribute('target') ?? '',
  );
  expect(baseTarget).toBe('_blank');

  await openerPage.close();
});

test('details: selection-markdown preview strips <script> from raw HTML inside markdown', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    seedSelection,
  );

  // marked preserves raw HTML blocks in markdown, so a user-supplied
  // markdown file containing a <script> reaches the preview before
  // the sanitizer runs. buildPreviewHtml must still strip it (and
  // the sandbox denies `allow-scripts` regardless).
  const MARKER = 'md-hostile-marker-4419';
  const MD = [
    `# ${MARKER}`,
    '',
    '<script>window.top.location = "https://evil.example/"</script>',
  ].join('\n');
  await capturePage.locator('#edit-selection-markdown-btn').click();
  await setEditorCode(capturePage.locator('#edit-selection-markdown-textarea'), MD);
  await capturePage.locator('#edit-selection-markdown-mode-preview').click();

  const iframe = capturePage.frameLocator('#edit-selection-markdown-preview');
  await expect(iframe.locator('h1')).toHaveText(MARKER);
  await expect(iframe.locator('script')).toHaveCount(0);

  await openerPage.close();
});

// ─── Graceful handling of failed HTML / selection scrape ──────────
//
// `chrome.scripting.executeScript` fails on restricted URLs
// (chrome://, the Web Store, file:// without explicit opt-in, etc.)
// — the Capture page flow must still open, with Save HTML + Save
// selection disabled and error icons explaining why, so the user
// can still take a URL- / screenshot- / prompt-only capture with
// annotations. We simulate the failure by stubbing executeScript in
// the SW; driving an actual chrome:// page from Playwright is
// flaky across headless modes.

async function openDetailsFlowWithFailedScrape(
  extensionContext: BrowserContext,
  fixtureServer: { baseUrl: string },
  getServiceWorker: () => Promise<Worker>,
  errorMessage: string,
): Promise<{ openerPage: Page; capturePage: Page }> {
  const sw0 = await getServiceWorker();
  await sw0.evaluate((msg) => {
    interface ScrapeSpy {
      __seeScrapeOrig?: typeof chrome.scripting.executeScript;
    }
    const g = self as unknown as ScrapeSpy;
    if (!g.__seeScrapeOrig) {
      g.__seeScrapeOrig = chrome.scripting.executeScript.bind(chrome.scripting);
    }
    (chrome.scripting as { executeScript: typeof chrome.scripting.executeScript }).executeScript =
      (async () => {
        throw new Error(msg);
      }) as typeof chrome.scripting.executeScript;
  }, errorMessage);

  try {
    return await openDetailsFlow(extensionContext, fixtureServer, getServiceWorker);
  } finally {
    // Restore executeScript on its way out so later tests in the
    // worker see normal scraping again.
    const sw = await getServiceWorker();
    await sw.evaluate(() => {
      interface ScrapeSpy {
        __seeScrapeOrig?: typeof chrome.scripting.executeScript;
      }
      const g = self as unknown as ScrapeSpy;
      if (g.__seeScrapeOrig) {
        (chrome.scripting as { executeScript: typeof chrome.scripting.executeScript }).executeScript =
          g.__seeScrapeOrig;
      }
    });
  }
}

test('details: html scrape failure still opens the page with HTML/selection disabled + error icons', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const reason = 'Cannot access contents of the page';
  const { openerPage, capturePage } = await openDetailsFlowWithFailedScrape(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    reason,
  );

  // Save HTML is disabled + unchecked, its Copy and Edit buttons are
  // disabled (and hidden via the shared `.copy-btn:disabled` rule),
  // and the row carries the `has-error` class + a tooltip explaining
  // what went wrong.
  const htmlBox = capturePage.locator('#cap-html');
  await expect(htmlBox).toBeDisabled();
  await expect(htmlBox).not.toBeChecked();
  await expect(capturePage.locator('#copy-html-name')).toBeDisabled();
  await expect(capturePage.locator('#edit-html')).toBeDisabled();
  await expect(capturePage.locator('#row-html')).toHaveClass(/has-error/);
  await expect(capturePage.locator('#error-html')).toHaveAttribute(
    'title',
    new RegExp(`Unable to capture HTML contents.*${reason}`),
  );

  // Master "Save selection" checkbox stays in its default
  // greyed-out state. The failure was the same `executeScript`
  // call, so the HTML row's error already explains it; a
  // duplicate icon on the selection master row would just be
  // noise. We do NOT add `has-error` and do NOT set any
  // selection-error tooltip in this case.
  const selectionBox = capturePage.locator('#cap-selection');
  await expect(selectionBox).toBeDisabled();
  await expect(selectionBox).not.toBeChecked();
  await expect(capturePage.locator('#row-selection')).not.toHaveClass(/has-error/);
  await expect(capturePage.locator('#error-selection')).toHaveAttribute('title', '');

  // With no selection at all the whole format group is hidden —
  // the per-format rows don't surface in any scrape-failure path.
  await expect(capturePage.locator('.selection-formats')).toBeHidden();

  // Screenshot + prompt + highlights remain functional: drawing a
  // rectangle and saving the screenshot + prompt should still produce
  // a normal record.
  await dragRect(
    capturePage,
    { xPct: 0.2, yPct: 0.2 },
    { xPct: 0.4, yPct: 0.4 },
  );
  await capturePage.locator('#prompt-text').fill('scrape failed but I can still use this');
  await Promise.all([
    capturePage.waitForEvent('close'),
    capturePage.locator('#capture').click(),
  ]);

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.screenshot?.filename).toMatch(SCREENSHOT_PATTERN);
  expect(record.screenshot?.hasHighlights).toBe(true);
  expect(record.contents).toBeUndefined();
  expect(record.selection).toBeUndefined();
  expect(record.prompt).toBe('scrape failed but I can still use this');

  await openerPage.close();
});

test('details: html scrape failure allows url-only capture (no checkboxes)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlowWithFailedScrape(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'restricted url',
  );

  await configureAndCapture(capturePage, {
    saveScreenshot: false,
    saveHtml: false,
    prompt: 'just the url please',
  });

  const sw = await getServiceWorker();
  const record = await readLatestRecord(sw);
  expect(record.screenshot).toBeUndefined();
  expect(record.contents).toBeUndefined();
  expect(record.selection).toBeUndefined();
  expect(record.prompt).toBe('just the url please');
  expect(record.url).toBe(`${fixtureServer.baseUrl}/purple.html`);

  await openerPage.close();
});
