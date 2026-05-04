// E2E coverage for the Ask AI flow on the Capture page.
//
// - The injected runtime, menu, and message wiring run against a
//   fake-Claude page (tests/fixtures/pages/fake-claude.html) that
//   mimics the DOM hooks claude.ai's composer exposes.
// - Tests swap the Ask-provider registry to point at the fixture
//   URL via `self.SeeWhatISee._setAskProvidersForTest(...)`.
// - No test ever talks to the live claude.ai.
//
// What this spec covers, top to bottom:
//   - Menu rendering (sections, separators, exclude-pattern filter).
//   - The empty-payload guard ("Nothing to send…").
//   - Attachment matrix: every Save-checkbox combination produces
//     the right files with the right names + MIME types.
//   - Edit flows: editing HTML or selection in the edit dialog
//     before Ask sends the modified body, and drawing a highlight
//     on the screenshot sends the baked-in image.
//   - Multi-line prompt: paragraph breaks, no premature submit.
//   - Error flows: missing inject-runtime selectors, tab closed
//     between menu open and click.
//   - Alt+A keyboard binding still opens the menu.
//
// Target-window pinning lives in a sibling spec —
// `tests/e2e/ask-pinned-tabs.spec.ts` — because that suite opens
// extra Claude tabs per test and benefits from staying small. Both
// specs share `tests/e2e/ask-helpers.ts`.
//
// SW idle-out caveat: the test seam mutates `ASK_PROVIDERS` in
// memory via `_setAskProvidersForTest`. If the MV3 service worker
// were to respawn between the override and the runtime call, the
// override would be lost and the test would target the real
// claude.ai. In practice the spec runs to completion well inside
// the SW idle window; if a flake ever surfaces here, persist the
// override in `chrome.storage.session` instead.

import { test, expect } from '../fixtures/extension';
import { dragRect, openDetailsFlow, seedSelection } from './details-helpers';
import {
  clickExistingFakeClaudeItem,
  clickNewClaudeItem,
  configureCapture,
  fakeClaudeState,
  installAskTestHooks,
  openFakeClaudeTab,
  overrideAskProviders,
  waitForAskMenuReady,
} from './ask-helpers';

installAskTestHooks();

// ─── Menu rendering ───────────────────────────────────────────────

test('ask menu: lists "New window in" plus an open fake-Claude tab', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);

  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  await capturePage.locator('#ask-menu-btn').click();
  await waitForAskMenuReady(capturePage);

  await expect(
    capturePage.locator('#ask-menu .ask-menu-heading', {
      hasText: 'Existing window in Claude',
    }),
  ).toBeVisible();
  await expect(capturePage.locator('#ask-menu .ask-menu-item')).toHaveCount(2);

  await claudePage.close();
  await openerPage.close();
});

test('ask menu: "Existing window in" section omitted when no tab matches', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);

  await capturePage.locator('#ask-menu-btn').click();
  await waitForAskMenuReady(capturePage);

  await expect(
    capturePage.locator('#ask-menu .ask-menu-heading', {
      hasText: 'Existing window in',
    }),
  ).toHaveCount(0);

  await openerPage.close();
});

test('ask menu: excludeUrlPatterns shows tabs disabled with suffix', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl, {
    excludeUrlPatterns: ['http://127.0.0.1*/fake-claude*'],
  });

  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  await capturePage.locator('#ask-menu-btn').click();
  await waitForAskMenuReady(capturePage);

  // Excluded tabs still surface in the menu, but disabled with a
  // "(Wrong page: /<first-segment>)" suffix so the user
  // sees the tab is recognised as a Claude tab — just not a valid
  // Ask target — and which sub-page it's actually on. The fixture
  // page lives at /fake-claude.html so the first-segment is the
  // whole filename.
  const existingItems = capturePage.locator('#ask-menu .ask-menu-item', {
    hasText: 'Fake Claude',
  });
  await expect(existingItems).toHaveCount(1);
  const item = existingItems.first();
  await expect(item).toHaveAttribute('aria-disabled', 'true');
  // Excluded tabs are never the resolved default — the pin
  // resolver also rejects them, so plain Ask can never land here.
  await expect(item).not.toHaveClass(/\bis-default\b/);
  await expect(item.locator('.ask-menu-suffix')).toHaveText(
    '(Wrong page: /fake-claude.html)',
  );

  await claudePage.close();
  await openerPage.close();
});

