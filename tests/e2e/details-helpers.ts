// Shared helpers for the Capture page flow E2E specs:
// `capture-with-details`, `capture-details-copy`,
// `capture-details-edit`, `capture-drawing`, and
// `toolbar-dispatch`. Covers flow open, capture submit, CodeJar
// editor read/write, overlay drag, clipboard / download spies, and
// selection seeding — the plumbing every consumer would otherwise
// duplicate.

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

// Open a fixture page (the "opener") and trigger the Capture page flow.
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
  // Optional storage seed applied *after* the clear that opens this
  // helper and *before* the flow starts — so the Capture page's
  // first-paint `getDetailsData` round-trip sees these values.
  // Use this for `capturePageDefaults` (button + Enter behaviour)
  // and any other key the page reads from `chrome.storage.local`.
  seedStorage?: Record<string, unknown>,
): Promise<{ openerPage: Page; capturePage: Page }> {
  // Clean log so stale entries from an earlier test in the same
  // worker can't satisfy our assertions.
  const sw0 = await getServiceWorker();
  await sw0.evaluate(() => chrome.storage.local.clear());
  if (seedStorage) {
    await sw0.evaluate(async (data) => {
      await chrome.storage.local.set(data);
    }, seedStorage);
  }

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

// Drag on the drawing overlay between the given percentage
// coordinates of its bounding box. Used by drawing tests to commit
// an edit of whichever tool is currently selected (Box by default;
// Line / Crop / Redact when the test clicks the matching tool
// button first).
//
// Callers must keep `fromPct` at least `HANDLE_PX` (10 CSS px)
// away from every image edge. If the mousedown lands inside the
// HANDLE_PX band, `detectCropHandle` in capture-page.ts fires and
// starts a *crop-handle drag* (creating or resizing the crop)
// instead of a tool-driven draw — a silent miscategorisation that
// would look like a drawing test failure but is actually a misuse
// of the helper. We assert against it rather than guessing intent.
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
      `a mousedown there would start a crop-handle drag instead of a tool draw. Keep the start at ` +
      `least ${HANDLE_PX}px inset, or use the dragEdge helper if a crop-handle drag is the intent.`,
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

// ─── Clipboard + download spies (copy-button / edit-dialog tests) ─

// Spy on `navigator.clipboard.writeText` from the Capture page. The
// spy installs a per-page array of all text writes so the test can
// inspect them without needing clipboard-read permission (which
// additionally requires user activation to actually read back).
function getSW(pageOrSw: Page | Worker): Worker {
  if ('context' in pageOrSw) {
    const sw = pageOrSw.context().serviceWorkers()[0];
    if (!sw) throw new Error('No service worker found in page context');
    return sw;
  }
  return pageOrSw;
}

export async function installClipboardSpy(pageOrSw: Page | Worker): Promise<void> {
  const sw = getSW(pageOrSw);
  await sw.evaluate(() => {
    interface SpyState { __seeClip?: string[] }
    const g = self as unknown as SpyState;
    g.__seeClip = [];
  });
}

export async function readClipboardSpy(pageOrSw: Page | Worker): Promise<string[]> {
  const sw = getSW(pageOrSw);
  return await sw.evaluate(
    () => (self as unknown as { __seeClip?: string[] }).__seeClip ?? [],
  );
}

// Wait until the clipboard spy has recorded `n` writes. Copy click
// handlers are async (SW round-trip + wait-for-download-complete),
// so a Playwright `.click()` resolves before the write lands.
export async function waitForClipboardWrites(pageOrSw: Page | Worker, n: number): Promise<void> {
  const sw = getSW(pageOrSw);
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const len = await sw.evaluate(
      () => (self as unknown as { __seeClip?: string[] }).__seeClip?.length ?? 0,
    );
    if (len >= n) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timeout waiting for ${n} clipboard writes in Service Worker`);
}

// ─── Image-clipboard spy (palette Copy button) ───────────────────
//
// `navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])`
// is a different API surface from the `writeText` covered by
// `installClipboardSpy`. The image-spy stubs `clipboard.write`,
// reads each ClipboardItem's blobs synchronously, and stores the
// bytes as base64 strings (the only blob shape Playwright's
// eval boundary serialises cleanly).
export interface ClipboardWriteEntry {
  /** ClipboardItem.types as reported at write time. */
  types: string[];
  /** Per-type blob bytes, base64-encoded. Use `Buffer.from(.., 'base64')`. */
  blobs: Record<string, string>;
}

export async function installClipboardWriteSpy(page: Page): Promise<void> {
  await page.evaluate(() => {
    interface Entry { types: string[]; blobs: Record<string, string> }
    interface SpyState { __seeClipWrites?: Entry[] }
    const g = self as unknown as SpyState;
    g.__seeClipWrites = [];
    // Unlike `installClipboardSpy` (which calls through to the real
    // `writeText`), this spy intentionally does NOT call the original
    // `clipboard.write` — `image/png` writes need a focused window
    // and clean user-activation that the headless test browser doesn't
    // always produce, and the test only cares which bytes the page
    // tried to write. Call-through would buy nothing here and would
    // make the spy flaky on focus loss.
    (navigator.clipboard as { write: (items: ClipboardItem[]) => Promise<void> }).write =
      async (items: ClipboardItem[]) => {
        for (const item of items) {
          const blobs: Record<string, string> = {};
          for (const type of item.types) {
            const blob = await item.getType(type);
            const buf = await blob.arrayBuffer();
            // Build a binary string then btoa — Playwright's
            // page.evaluate can return primitives but not ArrayBuffer,
            // so the test side decodes from base64 instead.
            const bytes = new Uint8Array(buf);
            let bin = '';
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            blobs[type] = btoa(bin);
          }
          g.__seeClipWrites!.push({ types: [...item.types], blobs });
        }
      };
  });
}

export async function readClipboardWriteSpy(page: Page): Promise<ClipboardWriteEntry[]> {
  return await page.evaluate(
    () => (self as unknown as { __seeClipWrites?: ClipboardWriteEntry[] }).__seeClipWrites ?? [],
  );
}

export async function waitForClipboardWriteSpy(page: Page, n: number): Promise<void> {
  await page.waitForFunction(
    (count) =>
      ((self as unknown as { __seeClipWrites?: unknown[] }).__seeClipWrites?.length ?? 0) >= count,
    n,
    { timeout: 5000 },
  );
}

// Count the screenshot / HTML downloads recorded in the SW spy
// (installed by `openDetailsFlow`). Used to assert the per-tab cache
// short-circuits — i.e. after the first Copy on each kind, neither a
// repeat Copy nor the eventual Capture should add another entry.
export async function countDownloadsBySuffix(sw: Worker, suffix: string): Promise<number> {
  return await sw.evaluate((sfx) => {
    interface SpyState { __seeDl?: { id: number; name: string }[] }
    const list = (self as unknown as SpyState).__seeDl ?? [];
    return list.filter((d) => d.name.endsWith(sfx)).length;
  }, suffix);
}

// Return *all* downloads whose requested filename matches a bare
// basename prefix (e.g. `'contents-'` or `'selection-'`), in the
// order they were initiated. Each entry includes the chrome
// downloadId so the caller can resolve the on-disk path and read
// the bytes back. Used by the edit-dialog tests to verify that a
// post-edit Copy requests the *same* pinned filename as the
// pre-edit Copy (i.e. production overwrites in place) while also
// proving the bytes on disk differ.
export async function findAllCapturedDownloads(
  sw: Worker,
  basenamePrefix: string,
): Promise<{ id: number; name: string }[]> {
  return await sw.evaluate((prefix) => {
    interface SpyState { __seeDl?: { id: number; name: string }[] }
    const list = (self as unknown as SpyState).__seeDl ?? [];
    // `name` is the full `SeeWhatISee/<basename>` path we passed to
    // `chrome.downloads.download`. Match the bare basename prefix
    // so callers don't have to care about the directory segment.
    return list.filter((d) => {
      const base = d.name.split('/').pop() ?? d.name;
      return base.startsWith(prefix);
    });
  }, basenamePrefix);
}

// ─── Page-side download spy (Save-as buttons) ────────────────────
//
// The per-row "Save…" buttons and the in-dialog "Download" button
// call `chrome.downloads.download({ saveAs: true })` directly from
// the Capture page (no SW round-trip). That call would normally pop
// a native OS save dialog, which Playwright can't drive. The spy
// below replaces `chrome.downloads.download` on the Capture page
// with a stub that:
//
//   - records the requested `filename`, `saveAs` flag, and `url`;
//   - fetches the URL itself so the test can inspect the bytes
//     before the page-side `finally` revokes the blob;
//   - returns a synthetic id without ever invoking the real
//     chrome API, so no dialog appears and nothing lands in the
//     downloads dir.
//
// Independent from the SW-side download spy installed by
// `openDetailsFlow`: SW-side calls (Copy buttons, Capture submit)
// still go through the real `chrome.downloads.download` and get
// recorded under `__seeDl` on the SW.
export interface PageDownloadEntry {
  filename: string;
  saveAs: boolean;
  url: string;
  /** Fetched body. For PNG data URLs the UTF-8 decode is lossy — only
   *  compare bytes for known text formats (HTML / txt / md). */
  bytes: string;
  /** Content-Type from the fetched response. */
  mime: string;
}

export async function installPageDownloadSpy(page: Page): Promise<void> {
  await page.evaluate(() => {
    interface PageDl {
      filename: string;
      saveAs: boolean;
      url: string;
      bytes: string;
      mime: string;
    }
    interface SpyState { __seePgDl?: PageDl[] }
    const g = self as unknown as SpyState;
    g.__seePgDl = [];
    (chrome.downloads as { download: typeof chrome.downloads.download }).download =
      (async (opts: chrome.downloads.DownloadOptions): Promise<number> => {
        const url = opts.url ?? '';
        let bytes = '';
        let mime = '';
        if (url) {
          try {
            const res = await fetch(url);
            mime = res.headers.get('content-type') ?? '';
            bytes = await res.text();
          } catch {
            // Blob URL might already be revoked in pathological cases —
            // record what we have and let the test inspect.
          }
        }
        g.__seePgDl!.push({
          filename: opts.filename ?? '',
          saveAs: opts.saveAs === true,
          url,
          bytes,
          mime,
        });
        // Synthetic id: production callers only use the return value
        // for nothing (they `await` the call but discard the id), so
        // any number works. Negative so a chrome.downloads.search
        // (which rejects negative ids) would error visibly.
        return -100000 - g.__seePgDl!.length;
      }) as typeof chrome.downloads.download;
  });
}

export async function readPageDownloads(page: Page): Promise<PageDownloadEntry[]> {
  return await page.evaluate(
    () => (self as unknown as { __seePgDl?: PageDownloadEntry[] }).__seePgDl ?? [],
  );
}

export async function waitForPageDownloads(page: Page, n: number): Promise<void> {
  await page.waitForFunction(
    (count) =>
      ((self as unknown as { __seePgDl?: unknown[] }).__seePgDl?.length ?? 0) >= count,
    n,
    { timeout: 5000 },
  );
}

// Spy on Capture / Ask-btn clicks. Records which button id received
// the click and stops propagation so the page's own submit / Ask
// handlers DON'T fire — the spy is for tests that only care about
// *which* button was triggered, not about driving the full Capture
// or Ask round-trip. Use a capture-phase listener so the spy sees the
// click before the bubble-phase listeners that capture-page.ts wires
// (the page's `captureBtn.addEventListener('click', …)` is bubble-
// phase; stopImmediatePropagation in the capture phase suppresses it).
export async function installButtonClickSpy(capturePage: Page): Promise<void> {
  await capturePage.evaluate(() => {
    interface Spy { __seeBtnClicks?: string[] }
    const g = self as unknown as Spy;
    g.__seeBtnClicks = [];
    for (const id of ['capture', 'ask-btn']) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.addEventListener(
        'click',
        (e) => {
          e.stopImmediatePropagation();
          e.preventDefault();
          g.__seeBtnClicks!.push(id);
        },
        true,
      );
    }
  });
}

export async function readButtonClickSpy(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (self as unknown as { __seeBtnClicks?: string[] }).__seeBtnClicks ?? [],
  );
}

// Open a fixture page that contains an `<img>`, resolve its URL, and
// trigger the image-context Capture page flow via
// `SeeWhatISee.startCaptureWithDetailsFromImage(tab, srcUrl)`. Mirror
// of `openDetailsFlow` for the image-right-click path: same download
// spy, same `capturePage` wait, same `seedStorage` hook so
// withSelection-default tests can pre-seed `capturePageDefaults`.
//
// `imageSelector` defaults to `#target` (the id used by
// `red-image.html`); pass a different selector when adding a new
// image fixture page.
export async function openImageDetailsFlow(
  extensionContext: BrowserContext,
  fixtureServer: { baseUrl: string },
  getServiceWorker: () => Promise<Worker>,
  fixturePath = 'red-image.html',
  beforeCapture?: (page: Page) => Promise<void>,
  seedStorage?: Record<string, unknown>,
  imageSelector = '#target',
): Promise<{ openerPage: Page; capturePage: Page; imageUrl: string }> {
  const sw0 = await getServiceWorker();
  await sw0.evaluate(() => chrome.storage.local.clear());
  if (seedStorage) {
    await sw0.evaluate(async (data) => {
      await chrome.storage.local.set(data);
    }, seedStorage);
  }

  const openerPage = await extensionContext.newPage();
  await openerPage.goto(`${fixtureServer.baseUrl}/${fixturePath}`);
  await openerPage.bringToFront();

  // Resolve the image's absolute `src`. The page-side fetch in the
  // SW reads the same string we're about to send, so use the
  // browser's resolved URL (handles relative paths automatically).
  const imageUrl = await openerPage.locator(imageSelector).evaluate(
    (el) => (el as HTMLImageElement).src,
  );

  if (beforeCapture) await beforeCapture(openerPage);

  const capturePagePromise = extensionContext.waitForEvent('page', {
    predicate: (p) => p.url().endsWith('/capture.html'),
    timeout: 5000,
  });

  const sw = await getServiceWorker();
  await sw.evaluate(async (src) => {
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

    const [active] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (!active) throw new Error('no active tab to start image-flow capture');
    await (
      self as unknown as {
        SeeWhatISee: {
          startCaptureWithDetailsFromImage: (
            tab: chrome.tabs.Tab,
            srcUrl: string,
          ) => Promise<void>;
        };
      }
    ).SeeWhatISee.startCaptureWithDetailsFromImage(active, src);
  }, imageUrl);

  const capturePage = await capturePagePromise;
  await capturePage.waitForLoadState('domcontentloaded');
  await capturePage.waitForFunction(() => {
    const img = document.getElementById('preview') as HTMLImageElement | null;
    return !!(img && img.complete && img.naturalWidth > 0 && img.clientWidth > 0);
  });

  return { openerPage, capturePage, imageUrl };
}

// Inject a <span> into the current page body and select its contents
// so the SW's scripting call sees a non-empty `window.getSelection`.
// Shared between the edit-selection tests and the toolbar-dispatch
// tests that care about click-with-a-selection routing.
export async function seedSelection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const span = document.createElement('span');
    span.id = 'sel-seed';
    span.textContent = 'hello selection world';
    document.body.appendChild(span);
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel!.removeAllRanges();
    sel!.addRange(range);
  });
}
