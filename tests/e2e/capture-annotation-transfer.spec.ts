// E2E coverage for annotation transfer — the More menu's
// "Copy annotations" / "Paste annotations" /
// "Import annotations from last capture" trio, which carries one
// capture's drawings + crop onto another so a before/after pair
// lines up exactly.
//
// Specs here:
//   - copy → paste across two Capture pages, including an applied
//     ("Replace with cropped image") crop, which the target has to
//     re-derive from its own original;
//   - paste over existing annotations: overwrite, then Undo peeling
//     the pasted edits off one at a time before the last click
//     restores the pre-paste state, and Redo walking back up through
//     the marker so the re-done paste stays undoable;
//   - the enable rules and the "Unavailable: …" tooltip line, with
//     the size gate driven by a hand-seeded wrong-size payload;
//   - import from the last closed Capture page.
//
// The clipboard lives in `chrome.storage.session`, which survives
// between the two `openDetailsFlow` calls in a test (that helper only
// clears `local`). Each test clears `session` up front so a previous
// test's copy can't satisfy its assertions.

import type { Page, Worker } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import {
  configureAndCapture,
  dragRect,
  openDetailsFlow,
} from './details-helpers';
import {
  clickMoreMenuItem,
  readEditKinds,
  readEffectiveCrop,
} from './capture-drawing-helpers';

async function clearSession(getServiceWorker: () => Promise<Worker>): Promise<void> {
  const sw = await getServiceWorker();
  await sw.evaluate(() => chrome.storage.session.clear());
}

async function readNaturalWidth(capturePage: Page): Promise<number> {
  return capturePage.evaluate(
    () => (document.getElementById('preview') as HTMLImageElement).naturalWidth,
  );
}

// Open the More menu and leave it open, having waited out the async
// refresh of the two paste sources. Tests that assert a *disabled*
// item need this: the items start disabled, so waiting for the
// refresh is the only way to tell "still loading" from "blocked".
async function openMoreMenuSettled(capturePage: Page): Promise<void> {
  await capturePage.locator('#more').click();
  // The refresh ends by rewriting every transfer item's title, and
  // the pre-init markup carries no "From:" / "Unavailable:" suffix
  // on Paste — so a suffix appearing is the settle signal. Import is
  // never enabled without a prior close, so Paste is the one item
  // whose title always changes.
  //
  // Generous timeout: this waits on an SW round-trip, and a run that
  // hits the `captureVisibleTab` 2/sec quota backoff can stall it well
  // past the 5s default. The assertion is about the refresh having
  // landed, not about how fast it lands.
  await expect(capturePage.locator('#paste-annotations')).toHaveAttribute(
    'title',
    /Unavailable:|From:/,
    { timeout: 15000 },
  );
}

// Draw a red box in the upper-left quadrant and a crop over the
// middle half — the shared "some annotations exist" starting state.
async function drawBoxAndCrop(capturePage: Page): Promise<void> {
  await dragRect(capturePage, { xPct: 0.1, yPct: 0.1 }, { xPct: 0.4, yPct: 0.4 });
  await capturePage.locator('#tool-crop').click();
  await dragRect(capturePage, { xPct: 0.25, yPct: 0.25 }, { xPct: 0.75, yPct: 0.75 });
}

test('annotation transfer: copy on one capture pastes the same edits + crop onto another', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  await clearSession(getServiceWorker);

  // ─── Source capture: draw, then copy ───
  const a = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'shrink-target.html',
  );
  await drawBoxAndCrop(a.capturePage);
  const sourceCrop = await readEffectiveCrop(a.capturePage);
  expect(sourceCrop).not.toBeNull();

  await clickMoreMenuItem(a.capturePage, '#copy-annotations');
  // A successful transfer says nothing: the status line sits far from
  // the menu and writing to it shifts the layout. Only failures speak.
  await expect(a.capturePage.locator('#ask-status')).toHaveText('');
  await a.capturePage.close();
  await a.openerPage.close();

  // ─── Target capture: a different page, same viewport size ───
  const b = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
  );
  expect(await readEditKinds(b.capturePage)).toEqual([]);

  await clickMoreMenuItem(b.capturePage, '#paste-annotations');

  // Same edits, in the same order, at the same percentages.
  expect(await readEditKinds(b.capturePage)).toEqual(['rect', 'crop']);
  const pastedCrop = await readEffectiveCrop(b.capturePage);
  expect(pastedCrop).not.toBeNull();
  expect(pastedCrop!.x).toBeCloseTo(sourceCrop!.x, 1);
  expect(pastedCrop!.y).toBeCloseTo(sourceCrop!.y, 1);
  expect(pastedCrop!.w).toBeCloseTo(sourceCrop!.w, 1);
  expect(pastedCrop!.h).toBeCloseTo(sourceCrop!.h, 1);

  await b.capturePage.close();
  await b.openerPage.close();
});

