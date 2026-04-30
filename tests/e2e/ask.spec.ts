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
//
// SW idle-out caveat: the test seam mutates `ASK_PROVIDERS` in
// memory via `_setAskProvidersForTest`. If the MV3 service worker
// were to respawn between the override and the runtime call, the
// override would be lost and the test would target the real
// claude.ai. In practice the spec runs to completion well inside
// the SW idle window; if a flake ever surfaces here, persist the
// override in `chrome.storage.session` instead.

import type { BrowserContext, Page, Worker } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { dragRect, openDetailsFlow, seedSelection } from './details-helpers';

// chrome.tabs.captureVisibleTab is rate-limited (~2/s per window);
// each test in this file opens the Capture page once, so a small
// cushion keeps the suite from tripping the quota.
test.beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 600));
});

// Match patterns ignore ports, so `http://127.0.0.1/...` is enough
// to match the fixture server regardless of which random port it
// chose. The fake-claude page lives at /fake-claude.html.
const FAKE_CLAUDE_URL_PATTERN = 'http://127.0.0.1/fake-claude.html*';

// ─── State + helpers shared across cases ─────────────────────────

interface AttachedFile {
  name: string;
  type: string;
  size: number;
  content?: string; // populated for text/* files after FileReader resolves
}
interface FakeClaudeState {
  attachedFiles: AttachedFile[];
  submitClicks: number;
  lastSubmitText: string | null;
  lastSubmitHtml: string | null;
}

/**
 * Read state off the fake-Claude page after waiting for any pending
 * FileReader.text() promises to settle. The fake page populates the
 * `content` field asynchronously, so reading raw `attachedFiles`
 * right after the runtime returns can race the read.
 */
async function fakeClaudeState(page: Page): Promise<FakeClaudeState> {
  // Bounded explicitly so a stuck content-read (e.g. a future test
  // that attaches a non-text MIME we forgot to handle) fails fast
  // with a clear error instead of timing out at the test level.
  await page.waitForFunction(
    () => {
      interface Win { __seeFakeClaude?: FakeClaudeState }
      const s = (window as unknown as Win).__seeFakeClaude;
      if (!s) return false;
      return s.attachedFiles.every(
        (f) =>
          !(f.type === 'text/html' || f.type === 'text/plain' || f.type === 'text/markdown')
          || f.content !== undefined,
      );
    },
    null,
    { timeout: 5000 },
  );
  return await page.evaluate(
    () =>
      (window as unknown as { __seeFakeClaude: FakeClaudeState })
        .__seeFakeClaude,
  );
}

interface OverrideOpts {
  excludeUrlPatterns?: string[];
  /**
   * Override the inject-runtime selectors. Defaults to the real
   * claude.ai selectors (which also match the fake-Claude fixture).
   * Tests use this to force missing-selector error paths.
   */
  selectors?: {
    fileInput?: string[];
    textInput?: string[];
    submitButton?: string[];
  };
}

/**
 * Replace the Ask-provider registry with a single fake-Claude entry
 * pointing at the fixture page. The pre-existing `ASK_PROVIDERS`
 * array binding is preserved (the setter mutates in place) so
 * importers see the swap. afterEach restores from `originalProviders`.
 */
async function overrideAskProviders(
  sw: Worker,
  baseUrl: string,
  opts: OverrideOpts = {},
): Promise<void> {
  await sw.evaluate(
    ({ urlPattern, newTabUrl, excludes, selectorOverrides }) => {
      const api = (
        self as unknown as {
          SeeWhatISee: {
            _setAskProvidersForTest: (p: unknown[]) => void;
          };
        }
      ).SeeWhatISee;
      api._setAskProvidersForTest([
        {
          id: 'claude',
          label: 'Claude',
          urlPatterns: [urlPattern],
          excludeUrlPatterns: excludes,
          newTabUrl,
          enabled: true,
          selectors: {
            fileInput: selectorOverrides.fileInput ?? [
              'input[data-testid="file-upload"]',
            ],
            textInput: selectorOverrides.textInput ?? [
              'div.ProseMirror[contenteditable="true"]',
            ],
            submitButton: selectorOverrides.submitButton ?? [
              'button[aria-label="Send message"]',
            ],
          },
        },
      ]);
    },
    {
      urlPattern: FAKE_CLAUDE_URL_PATTERN,
      newTabUrl: `${baseUrl}/fake-claude.html`,
      excludes: opts.excludeUrlPatterns ?? [],
      selectorOverrides: opts.selectors ?? {},
    },
  );
}