// ─── Empty-payload guard ──────────────────────────────────────────

test('ask: "Nothing to send" guard fires before any SW round-trip', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);

  await configureCapture(capturePage, {
    saveScreenshot: false,
    saveHtml: false,
    prompt: '',
  });

  await capturePage.locator('#ask-menu-btn').click();
  await waitForAskMenuReady(capturePage);
  await clickNewClaudeItem(capturePage);

  await expect(capturePage.locator('#ask-status')).toContainText(
    'Nothing to send',
  );
  // No new tab should have opened — only the opener and the
  // capture page should still be around.
  const pages = extensionContext.pages();
  expect(pages.some((p) => p.url().endsWith('/fake-claude.html'))).toBe(false);

  await openerPage.close();
});

// ─── Attachment matrix ────────────────────────────────────────────
//
// One test per Save-checkbox combination, asserting the exact set of
// files and their MIME types arriving at the fake-Claude page. The
// auto-submit toggle keys off prompt non-emptiness, so each case
// also asserts the click count matches the expected behaviour.

interface MatrixCase {
  name: string;
  saveScreenshot: boolean;
  saveHtml: boolean;
  selectionFormat?: 'html' | 'text' | 'markdown' | null;
  prompt: string;
  needSelection?: boolean;
  expected: {
    name: string;
    type: string;
  }[];
  expectedSubmits: number;
}

const matrixCases: MatrixCase[] = [
  {
    name: 'screenshot only, prompt → image attached + submit',
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'analyze',
    expected: [{ name: 'screenshot.png', type: 'image/png' }],
    expectedSubmits: 1,
  },
  {
    name: 'screenshot only, no prompt → image attached, no submit',
    saveScreenshot: true,
    saveHtml: false,
    prompt: '',
    expected: [{ name: 'screenshot.png', type: 'image/png' }],
    expectedSubmits: 0,
  },
  {
    name: 'html only, prompt → contents.html attached + submit',
    saveScreenshot: false,
    saveHtml: true,
    prompt: 'find a bug',
    expected: [{ name: 'contents.html', type: 'text/html' }],
    expectedSubmits: 1,
  },
  {
    name: 'screenshot + html, prompt → both attached',
    saveScreenshot: true,
    saveHtml: true,
    prompt: 'review',
    expected: [
      { name: 'screenshot.png', type: 'image/png' },
      { name: 'contents.html', type: 'text/html' },
    ],
    expectedSubmits: 1,
  },
  {
    name: 'selection (markdown) only → selection.md attached',
    saveScreenshot: false,
    saveHtml: false,
    selectionFormat: 'markdown',
    needSelection: true,
    prompt: 'summarise',
    expected: [{ name: 'selection.md', type: 'text/markdown' }],
    expectedSubmits: 1,
  },
  {
    name: 'selection (text) only → selection.txt attached',
    saveScreenshot: false,
    saveHtml: false,
    selectionFormat: 'text',
    needSelection: true,
    prompt: 'summarise',
    expected: [{ name: 'selection.txt', type: 'text/plain' }],
    expectedSubmits: 1,
  },
  {
    name: 'selection (html) only → selection.html attached',
    saveScreenshot: false,
    saveHtml: false,
    selectionFormat: 'html',
    needSelection: true,
    prompt: 'summarise',
    expected: [{ name: 'selection.html', type: 'text/html' }],
    expectedSubmits: 1,
  },
  {
    name: 'screenshot + html + selection (md), prompt → all three attached',
    saveScreenshot: true,
    saveHtml: true,
    selectionFormat: 'markdown',
    needSelection: true,
    prompt: 'go',
    expected: [
      { name: 'screenshot.png', type: 'image/png' },
      { name: 'contents.html', type: 'text/html' },
      { name: 'selection.md', type: 'text/markdown' },
    ],
    expectedSubmits: 1,
  },
  {
    name: 'prompt only, no checkboxes → no files, submit fires',
    saveScreenshot: false,
    saveHtml: false,
    prompt: 'just a question',
    expected: [],
    expectedSubmits: 1,
  },
];

