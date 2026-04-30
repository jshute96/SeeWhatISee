// Live tests for the Ask injection library against real gemini.google.com.
//
// All test cases live in `lib/live-suite.ts` — this file just wires
// up the Gemini-specific provider config: selectors are imported
// directly from `src/background/ask/gemini.ts` (single source of
// truth — prod adapter and live tests can't drift), and a few
// DOM-verification helpers are added that target Gemini's Angular
// `<uploader-file-preview>` chips and `<user-query>` element.
// Setup is in `docs/ask-live-tests.md`.

import { expect, type Locator, type Page } from '@playwright/test';
import { geminiProvider } from '../../src/background/ask/gemini.js';
import { runLiveSuite } from './lib/live-suite.js';
import type { LiveProvider } from './lib/types.js';

const SELECTORS = geminiProvider.selectors;

const gemini: LiveProvider = {
  id: 'gemini',
  label: 'Gemini',
  newTabUrl: geminiProvider.newTabUrl,
  selectors: SELECTORS,

  async waitForComposerReady(page: Page): Promise<void> {
    // Quill's `.ql-editor` appears once the composer JS has
    // hydrated. Without this wait, every subsequent selector check
    // races Gemini's bundle.
    await expect(page.locator(SELECTORS.textInput[0])).toBeVisible({
      timeout: 30_000,
    });
  },

  // Gemini renders each attached file as a `<uploader-file-preview>`
  // chip. The chip's filename isn't in its text content (Gemini
  // splits "selection.md" into the visible label "selection MD"),
  // but every chip has a "Remove file <filename>" button — use that
  // as a stable, exact match.
  imageAttachmentLocator(page: Page, filename: string): Locator {
    return page.locator('uploader-file-preview', {
      has: page.locator(`button[aria-label="Remove file ${filename}"]`),
    });
  },

  fileAttachmentLocator(page: Page, filename: string): Locator {
    return page.locator('uploader-file-preview', {
      has: page.locator(`button[aria-label="Remove file ${filename}"]`),
    });
  },

  allAttachmentsLocator(page: Page): Locator {
    return page.locator('uploader-file-preview');
  },

  userMessageLocator(page: Page, hasText: string): Locator {
    // Gemini's user message bubble is `user-query` (Angular custom
    // element) with the prompt text inside `.query-text`.
    return page.locator('user-query', { hasText });
  },

  async readComposerText(page: Page): Promise<string> {
    return await page
      .locator(SELECTORS.textInput[0])
      .evaluate((el) => (el as HTMLElement).textContent ?? '');
  },
};

runLiveSuite(gemini);
