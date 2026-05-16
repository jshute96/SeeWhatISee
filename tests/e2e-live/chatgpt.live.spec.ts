// Live tests for the Ask injection library against real chatgpt.com.
//
// The shared cases live in `lib/live-suite.ts`; this file wires up
// the ChatGPT-specific provider config (selectors imported from
// `src/ask/chatgpt.ts`, plus a few DOM-verification
// helpers targeting ChatGPT's `group/file-tile` attachment chips and
// `data-message-author-role` user-message element). It also carries
// the ChatGPT-only carryover repro at the bottom — see the
// `runLiveSuite` call for where the shared suite ends. Setup lives
// in `docs/ask-live-tests.md`.

import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { chatgptProvider } from '../../src/ask/chatgpt.js';
import { driveBridge } from './lib/bridge.js';
import {
  getSharedBrowser,
  getSharedProviderPage,
  runLiveSuite,
} from './lib/live-suite.js';
import type { LiveProvider } from './lib/types.js';

const SELECTORS = chatgptProvider.selectors;

// Each attached file renders inside a `div` whose class list includes
// `group/file-tile` — this is ChatGPT's canonical attachment-chip
// wrapper. Tailwind's slash-in-class-name means we match by substring
// on the `class` attribute rather than `.group\/file-tile`.
const FILE_TILE_SELECTOR = 'div[class*="group/file-tile"]';

// Matches the per-chip remove button. ChatGPT's aria-label looks like
// `Remove file 1: contents.html` — the leading number is positional
// and re-renumbers as files are added/removed, so we anchor on the
// `: <filename>` suffix instead. Using `*=` (substring) plus the
// colon-space prefix avoids cross-chip collisions on partial filename
// overlaps.
function removeButton(page: Page, filename: string): Locator {
  return page.locator(`button[aria-label*=": ${filename}"]`);
}

const chatgpt: LiveProvider = {
  id: 'chatgpt',
  label: 'ChatGPT',
  newTabUrl: chatgptProvider.newTabUrl,
  selectors: SELECTORS,

  async waitForComposerReady(page: Page): Promise<void> {
    // ProseMirror appears once the composer JS hydrates. Without this
    // wait, the first selector check races ChatGPT's bundle.
    await expect(page.locator(SELECTORS.textInput[0])).toBeVisible({
      timeout: 30_000,
    });
  },

  // Image attachments render the same chip wrapper as files but with
  // an inline `<img>` preview inside. Use that as the "this arrived
  // as an image" signal so the test can't be satisfied by an
  // accidentally-uploaded text blob with a `.png` name.
  imageAttachmentLocator(page: Page, filename: string): Locator {
    return page
      .locator(FILE_TILE_SELECTOR, { has: removeButton(page, filename) })
      .filter({ has: page.locator('img') });
  },

  // Non-image chips have the same wrapper but show a filename label
  // and a "File" tag instead of an image preview. Filename match via
  // the remove-button aria-label is the canonical signal.
  fileAttachmentLocator(page: Page, filename: string): Locator {
    return page.locator(FILE_TILE_SELECTOR, {
      has: removeButton(page, filename),
    });
  },

  allAttachmentsLocator(page: Page): Locator {
    return page.locator(FILE_TILE_SELECTOR);
  },

  userMessageLocator(page: Page, hasText: string): Locator {
    // ChatGPT renders the user's bubble as
    // `<div data-message-author-role="user">` containing the prompt.
    return page.locator('div[data-message-author-role="user"]', { hasText });
  },

  async readComposerText(page: Page): Promise<string> {
    return await page
      .locator(SELECTORS.textInput[0])
      .evaluate((el) => (el as HTMLElement).textContent ?? '');
  },
};

runLiveSuite(chatgpt);

// ─── ChatGPT-only: real-world draft-carryover repro ───────────────
//
// Original user reproduction: open chatgpt.com, type into the
// composer, wait a beat, close the window. Open Capture, run Ask
// ChatGPT with just an image (no prompt). After completion, the old
// text reappears in the new tab's composer.
//
// Mechanism (per user observation): ChatGPT persists unsent composer
// text to localStorage under `oai/apps/conversationDrafts`. On any
// fresh load of chatgpt.com that key is read back and the composer
// is repopulated — sometimes after our Ask flow has already
// completed, so a snapshot clear at the start of the run misses it.
//
// Why a custom block instead of slotting into the shared suite:
// the priming step is provider-specific (the draft key, the
// reload-to-trigger-restore mechanic), and most of the shared
// suite's tests assume an empty composer at startup. This stays
// out of the shared rotation so the other providers don't grow a
// no-op carryover scaffold.