test('annotation transfer: an applied crop is re-derived on the target', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  await clearSession(getServiceWorker);

  const a = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'shrink-target.html',
  );
  const fullWidth = await readNaturalWidth(a.capturePage);

  // Crop, then realise it in the pixels, then draw on top of the
  // re-framed image — so the payload carries both halves: a
  // `viewCropPct` and edits expressed against the cropped frame.
  await a.capturePage.locator('#tool-crop').click();
  await dragRect(a.capturePage, { xPct: 0.25, yPct: 0.25 }, { xPct: 0.75, yPct: 0.75 });
  await clickMoreMenuItem(a.capturePage, '#view-cropped');
  await a.capturePage.waitForFunction(
    (w) => (document.getElementById('preview') as HTMLImageElement).naturalWidth < w,
    fullWidth,
  );
  const croppedWidth = await readNaturalWidth(a.capturePage);
  await a.capturePage.locator('#tool-box').click();
  await dragRect(a.capturePage, { xPct: 0.1, yPct: 0.1 }, { xPct: 0.5, yPct: 0.5 });

  await clickMoreMenuItem(a.capturePage, '#copy-annotations');
  await a.capturePage.close();
  await a.openerPage.close();

  const b = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
  );
  expect(await readNaturalWidth(b.capturePage)).toBe(fullWidth);

  await clickMoreMenuItem(b.capturePage, '#paste-annotations');

  // The target's own original was re-cropped to the same region…
  await b.capturePage.waitForFunction(
    (w) => (document.getElementById('preview') as HTMLImageElement).naturalWidth === w,
    croppedWidth,
  );
  // …and the box that was drawn against the cropped frame came with
  // it, with no crop edit left over (it's realised in the pixels).
  expect(await readEditKinds(b.capturePage)).toEqual(['rect']);

  await b.capturePage.close();
  await b.openerPage.close();
});

test('annotation transfer: paste overwrites, and Undo peels the pasted edits then restores', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  await clearSession(getServiceWorker);

  // Copy two boxes.
  const a = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'shrink-target.html',
  );
  await dragRect(a.capturePage, { xPct: 0.1, yPct: 0.1 }, { xPct: 0.3, yPct: 0.3 });
  await dragRect(a.capturePage, { xPct: 0.5, yPct: 0.5 }, { xPct: 0.7, yPct: 0.7 });
  await clickMoreMenuItem(a.capturePage, '#copy-annotations');
  await a.capturePage.close();
  await a.openerPage.close();

  // The target already has its own annotation — a redaction, so the
  // kinds tell the two sets apart.
  const b = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
  );
  await b.capturePage.locator('#tool-redact').click();
  await dragRect(b.capturePage, { xPct: 0.6, yPct: 0.1 }, { xPct: 0.9, yPct: 0.3 });
  expect(await readEditKinds(b.capturePage)).toEqual(['redact']);

  // Paste replaces rather than merges — and stays quiet about it.
  await clickMoreMenuItem(b.capturePage, '#paste-annotations');
  expect(await readEditKinds(b.capturePage)).toEqual(['rect', 'rect']);
  await expect(b.capturePage.locator('#ask-status')).toHaveText('');

  // Undo steps back through the pasted edits one at a time…
  const undo = b.capturePage.locator('#undo');
  await undo.click();
  expect(await readEditKinds(b.capturePage)).toEqual(['rect']);
  await undo.click();
  expect(await readEditKinds(b.capturePage)).toEqual([]);
  // …and the next click — the one that reaches the paste marker —
  // brings the pre-paste state back.
  await undo.click();
  expect(await readEditKinds(b.capturePage)).toEqual(['redact']);
  // History below the marker is intact: the redaction still undoes.
  await undo.click();
  expect(await readEditKinds(b.capturePage)).toEqual([]);
  await expect(undo).toBeDisabled();

  await b.capturePage.close();
  await b.openerPage.close();
});

