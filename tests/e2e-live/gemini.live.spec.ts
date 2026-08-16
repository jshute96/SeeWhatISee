// Live tests for the Ask injection library against real gemini.google.com.
//
// All test cases live in `lib/live-suite.ts` — this file just wires
// up the Gemini-specific provider config: selectors are imported
// directly from `src/ask/gemini.ts` (single source of
// truth — prod adapter and live tests can't drift), and a few
// DOM-verification helpers are added that target Gemini's Angular
// `<uploader-file-preview>` chips and `<user-query>` element.
// Setup is in `docs/ask-live-tests.md`.

import { expect, type Locator, type Page } from '@playwright/test';
import { geminiProvider } from '../../src/ask/gemini.js';
import { runLiveSuite } from './lib/live-suite.js';
import type { LiveProvider } from './lib/types.js';

const SELECTORS = geminiProvider.selectors;

/** The `<uploader-file-preview>` chip for one attached file.
 *
 *  Finding it by filename is awkward, because nothing *inside* the
 *  chip carries the name: the visible label is truncated
 *  ("contents.html" renders as "contents"), the preview `<img>` has
 *  `alt="attachment"`, and the close button is labelled
 *  "close attachment". Gemini used to expose a
 *  `Remove file <filename>` button; it no longer does.
 *
 *  What survives is the accessible description — the chip points
 *  `aria-describedby` at a hidden Angular CDK message element whose
 *  text is the exact filename. ("Angular CDK" = the component
 *  toolkit behind Gemini's UI; it parks these description nodes in
 *  one container at the end of `<body>`.)
 *
 *  That's a cross-document reference, which CSS can't follow, hence
 *  XPath. Keeping it as a selector (rather than resolving the id in
 *  JS first) means the locator stays lazy, so `toBeVisible` still
 *  retries while the chip is mounting.
 *
 *  Two details the obvious XPath gets wrong:
 *
 *  - `aria-describedby` is an id *list*, and CDK appends to it. A
 *    plain `=` comparison silently stops matching the moment a
 *    second id lands there, so compare space-padded and use
 *    `contains` for a whole-token match.
 *  - The filename lookup is scoped to CDK's description container,
 *    so an unrelated element that merely happens to render the
 *    filename as text can't supply the id.
 */
function chipByFilename(page: Page, filename: string): Locator {
  const descriptionId =
    `//*[contains(@class,"cdk-describedby-message-container")]` +
    `//*[normalize-space(text())=${JSON.stringify(filename)}]/@id`;
  return page.locator(
    `xpath=//uploader-file-preview[.//*[contains(` +
      `concat(" ", normalize-space(@aria-describedby), " "), ` +
      `concat(" ", ${descriptionId}, " "))]]`,
  );
}

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

  imageAttachmentLocator(page: Page, filename: string): Locator {
    return chipByFilename(page, filename);
  },

  fileAttachmentLocator(page: Page, filename: string): Locator {
    return chipByFilename(page, filename);
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