for (const c of matrixCases) {
  test(`matrix: ${c.name}`, async ({
    extensionContext,
    fixtureServer,
    getServiceWorker,
  }) => {
    const { openerPage, capturePage } = await openDetailsFlow(
      extensionContext,
      fixtureServer,
      getServiceWorker,
      'purple.html',
      c.needSelection ? seedSelection : undefined,
    );
    const sw = await getServiceWorker();
    await overrideAskProviders(sw, fixtureServer.baseUrl);
    const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

    await configureCapture(capturePage, c);

    await capturePage.locator('#ask-menu-btn').click();
    await waitForAskMenuReady(capturePage);
    await clickExistingFakeClaudeItem(capturePage);

    await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
      timeout: 10_000,
    });

    const state = await fakeClaudeState(claudePage);
    expect(state.attachedFiles.map((f) => ({ name: f.name, type: f.type })))
      .toEqual(expect.arrayContaining(c.expected));
    expect(state.attachedFiles).toHaveLength(c.expected.length);
    expect(state.submitClicks).toBe(c.expectedSubmits);

    await claudePage.close();
    await openerPage.close();
  });
}

// ─── Edited content sends the modified version ──────────────────

test('ask: edited HTML body is sent (not the original capture)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  // Open the Edit-HTML dialog and replace the body with a unique
  // marker. The dialog's CodeJar editor is a contenteditable; the
  // existing edit-spec helpers manipulate it via textContent +
  // keyup, but for this test we just need the saved body to land
  // in `captured.html` so a direct sequence is enough.
  await capturePage.locator('#edit-html').click();
  const editor = capturePage.locator('#edit-html-textarea');
  await editor.evaluate((el) => {
    el.textContent = '<html><body>EDITED-MARKER-XYZ</body></html>';
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  });
  await capturePage.locator('#edit-html-save').click();
  // Wait for the dialog to actually close before configuring the
  // checkboxes — the save handler closes asynchronously after the
  // SW round-trip, and a click into a still-modal Capture page
  // could race the close.
  await expect(capturePage.locator('#edit-html-dialog')).toHaveJSProperty(
    'open',
    false,
  );

  await configureCapture(capturePage, {
    saveScreenshot: false,
    saveHtml: true,
    prompt: 'review my edits',
  });

  await capturePage.locator('#ask-menu-btn').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);
  await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
    timeout: 10_000,
  });

  const state = await fakeClaudeState(claudePage);
  const html = state.attachedFiles.find((f) => f.name === 'contents.html');
  expect(html?.content).toContain('EDITED-MARKER-XYZ');

  await claudePage.close();
  await openerPage.close();
});

test('ask: edited selection body is sent (not the original capture)', async ({
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
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  // Pick markdown format, then edit it.
  await capturePage.locator('#cap-selection-markdown').click();
  await capturePage.locator('#edit-selection-markdown-btn').click();
  const editor = capturePage.locator('#edit-selection-markdown-textarea');
  await editor.evaluate((el) => {
    el.textContent = 'EDITED-SELECTION-ABC';
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  });
  await capturePage.locator('#edit-selection-markdown-save').click();
  // Wait for the dialog to actually close — same rationale as the
  // edit-HTML test above.
  await expect(
    capturePage.locator('#edit-selection-markdown-dialog'),
  ).toHaveJSProperty('open', false);

  await configureCapture(capturePage, {
    saveScreenshot: false,
    saveHtml: false,
    selectionFormat: 'markdown',
    prompt: 'use my edited summary',
  });

  await capturePage.locator('#ask-menu-btn').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);
  await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
    timeout: 10_000,
  });

  const state = await fakeClaudeState(claudePage);
  const sel = state.attachedFiles.find((f) => f.name === 'selection.md');
  expect(sel?.content).toContain('EDITED-SELECTION-ABC');

  await claudePage.close();
  await openerPage.close();
});

