// Live tests for the Ask injection library against real claude.ai.
//
// Scope is narrow on purpose: this isn't an extension e2e (the
// deterministic suite covers that). It's a contract test for the
// library at `src/ask-inject.ts` — does it correctly attach files,
// type prompts, and click submit when run against a real Claude
// composer? And do the production timing constants still work?
//
// What we do per test:
//   1. Open a fresh `claude.ai/new` tab in the user's logged-in
//      Chromium (attached via `chromium.connectOverCDP`).
//   2. Read `dist/ask-inject.js` from disk and `page.evaluate(src)`
//      to register `window.__seeWhatISeeAsk`.
//   3. Call the runtime with a test payload and assert on the
//      observable DOM state.
//
// We deliberately do NOT route through the extension, the Capture
// page, the menu, or the runtime-message channel — those are
// covered deterministically in `tests/e2e/ask.spec.ts`. Including
// them here would just add flake from network / browser timing
// without testing anything new.
//
// Setup is in the parent doc (`docs/ask-on-web.md` "Live e2e
// tests"): launch `scripts/open-test-browser.sh`, log in to your
// test account once. Sessions persist via `.chrome-test-profile/`.

import fs from 'node:fs';
import path from 'node:path';
import {
  test,
  expect,
  chromium,
  type Browser,
  type Page,
} from '@playwright/test';

const CDP_ENDPOINT = process.env.SEE_LIVE_CDP_ENDPOINT ?? 'http://127.0.0.1:9222';
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const ASK_INJECT_PATH = path.join(REPO_ROOT, 'dist/ask-inject.js');

// Mirrors `src/background/ask/claude.ts`. Keep in sync when the
// adapter's selectors change — divergence here is the early-warning
// signal that prod selectors haven't been updated.
const CLAUDE_SELECTORS = {
  fileInput: [
    'input[data-testid="file-upload"]',
    'input[type="file"][accept*="image"]',
    'input[type="file"]',
  ],
  textInput: [
    'div.ProseMirror[contenteditable="true"]',
    'div[contenteditable="true"][data-testid]',
    'div[contenteditable="true"]',
  ],
  submitButton: [
    'button[aria-label="Send Message"]',
    'button[aria-label="Send message"]',
    'button[aria-label*="send" i]',
  ],
  attachmentPreview: [],
};

// Per-run tag so each Ask test's user-message bubble is unique
// (and conversations sort to the top of your account's history,
// easy to find and delete by hand).
const RUN_TAG = `[SeeWhatISee live test ${Date.now()}]`;

// 1×1 transparent PNG — smallest possible image attachment, keeps
// network traffic and Claude account usage minimal.
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==';

let browser: Browser;
let askInjectSrc: string;

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
        `then log in to your Claude test account and rerun the tests.`,
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
// CDP browser accumulates a dozen+ stale claude.ai/new tabs across
// runs, and the user has to close them by hand.
let pagesToClose: Page[] = [];

test.afterEach(async () => {
  for (const p of pagesToClose) {
    try {
      await p.close();
    } catch {
      // Tab might already be closed (auto-submit test follows
      // Claude's redirect to /chat/<id>, then the tab closes when
      // we close the browser handle in afterAll). Ignore.
    }
  }
  pagesToClose = [];
});

async function openFreshClaudePage(): Promise<Page> {
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('CDP browser has no contexts — is it fully started?');
  const page = await ctx.newPage();
  pagesToClose.push(page);
  await page.goto('https://claude.ai/new', { waitUntil: 'domcontentloaded' });
  // ProseMirror is a stable late-render signal: it appears once the
  // composer JS has hydrated. Without this wait, every subsequent
  // selector check races Claude's bundle.
  await expect(page.locator(CLAUDE_SELECTORS.textInput[0])).toBeVisible({
    timeout: 30_000,
  });
  return page;
}

async function loadAskRuntime(page: Page): Promise<void> {
  // The compiled bundle is a self-contained IIFE — evaluate runs it
  // and the IIFE assigns `window.__seeWhatISeeAsk`. No exports, no
  // module wrapper to unpack.
  await page.evaluate(askInjectSrc);
}

interface AskAttachment {
  data: string;
  kind: 'image' | 'text';
  mimeType: string;
  filename: string;
}

