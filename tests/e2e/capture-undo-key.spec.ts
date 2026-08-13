// E2E coverage for `Ctrl+Z` on the Capture page, which has two
// unrelated undo stacks — the image edits and the prompt textarea's
// own text undo. `src/capture-page/undo-scope.ts` routes the key by
// an invisible "undo scope" rather than by focus, because drawing
// never takes focus off the prompt.

import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { dragRect, openDetailsFlow } from './details-helpers';
import { readEditKinds } from './capture-drawing-helpers';

/** id of the element that currently has focus in the Capture page. */
async function focusedId(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.id ?? '');
}

test('undo key: Ctrl+Z after drawing pops image edits, not text', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const prompt = capturePage.locator('#prompt-text');

  // Type first, so the textarea has something on its own undo stack —
  // this is what Chrome's default Ctrl+Z would have reached for.
  await prompt.click();
  await capturePage.keyboard.type('hello');

  await dragRect(capturePage, { xPct: 0.2, yPct: 0.2 }, { xPct: 0.3, yPct: 0.3 });
  await dragRect(capturePage, { xPct: 0.4, yPct: 0.4 }, { xPct: 0.5, yPct: 0.5 });
  // The point of the whole module: drawing leaves the caret where it
  // was, so focus can't be what decides where Ctrl+Z goes.
  expect(await focusedId(capturePage)).toBe('prompt-text');

  await capturePage.keyboard.press('Control+z');
  expect(await readEditKinds(capturePage)).toEqual(['rect']);
  await capturePage.keyboard.press('Control+z');
  expect(await readEditKinds(capturePage)).toEqual([]);
  await expect(prompt).toHaveValue('hello');

  // Nothing left to undo: the key is still swallowed rather than
  // falling through to the text stack.
  await capturePage.keyboard.press('Control+z');
  await expect(prompt).toHaveValue('hello');

  await openerPage.close();
});

test('undo key: typing in the prompt hands Ctrl+Z back to the text', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const prompt = capturePage.locator('#prompt-text');

  await dragRect(capturePage, { xPct: 0.2, yPct: 0.2 }, { xPct: 0.3, yPct: 0.3 });
  // No click into the field — the draw left the caret there, which is
  // the "draw, then just start typing" flow we want to keep working.
  await capturePage.keyboard.type('hello');
  await expect(prompt).toHaveValue('hello');

  await capturePage.keyboard.press('Control+z');
  // The typing burst is gone and the drawing survived.
  await expect(prompt).not.toHaveValue('hello');
  expect(await readEditKinds(capturePage)).toEqual(['rect']);

  // Clicking a palette tool takes the scope back to the image.
  await capturePage.locator('#tool-redact').click();
  await capturePage.keyboard.press('Control+z');
  expect(await readEditKinds(capturePage)).toEqual([]);

  await openerPage.close();
});

test('undo key: an arrow-key nudge mid-drag leaves the scope on the image', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const prompt = capturePage.locator('#prompt-text');
  await prompt.click();
  await capturePage.keyboard.type('hello');

  // Nudging the drag point with the arrow keys is image work, but the
  // caret is still in the prompt (drawing never takes focus), so the
  // press reaches the textarea. The drag handler consumes it in the
  // capture phase — the scope has to notice that and not treat it as
  // the user going back to typing.
  const box = await capturePage.locator('#overlay').boundingBox();
  if (!box) throw new Error('overlay has no bounding box');
  await capturePage.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await capturePage.mouse.down();
  await capturePage.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await capturePage.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await capturePage.keyboard.press('ArrowRight');
  await capturePage.mouse.up();
  expect(await readEditKinds(capturePage)).toEqual(['rect']);

  await capturePage.keyboard.press('Control+z');
  expect(await readEditKinds(capturePage)).toEqual([]);
  await expect(prompt).toHaveValue('hello');

  await openerPage.close();
});

test('undo key: text arriving without a keystroke takes the scope back', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const prompt = capturePage.locator('#prompt-text');

  await dragRect(capturePage, { xPct: 0.2, yPct: 0.2 }, { xPct: 0.3, yPct: 0.3 });
  // `insertText` fires `input` with no keydown at all — the same shape
  // as a Ctrl+V paste or a text drag-drop into the field, which a
  // keystroke-only scope tracker would miss.
  await capturePage.keyboard.insertText('pasted');
  await expect(prompt).toHaveValue('pasted');

  await capturePage.keyboard.press('Control+z');
  await expect(prompt).not.toHaveValue('pasted');
  expect(await readEditKinds(capturePage)).toEqual(['rect']);

  await openerPage.close();
});

test('undo key: Ctrl+Z on a save checkbox does nothing', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const prompt = capturePage.locator('#prompt-text');
  await prompt.click();
  await capturePage.keyboard.type('hello');

  // A checkbox is an `<input>` but holds no text, so it must not be
  // mistaken for "a field the browser's text undo belongs to" — that
  // would let Chrome's default undo the prompt and yank focus there.
  await capturePage.locator('#cap-screenshot').focus();
  await capturePage.keyboard.press('Control+z');
  expect(await focusedId(capturePage)).toBe('cap-screenshot');
  await expect(prompt).toHaveValue('hello');

  await openerPage.close();
});

test('undo key: Ctrl+Shift+Z still redoes prompt text', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const prompt = capturePage.locator('#prompt-text');
  await prompt.click();
  await capturePage.keyboard.type('hello');

  // The one deliberate passthrough: the image stack has no redo, so
  // Shift is never taken and the textarea keeps its own.
  await capturePage.keyboard.press('Control+z');
  await expect(prompt).not.toHaveValue('hello');
  await capturePage.keyboard.press('Control+Shift+z');
  await expect(prompt).toHaveValue('hello');

  await openerPage.close();
});

test('undo key: Ctrl+Z with focus on neither half does nothing', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  const prompt = capturePage.locator('#prompt-text');

  await dragRect(capturePage, { xPct: 0.2, yPct: 0.2 }, { xPct: 0.3, yPct: 0.3 });
  await capturePage.keyboard.type('hello');

  // Tab out of the prompt to the Capture button. The prompt owns the
  // undo scope but no longer has the caret, so the key resolves to
  // nothing — and, crucially, Chrome's default doesn't get to undo
  // the typing and drag focus back into the field to show it.
  await capturePage.locator('#capture').focus();
  await capturePage.keyboard.press('Control+z');
  expect(await focusedId(capturePage)).toBe('capture');
  await expect(prompt).toHaveValue('hello');
  expect(await readEditKinds(capturePage)).toEqual(['rect']);

  await openerPage.close();
});
