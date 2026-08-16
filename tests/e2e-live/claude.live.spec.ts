// Live tests for the Ask injection library against real claude.ai.
//
// All test cases live in `lib/live-suite.ts` — this file just wires
// up the Claude-specific provider config: selectors are imported
// directly from `src/ask/claude.ts` (single source of
// truth — prod adapter and live tests can't drift), and a few
// DOM-verification helpers are added that target claude.ai's
// data-testids. Setup is in `docs/ask-live-tests.md`.

import { expect, type Locator, type Page } from '@playwright/test';
import { claudeProvider } from '../../src/ask/claude.js';
import { clearContentEditable } from './lib/dom.js';
import { runLiveSuite } from './lib/live-suite.js';
import type { LiveProvider } from './lib/types.js';

const SELECTORS = claudeProvider.selectors;

// Every composer attachment — image preview or file card — mounts
// under this wrapper.
const ATTACHMENT_THUMBNAIL = '[data-testid="file-thumbnail"]';

const claude: LiveProvider = {
  id: 'claude',
  label: 'Claude',
  newTabUrl: claudeProvider.newTabUrl,
  selectors: SELECTORS,

  async waitForComposerReady(page: Page): Promise<void> {
    // ProseMirror is a stable late-render signal: it appears once
    // the composer JS has hydrated. Without this wait, every
    // subsequent selector check races Claude's bundle.
    await expect(page.locator(SELECTORS.textInput[0])).toBeVisible({
      timeout: 30_000,
    });
  },

  async resetPage(page: Page): Promise<void> {
    // claude.ai persists the composer draft — text *and* attachment
    // thumbnails — across `goto(newTabUrl)`, so the shared suite's
    // navigate-between-tests reset isn't enough on its own. Left
    // uncleaned, a second `test.png` from an earlier test makes the
    // filename locators strict-mode ambiguous.
    await page.evaluate(clearContentEditable, SELECTORS.textInput[0]);

    // Thumbnails unmount one React render at a time, so drop them
    // one per pass rather than firing every click at once. Clicking
    // via `evaluate` (not Playwright's `.click()`) skips the
    // actionability wait — the remove button only becomes visible on
    // hover. Bounded so a stuck thumbnail fails the assertion in the
    // test rather than hanging here.
    const thumbnails = page.locator(ATTACHMENT_THUMBNAIL);
    for (let i = 0; i < 20 && (await thumbnails.count()) > 0; i++) {
      // Query *inside* a thumbnail so the click and the loop
      // condition can't disagree — an unrelated "Remove …" button
      // elsewhere on the page would otherwise spin this loop out.
      await page.evaluate((thumbnail) => {
        document
          .querySelector<HTMLButtonElement>(
            `${thumbnail} button[aria-label^="Remove"]`,
          )
          ?.click();
      }, ATTACHMENT_THUMBNAIL);
      await page.waitForTimeout(250);
    }
  },

  imageAttachmentLocator(page: Page, filename: string): Locator {
    // Image previews are `file-thumbnail` wrappers around an
    // `<img>` whose `alt` is the filename — claude.ai used to put
    // the filename on the wrapper's own `data-testid`, but no
    // longer does. The `alt` is the only filename-tagged hook left.
    return page.locator(ATTACHMENT_THUMBNAIL, {
      has: page.locator(`img[alt="${filename}"]`),
    });
  },

  fileAttachmentLocator(page: Page, filename: string): Locator {
    // Non-image files use the same wrapper, but render the filename
    // as text instead of an image preview.
    return page.locator(ATTACHMENT_THUMBNAIL, { hasText: filename });
  },

  allAttachmentsLocator(page: Page): Locator {
    return page.locator(ATTACHMENT_THUMBNAIL);
  },

  userMessageLocator(page: Page, hasText: string): Locator {
    return page.locator('[data-testid="user-message"]', { hasText });
  },

  async readComposerText(page: Page): Promise<string> {
    return await page
      .locator(SELECTORS.textInput[0])
      .evaluate((el) => (el as HTMLElement).textContent ?? '');
  },
};

runLiveSuite(claude);