const CHATGPT_DRAFT_LOCALSTORAGE_KEY = 'oai/apps/conversationDrafts';

const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../..',
);
const ASK_INJECT_PATH = path.join(REPO_ROOT, 'dist/ask-inject.js');

// 1×1 transparent PNG — same payload the shared suite uses, kept
// inline so this block doesn't depend on suite-private constants.
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==';

test('ChatGPT: image-only Ask after a prior draft leaves the composer clean', async () => {
  test.setTimeout(60_000);
  const browser = await getSharedBrowser('ChatGPT');
  const page = await getSharedProviderPage(browser, chatgpt);

  const draftMarker = `LEFTOVER-DRAFT-${Date.now()}`;

  // Phase 1: prime a draft. Type into the composer and let ChatGPT
  // auto-persist it to `oai/apps/conversationDrafts` — mirrors the
  // user's original reproduction ("type some text, maybe waiting a
  // moment").
  await page.goto(chatgpt.newTabUrl, { waitUntil: 'domcontentloaded' });
  await chatgpt.waitForComposerReady(page);
  await page.locator(SELECTORS.textInput[0]).click();
  await page.keyboard.type(draftMarker, { delay: 20 });
  await expect(page.locator(SELECTORS.textInput[0])).toContainText(draftMarker);
  await page.waitForTimeout(2_000);
  const draftBefore = await page.evaluate(
    (key) => localStorage.getItem(key),
    CHATGPT_DRAFT_LOCALSTORAGE_KEY,
  );
  expect(
    draftBefore,
    `priming did not write a draft to ${CHATGPT_DRAFT_LOCALSTORAGE_KEY}`,
  ).toContain(draftMarker);

  // Phase 2: fresh page load — same URL the SW opens on an
  // Ask-initiated newTab run. ChatGPT will re-hydrate the draft
  // from localStorage and re-render it from React state for
  // several seconds afterwards (see the "ChatGPT draft-injection
  // workaround" section in `docs/ask-on-web.md`).
  await page.goto(chatgpt.newTabUrl, { waitUntil: 'domcontentloaded' });
  await chatgpt.waitForComposerReady(page);

  // Phase 3: drive the bridge exactly as the widget does on a newTab
  // run for ChatGPT: clearComposer first (best-effort DOM wipe plus
  // a watch observer that keeps wiping until the user takes over),
  // then attach an image, no prompt, no submit. This is the user's
  // exact reported failure case.
  const askInjectSrc = fs.readFileSync(ASK_INJECT_PATH, 'utf8');
  await page.evaluate(askInjectSrc);
  const result = await driveBridge(
    page,
    SELECTORS,
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
    true,
  );
  expect(result.ok, result.error).toBe(true);
  await expect(chatgpt.imageAttachmentLocator(page, 'test.png')).toBeVisible({
    timeout: 10_000,
  });

  // Composer-state check: watch for 10 s and fail if the draftMarker
  // ever appears in the composer in that window. The wide-scope
  // persistent observer should be wiping any draft that ChatGPT
  // tries to re-render. `waitFor` polls and fails fast on the first
  // appearance, so a transient flash still trips it. 10 s exceeds
  // ChatGPT's observed hydration window (draft injects at ~3 s
  // post-load in the test env; logged-in re-render passes may
  // continue beyond that).
  const restored = await page
    .locator(SELECTORS.textInput[0], { hasText: draftMarker })
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true, () => false);
  expect(
    restored,
    'composer leaked the prior draft into the new run (saw the marker ' +
      'reappear during the post-clear watch window — the persistent ' +
      'observer is not catching it)',
  ).toBe(false);

  // Final-state sanity check after the watch window — the composer
  // should still be empty (or at worst contain only ChatGPT's own
  // placeholder boilerplate, which shouldn't include our marker).
  const finalText = (await chatgpt.readComposerText(page)).trim();
  expect(finalText, `composer ended with leaked text: "${finalText}"`).not.toContain(
    draftMarker,
  );
});
