// E2E coverage for the in-page Ask status widget
// (`src/ask-widget.ts`). The widget mounts in an ISOLATED-world
// shadow DOM on the destination AI tab and is driven by records
// the SW writes to `chrome.storage.session` keyed by destination
// tabId. These tests use the same fake-Claude fixture as
// `ask.spec.ts`; the widget renders on top of fake-Claude's DOM.
//
// Selectors inside the shadow root are reached by chaining off the
// host locator (`widget(page).locator('#…')`). Playwright pierces
// open shadow roots when descending from a host element but the
// page-level root doesn't see across the shadow boundary, so the
// chain is required.

import { test, expect, type Page, type Locator } from '../fixtures/extension';
import { openDetailsFlow, seedSelection } from './details-helpers';
import {
  clickExistingFakeClaudeItem,
  configureCapture,
  installAskTestHooks,
  openFakeClaudeTab,
  overrideAskProviders,
  waitForAskMenuReady,
} from './ask-helpers';

installAskTestHooks();

const HOST_SEL = '#see-what-i-see-widget-host';

/**
 * Anchor inside the widget's shadow root. Every UI assertion
 * descends from here — direct `page.locator('#collapsed')` calls
 * don't pierce the shadow boundary from the page root.
 */
function widget(page: Page): Locator {
  return page.locator(HOST_SEL);
}

test('widget: appears on destination, transitions to success, auto-collapses', async ({
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
    saveHtml: true,
    prompt: 'widget happy path',
  });

  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);

  // Page-side reports Sent.
  await expect(capturePage.locator('#ask-status')).toContainText('Sent', {
    timeout: 10_000,
  });

  // Widget host appears on the destination.
  await expect(claudePage.locator(HOST_SEL)).toBeAttached({ timeout: 5000 });

  // After success the widget collapses — collapsed view shown,
  // expanded view hidden — and the title-bar status dot reads
  // "Injected successfully."
  await expect(widget(claudePage).locator('#collapsed')).toBeVisible({ timeout: 5000 });
  await expect(widget(claudePage).locator('#expanded')).toBeHidden();

  // The status dot's data-status reflects the success state.
  const dotStatus = await widget(claudePage)
    .locator('#collapsed .swis-status-icon')
    .first()
    .getAttribute('data-status');
  expect(dotStatus).toBe('success');

  await claudePage.close();
  await openerPage.close();
});

test('widget: error path → stays expanded with the error text', async ({
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
  // Sabotage the file-input selector so the inject runtime fails;
  // the widget should reflect that in its Status section.
  await overrideAskProviders(sw, fixtureServer.baseUrl, {
    selectors: {
      fileInput: ['input[data-testid="this-selector-does-not-exist"]'],
    },
  });
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'will fail',
  });

  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);

  await expect(capturePage.locator('#ask-status')).toContainText(
    /Could not find the file-upload input/,
    { timeout: 10_000 },
  );

  // Widget remains expanded, status dot is red, status text mentions the error.
  await expect(widget(claudePage).locator('#expanded')).toBeVisible({ timeout: 5000 });
  await expect(widget(claudePage).locator('#collapsed')).toBeHidden();

  await expect(
    widget(claudePage).locator('#status-text'),
  ).toContainText(/Could not find the file-upload input/);

  const dotStatus = await widget(claudePage)
    .locator('#expanded .swis-status-icon')
    .first()
    .getAttribute('data-status');
  expect(dotStatus).toBe('error');

  await claudePage.close();
  await openerPage.close();
});

test('widget: Content section has copy buttons; copy populates clipboard', async ({
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
    saveScreenshot: false,
    saveHtml: true,
    prompt: 'copy-buttons test',
  });

  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);

  await expect(capturePage.locator('#ask-status')).toContainText('Sent', {
    timeout: 10_000,
  });

  // Widget auto-collapsed on success — re-expand to access content
  // buttons (clicking the strip outside its × is the contract).
  await widget(claudePage).locator('#collapsed').click();
  await expect(widget(claudePage).locator('#expanded')).toBeVisible();

  // Both attachments + the prompt should be present as buttons.
  const buttons = widget(claudePage).locator('#content-buttons .swis-copy-btn');
  await expect(buttons).toHaveCount(2); // HTML + Prompt
  await expect(buttons.nth(0)).toHaveText('HTML');
  await expect(buttons.nth(1)).toHaveText('Prompt');

  // Click "Prompt" — clipboard should receive the prompt text. The
  // page needs clipboard-read permission to verify; grant it for
  // the destination origin so we can read what was written.
  await extensionContext.grantPermissions(
    ['clipboard-read', 'clipboard-write'],
    { origin: fixtureServer.baseUrl },
  );
  await buttons.nth(1).click();
  // Transient feedback flips the button label.
  await expect(buttons.nth(1)).toHaveText('Copied!');

  const clip = await claudePage.evaluate(() =>
    navigator.clipboard.readText(),
  );
  expect(clip).toBe('copy-buttons test');

  await claudePage.close();
  await openerPage.close();
});