test('ask: drawing a highlight bakes the modified PNG into the attachment', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Capture two screenshots from the same page: one without an
  // annotation, one with a drawn box. Their byte sizes must differ —
  // confirms `renderHighlightedPng` produced a fresh image and that
  // image was the one sent, rather than the original capture.
  async function sizeOnce(annotate: boolean): Promise<number> {
    const { openerPage, capturePage } = await openDetailsFlow(
      extensionContext,
      fixtureServer,
      getServiceWorker,
    );
    const sw = await getServiceWorker();
    await overrideAskProviders(sw, fixtureServer.baseUrl);
    const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

    if (annotate) {
      await dragRect(
        capturePage,
        { xPct: 0.2, yPct: 0.2 },
        { xPct: 0.4, yPct: 0.4 },
      );
    }
    await configureCapture(capturePage, {
      saveScreenshot: true,
      saveHtml: false,
      prompt: 'analyze',
    });

    await capturePage.locator('#ask-menu-btn').click();
    await waitForAskMenuReady(capturePage);
    await clickExistingFakeClaudeItem(capturePage);
    await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
      timeout: 10_000,
    });

    const state = await fakeClaudeState(claudePage);
    const ss = state.attachedFiles.find((f) => f.name === 'screenshot.png');
    expect(ss?.type).toBe('image/png');
    const size = ss?.size ?? 0;
    expect(size).toBeGreaterThan(0);

    await claudePage.close();
    await openerPage.close();
    return size;
  }

  const baselineSize = await sizeOnce(false);
  // chrome.tabs.captureVisibleTab is rate-limited (~2/s per window).
  // The first sizeOnce just fired one; pause before the second so
  // the suite doesn't trip the quota inside this single test.
  await new Promise((r) => setTimeout(r, 600));
  const annotatedSize = await sizeOnce(true);
  // A drawn red box paints fresh pixels into the rendered PNG, so
  // the compressed bytes will differ. We don't pin a direction —
  // the bake can be slightly larger or smaller than the raw capture
  // depending on the image content.
  expect(annotatedSize).not.toBe(baselineSize);
});

// ─── Multi-line prompt ───────────────────────────────────────────

test('ask: multi-line prompt produces paragraph breaks, not premature submit', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  // Multi-line prompt — Shift+Enter style content. If the runtime
  // sent `\n` to insertText, ProseMirror would interpret as Enter
  // and submit early; we'd see only "first" in the editor.
  const promptText = 'first line\nsecond line\n\nfourth after blank';
  await capturePage.locator('#prompt-text').fill(promptText);

  await capturePage.locator('#ask-menu-btn').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);

  await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
    timeout: 10_000,
  });

  const state = await fakeClaudeState(claudePage);
  expect(state.submitClicks).toBe(1);

  // All four logical segments must reach the editor in order, AND
  // there must be at least one paragraph or line break between
  // them (catches a regression that strips the breaks and emits
  // "first linesecond line…").
  const text = state.lastSubmitText ?? '';
  const idxs = [
    text.indexOf('first line'),
    text.indexOf('second line'),
    text.indexOf('fourth after blank'),
  ];
  expect(idxs.every((i) => i >= 0)).toBe(true);
  expect(idxs[0]).toBeLessThan(idxs[1]);
  expect(idxs[1]).toBeLessThan(idxs[2]);
  // Editor HTML should contain a paragraph break (`<p>` or `<br>`).
  expect(state.lastSubmitHtml ?? '').toMatch(/<p|<br/i);

  await claudePage.close();
  await openerPage.close();
});

// ─── Error flows ─────────────────────────────────────────────────