async function callAskRuntime(
  page: Page,
  attachments: AskAttachment[],
  promptText: string,
  autoSubmit: boolean,
): Promise<{ ok: boolean; error?: string }> {
  return await page.evaluate(
    async ({ selectors, payload }) => {
      const fn = (window as unknown as { __seeWhatISeeAsk?: Function }).__seeWhatISeeAsk;
      if (!fn) return { ok: false, error: 'runtime not loaded' };
      return await fn(selectors, payload);
    },
    {
      selectors: CLAUDE_SELECTORS,
      payload: { attachments, promptText, autoSubmit },
    },
  );
}

// ─── Selector smoke test ─────────────────────────────────────────

test('selectors match real claude.ai DOM', async () => {
  const page = await openFreshClaudePage();
  // The first selector in each list is the most-specific one and is
  // the one we expect to match in steady state. Failure here means
  // claude.ai changed its DOM hooks — update src/background/ask/claude.ts
  // (and the mirror at the top of this file).
  await expect(page.locator(CLAUDE_SELECTORS.fileInput[0])).toBeAttached({
    timeout: 5_000,
  });
  await expect(page.locator(CLAUDE_SELECTORS.textInput[0])).toBeVisible();

  // Claude's Send button is only rendered into the DOM once the
  // composer has something to send. Type a character so the button
  // appears, then assert our selector matches it. (The runtime's
  // `clickSubmit` poll only runs after typePrompt, so this matches
  // the real ordering.)
  await page.locator(CLAUDE_SELECTORS.textInput[0]).click();
  await page.keyboard.type('x');
  await expect(page.locator(CLAUDE_SELECTORS.submitButton[1])).toBeAttached({
    timeout: 5_000,
  });
});

// ─── No-submit multi-file attach ─────────────────────────────────
//
// Most live coverage avoids submitting — uploads to Claude don't
// burn server resources or build conversation history when the
// composer is left in the "ready to send" state. This single test
// covers all three attachment types (image, HTML, selection
// markdown) without committing them.

test('ask runtime: image + html + selection attach, no submit', async () => {
  const page = await openFreshClaudePage();
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

  // 1) Image preview: Claude tags it with its filename as
  //    data-testid (e.g. `data-testid="test.png"`).
  await expect(page.locator('[data-testid="test.png"]')).toBeVisible({
    timeout: 10_000,
  });
  // 2) Non-image file thumbnails: HTML + selection.md both render
  //    with `data-testid="file-thumbnail"`. We expect 2 of these
  //    (one per non-image file).
  await expect(page.locator('[data-testid="file-thumbnail"]')).toHaveCount(
    2,
    { timeout: 10_000 },
  );
  // 3) The thumbnails carry the filename text — confirms the right
  //    files made it through, not just any two file blobs.
  await expect(
    page.locator('[data-testid="file-thumbnail"]', { hasText: 'contents.html' }),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="file-thumbnail"]', { hasText: 'selection.md' }),
  ).toBeVisible();

  // 4) Composer was NOT submitted.
  await expect(page.locator('[data-testid="user-message"]')).toHaveCount(0);

  // 5) Composer is empty and the user can keep typing on top.
  const text = await page
    .locator(CLAUDE_SELECTORS.textInput[0])
    .evaluate((el) => (el as HTMLElement).textContent ?? '');
  expect(text.trim()).toBe('');
  await page.locator(CLAUDE_SELECTORS.textInput[0]).click();
  await page.keyboard.type(`${RUN_TAG} (manual continuation)`, { delay: 5 });
  await expect(page.locator(CLAUDE_SELECTORS.textInput[0])).toContainText(
    RUN_TAG,
  );

});

// ─── Two-step accumulation tests ─────────────────────────────────
//
// The injection runtime is intentionally additive: it doesn't clear
// the composer first. Calling it twice without submit between
// matches what happens when a user runs Ask twice from the
// extension before pressing Send — each call should add on top of
// what's already there. These tests pin that behaviour.

