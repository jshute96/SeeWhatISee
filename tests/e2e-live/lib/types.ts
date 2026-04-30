// Shape of a live-test provider plugin. Each provider supplies the
// data the shared `live-suite.ts` needs to drive the same tests
// against any AI site:
//
//   - The selectors the runtime should use (mirrors the values in
//     `src/background/ask/<provider>.ts` — divergence here is the
//     early-warning signal that prod selectors haven't been updated).
//   - DOM-verification helpers that locate the provider-specific
//     equivalent of "image preview", "file thumbnail", and
//     "submitted user message".
//
// Anything generic (typing the prompt, calling the runtime, tracking
// pages-to-close, run tagging) lives in `live-suite.ts` and doesn't
// vary across providers.

import type { Locator, Page } from '@playwright/test';
import type { AskInjectSelectors } from '../../../src/background/ask/providers.js';

export interface LiveProvider {
  /** Stable id, used in fixture filenames and run-tag prefixes. */
  id: 'claude' | 'gemini';
  /** Display name used in test descriptions. */
  label: string;
  /** Page opened for each test. */
  newTabUrl: string;
  /** Selectors imported from `src/background/ask/<provider>.ts`. */
  selectors: AskInjectSelectors;

  /**
   * Wait for the composer to be ready to accept input. Lets the
   * suite race-proof the first interaction without hard sleeps.
   * Implementations typically `expect(...textInput).toBeVisible()`
   * with a generous timeout.
   */
  waitForComposerReady: (page: Page) => Promise<void>;

  /**
   * Locator for the in-composer preview of an attached image with the
   * given filename. Used by the no-submit attach test to confirm the
   * image arrived as an image (not just any blob).
   */
  imageAttachmentLocator: (page: Page, filename: string) => Locator;

  /**
   * Locator for the in-composer thumbnail of a non-image file with
   * the given filename. Note this is filename-tagged, not filename-
   * containing — pass the literal filename and the helper picks the
   * right matching strategy for the provider.
   */
  fileAttachmentLocator: (page: Page, filename: string) => Locator;

  /**
   * Count of all file/image attachments currently in the composer.
   * Used as a race-proof "we have N attachments now" assertion.
   */
  allAttachmentsLocator: (page: Page) => Locator;

  /**
   * Locator for a submitted user message containing the given text.
   * Used after auto-submit to confirm the message reached the
   * conversation.
   */
  userMessageLocator: (page: Page, hasText: string) => Locator;

  /**
   * Read the composer's current text content. The shared suite uses
   * this to verify post-submit reset and prompt accumulation. Raw
   * (untrimmed) so the suite can decide what trimming makes sense.
   */
  readComposerText: (page: Page) => Promise<string>;
}
