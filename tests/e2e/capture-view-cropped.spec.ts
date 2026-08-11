// E2E coverage for the Capture page's "View cropped" action
// (`#view-cropped`, in the More menu) — it replaces the displayed
// image with just the cropped region, as if the capture had been
// taken at that size.
//
// Covered here:
//   - enable rule (needs an active crop) and the natural-size /
//     edit-stack effects of a click;
//   - re-cropping the already-cropped image (crop-of-a-crop);
//   - a Box edit surviving the re-frame with re-mapped percentages,
//     and one that falls entirely outside being dropped;
//   - Undo restoring the full-size image and the crop edit;
//   - the More menu's open / dismiss behaviour, which is what makes
//     both items reachable.

import { test, expect } from '../fixtures/extension';
import { dragRect, openDetailsFlow } from './details-helpers';
import {
  clickMoreMenuItem,
  readEditKinds,
  readEffectiveCrop,
  readLastBounds,
} from './capture-drawing-helpers';

// Natural (intrinsic) pixel size of the preview image — this is what
// View cropped rewrites.
async function readNaturalSize(
  capturePage: import('@playwright/test').Page,
): Promise<{ w: number; h: number }> {
  return capturePage.evaluate(() => {
    const img = document.getElementById('preview') as HTMLImageElement;
    return { w: img.naturalWidth, h: img.naturalHeight };
  });
}

// Wait for the preview image to finish decoding a freshly assigned
// `src`. Every View cropped / Undo click swaps the data URL, and the
// natural-size assertions below have to run against the new bytes.
async function waitForNaturalWidth(
  capturePage: import('@playwright/test').Page,
  expected: number,
): Promise<void> {
  await capturePage.waitForFunction(
    (w) => (document.getElementById('preview') as HTMLImageElement).naturalWidth === w,
    expected,
  );
}

test('view cropped: re-frames the image around the crop and Undo restores it', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'shrink-target.html',
  );
  const btn = capturePage.locator('#view-cropped');

  // No crop drawn yet — nothing to re-frame.
  await expect(btn).toBeDisabled();

  const full = await readNaturalSize(capturePage);

  // Draw a crop over the middle half of the image on each axis.
  await capturePage.locator('#tool-crop').click();
  await dragRect(capturePage, { xPct: 0.25, yPct: 0.25 }, { xPct: 0.75, yPct: 0.75 });
  expect(await readEffectiveCrop(capturePage)).not.toBeNull();
  await expect(btn).toBeEnabled();

  await clickMoreMenuItem(capturePage, '#view-cropped');

  // The base image is now the crop: half the width and height (±1px
  // for the crop percentages rounding to whole pixels), and the crop
  // edit is gone — it's been realised in the pixels.
  const cropped = await readNaturalSize(capturePage);
  expect(Math.abs(cropped.w - full.w / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(cropped.h - full.h / 2)).toBeLessThanOrEqual(1);
  expect(await readEditKinds(capturePage)).toEqual([]);
  expect(await readEffectiveCrop(capturePage)).toBeNull();
  // With no crop left, the button goes back to disabled.
  await expect(btn).toBeDisabled();

  // Undo puts the full-size capture back, crop edit and all.
  await capturePage.locator('#undo').click();
  await waitForNaturalWidth(capturePage, full.w);
  expect(await readEditKinds(capturePage)).toEqual(['crop']);
  const restored = await readEffectiveCrop(capturePage);
  expect(restored).not.toBeNull();
  expect(restored!.w).toBeGreaterThan(40);
  expect(restored!.w).toBeLessThan(60);
  await expect(btn).toBeEnabled();

  await openerPage.close();
});