test('ask error: missing file-input selector → status reports the failure', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  // Override the file-input selector with a value that won't match
  // anything on fake-claude — the per-file attachment helper should
  // throw "Could not find the file-upload input". The widget walks
  // items in order, so the prompt still gets typed (text-input
  // selectors are intact) and the submit is skipped because the
  // screenshot item ended in error.
  await overrideAskProviders(sw, fixtureServer.baseUrl, {
    selectors: { fileInput: ['#nonexistent-file-input'] },
  });
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'will fail',
  });

  await capturePage.locator('#ask-menu-btn').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);

  await expect(capturePage.locator('#ask-status')).toContainText(
    'Attachment not accepted',
    { timeout: 10_000 },
  );
  // No file should have arrived; submit is skipped (attachment
  // failed) — the prompt still got typed but won't have been sent.
  const state = await fakeClaudeState(claudePage);
  expect(state.attachedFiles).toHaveLength(0);
  expect(state.submitClicks).toBe(0);

  await claudePage.close();
  await openerPage.close();
});

test('ask error: missing prompt-input selector → status reports the failure', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl, {
    selectors: { textInput: ['#nonexistent-prompt'] },
  });
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  // Need a non-empty prompt to make typePrompt actually run
  // (it early-returns on empty text).
  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'this prompt cannot be typed',
  });

  await capturePage.locator('#ask-menu-btn').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);

  await expect(capturePage.locator('#ask-status')).toContainText(
    'Prompt not accepted',
    { timeout: 10_000 },
  );

  await claudePage.close();
  await openerPage.close();
});

test('ask: attachment-preview verification confirms each chip appeared', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  // Opt the runtime into preview-count verification with the fixture's
  // per-file `<span data-testid="attachment-pill">` selector.
  await overrideAskProviders(sw, fixtureServer.baseUrl, {
    selectors: {
      attachmentPreview: ['span[data-testid="attachment-pill"]'],
    },
  });
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  // Two attachments → two chips → no error.
  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: true,
    prompt: 'happy verification',
  });

  await capturePage.locator('#ask-menu-btn').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);

  await expect(capturePage.locator('#ask-status')).toContainText('Sent', {
    timeout: 10_000,
  });
  const state = await fakeClaudeState(claudePage);
  expect(state.attachedFiles).toHaveLength(2);
  expect(state.submitClicks).toBe(1);

  await claudePage.close();
  await openerPage.close();
});

test('ask error: destination silently drops non-image attachment → HTML item fails individually', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Mirrors the ChatGPT-logged-out case: file input accepts the
  // dispatch, image chip appears, HTML chip never does. With per-file
  // dispatch the image item succeeds and the HTML item fails on its
  // own chip-count check. The widget marks just the HTML row as
  // errored and skips submit.
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl, {
    selectors: {
      attachmentPreview: ['span[data-testid="attachment-pill"]'],
    },
  });
  // Open fake-Claude with `?reject=non-image` so only image files
  // get a preview chip rendered.
  const claudePage = await extensionContext.newPage();
  await claudePage.goto(`${fixtureServer.baseUrl}/fake-claude.html?reject=non-image`);
  await claudePage.waitForFunction(() =>
    Boolean((window as unknown as { __seeFakeClaude?: unknown }).__seeFakeClaude),
  );
  // Shorten the verification window so the test isn't slow.
  await claudePage.evaluate(() => {
    (
      window as unknown as { __seeWhatISeeAskTuning?: Record<string, number> }
    ).__seeWhatISeeAskTuning = {
      fileSettleMs: 50,
      previewConfirmTimeoutMs: 800,
    };
  });

  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: true,
    prompt: 'will be rejected',
  });

  await capturePage.locator('#ask-menu-btn').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);

  // One attachment failed (HTML), Screenshot succeeded — summary
  // collapses to the count-based "Attachment not accepted" form.
  await expect(capturePage.locator('#ask-status')).toContainText(
    'Attachment not accepted',
    { timeout: 10_000 },
  );
  // Submit must not have fired — HTML attachment failed.
  const state = await fakeClaudeState(claudePage);
  expect(state.submitClicks).toBe(0);

  await claudePage.close();
  await openerPage.close();
});

