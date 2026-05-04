// E2E coverage for AskProvider.urlVariants — the per-URL override of
// `acceptedAttachmentKinds` used by Claude on `/code` (Claude Code),
// where the composer is image-only despite living on the same host
// as full-featured Claude.
//
// The fake-Claude fixture is reused as the "Claude Code" stand-in
// since the runtime is selector-driven and the variant rule is
// expressed entirely via provider data. The test seam adds a
// `urlVariants` entry whose pattern matches the same fixture URL the
// fake provider lists in `urlPatterns`, so any send to that fixture
// page is treated as an image-only destination.
//
// What this spec covers:
//   - Pre-send guard: HTML/selection checked → page refuses to send,
//     names the destination via the variant `label`, and lists the
//     Save rows the user must uncheck.
//   - When only image + prompt is selected, send succeeds end-to-end
//     (file attached, prompt typed, submit fires) — Claude Code's
//     happy path, the subset that's expected to work.
//   - Same flow after the user unchecks the offending rows (no skip
//     suffix surfaces, since the page pre-prunes the payload).

import { test, expect } from '../fixtures/extension';
import { openDetailsFlow, seedSelection } from './details-helpers';
import {
  clickExistingFakeClaudeItem,
  configureCapture,
  fakeClaudeState,
  installAskTestHooks,
  openFakeClaudeTab,
  overrideAskProviders,
  waitForAskMenuReady,
} from './ask-helpers';

installAskTestHooks();

test('url variant: pre-send guard refuses HTML/selection on image-only destination', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    seedSelection,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl, {
    urlVariants: [
      {
        // Same pattern as the provider's urlPatterns — the variant
        // applies to every existing fake-Claude tab. `label` is what
        // the pre-send refusal message uses to name the destination.
        pattern: `${fixtureServer.baseUrl}/fake-claude.html*`,
        label: 'Claude Code',
        acceptedAttachmentKinds: ['image'],
      },
    ],
  });
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: true,
    selectionFormat: 'markdown',
    prompt: 'something',
  });

  // Open the menu and pick the existing fake-Claude tab.
  await capturePage.locator('#ask-menu-btn').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);

  // Page-side guard fires before any SW round-trip — status names
  // the destination via the variant's `label` and lists the Save
  // rows the user must uncheck. The fake-Claude tab should never
  // receive any files.
  await expect(capturePage.locator('#ask-status')).toContainText(
    'Claude Code only accepts image attachments',
    { timeout: 5_000 },
  );
  await expect(capturePage.locator('#ask-status')).toContainText(
    'uncheck Save HTML and Save selection',
  );
  const state = await fakeClaudeState(claudePage);
  expect(state.attachedFiles).toHaveLength(0);
  expect(state.submitClicks).toBe(0);

  await claudePage.close();
  await openerPage.close();
});

test('url variant: image + prompt only → sends end-to-end (Claude Code happy path)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    seedSelection,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl, {
    urlVariants: [
      {
        pattern: `${fixtureServer.baseUrl}/fake-claude.html*`,
        label: 'Claude Code',
        acceptedAttachmentKinds: ['image'],
      },
    ],
  });
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  // Subset that's expected to work on Claude Code: image + prompt.
  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'help me debug this screenshot',
  });

  await capturePage.locator('#ask-menu-btn').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);

  await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
    timeout: 10_000,
  });
  const state = await fakeClaudeState(claudePage);
  expect(state.attachedFiles.map((f) => ({ name: f.name, type: f.type }))).toEqual(
    [{ name: 'screenshot.png', type: 'image/png' }],
  );
  expect(state.submitClicks).toBe(1);
  expect(state.lastSubmitText).toContain('help me debug this screenshot');

  await claudePage.close();
  await openerPage.close();
});

test('url variant: HTML/selection unchecked plus image → sends, no skip suffix', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    seedSelection,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl, {
    urlVariants: [
      {
        pattern: `${fixtureServer.baseUrl}/fake-claude.html*`,
        label: 'Claude Code',
        acceptedAttachmentKinds: ['image'],
      },
    ],
  });
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  // Start with everything checked, then uncheck — exercises the same
  // boxes the user would hit after seeing the guard error.
  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: true,
    selectionFormat: 'markdown',
    prompt: 'go',
  });
  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    selectionFormat: null,
    prompt: 'go',
  });

  await capturePage.locator('#ask-menu-btn').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);

  // Plain "Sent." — the SW filter path is not exercised here because
  // the page already pruned the payload to image-only.
  await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
    timeout: 10_000,
  });
  const state = await fakeClaudeState(claudePage);
  expect(state.attachedFiles.map((f) => f.name)).toEqual(['screenshot.png']);

  await claudePage.close();
  await openerPage.close();
});
