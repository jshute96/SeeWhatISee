// E2E coverage for "Restore last capture": every Capture-page close
// path promotes the per-tab session into a single `lastCapture`
// session-storage slot, and the More-menu "Restore last capture"
// entry rehydrates that slot into a fresh Capture-page tab.
//
// Two specs:
//   - Slot lifecycle + prompt restore (the smallest end-to-end
//     check that the round-trip is wired at all).
//   - The multi-capture bump round-trip the user actually asked
//     about: capture → restore + capture (no edits) keeps the same
//     filenames, then restore + new edits + capture bumps to `-1`
//     suffixes with new bytes. This pins both the `bases` carry-
//     forward (the regression that produced `…-3-4.png` instead of
//     `…-4.png`) and the saved/revisions round-trip.
//
// The restore handler is invoked directly through the SW test seam
// (`self.SeeWhatISee.restoreLastCapture`) rather than the context
// menu — context-menu clicks aren't drivable in the headless test
// browser, and the seam is the same entry point the menu wires up
// in production.

import fs from 'node:fs';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { waitForDownloadPath } from '../fixtures/files';
import {
  CONTENTS_PATTERN,
  SCREENSHOT_PATTERN,
  configureAndCapture,
  dragRect,
  findAllCapturedDownloads,
  findCapturedDownload,
  openDetailsFlow,
  readLatestRecord,
  seedSelection,
  setEditorCode,
} from './details-helpers';

const SELECTION_MD_PATTERN = /^selection-\d{8}-\d{6}-\d{3}\.md$/;
const BUMPED_SELECTION_MD_PATTERN = /^selection-\d{8}-\d{6}-\d{3}-1\.md$/;
const BUMPED_SCREENSHOT_PATTERN = /^screenshot-\d{8}-\d{6}-\d{3}-1\.png$/;
const BUMPED_CONTENTS_PATTERN = /^contents-\d{8}-\d{6}-\d{3}-1\.html$/;

/**
 * Read the `lastCapture` slot directly out of `chrome.storage.session`.
 * `getLastCapture` isn't on `self.SeeWhatISee` (production has no
 * caller for it outside `last-capture.ts`), so the SW eval pulls the
 * raw record. Returns `null` rather than `undefined` so the
 * playwright eval boundary can return it.
 */
async function readLastCaptureSlot(sw: Worker): Promise<unknown> {
  return await sw.evaluate(async () => {
    const stored = await chrome.storage.session.get('lastCapture');
    return stored.lastCapture ?? null;
  });
}

/**
 * Trigger `restoreLastCapture` via the SW test seam and wait for the
 * new Capture-page tab to open + paint its screenshot. Mirrors the
 * post-create wait `openDetailsFlow` does so callers can immediately
 * drive the restored page.
 */
async function restoreAndWaitForCapturePage(
  extensionContext: BrowserContext,
  getServiceWorker: () => Promise<Worker>,
): Promise<Page> {
  const capturePagePromise = extensionContext.waitForEvent('page', {
    predicate: (p) => p.url().endsWith('/capture.html'),
    timeout: 20000,
  });

  const sw = await getServiceWorker();
  await sw.evaluate(async () => {
    const [active] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    await (
      self as unknown as {
        SeeWhatISee: {
          restoreLastCapture: (
            tab: chrome.tabs.Tab | undefined,
          ) => Promise<void>;
        };
      }
    ).SeeWhatISee.restoreLastCapture(active);
  });

  const capturePage = await capturePagePromise;
  await capturePage.waitForLoadState('domcontentloaded');
  await capturePage.waitForFunction(() => {
    const img = document.getElementById('preview') as HTMLImageElement | null;
    return !!(img && img.complete && img.naturalWidth > 0 && img.clientWidth > 0);
  });
  return capturePage;
}