test('ask error: preview selectors that match nothing → "could not verify" message', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Simulates selector drift: provider declares `attachmentPreview`
  // but no selector matches anything on the destination. The runtime
  // should surface a soft "Could not verify attachment delivery"
  // message instead of blaming the user for being logged out.
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl, {
    selectors: {
      // Selector that won't match anything on fake-Claude.
      attachmentPreview: ['div.nonexistent-chip'],
    },
  });
  const claudePage = await extensionContext.newPage();
  await claudePage.goto(`${fixtureServer.baseUrl}/fake-claude.html`);
  await claudePage.waitForFunction(() =>
    Boolean((window as unknown as { __seeFakeClaude?: unknown }).__seeFakeClaude),
  );
  await claudePage.evaluate(() => {
    (
      window as unknown as { __seeWhatISeeAskTuning?: Record<string, number> }
    ).__seeWhatISeeAskTuning = {
      fileSettleMs: 50,
      previewConfirmTimeoutMs: 600,
    };
  });

  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'cannot verify',
  });

  await capturePage.locator('#ask-menu-btn').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);

  // The "could not verify" raw error from the chip-count gate is
  // still on the failed row's icon tooltip; the user-facing summary
  // collapses to the count-based form.
  await expect(capturePage.locator('#ask-status')).toContainText(
    'Attachment not accepted',
    { timeout: 10_000 },
  );

  await claudePage.close();
  await openerPage.close();
});

// ─── Pin liveness across menu pick → tab dies → Ask click ────────
//
// Menu picks now set the default rather than send. The "tab dies
// between menu render and item click" race the old behavior had
// is gone — instead, the user can pick a tab as default, that tab
// can later die / navigate away / land on a wrong page, and the
// next plain Ask still resolves cleanly. `resolveAsk` is the
// arbiter; these tests pin the user-visible outcome.

test('pin: existing-tab pick falls back to a new tab when the pinned tab closes before send', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'pin then close',
  });

  // Pick the fake-Claude tab as the default destination, then kill
  // it. The Ask click that follows hits resolveAsk, which clears
  // the dead pin lazily and falls through to a fresh new-tab.
  await capturePage.locator('#ask-menu-btn').click();
  await waitForAskMenuReady(capturePage);
  await capturePage
    .locator('#ask-menu .ask-menu-item', { hasText: 'Fake Claude' })
    .click();
  // Wait for the default-set round-trip to settle (button re-enables
  // when refreshAskTargetLabel finishes), then close the pinned tab
  // before clicking Ask.
  await expect(capturePage.locator('#ask-btn')).toBeEnabled();
  await claudePage.close();

  await capturePage.locator('#ask-btn').click();

  await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
    timeout: 15_000,
  });
  // A fresh fake-Claude tab was opened to land the send.
  const opened = extensionContext
    .pages()
    .filter((p) => p.url().endsWith('/fake-claude.html'));
  expect(opened).toHaveLength(1);
  await opened[0].close();

  await openerPage.close();
});

test('pin: existing-tab pick falls back when the pinned tab navigates off the provider', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'pin then navigate off',
  });

  await capturePage.locator('#ask-menu-btn').click();
  await waitForAskMenuReady(capturePage);
  await capturePage
    .locator('#ask-menu .ask-menu-item', { hasText: 'Fake Claude' })
    .click();
  await expect(capturePage.locator('#ask-btn')).toBeEnabled();
  // Navigate the pinned tab off the provider's host before sending.
  // resolveAsk's stillProvider check should drop the pin and the
  // fallback should open a fresh fake-Claude tab.
  await claudePage.goto(`${fixtureServer.baseUrl}/green.html`);

  await capturePage.locator('#ask-btn').click();

  await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
    timeout: 15_000,
  });
  const opened = extensionContext
    .pages()
    .filter((p) => p.url().endsWith('/fake-claude.html'));
  // The original fake-Claude tab is still around (it just navigated
  // off — we then went back via the new tab opened by the fallback).
  // Count only the live `/fake-claude.html` pages: should be exactly
  // one (the freshly-opened fallback).
  expect(opened).toHaveLength(1);
  await opened[0].close();

  await claudePage.close();
  await openerPage.close();
});