test('ask runtime: two prompt-only calls accumulate text in the composer', async () => {
  const page = await openFreshClaudePage();
  await loadAskRuntime(page);

  // First call: just type some prompt text. No files, no submit.
  const r1 = await callAskRuntime(page, [], `${RUN_TAG} part one. `, false);
  expect(r1.ok, r1.error).toBe(true);

  // Second call: type more text. The composer's cursor stays where
  // typePrompt left it (end of the previous insertion), so the
  // second call's text appends.
  const r2 = await callAskRuntime(page, [], `${RUN_TAG} part two.`, false);
  expect(r2.ok, r2.error).toBe(true);

  // Both segments present, in order. Substring + index check is
  // resilient to ProseMirror's paragraph rendering details.
  const text = await page
    .locator(CLAUDE_SELECTORS.textInput[0])
    .evaluate((el) => (el as HTMLElement).textContent ?? '');
  const i1 = text.indexOf('part one.');
  const i2 = text.indexOf('part two.');
  expect(i1).toBeGreaterThanOrEqual(0);
  expect(i2).toBeGreaterThanOrEqual(0);
  expect(i1).toBeLessThan(i2);

  // No submit fired between or after.
  await expect(page.locator('[data-testid="user-message"]')).toHaveCount(0);
});

test('ask runtime: two file-attach calls accumulate attachments', async () => {
  const page = await openFreshClaudePage();
  await loadAskRuntime(page);

  // First call: attach an image. No prompt, no submit.
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
  await expect(page.locator('[data-testid="first.png"]')).toBeVisible({
    timeout: 10_000,
  });

  // Second call: attach a different file. Claude's onChange
  // handler appends to its existing attachment list (same
  // behaviour as picking a second file via the paperclip).
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

  // Both attachments are now present in the composer.
  await expect(page.locator('[data-testid="first.png"]')).toBeVisible();
  await expect(
    page.locator('[data-testid="file-thumbnail"]', { hasText: 'second.md' }),
  ).toBeVisible({ timeout: 10_000 });

  // No submit fired between or after.
  await expect(page.locator('[data-testid="user-message"]')).toHaveCount(0);
});

// ─── Auto-submit end-to-end (the ONE submitting test) ────────────
//
// Sends a tagged message + the same three attachment types so a
// single token-consuming run verifies the full submit pipeline
// (file pipe → typing → Send click → conversation update). Keep
// the prompt short so the response is small.

test('ask runtime: image + html + selection + prompt → message submitted', async () => {
  const page = await openFreshClaudePage();
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

  // Verify Claude saw the submit by waiting for our tagged
  // user-message bubble to render in the conversation.
  await expect(
    page.locator('[data-testid="user-message"]', { hasText: RUN_TAG }),
  ).toBeVisible({ timeout: 15_000 });

  // Post-submit state check. Claude redirects to /chat/<id> and
  // resets the composer. Calling the runtime again should populate
  // a *fresh* composer — confirms the textContent we read with our
  // extraction approach reflects the live state (not stale
  // pre-submit content) AND that typePrompt doesn't carry leftover
  // text across a submit boundary.
  const POST_SUBMIT_MARKER = `POST-SUBMIT-MARKER-${Date.now()}`;
  // Wait for the composer to be empty before calling — Claude's
  // post-submit reset is async (a tick or two after the user-bubble
  // appears). Explicit timeout because Playwright's `expect.poll`
  // default is 0 (one shot, no retry).
  await expect
    .poll(
      async () =>
        (
          await page
            .locator(CLAUDE_SELECTORS.textInput[0])
            .evaluate((el) => (el as HTMLElement).textContent ?? '')
        ).trim(),
      { timeout: 15_000 },
    )
    .toBe('');

  const r2 = await callAskRuntime(page, [], POST_SUBMIT_MARKER, false);
  expect(r2.ok, r2.error).toBe(true);

  // Stronger than `not.toContain(ORIGINAL_PROMPT_MARKER)`: the
  // composer should now contain the new prompt and NOTHING ELSE.
  // Pins both that the runtime populated the fresh composer
  // correctly and that no pre-submit text bled through.
  const composerText = await page
    .locator(CLAUDE_SELECTORS.textInput[0])
    .evaluate((el) => (el as HTMLElement).textContent ?? '');
  expect(composerText.trim()).toBe(POST_SUBMIT_MARKER);
});
