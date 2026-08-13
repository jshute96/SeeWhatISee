// E2E coverage for keyboard operation of the Capture page's tool
// column and its popup menus:
//
//   - Space / Enter on a drawing-tool button selects the tool (the
//     mouse path switches on `mousedown`, which a keyboard press
//     never delivers).
//   - The Zoom / More… popovers and the Ask destination menu are
//     arrow-navigable; a menu opened from the keyboard starts with
//     its first item focused, and one opened with the mouse starts
//     with nothing focused until the first Down / Up.

import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { dragRect, openDetailsFlow } from './details-helpers';
import {
  overrideAskProviders,
  waitForAskMenuReady,
} from './ask-helpers';

/** id of the element that currently has focus in the Capture page. */
async function focusedId(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.id ?? '');
}

// Wait until the screenshot has decoded — the Zoom menu's items are
// built on first open and the palette sits beside a 0×0 preview until
// then.
async function waitForImageLoaded(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      (document.getElementById('preview') as HTMLImageElement | null)
        ?.naturalWidth ?? 0,
    null,
    { timeout: 5000 },
  );
}

test('keyboard: Space on a tool button selects that tool', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await waitForImageLoaded(capturePage);

  // Box is the initial tool; move to Redact with the keyboard alone.
  await expect(capturePage.locator('#tool-box')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await capturePage.locator('#tool-redact').focus();
  await capturePage.keyboard.press(' ');
  await expect(capturePage.locator('#tool-redact')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(capturePage.locator('#tool-redact')).toHaveClass(/selected/);
  await expect(capturePage.locator('#tool-box')).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  // Enter works the same way.
  await capturePage.locator('#tool-arrow').focus();
  await capturePage.keyboard.press('Enter');
  await expect(capturePage.locator('#tool-arrow')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(capturePage.locator('#tool-redact')).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  await openerPage.close();
});

test('keyboard: Zoom menu — keyboard open focuses the first item, arrows wrap', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await waitForImageLoaded(capturePage);

  const items = capturePage.locator('.zoom-menu-item');

  // Mouse open: focus stays on the button until an arrow press.
  await capturePage.locator('#zoom').click();
  await expect(capturePage.locator('.zoom-menu')).toBeVisible();
  expect(await focusedId(capturePage)).toBe('zoom');
  const count = await items.count();
  expect(count).toBeGreaterThan(1);

  // Up from "nothing focused" lands on the last item; Down wraps back
  // round to the first.
  await capturePage.keyboard.press('ArrowUp');
  await expect(items.nth(count - 1)).toBeFocused();
  await capturePage.keyboard.press('ArrowDown');
  await expect(items.nth(0)).toBeFocused();
  await capturePage.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  // Home / End jump to the ends from wherever focus sits.
  await capturePage.keyboard.press('End');
  await expect(items.nth(count - 1)).toBeFocused();
  await capturePage.keyboard.press('Home');
  await expect(items.nth(0)).toBeFocused();
  // Escape closes and hands focus back from inside the menu.
  await capturePage.keyboard.press('Escape');
  await expect(capturePage.locator('.zoom-menu')).toBeHidden();
  expect(await focusedId(capturePage)).toBe('zoom');

  // Keyboard open: first item focused with no extra press. Enter then
  // fires it — 100% zoom, closing the menu and returning focus.
  await capturePage.locator('#zoom').focus();
  await capturePage.keyboard.press('Enter');
  await expect(capturePage.locator('.zoom-menu')).toBeVisible();
  await expect(items.nth(0)).toBeFocused();
  await capturePage.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await capturePage.keyboard.press('Enter');
  await expect(capturePage.locator('.zoom-menu')).toBeHidden();
  expect(await focusedId(capturePage)).toBe('zoom');

  await openerPage.close();
});

test('keyboard: More… opened by keyboard focuses a row once the async refresh lands', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await waitForImageLoaded(capturePage);

  // Seed a paste-able payload sized to this capture, *before* the
  // menu's first open. Nothing is drawn, so every row is disabled at
  // open time and Paste only lights up once the async
  // annotation-transfer read lands — the exact window in which a
  // synchronous first-item focus finds nothing to focus.
  const size = await capturePage.evaluate(() => {
    const img = document.getElementById('preview') as HTMLImageElement;
    return { w: img.naturalWidth, h: img.naturalHeight };
  });
  const sw = await getServiceWorker();
  await sw.evaluate(async (source) => {
    await chrome.storage.session.set({
      annotationClipboard: {
        v: 1,
        edits: [{ id: 1, kind: 'rect', x: 10, y: 10, w: 20, h: 20 }],
        viewCropPct: null,
        source,
        label: 'seeded capture',
      },
    });
  }, size);

  await capturePage.locator('#more').focus();
  await capturePage.keyboard.press('Enter');
  await expect(capturePage.locator('#more-menu')).toBeVisible();
  await expect(capturePage.locator('#shrink')).toBeDisabled();
  // Paste is the only pickable row, and it's the one focus must land
  // on once the read settles.
  await expect(capturePage.locator('#paste-annotations')).toBeFocused();

  await capturePage.keyboard.press('Escape');
  await expect(capturePage.locator('#more-menu')).toBeHidden();
  expect(await focusedId(capturePage)).toBe('more');

  // A mouse open highlights nothing, even after the same refresh.
  await capturePage.locator('#more').click();
  await expect(capturePage.locator('#more-menu')).toBeVisible();
  await expect(
    capturePage.locator('#more-menu .palette-menu-item:focus'),
  ).toHaveCount(0);
  await capturePage.keyboard.press('Escape');

  await openerPage.close();
});

