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

  await capturePage.locator('#ask-caret').click();
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

  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);

  await expect(
    capturePage.locator('#ask-menu .ask-menu-heading', {
      hasText: 'Existing window in',
    }),
  ).toHaveCount(0);

  await openerPage.close();
});

test('ask menu: excludeUrlPatterns filters tabs out', async ({
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

  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);

  // Exclusion pattern must filter the tab out of the listing.
  await expect(
    capturePage.locator('#ask-menu .ask-menu-heading', {
      hasText: 'Existing window in',
    }),
  ).toHaveCount(0);

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

  await capturePage.locator('#ask-caret').click();
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

    await capturePage.locator('#ask-caret').click();
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

  await capturePage.locator('#ask-caret').click();
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

  await capturePage.locator('#ask-caret').click();
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

    await capturePage.locator('#ask-caret').click();
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

  await capturePage.locator('#ask-caret').click();
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
  // anything on fake-claude — the inject runtime should throw
  // "Could not find the file-upload input".
  await overrideAskProviders(sw, fixtureServer.baseUrl, {
    selectors: { fileInput: ['#nonexistent-file-input'] },
  });
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'will fail',
  });

  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);

  await expect(capturePage.locator('#ask-status')).toContainText(
    'Could not find the file-upload input',
    { timeout: 10_000 },
  );
  // No file should have arrived; the failure happens before attach.
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

  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);

  await expect(capturePage.locator('#ask-status')).toContainText(
    'Could not find the prompt input',
    { timeout: 10_000 },
  );

  await claudePage.close();
  await openerPage.close();
});

test('ask error: target tab closed between menu render and click', async ({
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
    prompt: 'to a closed tab',
  });

  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);

  // Close the fake-Claude tab between menu render and item click.
  // resolveTab in background/ask/index.ts catches the rejection and
  // surfaces "Could not open Claude: …" via the Capture page status.
  await claudePage.close();

  await clickExistingFakeClaudeItem(capturePage);

  await expect(capturePage.locator('#ask-status')).toContainText(
    'Could not open Claude',
    { timeout: 10_000 },
  );

  await openerPage.close();
});

// ─── Keyboard binding ────────────────────────────────────────────

test('Alt+A opens the Ask menu (does not direct-send)', async ({
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

  // Configure the page so a direct-send *would* succeed if Alt+A
  // somehow hit the main button — distinguishes "menu opened" from
  // "send fired" (which would set #ask-status to "Sending…/Sent.").
  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'should not send',
  });

  await capturePage.locator('body').focus();
  await capturePage.keyboard.press('Alt+a');

  await waitForAskMenuReady(capturePage);
  await expect(capturePage.locator('#ask-menu')).toBeVisible();
  // Status line untouched — no send fired.
  await expect(capturePage.locator('#ask-status')).toHaveText('');

  await openerPage.close();
});