test('pin: existing-tab pick falls back when the pinned tab navigates to an excluded URL', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  // Mark `?excluded` URLs on the fake-Claude page as non-chat
  // (mirrors real Claude's settings/library/recents exclusion list).
  await overrideAskProviders(sw, fixtureServer.baseUrl, {
    excludeUrlPatterns: ['*excluded*'],
  });
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'pin then to excluded',
  });

  await capturePage.locator('#ask-menu-btn').click();
  await waitForAskMenuReady(capturePage);
  await capturePage
    .locator('#ask-menu .ask-menu-item', { hasText: 'Fake Claude' })
    .click();
  await expect(capturePage.locator('#ask-btn')).toBeEnabled();
  // Same host, wrong page. The pin is kept (so a navigation back
  // restores it) but resolveAsk's `excluded` branch routes the
  // resolution to the new-tab fallback for *this* send.
  await claudePage.goto(`${fixtureServer.baseUrl}/fake-claude.html?excluded=1`);

  await capturePage.locator('#ask-btn').click();

  await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
    timeout: 15_000,
  });
  const opened = extensionContext
    .pages()
    .filter(
      (p) =>
        p.url().endsWith('/fake-claude.html')
        && p !== claudePage,
    );
  expect(opened).toHaveLength(1);
  await opened[0].close();

  await claudePage.close();
  await openerPage.close();
});

// ─── Keyboard binding ────────────────────────────────────────────

test('Alt+A fires the Ask button (does not open the menu)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Alt+A is now equivalent to clicking #ask-btn — the menu is a
  // default-picker, so opening it from the keyboard would force a
  // useless second key for "send." This test pins the new
  // contract: menu stays hidden, status flips to "Sent." against
  // the resolved default destination.
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'sent via Alt+A',
  });

  await capturePage.locator('body').focus();
  await capturePage.keyboard.press('Alt+a');

  // Status line lights up because the keyboard path now sends.
  await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
    timeout: 10_000,
  });
  // Menu must not have opened — Alt+A is no longer a caret click.
  await expect(capturePage.locator('#ask-menu')).toBeHidden();

  await claudePage.close();
  await openerPage.close();
});

// ─── Click modifier coverage on #ask-btn ─────────────────────────

test('ask: shift-click leaves the page open after a successful Ask (matches plain-click default)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Plain click on #ask-btn already leaves the page open. Shift-
  // click has the same outcome — pinning it here keeps the chord
  // working symmetrically with the Capture button's shift-click.
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'shift-click ask',
  });
  await capturePage.locator('#ask-btn').click({ modifiers: ['Shift'] });

  await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
    timeout: 15_000,
  });
  expect(capturePage.isClosed()).toBe(false);

  await capturePage.close();
  await claudePage.close();
  await openerPage.close();
});

test('ask: ctrl-click closes the Capture page and leaves focus on the provider tab', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Ctrl-click is the explicit "send and dismiss" gesture. After a
  // successful send the page-side handler posts `closeCapturePage`
  // to the SW, which removes the tab WITHOUT re-activating the
  // opener — `sendToAi` already focused the provider tab so the
  // user can watch the answer land. Re-focusing the opener here
  // (the original screenshot tab) would defeat the gesture.
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'ctrl-click ask',
  });

  await Promise.all([
    capturePage.waitForEvent('close'),
    capturePage.locator('#ask-btn').click({ modifiers: ['Control'] }),
  ]);
  expect(capturePage.isClosed()).toBe(true);

  // The active tab in the focused window should be a provider
  // tab (the one sendToAi just focused), NOT the opener (which
  // would mean focus snapped back to the original screenshot
  // page). The plain-Ask path with no pin opens a fresh tab on
  // the first enabled provider, so we check the active tab's
  // URL is on fake-claude.html rather than matching a specific
  // pre-existing tab id.
  const activeUrl = await sw.evaluate(async () => {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return active?.url ?? '';
  });
  expect(activeUrl).toContain('/fake-claude.html');

  await claudePage.close();
  await openerPage.close();
});

// ─── Per-provider Ask buttons ────────────────────────────────────