test('restore-last-capture: empty slot at startup, capture populates it, restore re-opens with prompt', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Clean SW-side state. `openDetailsFlow` does `chrome.storage.local.clear()`,
  // but `lastCapture` lives in `chrome.storage.session`, so a stale
  // slot from a previous test in the same worker would otherwise
  // mask the "empty at startup" assertion.
  const sw0 = await getServiceWorker();
  await sw0.evaluate(() => chrome.storage.session.clear());
  expect(await readLastCaptureSlot(sw0)).toBeNull();

  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  const PROMPT = 'restore me later';
  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: PROMPT,
  });

  // Capture-button close path → promoteSessionToLastCapture fires.
  // The slot should now hold *something* keyed by `capture`, and
  // round-trip the prompt under `uiState`.
  const sw = await getServiceWorker();
  const stored = await readLastCaptureSlot(sw) as {
    capture: { screenshotDataUrl: string };
    uiState?: { prompt?: string };
  } | null;
  expect(stored).not.toBeNull();
  expect(stored!.capture.screenshotDataUrl.length).toBeGreaterThan(0);
  expect(stored!.uiState?.prompt).toBe(PROMPT);

  // Now drive Restore. The new Capture-page tab should paint with
  // the prompt textarea pre-filled.
  const restored = await restoreAndWaitForCapturePage(
    extensionContext,
    getServiceWorker,
  );
  await expect(restored.locator('#prompt-text')).toHaveValue(PROMPT);

  // Slot is dropped eagerly by `openCapturePageWithSession`'s quota-
  // relief clear inside the restore path. The new session will
  // re-populate it on the next close.
  expect(await readLastCaptureSlot(sw)).toBeNull();

  await restored.close();
  await openerPage.close();
});