test('view cropped: crops again inside the already-cropped image', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'shrink-target.html',
  );
  const full = await readNaturalSize(capturePage);

  await capturePage.locator('#tool-crop').click();
  await dragRect(capturePage, { xPct: 0.25, yPct: 0.25 }, { xPct: 0.75, yPct: 0.75 });
  await clickMoreMenuItem(capturePage, '#view-cropped');
  await waitForNaturalWidth(capturePage, Math.round(full.w / 2));

  // A second crop, drawn over the middle half of what's left, halves
  // the image again — the new picture is the whole coordinate space
  // as far as the crop tool is concerned.
  await dragRect(capturePage, { xPct: 0.25, yPct: 0.25 }, { xPct: 0.75, yPct: 0.75 });
  await clickMoreMenuItem(capturePage, '#view-cropped');
  const twice = await readNaturalSize(capturePage);
  expect(Math.abs(twice.w - full.w / 4)).toBeLessThanOrEqual(1);
  expect(Math.abs(twice.h - full.h / 4)).toBeLessThanOrEqual(1);

  await openerPage.close();
});

test('view cropped: a drawn box survives, re-mapped into the new frame', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'shrink-target.html',
  );

  // Box over 40%–60% of the full image…
  await dragRect(capturePage, { xPct: 0.4, yPct: 0.4 }, { xPct: 0.6, yPct: 0.6 });
  // …then crop to 25%–75%, so the box occupies 30%–70% of the crop.
  await capturePage.locator('#tool-crop').click();
  await dragRect(capturePage, { xPct: 0.25, yPct: 0.25 }, { xPct: 0.75, yPct: 0.75 });
  await clickMoreMenuItem(capturePage, '#view-cropped');

  expect(await readEditKinds(capturePage)).toEqual(['rect']);
  const box = await readLastBounds(capturePage, 'rect');
  expect(box).not.toBeNull();
  // Generous slack: the drag's start/end land on whole CSS pixels,
  // which don't divide evenly into the percentages above.
  expect(Math.abs(box!.x - 30)).toBeLessThan(4);
  expect(Math.abs(box!.y - 30)).toBeLessThan(4);
  expect(Math.abs(box!.w - 40)).toBeLessThan(6);
  expect(Math.abs(box!.h - 40)).toBeLessThan(6);

  await openerPage.close();
});

test('view cropped: an edit entirely outside the crop is dropped, and Undo brings it back', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'shrink-target.html',
  );
  const full = await readNaturalSize(capturePage);

  // Box in the top-left quadrant, crop the bottom-right one — no
  // overlap at all.
  await dragRect(capturePage, { xPct: 0.1, yPct: 0.1 }, { xPct: 0.35, yPct: 0.35 });
  await capturePage.locator('#tool-crop').click();
  await dragRect(capturePage, { xPct: 0.55, yPct: 0.55 }, { xPct: 0.9, yPct: 0.9 });
  await clickMoreMenuItem(capturePage, '#view-cropped');

  // Dropped, not just clipped: an invisible edit would still claim
  // highlights on the saved record and offer itself to Shrink.
  expect(await readEditKinds(capturePage)).toEqual([]);

  // Undo restores the whole pre-crop state, the box included.
  await capturePage.locator('#undo').click();
  await waitForNaturalWidth(capturePage, full.w);
  expect(await readEditKinds(capturePage)).toEqual(['rect', 'crop']);

  await openerPage.close();
});

test('more menu: opens, and closes on an item, Escape, or a click elsewhere', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'shrink-target.html',
  );
  const menu = capturePage.locator('#more-menu');
  const moreBtn = capturePage.locator('#more');

  await expect(menu).toBeHidden();

  // Toggle open, then shut from the button itself. The outside-click
  // closer has to leave this path alone — if it fired first the menu
  // would close and the button's click would reopen it.
  await moreBtn.click();
  await expect(menu).toBeVisible();
  await moreBtn.click();
  await expect(menu).toBeHidden();

  // Escape.
  await moreBtn.click();
  await expect(menu).toBeVisible();
  await capturePage.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // A click anywhere else — here the prompt textarea, so the press
  // lands on something unrelated to the palette.
  await moreBtn.click();
  await expect(menu).toBeVisible();
  await capturePage.locator('#prompt-text').click();
  await expect(menu).toBeHidden();

  // Picking an item closes it too (Shrink box is enabled in Crop
  // mode, which falls back to the full image).
  await capturePage.locator('#tool-crop').click();
  await clickMoreMenuItem(capturePage, '#shrink');
  await expect(menu).toBeHidden();

  await openerPage.close();
});
