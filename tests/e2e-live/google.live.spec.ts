// Live tests for the Ask injection library against real google.com.
//
// Doesn't use the shared `runLiveSuite` harness because Google
// fundamentally diverges from the chat providers:
//
//   - Submit navigates the tab off `google.com` to `/search?q=…`,
//     dropping the IIFE-loaded `__seeWhatISeeAsk` runtime. The shared
//     suite's post-submit "call the runtime again" check would never
//     re-resolve.
//   - There's no conversation surface, so most of the shared suite's
//     locators (`userMessageLocator`, `fileAttachmentLocator`) don't
//     have a meaningful Google analogue.
//   - In production this is a `newTabOnly` provider — the user always
//     gets a fresh google.com tab, so two-call accumulation is moot.
//
// Three focused tests instead: the selectors smoke check, an
// image-attaches-no-submit case, and an image + prompt → submit case
// that verifies the page actually navigates to `/search?q=…`.
//
// As with the other live specs, this attaches to the test browser
// over CDP and never launches its own. Setup lives in
// `docs/ask-live-tests.md`.

import fs from 'node:fs';
import path from 'node:path';
import {
  test,
  expect,
  chromium,
  type Browser,
  type Page,
} from '@playwright/test';
import { googleProvider } from '../../src/background/ask/google.js';

const CDP_ENDPOINT = process.env.SEE_LIVE_CDP_ENDPOINT ?? 'http://127.0.0.1:9222';
const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../..',
);
const ASK_INJECT_PATH = path.join(REPO_ROOT, 'dist/ask-inject.js');

const SELECTORS = googleProvider.selectors;
const COMPOSER = SELECTORS.textInput[0];

// 1×1 transparent PNG — smallest valid image, keeps Google's image-
// search server-side traffic minimal.
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==';

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

let SHARED_BROWSER: Browser | null = null;
let SHARED_PAGE: Page | null = null;
let askInjectSrc: string;