test('annotation transfer: Ctrl+Y re-applies an undone paste, undoably', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  await clearSession(getServiceWorker);

  const a = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'shrink-target.html',
  );
  await dragRect(a.capturePage, { xPct: 0.1, yPct: 0.1 }, { xPct: 0.3, yPct: 0.3 });
  await clickMoreMenuItem(a.capturePage, '#copy-annotations');
  await a.capturePage.close();
  await a.openerPage.close();

  const b = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
  );
  await b.capturePage.locator('#tool-redact').click();
  await dragRect(b.capturePage, { xPct: 0.6, yPct: 0.1 }, { xPct: 0.9, yPct: 0.3 });
  await clickMoreMenuItem(b.capturePage, '#paste-annotations');
  expect(await readEditKinds(b.capturePage)).toEqual(['rect']);

  // Undo twice: the pasted edit, then the marker itself, which is
  // the click that swaps the whole pre-paste world back.
  const undo = b.capturePage.locator('#undo');
  await undo.click();
  await undo.click();
  expect(await readEditKinds(b.capturePage)).toEqual(['redact']);

  // Redo returns to the state right after that second Undo's target
  // — the emptied stack the marker left behind, not the paste's
  // edits, which sit above it and redo one at a time.
  await b.capturePage.keyboard.press('Control+y');
  expect(await readEditKinds(b.capturePage)).toEqual([]);
  await b.capturePage.keyboard.press('Control+y');
  expect(await readEditKinds(b.capturePage)).toEqual(['rect']);

  // The re-done paste is undoable again, all the way back through the
  // marker to the target's own redaction — this is what fails if redo
  // restores the edits without the stack the marker indexes into.
  await b.capturePage.keyboard.press('Control+z');
  await b.capturePage.keyboard.press('Control+z');
  expect(await readEditKinds(b.capturePage)).toEqual(['redact']);

  await b.capturePage.close();
  await b.openerPage.close();
});

test('annotation transfer: menu items explain why they are unavailable', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  await clearSession(getServiceWorker);

  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'shrink-target.html',
  );

  // Nothing drawn, nothing copied, nothing closed before us.
  await openMoreMenuSettled(capturePage);
  await expect(capturePage.locator('#copy-annotations')).toBeDisabled();
  await expect(capturePage.locator('#copy-annotations')).toHaveAttribute(
    'title',
    /Unavailable: This capture has no image edits/,
  );
  await expect(capturePage.locator('#paste-annotations')).toBeDisabled();
  await expect(capturePage.locator('#paste-annotations')).toHaveAttribute(
    'title',
    /Unavailable: No image edits have been copied yet/,
  );
  await expect(capturePage.locator('#import-annotations')).toBeDisabled();
  await capturePage.keyboard.press('Escape');

  // Copy lights up as soon as there's something to copy.
  await dragRect(capturePage, { xPct: 0.1, yPct: 0.1 }, { xPct: 0.4, yPct: 0.4 });
  await openMoreMenuSettled(capturePage);
  await expect(capturePage.locator('#copy-annotations')).toBeEnabled();
  await capturePage.keyboard.press('Escape');

  // A payload for a differently-sized capture stays blocked, and the
  // tooltip names both sizes. Seeded straight into the slot: the
  // fixture pages all capture at the same viewport size, so there's
  // no way to produce a mismatch through the UI.
  const sw = await getServiceWorker();
  await sw.evaluate(async () => {
    await chrome.storage.session.set({
      annotationClipboard: {
        v: 1,
        edits: [{ id: 1, kind: 'rect', x: 10, y: 10, w: 20, h: 20 }],
        viewCropPct: null,
        source: { w: 4321, h: 8765 },
        label: 'some other capture',
      },
    });
  });
  await openMoreMenuSettled(capturePage);
  await expect(capturePage.locator('#paste-annotations')).toBeDisabled();
  await expect(capturePage.locator('#paste-annotations')).toHaveAttribute(
    'title',
    /Unavailable: Copied edits are for a 4321×8765 image; this one is \d+×\d+/,
  );

  await capturePage.close();
  await openerPage.close();
});

test('annotation transfer: import pulls the annotations from the last closed capture', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  await clearSession(getServiceWorker);

  // Capture A draws, then goes through the Capture button — the
  // close path that promotes its session into the `lastCapture` slot.
  const a = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'shrink-target.html',
  );
  await drawBoxAndCrop(a.capturePage);
  await configureAndCapture(a.capturePage, {
    saveScreenshot: true,
    saveHtml: false,
  });
  await a.openerPage.close();

  const b = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
  );
  // Import is live even though nothing was ever copied.
  await openMoreMenuSettled(b.capturePage);
  await expect(b.capturePage.locator('#paste-annotations')).toBeDisabled();
  await expect(b.capturePage.locator('#import-annotations')).toBeEnabled();
  await b.capturePage.locator('#import-annotations').click();

  expect(await readEditKinds(b.capturePage)).toEqual(['rect', 'crop']);
  expect(await readEffectiveCrop(b.capturePage)).not.toBeNull();

  await b.capturePage.close();
  await b.openerPage.close();
});