test('widget: Source section shows URL/title from the captured opener', async ({
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
    prompt: 'page section test',
  });

  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);

  await expect(capturePage.locator('#ask-status')).toContainText('Sent', {
    timeout: 10_000,
  });

  // Re-expand to inspect the Source section.
  await widget(claudePage).locator('#collapsed').click();

  const expectedUrl = `${fixtureServer.baseUrl}/purple.html`;
  await expect(widget(claudePage).locator('#page-url')).toHaveAttribute(
    'href',
    expectedUrl,
  );
  await expect(widget(claudePage).locator('#page-url-text')).toHaveText(expectedUrl);
  await expect(widget(claudePage).locator('#page-title')).toHaveAttribute(
    'href',
    expectedUrl,
  );

  await claudePage.close();
  await openerPage.close();
});

test('widget: × removes widget AND clears the storage record', async ({
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
    prompt: 'close-button test',
  });

  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);
  await expect(capturePage.locator('#ask-status')).toContainText('Sent', {
    timeout: 10_000,
  });

  // Re-expand to access the × in the title bar.
  await widget(claudePage).locator('#collapsed').click();
  await widget(claudePage).locator('#expanded [data-action="close"]').click();

  // Host element is removed from the page entirely.
  await expect(claudePage.locator(HOST_SEL)).toHaveCount(0);

  // Storage record is gone — query the SW directly. We assert no
  // record for ANY tab is left, which works because each test starts
  // from a freshly-cleared state and only this tab's record was ever
  // written.
  const stillThere = await sw.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    return Object.keys(all).filter((k) => k.startsWith('askWidget:'));
  });
  expect(stillThere).toEqual([]);

  await claudePage.close();
  await openerPage.close();
});

test('widget: minimize collapses; clicking the strip re-expands', async ({
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
  // Sabotage so the widget stays expanded on send (error path) — the
  // happy path auto-collapses, defeating the manual-toggle test.
  await overrideAskProviders(sw, fixtureServer.baseUrl, {
    selectors: {
      fileInput: ['input[data-testid="missing"]'],
    },
  });
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'minimize test',
  });

  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);

  await expect(widget(claudePage).locator('#expanded')).toBeVisible({ timeout: 5000 });

  // Click _ → collapses.
  await widget(claudePage).locator('#expanded [data-action="minimize"]').click();
  await expect(widget(claudePage).locator('#collapsed')).toBeVisible();
  await expect(widget(claudePage).locator('#expanded')).toBeHidden();

  // Click the strip (anywhere outside ×) → re-expands.
  await widget(claudePage).locator('#collapsed .swis-title-vertical').click();
  await expect(widget(claudePage).locator('#expanded')).toBeVisible();
  await expect(widget(claudePage).locator('#collapsed')).toBeHidden();

  // Host should still be present (not removed by minimize).
  await expect(claudePage.locator(HOST_SEL)).toHaveCount(1);

  await claudePage.close();
  await openerPage.close();
});

test('widget: re-Asking the same tab overwrites the prior record', async ({
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

  // First Ask: just a prompt.
  await configureCapture(capturePage, {
    saveScreenshot: false,
    saveHtml: false,
    prompt: 'first send',
  });
  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);
  await expect(capturePage.locator('#ask-status')).toContainText('Sent', {
    timeout: 10_000,
  });

  // Re-expand to inspect the first record's content buttons.
  await widget(claudePage).locator('#collapsed').click();
  await expect(
    widget(claudePage).locator('#content-buttons .swis-copy-btn'),
  ).toHaveCount(1);

  // Second Ask: screenshot + prompt. Storage record overwritten;
  // widget refreshes via storage.onChanged.
  await configureCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'second send',
  });
  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);
  await expect(capturePage.locator('#ask-status')).toContainText('Sent', {
    timeout: 10_000,
  });

  // Auto-collapsed again on the new success → re-expand and verify
  // both items now show.
  await widget(claudePage).locator('#collapsed').click();
  await expect(
    widget(claudePage).locator('#content-buttons .swis-copy-btn'),
  ).toHaveCount(2);

  await claudePage.close();
  await openerPage.close();
});