async function getBrowser(): Promise<Browser> {
  if (SHARED_BROWSER && SHARED_BROWSER.isConnected()) return SHARED_BROWSER;
  try {
    SHARED_BROWSER = await chromium.connectOverCDP(CDP_ENDPOINT);
    return SHARED_BROWSER;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not attach to test browser at ${CDP_ENDPOINT}: ${msg}\n\n` +
        `Launch it first:\n` +
        `  scripts/open-test-browser.sh\n` +
        `then rerun.`,
    );
  }
}

// Reuse a single google.com tab across tests, like `live-suite.ts`
// does for chat providers — opening fresh tabs each time pays a slow
// CDP raise per test and bloats the browser window list.
async function getGooglePage(browser: Browser): Promise<Page> {
  if (SHARED_PAGE && !SHARED_PAGE.isClosed()) return SHARED_PAGE;
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('CDP browser has no contexts');
  const start = new URL(googleProvider.newTabUrl);
  for (const p of ctx.pages()) {
    if (p.isClosed()) continue;
    let parsed: URL;
    try {
      parsed = new URL(p.url());
    } catch {
      continue;
    }
    if (parsed.host === start.host && parsed.pathname === start.pathname) {
      SHARED_PAGE = p;
      return p;
    }
  }
  SHARED_PAGE = await ctx.newPage();
  return SHARED_PAGE;
}

async function openFreshGooglePage(): Promise<Page> {
  const browser = await getBrowser();
  const page = await getGooglePage(browser);
  // Fresh DOM each test — submitting in test 3 navigates to
  // `/search?...`, so without the goto subsequent runs would land on
  // a results page with no `wcaWdc` file input.
  await page.goto(googleProvider.newTabUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.locator(COMPOSER)).toBeVisible({ timeout: 30_000 });
  return page;
}

async function loadRuntime(page: Page): Promise<void> {
  await page.evaluate(askInjectSrc);
}

async function callRuntime(
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
      selectors: googleProvider.selectors,
      payload: { attachments, promptText, autoSubmit },
    },
  );
}

test.beforeAll(async () => {
  if (!fs.existsSync(ASK_INJECT_PATH)) {
    throw new Error(
      `Build the extension first — ${ASK_INJECT_PATH} not found.\n` +
        `Run: npm run build`,
    );
  }
  askInjectSrc = fs.readFileSync(ASK_INJECT_PATH, 'utf8');
  await getBrowser();
});

test.afterAll(async () => {
  // Park the page back on google.com so the next run finds it via
  // the start-URL loop and skips `newPage`. Mirrors the shared suite.
  if (SHARED_PAGE && !SHARED_PAGE.isClosed()) {
    try {
      await SHARED_PAGE.goto(googleProvider.newTabUrl, {
        waitUntil: 'domcontentloaded',
      });
    } catch {
      // Tab may have been closed mid-test; ignore.
    }
  }
});

test('Google: selectors match the real DOM', async () => {
  const page = await openFreshGooglePage();
  // File input is in the initial DOM (no preFileInputClicks chain).
  // Walk the ranked list and require *some* selector to match.
  let fileFound = false;
  for (const sel of SELECTORS.fileInput) {
    if ((await page.locator(sel).count()) > 0) {
      fileFound = true;
      break;
    }
  }
  expect(fileFound, 'no file-input selector matched').toBe(true);

  await expect(page.locator(SELECTORS.textInput[0])).toBeVisible();

  // The "Google Search" submit button is in the initial DOM (unlike
  // chat composers that lazy-render Send), so we can assert it
  // directly without typing first.
  let submitFound = false;
  for (const sel of SELECTORS.submitButton) {
    if ((await page.locator(sel).count()) > 0) {
      submitFound = true;
      break;
    }
  }
  expect(submitFound, 'no submit-button selector matched').toBe(true);
});

test('Google: image attaches, no submit', async () => {
  const page = await openFreshGooglePage();
  await loadRuntime(page);
  const result = await callRuntime(
    page,
    [
      {
        data: TINY_PNG_DATA_URL,
        kind: 'image',
        mimeType: 'image/png',
        filename: 'test.png',
      },
    ],
    '',
    false,
  );
  expect(result.ok, result.error).toBe(true);

  // The file input is hidden, but `input.files` is the authoritative
  // signal — that's what Google's onChange handlers consume. Checking
  // it directly is more robust than scraping for whatever preview
  // chip Google chose to render today.
  const fileCount = await page.locator(SELECTORS.fileInput[0]).evaluate(
    (el) => (el as HTMLInputElement).files?.length ?? 0,
  );
  expect(fileCount).toBe(1);

  // Composer is empty — the runtime only attached the file, didn't
  // type anything.
  const text = await page.locator(COMPOSER).inputValue();
  expect(text).toBe('');

  // Confirm the page didn't navigate (we never asked for submit).
  expect(new URL(page.url()).pathname).toBe('/');
});

test('Google: image + prompt → submit navigates to /search', async () => {
  const page = await openFreshGooglePage();
  await loadRuntime(page);

  const PROMPT_MARKER = `seewhatisee-live-${Date.now()}`;
  const result = await callRuntime(
    page,
    [
      {
        data: TINY_PNG_DATA_URL,
        kind: 'image',
        mimeType: 'image/png',
        filename: 'test.png',
      },
    ],
    PROMPT_MARKER,
    true,
  );
  expect(result.ok, result.error).toBe(true);

  // After submit the form GETs `/search?...&q=<marker>`. Wait for the
  // navigation to land — Google occasionally inserts an interstitial
  // before resolving, so be generous.
  await page.waitForURL(/\/search\?/, { timeout: 15_000 });
  const finalUrl = new URL(page.url());
  expect(finalUrl.pathname).toBe('/search');
  expect(finalUrl.searchParams.get('q')).toBe(PROMPT_MARKER);
});
