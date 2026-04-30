// Shared live-test harness: runs the same set of tests against any
// provider that supplies a `LiveProvider` plugin. Per-provider specs
// (`tests/e2e-live/<provider>.live.spec.ts`) just import this and
// call `runLiveSuite(<provider>)`.
//
// Scope intentionally matches the design doc (`docs/ask-live-tests.md`):
//   - One test per spec actually submits ("1-of-N submits" rule).
//   - All other tests assert on UI state without pressing Send.
//   - Every test uses `chromium.connectOverCDP` against the manually-
//     launched test browser, never launches its own.

import fs from 'node:fs';
import path from 'node:path';
import {
  test,
  expect,
  chromium,
  type Browser,
  type Page,
} from '@playwright/test';
import type { LiveProvider } from './types.js';

const CDP_ENDPOINT = process.env.SEE_LIVE_CDP_ENDPOINT ?? 'http://127.0.0.1:9222';
const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../..',
);
const ASK_INJECT_PATH = path.join(REPO_ROOT, 'dist/ask-inject.js');

// 1×1 transparent PNG — smallest possible image attachment, keeps
// network traffic and account usage minimal.
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==';

// Mirror of the AskAttachment interface in `src/ask-inject.ts`. Kept
// as a separate copy because ask-inject.ts is a self-contained IIFE
// (no exports — it's loaded via `executeScript` as a classic script).
// MUST stay in sync with the IIFE's interface; if a new field is
// added there, add it here too.
interface AskAttachment {
  data: string;
  kind: 'image' | 'text';
  mimeType: string;
  filename: string;
}

type AskRuntime = (
  selectors: unknown,
  payload: unknown,
) => Promise<{ ok: boolean; error?: string }>;

/**
 * Run the five-test live suite (selectors smoke / multi-file no-submit /
 * two prompt-only calls accumulate / two file-attach calls accumulate /
 * image+html+selection+prompt → submit) against any AI provider that
 * supplies a `LiveProvider` plugin. Per-provider specs in
 * `tests/e2e-live/<provider>.live.spec.ts` are thin wrappers around a
 * single `runLiveSuite(provider)` call.
 */
