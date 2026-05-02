// Live tests for the Ask injection library against real
// `claude.ai/code` (Claude Code) — the agentic-coding sub-product
// that shares claude.ai's host but ships an image-only composer.
//
// In production it's not a separate `AskProvider`; it's a `urlVariants`
// entry on the regular Claude provider that narrows accepted kinds
// to `['image']`. This spec drives the runtime against the live
// `/code` URL, mirrors the same image-only constraint via
// `acceptedAttachmentKinds`, and reuses Claude's runtime selectors
// wholesale (the agentic UI shares the file input + ProseMirror
// composer + Send button shape). DOM-verification helpers diverge:
// Claude Code's UI is class-based (Epitaxy library) rather than
// data-testid-rich, so the locators target `epitaxy-*` classes and
// the user-message background variable instead of stable testids.
//
// Setup quirks:
//
// - Claude Code's Send button stays disabled until a repo is
//   selected. The test browser's persistent profile must have a
//   session set up at least once (any repo) before this spec will
//   pass — `claude.ai/code` will then redirect to the most recent
//   `/code/session_<id>` on first navigation.
// - `claude.ai/code` is a sticky URL: navigating back to it lands
//   you on the existing session with the prior composer state
//   intact (queued prompts, attached files). The default
//   `goto`-between-tests pattern would leak that state across
//   tests AND pay a slow page reload each time, so this spec
//   provides a `resetPage` hook that clears state in-place
//   (composer text + attachment pills) without navigating.

import { expect, type Locator, type Page } from '@playwright/test';
import { claudeProvider } from '../../src/background/ask/claude.js';
import { runLiveSuite } from './lib/live-suite.js';
import type { LiveProvider } from './lib/types.js';

const SELECTORS = claudeProvider.selectors;
const COMPOSER = SELECTORS.textInput[0];
const ATTACHMENT_PILL = '[class*="epitaxy-attachment-pill"]';

const claudeCode: LiveProvider = {
  id: 'claude-code',
  label: 'Claude Code',
  newTabUrl: 'https://claude.ai/code',
  selectors: SELECTORS,
  acceptedAttachmentKinds: ['image'],

  async waitForComposerReady(page: Page): Promise<void> {
    // Claude Code redirects `/code` → `/code/session_<id>` once it
    // resolves the user's last repo session, then mounts the
    // composer. ProseMirror is the late-render signal — same as
    // regular Claude.
    await expect(page.locator(COMPOSER)).toBeVisible({ timeout: 30_000 });
  },

  async resetPage(page: Page): Promise<void> {
    // All cleanup runs through `page.evaluate` because both targets
    // are mouse-unreachable:
    //
    //   - Pill remove buttons (`.epitaxy-pill-remove`) are styled
    //     `opacity: 0; pointer-events: none` until the pill is
    //     hovered, so Playwright's `.click()` actionability check
    //     waits forever. Calling `.click()` on the element directly
    //     dispatches the React click handler regardless.
    //   - The composer is a ProseMirror; `page.keyboard.press('Control+A')`
    //     collides with Claude Code's own bindings. `execCommand`
    //     mirrors the runtime's typePrompt path, so any future
    //     breakage surfaces in the prompt-typing tests too.
    await page.evaluate((composerSelector) => {
      document
        .querySelectorAll<HTMLButtonElement>(
          'button.epitaxy-pill-remove[aria-label^="Remove "]',
        )
        .forEach((b) => b.click());
      const composer = document.querySelector<HTMLElement>(composerSelector);
      if (composer) {
        composer.focus();
        document.execCommand('selectAll');
        document.execCommand('delete');
      }
    }, COMPOSER);
  },

  imageAttachmentLocator(page: Page, filename: string): Locator {
    // The pill body is a `<button aria-label="<filename>">` containing
    // the preview image. Filtering by aria-label gives us a
    // filename-tagged match (not just any attachment).
    return page.locator(`button[aria-label="${filename}"]`);
  },

  // `fileAttachmentLocator` deliberately omitted — Claude Code is
  // image-only via `acceptedAttachmentKinds`, and the shared suite
  // gates its call sites on the same `accepts(provider, 'text')`
  // branch that swaps text payloads for an extra image.

  allAttachmentsLocator(page: Page): Locator {
    return page.locator(ATTACHMENT_PILL);
  },

  userMessageLocator(page: Page, hasText: string): Locator {
    // Claude Code's user-message bubble is class-based — it carries
    // `bg-[var(--ui-user-message-background)]` rather than a stable
    // testid. The substring match on the variable name is the most
    // future-proof anchor we have.
    return page.locator('[class*="ui-user-message-background"]', { hasText });
  },

  async readComposerText(page: Page): Promise<string> {
    return await page
      .locator(COMPOSER)
      .evaluate((el) => (el as HTMLElement).textContent ?? '');
  },
};

runLiveSuite(claudeCode);