test('widget: re-Ask while collapsed re-expands during injecting', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // First Ask is the happy path so the widget auto-collapses.
  // Second Ask is sabotaged so it transitions injecting → error
  // and the post-collapse re-expansion sticks long enough to
  // assert. Without sabotage the injecting window is too short
  // (the success state collapses again immediately).
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  await configureCapture(capturePage, {
    saveScreenshot: false, saveHtml: false, prompt: 'first',
  });
  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);
  await expect(capturePage.locator('#ask-status')).toContainText('Sent', {
    timeout: 10_000,
  });
  await expect(widget(claudePage).locator('#collapsed')).toBeVisible({
    timeout: 5000,
  });

  await overrideAskProviders(sw, fixtureServer.baseUrl, {
    selectors: { fileInput: ['input[data-testid="missing"]'] },
  });
  await configureCapture(capturePage, {
    saveScreenshot: true, saveHtml: false, prompt: 'second',
  });
  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);

  // Widget pops open from collapsed before settling on error.
  await expect(widget(claudePage).locator('#expanded')).toBeVisible({
    timeout: 5000,
  });
  await expect(widget(claudePage).locator('#collapsed')).toBeHidden();

  await claudePage.close();
  await openerPage.close();
});

test('widget: selection-markdown attachment renders the markdown label', async ({
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
  await overrideAskProviders(sw, fixtureServer.baseUrl);
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  await configureCapture(capturePage, {
    saveScreenshot: false,
    saveHtml: false,
    selectionFormat: 'markdown',
    prompt: 'markdown test',
  });
  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);
  await expect(capturePage.locator('#ask-status')).toContainText('Sent', {
    timeout: 10_000,
  });

  await widget(claudePage).locator('#collapsed').click();
  const buttons = widget(claudePage).locator('#content-buttons .swis-copy-btn');
  await expect(buttons).toHaveCount(2);
  await expect(buttons.nth(0)).toHaveText('Selection (markdown)');
  await expect(buttons.nth(1)).toHaveText('Prompt');

  await claudePage.close();
  await openerPage.close();
});

test('widget: Screenshot copy writes a PNG to the clipboard', async ({
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
    saveScreenshot: true, saveHtml: false, prompt: '',
  });
  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);
  await expect(capturePage.locator('#ask-status')).toContainText('Sent', {
    timeout: 10_000,
  });

  await widget(claudePage).locator('#collapsed').click();
  await extensionContext.grantPermissions(
    ['clipboard-read', 'clipboard-write'],
    { origin: fixtureServer.baseUrl },
  );
  const screenshotBtn = widget(claudePage)
    .locator('#content-buttons .swis-copy-btn')
    .first();
  await screenshotBtn.click();
  // Wait for the visible "Copied!" confirmation so the clipboard
  // write has definitely landed before we try to read it back.
  await expect(screenshotBtn).toHaveText('Copied!');

  // navigator.clipboard.read() requires the page to be the focused
  // document. Bring it forward, then assert at least one
  // ClipboardItem carries an image/png entry. Validates the
  // dataUrlToBlob → ClipboardItem path that the text spec doesn't
  // exercise.
  await claudePage.bringToFront();
  const types = await claudePage.evaluate(async () => {
    const items = await navigator.clipboard.read();
    return items.flatMap((it) => Array.from(it.types));
  });
  expect(types).toContain('image/png');

  await claudePage.close();
  await openerPage.close();
});

test('widget: × on the collapsed strip also closes the widget', async ({
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
    saveScreenshot: false, saveHtml: false, prompt: 'collapsed-close',
  });
  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);
  await expect(capturePage.locator('#ask-status')).toContainText('Sent', {
    timeout: 10_000,
  });

  // Already collapsed (success). Click the × on the collapsed strip.
  await expect(widget(claudePage).locator('#collapsed')).toBeVisible();
  await widget(claudePage).locator('#collapsed [data-action="close"]').click();
  await expect(claudePage.locator(HOST_SEL)).toHaveCount(0);

  await claudePage.close();
  await openerPage.close();
});

test('widget: collapsed strip reads bottom-to-top icon→name→status→×', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // The vertical "SeeWhatISee" label is rotated such that it reads
  // bottom-to-top, and the strip's flex-direction: column-reverse
  // matches that reading direction. So the strip's order along the
  // user's natural reading sweep is icon, name, status, × — which
  // means visually top-to-bottom is the REVERSE: ×, status, name,
  // icon. No minimize button on the collapsed strip.
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  await configureCapture(capturePage, {
    saveScreenshot: false, saveHtml: false, prompt: 'order test',
  });
  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);
  await expect(capturePage.locator('#ask-status')).toContainText('Sent', {
    timeout: 10_000,
  });
  await expect(widget(claudePage).locator('#collapsed')).toBeVisible();

  await expect(
    widget(claudePage).locator('#collapsed [data-action="minimize"]'),
  ).toHaveCount(0);

  // Each child's painted top edge — sorted ascending should give
  // the visual top-to-bottom order: close, status, name, icon
  // (reverse of the read order).
  const yByLabel = await Promise.all([
    ['icon', '#collapsed .swis-icon'],
    ['name', '#collapsed .swis-title-vertical'],
    ['status', '#collapsed .swis-status-icon'],
    ['close', '#collapsed [data-action="close"]'],
  ].map(async ([label, sel]) => {
    const box = await widget(claudePage).locator(sel).boundingBox();
    if (!box) throw new Error(`no bounding box for ${label}`);
    return [label, box.y] as const;
  }));
  const orderedTopDown = [...yByLabel].sort((a, b) => a[1] - b[1]).map(([l]) => l);
  expect(orderedTopDown).toEqual(['close', 'status', 'name', 'icon']);

  await claudePage.close();
  await openerPage.close();
});