export function runLiveSuite(provider: LiveProvider): void {
  let browser: Browser;
  let askInjectSrc: string;
  // Per-run tag so each Ask test's user-message bubble is unique
  // (and conversations sort to the top of your account's history,
  // easy to find and delete by hand). Provider-tagged so logs from
  // a multi-provider run are separable.
  const RUN_TAG = `[SeeWhatISee live test ${provider.id} ${Date.now()}]`;

  test.beforeAll(async () => {
    if (!fs.existsSync(ASK_INJECT_PATH)) {
      throw new Error(
        `Build the extension first — ${ASK_INJECT_PATH} not found.\n` +
          `Run: npm run build`,
      );
    }
    askInjectSrc = fs.readFileSync(ASK_INJECT_PATH, 'utf8');
    try {
      browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not attach to test browser at ${CDP_ENDPOINT}: ${msg}\n\n` +
          `Launch it first:\n` +
          `  scripts/open-test-browser.sh\n` +
          `then log in to your ${provider.label} test account and rerun.`,
      );
    }
  });

  test.afterAll(async () => {
    // Closes the CDP wire, NOT the underlying browser — that stays
    // open for the next test run + your manual browsing.
    await browser?.close();
  });

  // Pages opened in a test are tracked here and closed in afterEach
  // so even a failing test cleans up after itself. Without this the
  // CDP browser accumulates a dozen+ stale tabs across runs.
  let pagesToClose: Page[] = [];

  test.afterEach(async () => {
    for (const p of pagesToClose) {
      try {
        await p.close();
      } catch {
        // Tab might already be closed (auto-submit flows can navigate
        // away, then the tab closes when we close the browser handle
        // in afterAll). Ignore.
      }
    }
    pagesToClose = [];
  });

  async function openFreshProviderPage(): Promise<Page> {
    const ctx = browser.contexts()[0];
    if (!ctx)
      throw new Error('CDP browser has no contexts — is it fully started?');
    const page = await ctx.newPage();
    pagesToClose.push(page);
    await page.goto(provider.newTabUrl, { waitUntil: 'domcontentloaded' });
    await provider.waitForComposerReady(page);
    return page;
  }

  async function loadAskRuntime(page: Page): Promise<void> {
    // The compiled bundle is a self-contained IIFE — evaluate runs it
    // and the IIFE assigns `window.__seeWhatISeeAsk`. No exports, no
    // module wrapper to unpack.
    await page.evaluate(askInjectSrc);
  }

  async function callAskRuntime(
    page: Page,
    attachments: AskAttachment[],
    promptText: string,
    autoSubmit: boolean,
  ): Promise<{ ok: boolean; error?: string }> {
    return await page.evaluate(
      async ({ selectors, payload }) => {
        const fn = (window as unknown as { __seeWhatISeeAsk?: AskRuntime })
          .__seeWhatISeeAsk;
        if (!fn) return { ok: false, error: 'runtime not loaded' };
        return await fn(selectors, payload);
      },
      {
        selectors: provider.selectors,
        payload: { attachments, promptText, autoSubmit },
      },
    );
  }

  // ─── Selector smoke test ───────────────────────────────────────

  test(`${provider.label}: selectors match the real DOM`, async () => {
    const page = await openFreshProviderPage();
    // The first selector in each list is the most-specific one and
    // is the one we expect to match in steady state. Failure here
    // means upstream changed its DOM hooks — update
    // src/background/ask/<provider>.ts (and the mirror in this file).
    //
    // For providers that surface their file input only after a click
    // chain (Gemini), check the FIRST preFileInputClicks selector
    // instead — that's the runtime's actual entry point. The runtime
    // itself polls for fileInput after clicking, so we don't need to
    // verify the input is in the initial DOM.
    const preClicks = provider.selectors.preFileInputClicks ?? [];
    const fileEntrySelector =
      preClicks.length > 0 ? preClicks[0] : provider.selectors.fileInput[0];
    await expect(page.locator(fileEntrySelector)).toBeAttached({
      timeout: 5_000,
    });
    await expect(page.locator(provider.selectors.textInput[0])).toBeVisible();

    // Some providers (e.g. Claude) only render the Send button into
    // the DOM once the composer has something to send. Type a
    // character so the button appears, then assert our selector
    // matches it.
    await page.locator(provider.selectors.textInput[0]).click();
    await page.keyboard.type('x');
    // Walk the ranked list and require *some* selector to match —
    // most specific often shifts a release at a time.
    let submitFound = false;
    for (const sel of provider.selectors.submitButton) {
      if ((await page.locator(sel).count()) > 0) {
        submitFound = true;
        break;
      }
    }
    expect(submitFound, 'no submit-button selector matched').toBe(true);
  });

  // ─── No-submit multi-file attach ───────────────────────────────

  test(`${provider.label}: image + html + selection attach, no submit`, async () => {
    const page = await openFreshProviderPage();
    await loadAskRuntime(page);
    const result = await callAskRuntime(
      page,
      [
        {
          data: TINY_PNG_DATA_URL,
          kind: 'image',
          mimeType: 'image/png',
          filename: 'test.png',
        },
        {
          data: '<html><body><p>fixture html for live test</p></body></html>',
          kind: 'text',
          mimeType: 'text/html',
          filename: 'contents.html',
        },
        {
          data: '## live test selection\n\nhello world',
          kind: 'text',
          mimeType: 'text/markdown',
          filename: 'selection.md',
        },
      ],
      '',
      false,
    );
    expect(result.ok, result.error).toBe(true);

    // 1) Image preview attached.
    await expect(provider.imageAttachmentLocator(page, 'test.png')).toBeVisible({
      timeout: 10_000,
    });
    // 2) Both non-image thumbnails attached (filename match — confirms
    //    the right files made it through, not just any two file blobs).
    await expect(
      provider.fileAttachmentLocator(page, 'contents.html'),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      provider.fileAttachmentLocator(page, 'selection.md'),
    ).toBeVisible({ timeout: 10_000 });

    // 3) Composer was NOT submitted.
    await expect(provider.userMessageLocator(page, RUN_TAG)).toHaveCount(0);

    // 4) Composer is empty and the user can keep typing on top.
    const text = await provider.readComposerText(page);
    expect(text.trim()).toBe('');
    await page.locator(provider.selectors.textInput[0]).click();
    await page.keyboard.type(`${RUN_TAG} (manual continuation)`, { delay: 5 });
    await expect(page.locator(provider.selectors.textInput[0])).toContainText(
      RUN_TAG,
    );
  });

  // ─── Two-step accumulation tests ───────────────────────────────
  //
  // The injection runtime is intentionally additive: it doesn't
  // clear the composer first. Calling it twice without submit
  // between matches what happens when a user runs Ask twice from
  // the extension before pressing Send.

  test(`${provider.label}: two prompt-only calls accumulate text`, async () => {
    const page = await openFreshProviderPage();
    await loadAskRuntime(page);

    const r1 = await callAskRuntime(page, [], `${RUN_TAG} part one. `, false);
    expect(r1.ok, r1.error).toBe(true);

    const r2 = await callAskRuntime(page, [], `${RUN_TAG} part two.`, false);
    expect(r2.ok, r2.error).toBe(true);

    // Both segments present, in order. Substring + index check is
    // resilient to editor paragraph rendering details.
    const text = await provider.readComposerText(page);
    const i1 = text.indexOf('part one.');
    const i2 = text.indexOf('part two.');
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThanOrEqual(0);
    expect(i1).toBeLessThan(i2);

    await expect(provider.userMessageLocator(page, RUN_TAG)).toHaveCount(0);
  });

  test(`${provider.label}: two file-attach calls accumulate attachments`, async () => {
    const page = await openFreshProviderPage();
    await loadAskRuntime(page);

    const r1 = await callAskRuntime(
      page,
      [
        {
          data: TINY_PNG_DATA_URL,
          kind: 'image',
          mimeType: 'image/png',
          filename: 'first.png',
        },
      ],
      '',
      false,
    );
    expect(r1.ok, r1.error).toBe(true);
    await expect(provider.imageAttachmentLocator(page, 'first.png')).toBeVisible({
      timeout: 10_000,
    });

    // Second call with a different file. Most providers' onChange
    // appends to the existing list (same as picking a second file
    // via the paperclip).
    const r2 = await callAskRuntime(
      page,
      [
        {
          data: '## second\n\nadded in a separate call',
          kind: 'text',
          mimeType: 'text/markdown',
          filename: 'second.md',
        },
      ],
      '',
      false,
    );
    expect(r2.ok, r2.error).toBe(true);

    await expect(provider.imageAttachmentLocator(page, 'first.png')).toBeVisible();
    await expect(provider.fileAttachmentLocator(page, 'second.md')).toBeVisible({
      timeout: 10_000,
    });
    await expect(provider.allAttachmentsLocator(page)).toHaveCount(2);

    await expect(provider.userMessageLocator(page, RUN_TAG)).toHaveCount(0);
  });

  // ─── Auto-submit end-to-end (the ONE submitting test) ──────────
  //
  // Sends a tagged message + the same three attachment types so a
  // single token-consuming run verifies the full submit pipeline
  // (file pipe → typing → Send click → conversation update). Keep
  // the prompt short so the response is small.

  test(`${provider.label}: image + html + selection + prompt → message submitted`, async () => {
    const page = await openFreshProviderPage();
    await loadAskRuntime(page);
    const ORIGINAL_PROMPT_MARKER = 'PRE-SUBMIT-please-reply-OK';
    const result = await callAskRuntime(
      page,
      [
        {
          data: TINY_PNG_DATA_URL,
          kind: 'image',
          mimeType: 'image/png',
          filename: 'test.png',
        },
        {
          data: '<html><body><p>fixture html for live test</p></body></html>',
          kind: 'text',
          mimeType: 'text/html',
          filename: 'contents.html',
        },
        {
          data: '## live test selection\n\nhello world',
          kind: 'text',
          mimeType: 'text/markdown',
          filename: 'selection.md',
        },
      ],
      `${RUN_TAG} ${ORIGINAL_PROMPT_MARKER}.`,
      true,
    );
    expect(result.ok, result.error).toBe(true);

    // Verify the provider saw the submit by waiting for our tagged
    // user-message bubble to render.
    await expect(provider.userMessageLocator(page, RUN_TAG)).toBeVisible({
      timeout: 15_000,
    });

    // Post-submit state check. The provider resets the composer
    // (Claude redirects to /chat/<id>; Gemini stays on the same URL
    // but blanks the input). Calling the runtime again should
    // populate a *fresh* composer — confirms our text-extraction
    // reflects live state AND that typePrompt doesn't carry leftover
    // text across the submit boundary.
    const POST_SUBMIT_MARKER = `POST-SUBMIT-MARKER-${Date.now()}`;
    await expect
      .poll(async () => (await provider.readComposerText(page)).trim(), {
        timeout: 15_000,
      })
      .toBe('');

    const r2 = await callAskRuntime(page, [], POST_SUBMIT_MARKER, false);
    expect(r2.ok, r2.error).toBe(true);

    // Stronger than `not.toContain(ORIGINAL_PROMPT_MARKER)`: composer
    // should now contain the new prompt and nothing else.
    const composerText = (await provider.readComposerText(page)).trim();
    expect(composerText).toBe(POST_SUBMIT_MARKER);
  });
}