let originalProviders: unknown[] | null = null;

test.beforeAll(async ({ getServiceWorker }) => {
  const sw = await getServiceWorker();
  originalProviders = await sw.evaluate(() => {
    const api = (
      self as unknown as {
        SeeWhatISee: { ASK_PROVIDERS: unknown[] };
      }
    ).SeeWhatISee;
    // JSON deep-clone so a later in-place mutation of ASK_PROVIDERS
    // doesn't corrupt our snapshot. The provider shape is plain
    // data (strings + bool + arrays) so JSON round-trip is lossless;
    // adding regex/function fields would break this assumption.
    return JSON.parse(JSON.stringify(api.ASK_PROVIDERS));
  });
});

test.afterEach(async ({ getServiceWorker }) => {
  if (!originalProviders) return;
  const sw = await getServiceWorker();
  await sw.evaluate((providers) => {
    const api = (
      self as unknown as {
        SeeWhatISee: { _setAskProvidersForTest: (p: unknown[]) => void };
      }
    ).SeeWhatISee;
    api._setAskProvidersForTest(providers);
  }, originalProviders);
});

/** Wait for the Ask menu to render its real items (not the Loading placeholder). */
async function waitForAskMenuReady(capturePage: Page): Promise<void> {
  await expect(
    capturePage.locator('#ask-menu .ask-menu-heading', {
      hasText: 'New window in',
    }),
  ).toBeVisible();
}

/** Click the existing-tab item that points at the fake-Claude page (title "Fake Claude"). */
async function clickExistingFakeClaudeItem(capturePage: Page): Promise<void> {
  await capturePage
    .locator('#ask-menu .ask-menu-item', { hasText: 'Fake Claude' })
    .click();
}

/** Click the "New window in Claude" item. */
async function clickNewClaudeItem(capturePage: Page): Promise<void> {
  // The new-tab item's text is exactly "Claude" (no parenthetical
  // suffix, since the only enabled provider has label "Claude").
  // hasText is a substring match, so exclude the existing-tab
  // entry which contains "Fake Claude".
  await capturePage
    .locator('#ask-menu .ask-menu-item')
    .filter({ hasText: /^Claude$/ })
    .click();
}

/** Open a fake-Claude tab and wait for its `__seeFakeClaude` global. */
async function openFakeClaudeTab(
  ctx: BrowserContext,
  fixtureServer: { baseUrl: string },
): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`${fixtureServer.baseUrl}/fake-claude.html`);
  await page.waitForFunction(() =>
    Boolean(
      (window as unknown as { __seeFakeClaude?: unknown }).__seeFakeClaude,
    ),
  );
  return page;
}

/**
 * Adjust the Capture page's Save checkboxes / selection-format radio /
 * prompt to a desired state. `selectionFormat: null` (or undefined)
 * leaves the master Save-selection unchecked.
 */
async function configureCapture(
  page: Page,
  opts: {
    saveScreenshot: boolean;
    saveHtml: boolean;
    selectionFormat?: 'html' | 'text' | 'markdown' | null;
    prompt?: string;
  },
): Promise<void> {
  const ss = page.locator('#cap-screenshot');
  if ((await ss.isChecked()) !== opts.saveScreenshot) await ss.click();
  const html = page.locator('#cap-html');
  if ((await html.isChecked()) !== opts.saveHtml) await html.click();
  if (opts.selectionFormat) {
    // Click the format radio — capture-page's change handler
    // auto-checks the master `cap-selection`.
    await page.locator(`#cap-selection-${opts.selectionFormat}`).click();
  } else {
    const sel = page.locator('#cap-selection');
    if ((await sel.isChecked()) === true) await sel.click();
  }
  await page.locator('#prompt-text').fill(opts.prompt ?? '');
}

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

  await capturePage.locator('#ask-btn').click();
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

  await capturePage.locator('#ask-btn').click();
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

  await capturePage.locator('#ask-btn').click();
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

  await capturePage.locator('#ask-btn').click();
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

    await capturePage.locator('#ask-btn').click();
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

  await capturePage.locator('#ask-btn').click();
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

  await capturePage.locator('#ask-btn').click();
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

    await capturePage.locator('#ask-btn').click();
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

  await capturePage.locator('#ask-btn').click();
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

  await capturePage.locator('#ask-btn').click();
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

  await capturePage.locator('#ask-btn').click();
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

  await capturePage.locator('#ask-btn').click();
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
