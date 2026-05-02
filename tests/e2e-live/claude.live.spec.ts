// Live tests for the Ask injection library against real claude.ai.
//
// All test cases live in `lib/live-suite.ts` — this file just wires
// up the Claude-specific provider config: selectors are imported
// directly from `src/background/ask/claude.ts` (single source of
// truth — prod adapter and live tests can't drift), and a few
// DOM-verification helpers are added that target claude.ai's
// data-testids. Setup is in `docs/ask-live-tests.md`.

import { expect, type Locator, type Page } from '@playwright/test';
import { claudeProvider } from '../../src/background/ask/claude.js';
import { runLiveSuite } from './lib/live-suite.js';
import type { LiveProvider } from './lib/types.js';

const SELECTORS = claudeProvider.selectors;

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

  imageAttachmentLocator(page: Page, filename: string): Locator {
    // Claude tags image previews with the filename as `data-testid`,
    // e.g. `data-testid="test.png"`.
    return page.locator(`[data-testid="${filename}"]`);
  },

  fileAttachmentLocator(page: Page, filename: string): Locator {
    // Non-image files render as `data-testid="file-thumbnail"`
    // elements with the filename inside.
    return page.locator('[data-testid="file-thumbnail"]', {
      hasText: filename,
    });
  },

  allAttachmentsLocator(page: Page): Locator {
    // The image-preview testid is the filename (variable), so we OR
    // file-thumbnail with anything carrying the upload-success role.
    return page.locator(
      '[data-testid="file-thumbnail"], [data-testid$=".png"], [data-testid$=".jpg"], [data-testid$=".jpeg"], [data-testid$=".gif"], [data-testid$=".webp"]',
    );
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
