// E2E coverage for the Ask AI target-window pinning behavior.
//
// Ask remembers the destination of the last successful send and
// reuses it on the next plain `#ask-btn` click. The menu marks the
// pinned target with a leading pin glyph; `#ask-caret` always opens
// the menu so the user can pick a different target.
//
// Split out from `ask.spec.ts` so the pin lifecycle (sending, then
// reading the pin back, sometimes after invalidating the pinned
// tab) reads as a single suite. Both files share the per-test
// scaffolding in `tests/e2e/ask-helpers.ts`.

import { test, expect } from '../fixtures/extension';
import { openDetailsFlow } from './details-helpers';
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

test('pin: with no pin, the "New window in" item shows the default pin', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);

  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);

  const newClaude = capturePage
    .locator('#ask-menu .ask-menu-item')
    .filter({ hasText: /^Claude$/ });
  await expect(newClaude).toHaveClass(/\bis-default\b/);

  await openerPage.close();
});

test('pin: clicking the main Ask button with no pin opens a new tab and sends', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);

  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'plain ask',
  });

  // Plain click — no menu. Resolves default → first enabled
  // provider's new tab → opens a fake-Claude page and sends.
  await capturePage.locator('#ask-btn').click();
  await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
    timeout: 15_000,
  });

  const opened = extensionContext
    .pages()
    .filter((p) => p.url().endsWith('/fake-claude.html'));
  expect(opened).toHaveLength(1);
  const state = await fakeClaudeState(opened[0]);
  expect(state.attachedFiles.map((f) => f.name)).toEqual(['screenshot.png']);
  expect(state.submitClicks).toBe(1);

  await opened[0].close();
  await openerPage.close();
});

test('pin: after sending to an existing tab, the menu marks it as default', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'first',
  });
  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);
  await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
    timeout: 10_000,
  });

  // Reopen the menu — the existing-tab item should now carry the
  // default pin, and the "New window in Claude" item should not.
  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);

  const existing = capturePage
    .locator('#ask-menu .ask-menu-item', { hasText: 'Fake Claude' });
  await expect(existing).toHaveClass(/\bis-default\b/);

  const newClaude = capturePage
    .locator('#ask-menu .ask-menu-item')
    .filter({ hasText: /^Claude$/ });
  await expect(newClaude).not.toHaveClass(/\bis-default\b/);

  await claudePage.close();
  await openerPage.close();
});

test('pin: subsequent plain Ask reuses the pinned tab (no new tab opened)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  // First send: pick the existing tab from the menu, which sets
  // the pin to its tabId.
  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'first',
  });
  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);
  await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
    timeout: 10_000,
  });

  // Second send: plain Ask — should reuse the pinned tab.
  // The fixture page's __seeFakeClaude state accumulates across
  // injections, so a second submit shows up as submitClicks === 2.
  await configureCapture(capturePage, {
    saveScreenshot: false,
    saveHtml: true,
    prompt: 'second',
  });
  await capturePage.locator('#ask-btn').click();
  await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
    timeout: 10_000,
  });

  // No additional fake-Claude tab should have been opened.
  const claudeTabs = extensionContext
    .pages()
    .filter((p) => p.url().endsWith('/fake-claude.html'));
  expect(claudeTabs).toHaveLength(1);

  const state = await fakeClaudeState(claudePage);
  expect(state.submitClicks).toBe(2);
  // Both submits' attachments accumulate in the fixture state.
  const names = state.attachedFiles.map((f) => f.name).sort();
  expect(names).toEqual(['contents.html', 'screenshot.png']);

  await claudePage.close();
  await openerPage.close();
});

test('pin: closed tab falls back to a new window', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  // Pin to the existing tab.
  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'first',
  });
  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);
  await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
    timeout: 10_000,
  });

  // Kill the pinned tab. Next plain Ask must open a fresh one.
  await claudePage.close();

  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'second',
  });
  await capturePage.locator('#ask-btn').click();
  await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
    timeout: 15_000,
  });

  const opened = extensionContext
    .pages()
    .filter((p) => p.url().endsWith('/fake-claude.html'));
  expect(opened).toHaveLength(1);
  const state = await fakeClaudeState(opened[0]);
  expect(state.submitClicks).toBe(1);

  await opened[0].close();
  await openerPage.close();
});

test('pin: tab navigated away from the provider invalidates the pin', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'first',
  });
  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);
  await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
    timeout: 10_000,
  });

  // Move the pinned tab off the provider URL. The pin's tabId is
  // still alive, but its URL no longer matches `urlPatterns`, so
  // resolveAsk should drop the pin and fall back.
  await claudePage.goto(`${fixtureServer.baseUrl}/purple.html`);

  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'second',
  });
  await capturePage.locator('#ask-btn').click();
  await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
    timeout: 15_000,
  });

  // The fallback opens a fresh fake-Claude tab — the navigated tab
  // stays on purple.html, untouched.
  const claudeTabs = extensionContext
    .pages()
    .filter((p) => p.url().endsWith('/fake-claude.html'));
  expect(claudeTabs).toHaveLength(1);
  expect(claudeTabs[0]).not.toBe(claudePage);

  await claudeTabs[0].close();
  await claudePage.close();
  await openerPage.close();
});