test('widget: clicking the expanded title bar collapses it', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Sabotage so the widget stays expanded — happy-path
  // auto-collapse would beat the manual click.
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl, {
    selectors: { fileInput: ['input[data-testid="missing"]'] },
  });
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  await configureCapture(capturePage, {
    saveScreenshot: true, saveHtml: false, prompt: 'titlebar-toggle',
  });
  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);
  await expect(widget(claudePage).locator('#expanded')).toBeVisible({
    timeout: 5000,
  });

  // Click the title text (NOT a button) — toggles to collapsed.
  await widget(claudePage).locator('#expanded .swis-title').click();
  await expect(widget(claudePage).locator('#collapsed')).toBeVisible();
  await expect(widget(claudePage).locator('#expanded')).toBeHidden();

  await claudePage.close();
  await openerPage.close();
});

test('widget: collapsed and expanded share the same top edge', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Pin the "top-right corner stays put when toggling state" intent.
  // Both states anchor by their top edge (no `transform: translateY`),
  // so flipping between them shouldn't shift the widget vertically.
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const sw = await getServiceWorker();
  await overrideAskProviders(sw, fixtureServer.baseUrl);
  const claudePage = await openFakeClaudeTab(extensionContext, fixtureServer);

  await configureCapture(capturePage, {
    saveScreenshot: false, saveHtml: false, prompt: 'top-edge test',
  });
  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);
  await expect(capturePage.locator('#ask-status')).toContainText('Sent', {
    timeout: 10_000,
  });

  // Auto-collapsed on success — record collapsed top.
  await expect(widget(claudePage).locator('#collapsed')).toBeVisible();
  const collapsedBox = await widget(claudePage)
    .locator('#collapsed')
    .boundingBox();
  if (!collapsedBox) throw new Error('no collapsed bounding box');

  // Expand and record expanded top.
  await widget(claudePage).locator('#collapsed').click();
  const expandedBox = await widget(claudePage)
    .locator('#expanded')
    .boundingBox();
  if (!expandedBox) throw new Error('no expanded bounding box');

  // Tops should match within a pixel of rounding.
  expect(Math.abs(collapsedBox.y - expandedBox.y)).toBeLessThanOrEqual(1);

  await claudePage.close();
  await openerPage.close();
});

test('widget: third section header reads "Source" (not "Page")', async ({
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
    saveScreenshot: true, saveHtml: false, prompt: 'source heading',
  });
  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);
  await expect(capturePage.locator('#ask-status')).toContainText('Sent', {
    timeout: 10_000,
  });

  await widget(claudePage).locator('#collapsed').click();
  const labels = widget(claudePage).locator('.swis-section-label');
  // Status, Content, Source — in that order.
  await expect(labels.nth(0)).toHaveText('Status');
  await expect(labels.nth(1)).toHaveText('Content');
  await expect(labels.nth(2)).toHaveText('Source');

  await claudePage.close();
  await openerPage.close();
});

test('widget: Source section title also has a Copy button', async ({
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
    saveScreenshot: true, saveHtml: false, prompt: 'page-title-copy',
  });
  await capturePage.locator('#ask-caret').click();
  await waitForAskMenuReady(capturePage);
  await clickExistingFakeClaudeItem(capturePage);
  await expect(capturePage.locator('#ask-status')).toContainText('Sent', {
    timeout: 10_000,
  });

  await widget(claudePage).locator('#collapsed').click();
  await extensionContext.grantPermissions(
    ['clipboard-read', 'clipboard-write'],
    { origin: fixtureServer.baseUrl },
  );

  // Read the title text the widget displayed, then click the title
  // copy button and assert clipboard matches.
  const expectedTitle = await widget(claudePage)
    .locator('#page-title')
    .textContent();
  await widget(claudePage).locator('#page-copy-title').click();
  await claudePage.bringToFront();
  const clip = await claudePage.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(expectedTitle);

  await claudePage.close();
  await openerPage.close();
});
