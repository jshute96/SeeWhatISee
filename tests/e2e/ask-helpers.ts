// Shared scaffolding for the Ask AI e2e specs:
//
//   - tests/e2e/ask.spec.ts          (menu / matrix / errors)
//   - tests/e2e/ask-pinned-tabs.spec.ts  (target-window pinning)
//
// Both files run against the fake-Claude fixture page and share the
// same provider-override seam, the same fake-page-state reader, the
// same per-test pause for `chrome.tabs.captureVisibleTab` rate-
// limiting, and the same snapshot/restore of `ASK_PROVIDERS`. None
// of that is specific to either suite, so it lives here to keep the
// spec files focused on tests rather than rigging.

import type { BrowserContext, Page, Worker } from '@playwright/test';
import { test, expect } from '../fixtures/extension';

// Match patterns ignore ports, so `http://127.0.0.1/...` is enough
// to match the fixture server regardless of which random port it
// chose. The fake-claude page lives at /fake-claude.html.
export const FAKE_CLAUDE_URL_PATTERN = 'http://127.0.0.1/fake-claude.html*';

export interface AttachedFile {
  name: string;
  type: string;
  size: number;
  content?: string; // populated for text/* files after FileReader resolves
}
export interface FakeClaudeState {
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
export async function fakeClaudeState(page: Page): Promise<FakeClaudeState> {
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

export interface OverrideOpts {
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
    /**
     * Per-attachment chip selectors. Setting this opts the runtime
     * into post-attach count verification — see
     * `AskInjectSelectors.attachmentPreview` jsdoc. Used by tests
     * that assert the runtime refuses when chips don't appear.
     */
    attachmentPreview?: string[];
  };
  /**
   * URL-variant overrides — same shape as `AskProvider.urlVariants`.
   * Used by the Claude Code spec to simulate the `/code` image-only
   * sub-page rule against the fake fixture. `pattern` is matched as a
   * `*`-glob against the destination tab's URL.
   */
  urlVariants?: Array<{
    pattern: string;
    label?: string;
    acceptedAttachmentKinds: ('image' | 'text')[];
  }>;
}

/**
 * Replace the Ask-provider registry with a single fake-Claude entry
 * pointing at the fixture page. The pre-existing `ASK_PROVIDERS`
 * array binding is preserved (the setter mutates in place) so
 * importers see the swap. The afterEach hook installed by
 * `installAskTestHooks` restores the original snapshot.
 */
export async function overrideAskProviders(
  sw: Worker,
  baseUrl: string,
  opts: OverrideOpts = {},
): Promise<void> {
  await sw.evaluate(
    ({ urlPattern, newTabUrl, excludes, selectorOverrides, urlVariants }) => {
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
          urlVariants,
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
            attachmentPreview: selectorOverrides.attachmentPreview,
          },
        },
      ]);
    },
    {
      urlPattern: FAKE_CLAUDE_URL_PATTERN,
      newTabUrl: `${baseUrl}/fake-claude.html`,
      excludes: opts.excludeUrlPatterns ?? [],
      selectorOverrides: opts.selectors ?? {},
      urlVariants: opts.urlVariants ?? [],
    },
  );
}

/**
 * Register the per-test rigging shared by every Ask spec:
 *
 *   - beforeEach: 600ms pause to dodge `chrome.tabs.captureVisibleTab`'s
 *     ~2/sec quota (each Ask test opens the Capture page once).
 *   - beforeAll: snapshot `ASK_PROVIDERS` so afterEach can restore it
 *     after the per-test override mutates the registry in place.
 *   - afterEach: restore the snapshot, then drop the `askPin` set by
 *     the previous test's send so the next test starts with a clean
 *     default.
 *
 * Call once at the top of each spec file. The closure over
 * `originalProviders` keeps the snapshot per-file (Playwright runs
 * beforeAll once per spec file), so two specs that import this can
 * each take and restore their own snapshot independently.
 */
export function installAskTestHooks(): void {
  test.beforeEach(async () => {
    await new Promise((r) => setTimeout(r, 600));
  });

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
    // Drop the pin set by sendToAi so the next test starts with a
    // clean default. Without this, the previous test's tab id (long
    // since closed) would still be the "pin" and resolveDefault would
    // chase a dead tab before falling through.
    await sw.evaluate(() => chrome.storage.session.remove('askPin'));
    // Drop any persisted Ask provider settings so a test that toggles
    // an enabled/default flag can't leak into the next test. The
    // SW's `normalizeAskProviderSettings` returns factory defaults
    // (all enabled, Claude default) when the key is absent.
    await sw.evaluate(() =>
      chrome.storage.local.remove('askProviderSettings'),
    );
  });
}

/** Wait for the Ask menu to render its real items (not the Loading placeholder). */
export async function waitForAskMenuReady(capturePage: Page): Promise<void> {
  await expect(
    capturePage.locator('#ask-menu .ask-menu-heading', {
      hasText: 'New window in',
    }),
  ).toBeVisible();
}

/**
 * Pick the existing-tab item that points at the fake-Claude page
 * (title "Fake Claude") AND fire the Ask. Menu picks no longer send
 * — they shift the default destination — so the natural "send via
 * this menu row" gesture is "click the row to set it as the
 * default, then click Ask." Wrapped in one helper so the call sites
 * read the same way they did before the menu became a default-
 * picker.
 */
export async function clickExistingFakeClaudeItem(capturePage: Page): Promise<void> {
  await capturePage
    .locator('#ask-menu .ask-menu-item', { hasText: 'Fake Claude' })
    .click();
  await capturePage.locator('#ask-btn').click();
}

/**
 * Pick the "New window in Claude" item AND fire the Ask. Same
 * "set-default-then-send" composition as
 * `clickExistingFakeClaudeItem` — see that helper's comment.
 */
export async function clickNewClaudeItem(capturePage: Page): Promise<void> {
  // The new-tab item's text is exactly "Claude" (no parenthetical
  // suffix, since the only enabled provider has label "Claude").
  // hasText is a substring match, so exclude the existing-tab
  // entry which contains "Fake Claude".
  await capturePage
    .locator('#ask-menu .ask-menu-item')
    .filter({ hasText: /^Claude$/ })
    .click();
  await capturePage.locator('#ask-btn').click();
}

/** Open a fake-Claude tab and wait for its `__seeFakeClaude` global. */
export async function openFakeClaudeTab(
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
export async function configureCapture(
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