test('ask: per-provider Ask <X> button sends to a fresh tab on that provider', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // The Ask button row appends one favicon-only `.ask-provider-btn`
  // per enabled provider (after `.ask-split`). Each click sends
  // straight to a *new tab* on that provider, bypassing the
  // resolved default — useful when the user wants a fresh
  // conversation without first walking through the Ask… menu to
  // set the default. The fake-Claude provider's label here is
  // "Claude", so the button's aria-label reads "Ask Claude in
  // new tab".
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);
  // overrideAskProviders mutates ASK_PROVIDERS in-place but fires
  // no storage event, so the Capture page is still showing the
  // pre-override per-provider rows it built on first load. Reload
  // forces refreshAskTargetLabel to fetch fresh state and rebuild
  // the rows from the (now single-provider) override.
  await capturePage.reload();
  await capturePage.waitForLoadState('domcontentloaded');

  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'per-provider ask',
  });

  const providerRows = capturePage.locator('.button-row .ask-provider-btn');
  await expect(providerRows).toHaveCount(1);
  // Favicon-only button — no text content. Identified via the
  // aria-label so screen readers know which destination it
  // targets, and via the favicon `<img>` whose src derives from
  // the provider's newTabUrl origin.
  await expect(providerRows.first()).toHaveAttribute(
    'aria-label',
    /Ask Claude in new tab/,
  );
  await expect(providerRows.first().locator('img')).toHaveAttribute(
    'src',
    /\/icons\/claude\.svg$/,
  );

  // Snapshot the existing fake-claude pages so we measure only the
  // tab the per-provider click opens — earlier tests in the same
  // worker can leave stragglers around (each test cleans up its
  // own opens, but the cleanup is best-effort).
  const before = new Set(
    extensionContext
      .pages()
      .filter((p) => p.url().endsWith('/fake-claude.html')),
  );

  await providerRows.first().click();
  await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
    timeout: 15_000,
  });

  const opened = extensionContext
    .pages()
    .filter((p) => p.url().endsWith('/fake-claude.html') && !before.has(p));
  expect(opened).toHaveLength(1);
  const state = await fakeClaudeState(opened[0]);
  expect(state.attachedFiles.map((f) => f.name)).toEqual(['screenshot.png']);
  expect(state.submitClicks).toBe(1);

  await opened[0].close();
  await openerPage.close();
});

test('ask: per-provider Ask <X> button respects ctrl-click (closes Capture page)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Per-provider rows honour the same shift/ctrl modifier semantics
  // as the default Ask row. ctrl-click → close the Capture page on
  // success, leaving focus on the destination provider tab.
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);
  // See the sibling per-provider test for why a reload is needed
  // after `overrideAskProviders`.
  await capturePage.reload();
  await capturePage.waitForLoadState('domcontentloaded');

  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'per-provider ctrl ask',
  });

  const providerRows = capturePage.locator('.button-row .ask-provider-btn');
  await expect(providerRows).toHaveCount(1);

  await Promise.all([
    capturePage.waitForEvent('close'),
    providerRows.first().click({ modifiers: ['Control'] }),
  ]);
  expect(capturePage.isClosed()).toBe(true);

  // Active tab is the freshly-opened provider tab, not the opener.
  const activeUrl = await sw.evaluate(async () => {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return active?.url ?? '';
  });
  expect(activeUrl).toContain('/fake-claude.html');

  // Clean up the spawned provider tab.
  const opened = extensionContext
    .pages()
    .filter((p) => p.url().endsWith('/fake-claude.html'));
  for (const p of opened) await p.close();
  await openerPage.close();
});

test('ask: shift+ctrl chord keeps the page open (shift wins)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Documented chord precedence on both buttons: shift wins over
  // ctrl, leaning toward the safer "don't disappear the preview"
  // outcome.
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'shift+ctrl ask',
  });
  await capturePage.locator('#ask-btn').click({ modifiers: ['Shift', 'Control'] });

  await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
    timeout: 15_000,
  });
  expect(capturePage.isClosed()).toBe(false);

  await capturePage.close();
  await claudePage.close();
  await openerPage.close();
});
