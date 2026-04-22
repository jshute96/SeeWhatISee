// Shared helpers for the "Capture with details…" E2E specs.
//
// Split out of `capture-with-details.spec.ts` so a second spec
// (`capture-drawing.spec.ts`) can reuse the flow without either
// duplicating ~120 lines of plumbing or forcing changes through a
// file that already runs 27 tests.

import fs from 'node:fs';
import type { BrowserContext, Locator, Page, Worker } from '@playwright/test';
import { type CaptureRecord, waitForDownloadPath } from '../fixtures/files';

// ─── Edit-dialog editor helpers ───────────────────────────────────
//
// The edit dialogs used to host a plain <textarea> where
// `.fill()` / `.inputValue()` worked out of the box. Since moving
// the editor to a CodeJar-wrapped `contenteditable` <div> (with
// highlight.js tokens rewriting the innerHTML on every input),
// those textarea-only Playwright APIs no longer apply. Tests set
// content by writing `textContent` directly — CodeJar's public
// `toString()` is also just `editor.textContent`, so reading +
// saving see the exact same bytes we wrote. Reading uses
// `.textContent()` for the same reason.

/** Read the current source of an edit-dialog editor (contenteditable). */
export async function getEditorCode(locator: Locator): Promise<string> {
  return (await locator.textContent()) ?? '';
}

/**
 * Replace the source of an edit-dialog editor. Writes `textContent`
 * directly (so hljs token spans from the previous highlight pass
 * are discarded) and dispatches a bubbling `keyup` so CodeJar's
 * input pipeline re-runs — CodeJar listens for `keyup` (not
 * `input`) to re-highlight + snapshot history. The save handler
 * reads `jar.toString()` = `editor.textContent` either way, so the
 * dispatch is for cosmetic consistency (test-time hljs tokens
 * match what a user would see) rather than save correctness.
 */
export async function setEditorCode(locator: Locator, value: string): Promise<void> {
  await locator.evaluate((el, v) => {
    el.textContent = v;
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }, value);
}

export const SCREENSHOT_PATTERN = /^screenshot-\d{8}-\d{6}-\d{3}\.png$/;
export const CONTENTS_PATTERN = /^contents-\d{8}-\d{6}-\d{3}\.html$/;

// Resolve the most recently recorded download whose requested
// filename ends with `suffix` (e.g. `'log.json'`, `'.png'`) to its
// on-disk path. Relies on the download-spy that openDetailsFlow
// installs on `chrome.downloads.download` before the flow starts.
//
// Returning the *latest* match (rather than the first) handles the
// case where the same logical artifact has been re-downloaded —
// e.g. a Copy-button pre-download at editVersion=0 followed by a
// Capture-time re-download at editVersion=1 after the user drew a
// highlight. Tests that only ever produce a single matching
// download (the common case) get the same result either way.
export async function findCapturedDownload(sw: Worker, suffix: string): Promise<string> {
  const id = await sw.evaluate((sfx) => {
    interface SpyState { __seeDl?: { id: number; name: string }[] }
    const list = (self as unknown as SpyState).__seeDl ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].name.endsWith(sfx)) return list[i].id;
    }
    throw new Error(
      `no captured download ending in ${sfx}; have: ${list.map((d) => d.name).join(', ')}`,
    );
  }, suffix);
  return await waitForDownloadPath(sw, id);
}

