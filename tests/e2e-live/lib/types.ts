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
import type {
  AskAttachmentKind,
  AskInjectSelectors,
} from '../../../src/background/ask/providers.js';

export interface LiveProvider {
  /** Stable id, used in fixture filenames and run-tag prefixes. */
  id: 'claude' | 'claude-code' | 'gemini' | 'chatgpt';
  /** Display name used in test descriptions. */
  label: string;
  /** Page opened for each test. */
  newTabUrl: string;
  /** Selectors imported from `src/background/ask/<provider>.ts`. */
  selectors: AskInjectSelectors;
  /**
   * Attachment kinds the destination's composer actually accepts at
   * `newTabUrl`. Mirrors `resolveAcceptedKinds` semantics: omit (or
   * leave undefined) for full-featured providers (all kinds); set to
   * a narrower list (e.g. `['image']` for Claude Code) and the shared
   * suite either swaps non-image attachments for extra images or
   * skips the case outright. Without this the multi-file / submit
   * tests would dispatch HTML / `.md` payloads the destination would
   * silently drop, hiding regressions.
   */
  acceptedAttachmentKinds?: AskAttachmentKind[];

  /**
   * Wait for the composer to be ready to accept input. Lets the
   * suite race-proof the first interaction without hard sleeps.
   * Implementations typically `expect(...textInput).toBeVisible()`
   * with a generous timeout.
   */
  waitForComposerReady: (page: Page) => Promise<void>;

  /**
   * Optional extra cleanup run AFTER the shared suite's
   * `goto(newTabUrl)` + `waitForComposerReady`. Used by destinations
   * where the goto doesn't actually wipe composer state — Claude
   * Code's `/code` redirects back to the last session and preserves
   * any queued prompt plus attachment pills. Implementations should
   * leave the page on the same URL with an empty composer and no
   * attachments, so each test starts from a known-clean state.
   */
  resetPage?: (page: Page) => Promise<void>;

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
   * right matching strategy for the provider. Required only on
   * providers whose `acceptedAttachmentKinds` includes `'text'`;
   * image-only destinations (Claude Code) leave it undefined and
   * the shared suite skips its call sites under the same
   * `accepts(provider, 'text')` guard that swaps the payload.
   */
  fileAttachmentLocator?: (page: Page, filename: string) => Locator;

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