test('keyboard: More… menu arrows skip disabled items', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await waitForImageLoaded(capturePage);

  // A drawn box enables Shrink (and Copy annotations); View cropped
  // stays disabled without a crop, so it's the row the arrows have to
  // skip.
  await dragRect(
    capturePage,
    { xPct: 0.2, yPct: 0.2 },
    { xPct: 0.4, yPct: 0.4 },
  );
  await expect(capturePage.locator('#view-cropped')).toBeDisabled();

  await capturePage.locator('#more').focus();
  await capturePage.keyboard.press('Enter');
  await expect(capturePage.locator('#more-menu')).toBeVisible();
  await expect(capturePage.locator('#shrink')).toBeFocused();
  await capturePage.keyboard.press('ArrowDown');
  await expect(capturePage.locator('#copy-annotations')).toBeFocused();
  // …and back up past it the same way.
  await capturePage.keyboard.press('ArrowUp');
  await expect(capturePage.locator('#shrink')).toBeFocused();

  await capturePage.keyboard.press('Escape');
  await expect(capturePage.locator('#more-menu')).toBeHidden();
  expect(await focusedId(capturePage)).toBe('more');

  await openerPage.close();
});

test('keyboard: Ask menu rows are arrow-navigable and fire on Enter', async ({
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

  // Mouse open highlights nothing; the first Down enters the list.
  await capturePage.locator('#ask-menu-btn').click();
  await waitForAskMenuReady(capturePage);
  await expect(
    capturePage.locator('#ask-menu .ask-menu-item:focus'),
  ).toHaveCount(0);
  await capturePage.keyboard.press('ArrowDown');
  await expect(
    capturePage.locator('#ask-menu .ask-menu-item').nth(0),
  ).toBeFocused();
  await capturePage.keyboard.press('Escape');
  await expect(capturePage.locator('#ask-menu')).toBeHidden();

  // Keyboard open — the rows render after an await, so the first-item
  // focus lands once they exist.
  await capturePage.locator('#ask-menu-btn').focus();
  await capturePage.keyboard.press('Enter');
  await waitForAskMenuReady(capturePage);
  const items = capturePage.locator('#ask-menu .ask-menu-item');
  await expect(items.nth(0)).toBeFocused();

  // The rows are `<li>`s, so Enter activation is synthesized by
  // `menu-keys.ts` — picking one sets the default and closes.
  await capturePage.keyboard.press('Enter');
  await expect(capturePage.locator('#ask-menu')).toBeHidden();
  // Applying the pick disables both Ask buttons for the SW
  // round-trip, so the focus handoff completes a beat later.
  await expect.poll(() => focusedId(capturePage)).toBe('ask-menu-btn');

  await openerPage.close();
});