export async function readLatestRecord(sw: Worker): Promise<CaptureRecord> {
  const logPath = await findCapturedDownload(sw, 'log.json');
  const lines = fs.readFileSync(logPath, 'utf8').trimEnd().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

// Open a fixture page (the "opener") and trigger the details flow.
// Returns both the opener page and the capture.html page so the
// caller can manipulate the latter and clean up the former.
export async function openDetailsFlow(
  extensionContext: BrowserContext,
  fixtureServer: { baseUrl: string },
  getServiceWorker: () => Promise<Worker>,
  fixturePath = 'purple.html',
  // Optional hook run on the opener page *after* it has been
  // brought to front but *before* the SW triggers
  // startCaptureWithDetails. Used by the selection-edit tests to
  // inject a live `window.getSelection()` state that the SW's
  // scripting call observes as `selection`.
  beforeCapture?: (page: Page) => Promise<void>,
): Promise<{ openerPage: Page; capturePage: Page }> {
  // Clean log so stale entries from an earlier test in the same
  // worker can't satisfy our assertions.
  const sw0 = await getServiceWorker();
  await sw0.evaluate(() => chrome.storage.local.clear());

  const openerPage = await extensionContext.newPage();
  await openerPage.goto(`${fixtureServer.baseUrl}/${fixturePath}`);
  await openerPage.bringToFront();
  if (beforeCapture) await beforeCapture(openerPage);

  // Set up the page-event listener *before* triggering the SW call,
  // so we don't miss the new tab if it lands fast.
  const capturePagePromise = extensionContext.waitForEvent('page', {
    predicate: (p) => p.url().endsWith('/capture.html'),
    timeout: 5000,
  });

  const sw = await getServiceWorker();
  // Install the spy + trigger the flow in one `evaluate` block so
  // we can't lose the patch to an SW idle-out between calls.
  await sw.evaluate(async () => {
    interface SpyState {
      __seeDl?: { id: number; name: string }[];
      __seeDlOrig?: typeof chrome.downloads.download;
    }
    const g = self as unknown as SpyState;
    if (!g.__seeDlOrig) {
      g.__seeDlOrig = chrome.downloads.download.bind(chrome.downloads);
      (chrome.downloads as { download: typeof chrome.downloads.download }).download =
        (async (opts: chrome.downloads.DownloadOptions) => {
          const id = await g.__seeDlOrig!(opts);
          if (typeof id === 'number') {
            g.__seeDl!.push({ id, name: opts.filename ?? '' });
          }
          return id;
        }) as typeof chrome.downloads.download;
    }
    g.__seeDl = [];

    await (
      self as unknown as {
        SeeWhatISee: { startCaptureWithDetails: () => Promise<void> };
      }
    ).SeeWhatISee.startCaptureWithDetails();
  });

  const capturePage = await capturePagePromise;
  await capturePage.waitForLoadState('domcontentloaded');
  // Wait for the screenshot data URL to load + the overlay to size
  // itself, so any subsequent highlight clicks land on a sized target.
  await capturePage.waitForFunction(() => {
    const img = document.getElementById('preview') as HTMLImageElement | null;
    return !!(img && img.complete && img.naturalWidth > 0 && img.clientWidth > 0);
  });

  return { openerPage, capturePage };
}

export interface CaptureOptions {
  saveScreenshot: boolean;
  saveHtml: boolean;
  prompt?: string;
}

export async function configureAndCapture(
  capturePage: Page,
  opts: CaptureOptions,
): Promise<void> {
  // Reconcile each checkbox against the desired state. Default
  // markup has cap-screenshot=checked / cap-html=unchecked.
  const screenshotEl = capturePage.locator('#cap-screenshot');
  if ((await screenshotEl.isChecked()) !== opts.saveScreenshot) {
    await screenshotEl.click();
  }
  const htmlEl = capturePage.locator('#cap-html');
  if ((await htmlEl.isChecked()) !== opts.saveHtml) {
    await htmlEl.click();
  }

  if (opts.prompt !== undefined) {
    await capturePage.locator('#prompt-text').fill(opts.prompt);
  }

  // The Capture button submits via runtime message; the background
  // saves and then closes our tab. Wait for the close to know the
  // round-trip is done.
  await Promise.all([
    capturePage.waitForEvent('close'),
    capturePage.locator('#capture').click(),
  ]);
}

// Drag a rectangle on the highlight overlay between the given
// percentage coordinates of its bounding box. Tests use this to
// produce highlights without coupling to an internal drawing helper.
//
// Callers must keep `fromPct` at least `HANDLE_PX` (10 CSS px)
// away from every image edge. If the mousedown lands inside the
// HANDLE_PX band, `detectCropHandle` in capture-page.ts fires
// and starts a *crop-drag* instead of a rect/line draw — a silent
// miscategorisation that'd look like a drawing test failure but is
// actually a misuse of the helper. We assert against it rather
// than guessing the intent.
export async function dragRect(
  capturePage: Page,
  fromPct: { xPct: number; yPct: number },
  toPct: { xPct: number; yPct: number },
): Promise<void> {
  const box = await capturePage.locator('#overlay').boundingBox();
  if (!box) throw new Error('overlay has no bounding box');
  const HANDLE_PX = 10;
  const x1 = box.x + box.width * fromPct.xPct;
  const y1 = box.y + box.height * fromPct.yPct;
  const x2 = box.x + box.width * toPct.xPct;
  const y2 = box.y + box.height * toPct.yPct;
  const insetX = Math.min(x1 - box.x, box.x + box.width - x1);
  const insetY = Math.min(y1 - box.y, box.y + box.height - y1);
  if (insetX < HANDLE_PX || insetY < HANDLE_PX) {
    throw new Error(
      `dragRect from (${fromPct.xPct}, ${fromPct.yPct}) is within ${HANDLE_PX}px of the image edge — ` +
      `a mousedown there would start a crop-drag instead of a rect draw. Keep the start at least ` +
      `${HANDLE_PX}px inset, or use the dragEdge helper if a crop-drag is the intent.`,
    );
  }
  await capturePage.mouse.move(x1, y1);
  await capturePage.mouse.down();
  // Two-step move so Playwright synthesises a real intermediate
  // mousemove and the overlay sees the drag distance cross the
  // CLICK_THRESHOLD_PX guard in capture-page.ts.
  await capturePage.mouse.move((x1 + x2) / 2, (y1 + y2) / 2);
  await capturePage.mouse.move(x2, y2);
  await capturePage.mouse.up();
}