test('pin: tab navigated to an excluded URL invalidates the pin', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  // Match all fake-Claude URLs as Claude tabs, then exclude the
  // ones with `?excluded=…`. The pinned tab will navigate from
  // valid → excluded between sends.
  await overrideAskProviders(sw, fixtureServer.baseUrl, {
    excludeUrlPatterns: ['*?excluded=*'],
  });
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'first',
  });
  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);
  await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
    timeout: 10_000,
  });

  // Navigate the pinned tab to the same page but with a query
  // string that flips it into the exclude bucket. The tab still
  // matches `urlPatterns` (so it's still listed as a Claude tab),
  // but resolveAsk must reject it because it now
  // matches `excludeUrlPatterns`.
  await claudePage.goto(`${fixtureServer.baseUrl}/fake-claude.html?excluded=1`);

  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'second',
  });
  await capturePage.locator('#ask-btn').click();
  await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
    timeout: 15_000,
  });

  // Two fake-Claude tabs now: the excluded one (still navigated to
  // ?excluded=1) and a fresh one the fallback opened to send into.
  const allClaude = extensionContext
    .pages()
    .filter((p) => p.url().includes('/fake-claude.html'));
  expect(allClaude).toHaveLength(2);
  const fresh = allClaude.find((p) => !p.url().includes('excluded'));
  expect(fresh).toBeDefined();
  expect(fresh).not.toBe(claudePage);

  await fresh!.close();
  await claudePage.close();
  await openerPage.close();
});

test('pin: stale pin shows greyed-out crossed pin on the wrong-page row', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  // Same shape as the previous test — match all fake-Claude URLs,
  // exclude `?excluded=…`. Lets us flip the pinned tab onto a
  // wrong page without leaving the provider's host.
  await overrideAskProviders(sw, fixtureServer.baseUrl, {
    excludeUrlPatterns: ['*?excluded=*'],
  });
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  // Pin to the existing tab via the menu.
  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'first',
  });
  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);
  await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
    timeout: 10_000,
  });

  // Navigate the pinned tab onto a wrong page. Pin is no longer
  // the default but should surface in the next menu render as a
  // stale row alongside the new "New window in" default.
  await claudePage.goto(`${fixtureServer.baseUrl}/fake-claude.html?excluded=1`);
  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);

  const stale = capturePage
    .locator('#ask-menu .ask-menu-item', { hasText: 'Fake Claude' });
  await expect(stale).toHaveClass(/\bis-stale\b/);
  // Stale rows show a grey crossed-out pin, not the green pin —
  // verify both states do *not* coincide on the same row.
  await expect(stale).not.toHaveClass(/\bis-default\b/);

  // The class alone proves nothing if the CSS rule that paints it
  // grey ever drifts. Pin the actual computed colour so a future
  // refactor of the indicator-glyph styling can't silently regress
  // to a green glyph on a stale row. Browsers serialise color as
  // `rgb(r, g, b)`; `#888` → `rgb(136, 136, 136)`.
  const checkColor = await stale
    .locator('.ask-menu-check')
    .evaluate((el) => getComputedStyle(el).color);
  expect(checkColor).toBe('rgb(136, 136, 136)');

  // The "New window in Claude" row carries the live default pin.
  const newClaude = capturePage
    .locator('#ask-menu .ask-menu-item')
    .filter({ hasText: /^Claude$/ });
  await expect(newClaude).toHaveClass(/\bis-default\b/);
  await expect(newClaude).not.toHaveClass(/\bis-stale\b/);

  await claudePage.close();
  await openerPage.close();
});

test('pin: navigating back from a wrong page restores the pin', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl, {
    excludeUrlPatterns: ['*?excluded=*'],
  });
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  // Pin via the menu.
  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'first',
  });
  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);
  await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
    timeout: 10_000,
  });

  // Stale roundtrip: wrong page → back to a valid URL. Pin should
  // recover (we deliberately don't clear it on the stale leg) and
  // become the live default again.
  await claudePage.goto(`${fixtureServer.baseUrl}/fake-claude.html?excluded=1`);
  await claudePage.goto(`${fixtureServer.baseUrl}/fake-claude.html`);

  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);

  // `is-default` on the existing-tab row only happens when
  // `resolveAsk` returns `{kind: 'existingTab', tabId: …}`, which
  // requires a live pin — plain-Ask hasn't fired again, so the
  // only way the pin can be live is if it survived the stale leg.
  // i.e. asserting `is-default` here transitively proves "pin was
  // kept, not cleared".
  const existing = capturePage
    .locator('#ask-menu .ask-menu-item', { hasText: 'Fake Claude' });
  await expect(existing).toHaveClass(/\bis-default\b/);
  await expect(existing).not.toHaveClass(/\bis-stale\b/);

  await claudePage.close();
  await openerPage.close();
});

test('pin: disabled provider invalidates the pin and falls back', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  // Pin to the existing tab.
  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'first',
  });
  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);
  await expect(capturePage.locator('#ask-status')).toHaveText('Sent.', {
    timeout: 10_000,
  });

  // Disable the only provider — pin should now be unusable, and
  // there's no fallback either, so plain Ask must surface the
  // "no provider" error.
  await sw.evaluate(() => {
    const api = (
      self as unknown as {
        SeeWhatISee: {
          ASK_PROVIDERS: { enabled: boolean }[];
        };
      }
    ).SeeWhatISee;
    api.ASK_PROVIDERS[0].enabled = false;
  });

  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'second',
  });
  await capturePage.locator('#ask-btn').click();
  await expect(capturePage.locator('#ask-status')).toContainText(
    'No Ask provider available',
    { timeout: 10_000 },
  );

  await claudePage.close();
  await openerPage.close();
});