test('restore-last-capture: round-trip with no edits reuses filenames; with edits bumps to -1', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // SeedSelection on the opener so loadData populates
  // `capture.selectionByFormat` and the cap-selection rows are
  // enabled — we need an editable selection to exercise the
  // selection-revision bump path.
  const sw0 = await getServiceWorker();
  await sw0.evaluate(() => chrome.storage.session.clear());

  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    seedSelection,
  );

  // ─── Capture A: prompt + drawing + edit-html + edit-selection.md ───

  const PROMPT_A = 'find the bug';
  await capturePage.locator('#prompt-text').fill(PROMPT_A);

  // Draw a box so the screenshot has an edit baked into it. Box is
  // the default tool; `dragRect` synthesises a real mouse drag at
  // overlay-percentage coordinates.
  await dragRect(
    capturePage,
    { xPct: 0.2, yPct: 0.2 },
    { xPct: 0.5, yPct: 0.5 },
  );

  // Pick the markdown selection format so the saved file lands at
  // `selection-…md` (no extension collision with `contents-…html`)
  // and the editor below targets the markdown editor.
  await capturePage.locator('#cap-selection-markdown').check();

  // Edit HTML.
  const EDITED_HTML_A = '<!doctype html><html><body>A</body></html>';
  await capturePage.locator('#edit-html').click();
  await setEditorCode(capturePage.locator('#edit-html-textarea'), EDITED_HTML_A);
  await capturePage.locator('#edit-html-save').click();
  await expect(capturePage.locator('#edit-html-dialog')).toHaveJSProperty('open', false);

  // Edit Selection (markdown).
  const EDITED_SEL_A = 'markdown body A';
  await capturePage.locator('#edit-selection-markdown-btn').click();
  await setEditorCode(
    capturePage.locator('#edit-selection-markdown-textarea'),
    EDITED_SEL_A,
  );
  await capturePage.locator('#edit-selection-markdown-save').click();
  await expect(capturePage.locator('#edit-selection-markdown-dialog'))
    .toHaveJSProperty('open', false);

  // Save: screenshot + HTML, plus the selection (selection is saved
  // when its master checkbox is on, which it is by default once a
  // selection exists — the markdown radio above ensured the format
  // pick survives). `configureAndCapture` reconciles the two
  // explicit checkboxes and clicks Capture.
  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: true,
  });

  const sw = await getServiceWorker();
  const recordA = await readLatestRecord(sw);
  expect(recordA.prompt).toBe(PROMPT_A);
  expect(recordA.screenshot?.filename).toMatch(SCREENSHOT_PATTERN);
  expect(recordA.contents?.filename).toMatch(CONTENTS_PATTERN);
  expect(recordA.contents?.isEdited).toBe(true);
  expect(recordA.selection?.filename).toMatch(SELECTION_MD_PATTERN);
  expect(recordA.selection?.format).toBe('markdown');
  expect(recordA.selection?.isEdited).toBe(true);

  // Verify A's on-disk bytes. The download spy records every
  // initiated download; the latest `.png` / `.html` / `.md` are
  // what `recordDetailedCapture` referenced.
  const aPng = await findCapturedDownload(sw, recordA.screenshot!.filename);
  const aHtml = await findCapturedDownload(sw, recordA.contents!.filename);
  const aMd = await findCapturedDownload(sw, recordA.selection!.filename);
  const aPngBytes = fs.readFileSync(aPng);
  expect(aPngBytes.length).toBeGreaterThan(0);
  expect(fs.readFileSync(aHtml, 'utf8')).toBe(EDITED_HTML_A);
  // downloadSelection appends a trailing newline when the body
  // doesn't already end in one — see `src/capture/downloads.ts`.
  expect(fs.readFileSync(aMd, 'utf8')).toBe(`${EDITED_SEL_A}\n`);

  // ─── Restore + Capture (no edits): same filenames, same bytes ───

  const restoredB = await restoreAndWaitForCapturePage(
    extensionContext,
    getServiceWorker,
  );
  // Prompt + edit flags survived: the page should paint with the
  // same prompt and the HTML body's badge should report the edited
  // bytes (not the original purple.html scrape).
  await expect(restoredB.locator('#prompt-text')).toHaveValue(PROMPT_A);

  // No further edits — straight to Capture. configureAndCapture
  // reconciles the checkboxes but they're already in the desired
  // state from the carried uiState.
  await configureAndCapture(restoredB, {
    saveScreenshot: true,
    saveHtml: true,
  });

  const recordB = await readLatestRecord(sw);
  expect(recordB.prompt).toBe(PROMPT_A);
  // Same filenames as A — revision unchanged, so the saved bumpIndex
  // is reused and the on-disk file is overwritten in place.
  expect(recordB.screenshot?.filename).toBe(recordA.screenshot?.filename);
  expect(recordB.contents?.filename).toBe(recordA.contents?.filename);
  expect(recordB.selection?.filename).toBe(recordA.selection?.filename);
  expect(recordB.contents?.isEdited).toBe(true);
  expect(recordB.selection?.isEdited).toBe(true);

  // Bytes are identical to A's — same source bytes flowed through.
  // (The HTML / selection bytes came from the carried `htmlEdited` /
  // `selectionEdited` bodies; the screenshot came from the carried
  // baked-in PNG override.)
  const bDownloads = await findAllCapturedDownloads(sw, 'screenshot-');
  const latestBPng = bDownloads[bDownloads.length - 1];
  const bPng = await waitForDownloadPath(sw, latestBPng.id);
  expect(fs.readFileSync(bPng)).toEqual(aPngBytes);

  const bHtmlDownloads = await findAllCapturedDownloads(sw, 'contents-');
  const latestBHtml = await waitForDownloadPath(
    sw,
    bHtmlDownloads[bHtmlDownloads.length - 1].id,
  );
  expect(fs.readFileSync(latestBHtml, 'utf8')).toBe(EDITED_HTML_A);

  const bMdDownloads = await findAllCapturedDownloads(sw, 'selection-');
  const latestBMd = await waitForDownloadPath(
    sw,
    bMdDownloads[bMdDownloads.length - 1].id,
  );
  expect(fs.readFileSync(latestBMd, 'utf8')).toBe(`${EDITED_SEL_A}\n`);

  // ─── Restore + edit + Capture: -1 suffix on every bumped artifact ───

  const restoredC = await restoreAndWaitForCapturePage(
    extensionContext,
    getServiceWorker,
  );
  await expect(restoredC.locator('#prompt-text')).toHaveValue(PROMPT_A);

  // Draw another box → screenshot.editVersion bumps → next save
  // sees a diverged revision and lands at `-1.png`.
  await dragRect(
    restoredC,
    { xPct: 0.55, yPct: 0.55 },
    { xPct: 0.8, yPct: 0.8 },
  );

  const EDITED_HTML_C = '<!doctype html><html><body>C</body></html>';
  await restoredC.locator('#edit-html').click();
  await setEditorCode(restoredC.locator('#edit-html-textarea'), EDITED_HTML_C);
  await restoredC.locator('#edit-html-save').click();
  await expect(restoredC.locator('#edit-html-dialog')).toHaveJSProperty('open', false);

  const EDITED_SEL_C = 'markdown body C — different';
  await restoredC.locator('#edit-selection-markdown-btn').click();
  await setEditorCode(
    restoredC.locator('#edit-selection-markdown-textarea'),
    EDITED_SEL_C,
  );
  await restoredC.locator('#edit-selection-markdown-save').click();
  await expect(restoredC.locator('#edit-selection-markdown-dialog'))
    .toHaveJSProperty('open', false);

  await configureAndCapture(restoredC, {
    saveScreenshot: true,
    saveHtml: true,
  });

  const recordC = await readLatestRecord(sw);
  expect(recordC.screenshot?.filename).toMatch(BUMPED_SCREENSHOT_PATTERN);
  expect(recordC.contents?.filename).toMatch(BUMPED_CONTENTS_PATTERN);
  expect(recordC.selection?.filename).toMatch(BUMPED_SELECTION_MD_PATTERN);

  // The bumped names must be the original A names + `-1`, not
  // `<bumped-A>-N`. This is the `bases` regression: if we had fed
  // the already-bumped `capture.screenshotFilename` back into
  // `bumpedFilename`, the second restored save here would land at
  // `…-1.png` *of the previous save's stem*, producing a doubled
  // suffix on subsequent rounds. Asserting the stem stays anchored
  // to A's name pins the fix.
  const aScreenshotStem = recordA.screenshot!.filename.replace(/\.png$/, '');
  const aContentsStem = recordA.contents!.filename.replace(/\.html$/, '');
  const aSelectionStem = recordA.selection!.filename.replace(/\.md$/, '');
  expect(recordC.screenshot!.filename).toBe(`${aScreenshotStem}-1.png`);
  expect(recordC.contents!.filename).toBe(`${aContentsStem}-1.html`);
  expect(recordC.selection!.filename).toBe(`${aSelectionStem}-1.md`);

  // New bytes landed under the new names.
  const cPng = await findCapturedDownload(sw, recordC.screenshot!.filename);
  expect(fs.readFileSync(cPng)).not.toEqual(aPngBytes);
  const cHtml = await findCapturedDownload(sw, recordC.contents!.filename);
  expect(fs.readFileSync(cHtml, 'utf8')).toBe(EDITED_HTML_C);
  const cMd = await findCapturedDownload(sw, recordC.selection!.filename);
  expect(fs.readFileSync(cMd, 'utf8')).toBe(`${EDITED_SEL_C}\n`);

  // A's files are still on disk under their original names — the
  // bump policy is "previous file stays immutable, next save lands
  // at a fresh -N." Verifies we didn't accidentally overwrite A.
  expect(fs.readFileSync(aPng)).toEqual(aPngBytes);
  expect(fs.readFileSync(aHtml, 'utf8')).toBe(EDITED_HTML_A);
  // downloadSelection appends a trailing newline when the body
  // doesn't already end in one — see `src/capture/downloads.ts`.
  expect(fs.readFileSync(aMd, 'utf8')).toBe(`${EDITED_SEL_A}\n`);

  await openerPage.close();
});
