// Live tests for the Ask injection library against real chatgpt.com.
//
// All test cases live in `lib/live-suite.ts` — this file just wires
// up the ChatGPT-specific provider config: selectors are imported
// directly from `src/background/ask/chatgpt.ts` (single source of
// truth — prod adapter and live tests can't drift), and a few
// DOM-verification helpers are added that target ChatGPT's
// `group/file-tile` attachment chips and `data-message-author-role`
// user-message element. Setup is in `docs/ask-live-tests.md`.

import { expect, type Locator, type Page } from '@playwright/test';
import { chatgptProvider } from '../../src/background/ask/chatgpt.js';
import { runLiveSuite } from './lib/live-suite.js';
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
