// E2E coverage for "Convert last drawn box…" (`#convert-last`, in the
// More menu) — the fix for a box drawn with the wrong tool selected.
// The item opens a submenu (`#convert-row`) of the three rect kinds
// under the item; picking one retargets the last edit in place.
//
// Covered here:
//   - the enable rule (top of the stack must be box-shaped) and the
//     submenu closing when the target goes away;
//   - the pushed-down button showing what the target already is;
//   - a Box → Crop conversion keeping the geometry, and Undo putting
//     the kind back;
//   - Box → Redact, checked through the flags a save would report.

import { test, expect } from '../fixtures/extension';
import { dragRect, openDetailsFlow } from './details-helpers';
import {
  clickMoreMenuItem,
  readEditFlags,
  readEditKinds,
  readEffectiveCrop,
  readLastBounds,
} from './capture-drawing-helpers';

test('convert: enable rule and the row that shows the current kind', async ({
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
  const item = capturePage.locator('#convert-last');
  const row = capturePage.locator('#convert-row');

  // Nothing drawn — nothing to convert.
  await expect(item).toBeDisabled();

  await dragRect(capturePage, { xPct: 0.2, yPct: 0.2 }, { xPct: 0.8, yPct: 0.8 });
  await expect(item).toBeEnabled();

  // The item is a disclosure, not a pick: the menu stays open and
  // the row appears under it.
  await expect(row).toBeHidden();
  await clickMoreMenuItem(capturePage, '#convert-last');
  await expect(capturePage.locator('#more-menu')).toBeVisible();
  await expect(row).toBeVisible();

  // The kind the target already is, shown pushed down.
  await expect(capturePage.locator('#convert-to-rect')).toHaveClass(/selected/);
  await expect(capturePage.locator('#convert-to-redact')).not.toHaveClass(/selected/);
  await expect(capturePage.locator('#convert-to-crop')).not.toHaveClass(/selected/);

  // A press elsewhere in the menu — here its own top padding, the
  // one spot the submenu can't be covering — closes the submenu and
  // leaves the menu itself open.
  await capturePage.locator('#more-menu').click({ position: { x: 4, y: 2 } });
  await expect(row).toBeHidden();
  await expect(capturePage.locator('#more-menu')).toBeVisible();

  // Disabled rows count too, even though Chrome fires no events for
  // them: while the submenu is up they give up their pointer events,
  // so the press lands on the menu. (`#view-cropped` is disabled —
  // there's no crop.)
  await item.click();
  await expect(row).toBeVisible();
  await capturePage.locator('#view-cropped').click({ force: true });
  await expect(row).toBeHidden();
  await expect(capturePage.locator('#more-menu')).toBeVisible();
  // Re-open it from the item directly — the menu is already up.
  await item.click();
  await expect(row).toBeVisible();

  // Losing the target collapses the row under the still-open menu —
  // Ctrl+Z from inside the menu undoes the box.
  await capturePage.keyboard.press('Control+z');
  await expect(item).toBeDisabled();
  await expect(row).toBeHidden();
  await expect(capturePage.locator('#more-menu')).toBeVisible();
  await capturePage.keyboard.press('Escape');

  // Only the *top* of the stack counts: a line drawn over a box is
  // what the item looks at, so it stays disabled.
  await capturePage.locator('#tool-box').click();
  await dragRect(capturePage, { xPct: 0.2, yPct: 0.2 }, { xPct: 0.8, yPct: 0.8 });
  await expect(item).toBeEnabled();
  await capturePage.locator('#tool-line').click();
  await dragRect(capturePage, { xPct: 0.3, yPct: 0.3 }, { xPct: 0.6, yPct: 0.6 });
  await expect(item).toBeDisabled();

  // Undoing the line puts the box back on top.
  await capturePage.locator('#undo').click();
  await expect(item).toBeEnabled();

  // Open, the submenu's buttons join the menu's arrow rotation. The
  // menu traps Tab, so that's the only way to reach them.
  await capturePage.locator('#more').focus();
  // Convert is the first enabled row here — Shrink is disabled in
  // Line mode, and View cropped without a crop.
  await capturePage.keyboard.press('Enter');
  await expect(item).toBeFocused();
  await capturePage.keyboard.press('Enter');
  await expect(row).toBeVisible();
  await capturePage.keyboard.press('ArrowDown');
  await expect(capturePage.locator('#convert-to-rect')).toBeFocused();

  // Arrowing back out of it closes it, so the focus ring can't walk
  // onto rows the submenu is painting over.
  await capturePage.keyboard.press('ArrowUp');
  await expect(row).toBeHidden();
  await expect(item).toBeFocused();

  // Closing while it holds focus hands focus back to the More button,
  // rather than dropping it on `<body>` where the arrows have nothing
  // to step from.
  await capturePage.keyboard.press('Enter');
  await expect(row).toBeVisible();
  await capturePage.keyboard.press('ArrowDown');
  await expect(capturePage.locator('#convert-to-rect')).toBeFocused();
  await capturePage.keyboard.press('Control+z');
  await expect(row).toBeHidden();
  await expect(capturePage.locator('#more')).toBeFocused();

  // Escape closes the menu, and the submenu goes with it.
  await capturePage.keyboard.press('Escape');
  await expect(capturePage.locator('#more-menu')).toBeHidden();
  await expect(row).toBeHidden();

  await openerPage.close();
});

test('convert: the submenu stays put when the window resizes', async ({
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

  // The submenu's `top` comes from the item it hangs off, and the
  // menu is re-placed on every window resize — so the two have to
  // still line up afterwards, and the submenu has to stay on screen.
  const expectAttached = async (): Promise<void> => {
    const item = await capturePage.locator('#convert-last').boundingBox();
    const row = await capturePage.locator('#convert-row').boundingBox();
    if (!item || !row) throw new Error('convert item / submenu has no box');
    expect(Math.abs(row.y - (item.y + item.height - 2))).toBeLessThan(1.5);
    const viewportH = capturePage.viewportSize()!.height;
    expect(row.y + row.height).toBeLessThanOrEqual(viewportH);
  };

  await dragRect(capturePage, { xPct: 0.2, yPct: 0.2 }, { xPct: 0.8, yPct: 0.8 });
  await clickMoreMenuItem(capturePage, '#convert-last');
  await expectAttached();

  await capturePage.setViewportSize({ width: 1000, height: 560 });
  await expect(capturePage.locator('#convert-row')).toBeVisible();
  await expectAttached();

  await openerPage.close();
});

test('convert: box → crop keeps the geometry, and Undo puts the kind back', async ({
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

  await dragRect(capturePage, { xPct: 0.2, yPct: 0.25 }, { xPct: 0.8, yPct: 0.75 });
  const drawn = await readLastBounds(capturePage, 'rect');
  expect(drawn).not.toBeNull();
  expect(await readEffectiveCrop(capturePage)).toBeNull();

  await clickMoreMenuItem(capturePage, '#convert-last');
  await capturePage.locator('#convert-to-crop').click();

  // Picking a kind *is* a pick, so the menu closes behind it.
  await expect(capturePage.locator('#more-menu')).toBeHidden();

  // One edit still, now a crop covering exactly what the box did.
  expect(await readEditKinds(capturePage)).toEqual(['crop']);
  expect(await readEffectiveCrop(capturePage)).toEqual(drawn);
  expect(await readLastBounds(capturePage, 'rect')).toBeNull();

  // Undo is a kind-only step: the box comes back where it was, rather
  // than disappearing.
  await capturePage.locator('#undo').click();
  expect(await readEditKinds(capturePage)).toEqual(['rect']);
  expect(await readLastBounds(capturePage, 'rect')).toEqual(drawn);
  expect(await readEffectiveCrop(capturePage)).toBeNull();

  // Redo re-applies the conversion, so it can be undone again.
  await capturePage.keyboard.press('Control+y');
  expect(await readEditKinds(capturePage)).toEqual(['crop']);
  expect(await readEffectiveCrop(capturePage)).toEqual(drawn);

  // Converting back the other way drops the crop again — the edit
  // stays put, only its kind changes.
  await clickMoreMenuItem(capturePage, '#convert-last');
  await capturePage.locator('#convert-to-rect').click();
  expect(await readEditKinds(capturePage)).toEqual(['rect']);
  expect(await readEffectiveCrop(capturePage)).toBeNull();
  expect(await readLastBounds(capturePage, 'rect')).toEqual(drawn);

  // Each conversion is its own step, so it takes one Undo per
  // conversion to get back to the drawn box — and one more to remove
  // it.
  await capturePage.locator('#undo').click();
  expect(await readEditKinds(capturePage)).toEqual(['crop']);
  await capturePage.locator('#undo').click();
  expect(await readEditKinds(capturePage)).toEqual(['rect']);
  await capturePage.locator('#undo').click();
  expect(await readEditKinds(capturePage)).toEqual([]);

  await openerPage.close();
});

test('convert: leaves the edits below the target alone', async ({
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

  // An earlier crop, then a box on top of it.
  await capturePage.locator('#tool-crop').click();
  await dragRect(capturePage, { xPct: 0.1, yPct: 0.1 }, { xPct: 0.9, yPct: 0.9 });
  const crop = await readEffectiveCrop(capturePage);
  expect(crop).not.toBeNull();
  await capturePage.locator('#tool-box').click();
  await dragRect(capturePage, { xPct: 0.3, yPct: 0.3 }, { xPct: 0.6, yPct: 0.6 });

  // Converting the box to a redaction touches only the box: the crop
  // below it keeps its bounds and stays the effective one.
  await clickMoreMenuItem(capturePage, '#convert-last');
  await capturePage.locator('#convert-to-redact').click();
  expect(await readEditKinds(capturePage)).toEqual(['crop', 'redact']);
  expect(await readEffectiveCrop(capturePage)).toEqual(crop);

  await openerPage.close();
});

test('convert: box → redaction switches the flags the save reports', async ({
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

  await dragRect(capturePage, { xPct: 0.2, yPct: 0.25 }, { xPct: 0.8, yPct: 0.75 });
  expect(await readEditFlags(capturePage)).toMatchObject({
    hasHighlights: true,
    hasRedactions: false,
  });

  await clickMoreMenuItem(capturePage, '#convert-last');
  await capturePage.locator('#convert-to-redact').click();

  expect(await readEditKinds(capturePage)).toEqual(['redact']);
  expect(await readEditFlags(capturePage)).toMatchObject({
    hasHighlights: false,
    hasRedactions: true,
  });

  // Re-opening the row shows the new kind as the pushed-down one, and
  // clicking it is a no-op rather than another undo step.
  await clickMoreMenuItem(capturePage, '#convert-last');
  await expect(capturePage.locator('#convert-to-redact')).toHaveClass(/selected/);
  await capturePage.locator('#convert-to-redact').click();
  expect(await readEditKinds(capturePage)).toEqual(['redact']);
  await capturePage.locator('#undo').click();
  expect(await readEditKinds(capturePage)).toEqual(['rect']);

  await openerPage.close();
});
