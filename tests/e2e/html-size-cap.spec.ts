// E2E for the per-artifact HTML size cap. Heavy SPAs can inline
// 5–15 MB of CSS / fonts / base64 assets into the page HTML; rather
// than letting that blow the 10 MiB `chrome.storage.session` quota
// silently, the capture-page flow drops the HTML and surfaces a
// "Content too large for Capture page: …" error on the Save HTML row.
//
// The cap is measured on the *stored* form — HTML is gzipped before
// it goes into session storage — so a compressible page several
// times the nominal limit still rides through. See
// `src/capture/packed-text.ts`.
//
// Cases:
//   1. Over-cap HTML at capture time → row disabled with error icon.
//   2. Under-cap HTML round-trips intact (the cap is a refuse-or-keep
//      decision, not lossy).
//   3. Over-cap content pasted into Edit HTML → handler returns the
//      error without mutating the body.
//   4. A multi-MB compressible page is kept, stored packed, and saves
//      to disk as plain HTML.
//   5. Over-cap *after* compression → the error quotes both figures.
//   6. Over the raw cap → refused before compression is even tried.
//   7. Edit-save of a large body packs it too (the second call site).
//   8. A corrupt packed body degrades to the Save-HTML error row
//      rather than blanking the capture.

import fs from 'node:fs';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { test, expect } from '../fixtures/extension';

type SizeCapApi = {
  startCaptureWithDetails: () => Promise<void>;
  _setHtmlSizeCapForTest: (bytes: number | null) => void;
  _setHtmlRawCapForTest: (bytes: number | null) => void;
};

// Inject random text into the opener page so the scraped HTML
// exceeds the (lowered, for tests) cap. Returns the resulting
// `document.documentElement.outerHTML` length so the test can size
// its assertions.
async function bloatOpenerHtml(page: Page, payloadBytes: number): Promise<number> {
  return await page.evaluate((n) => {
    const buf = new Uint8Array(n);
    const CHUNK = 65_536;
    for (let off = 0; off < buf.length; off += CHUNK) {
      crypto.getRandomValues(buf.subarray(off, Math.min(off + CHUNK, buf.length)));
    }
    let s = '';
    for (let i = 0; i < buf.length; i++) {
      s += String.fromCharCode(33 + (buf[i] % 94));
    }
    const div = document.createElement('div');
    div.textContent = s;
    document.body.appendChild(div);
    return document.documentElement.outerHTML.length;
  }, payloadBytes);
}

/**
 * Inject highly repetitive text into the opener page — the shape
 * real page markup has, and what gzip eats for breakfast. Uses
 * `textContent` rather than `innerHTML` so a multi-MB payload costs
 * one text node instead of tens of thousands of elements; the
 * serialized entities are just as compressible. Returns the
 * resulting `outerHTML` length.
 */
async function bloatOpenerHtmlCompressible(
  page: Page,
  approxBytes: number,
): Promise<number> {
  return await page.evaluate((n) => {
    const chunk =
      '<div class="row item"><span class="label">Name</span>'
      + '<span class="value">Value</span></div>\n';
    const div = document.createElement('div');
    div.textContent = chunk.repeat(Math.ceil(n / chunk.length));
    document.body.appendChild(div);
    return document.documentElement.outerHTML.length;
  }, approxBytes);
}

/** The `capture.html` body as it actually sits in session storage
 *  for the given Capture-page tab — packed or plain. */
async function storedHtmlForTab(sw: Worker, tabId: number): Promise<unknown> {
  return await sw.evaluate(async (id) => {
    const key = `captureDetails_${id}`;
    const got = await chrome.storage.session.get(key);
    return (got[key] as { capture?: { html?: unknown } } | undefined)?.capture?.html;
  }, tabId);
}

async function openCapturePageForTest(
  extensionContext: BrowserContext,
  fixtureServer: { baseUrl: string },
  sw: Worker,
  fixturePath: string,
  beforeCapture?: (page: Page) => Promise<void>,
  capBytes?: number,
  rawCapBytes?: number,
): Promise<{ openerPage: Page; capturePage: Page }> {
  const openerPage = await extensionContext.newPage();
  await openerPage.goto(`${fixtureServer.baseUrl}/${fixturePath}`);
  await openerPage.bringToFront();
  if (beforeCapture) await beforeCapture(openerPage);

  const capturePagePromise = extensionContext.waitForEvent('page', {
    predicate: (p) => p.url().endsWith('/capture.html'),
    timeout: 5000,
  });
  // Set the caps and trigger the capture in one evaluate so an SW
  // restart between them can't reset a cap on us. `null` means
  // "leave the production default in place."
  await sw.evaluate(async ([cap, rawCap]) => {
    const api = (self as unknown as { SeeWhatISee: SizeCapApi }).SeeWhatISee;
    if (cap !== null) api._setHtmlSizeCapForTest(cap);
    if (rawCap !== null) api._setHtmlRawCapForTest(rawCap);
    await api.startCaptureWithDetails();
  }, [capBytes ?? null, rawCapBytes ?? null]);
  const capturePage = await capturePagePromise;
  await capturePage.waitForLoadState('domcontentloaded');
  return { openerPage, capturePage };
}

test.describe('html-size-cap', () => {
  test.afterEach(async ({ getServiceWorker }) => {
    // Restore the production default — a leaked low cap would
    // affect subsequent tests in the same Playwright worker.
    const sw = await getServiceWorker();
    await sw.evaluate(() => {
      const api = (self as unknown as { SeeWhatISee: SizeCapApi }).SeeWhatISee;
      api._setHtmlSizeCapForTest(null);
      api._setHtmlRawCapForTest(null);
    });
  });

  test('over-cap HTML at capture: Save HTML disabled with the Content-too-large icon', async ({
    extensionContext,
    fixtureServer,
    getServiceWorker,
  }) => {
    const sw0 = await getServiceWorker();
    await sw0.evaluate(() => chrome.storage.local.clear());

    const sw = await getServiceWorker();
    const { openerPage, capturePage } = await openCapturePageForTest(
      extensionContext,
      fixtureServer,
      sw,
      'purple.html',
      // Inject 100 KiB of random text — easily over the 1 KiB cap
      // we install via `capBytes` below, after the page chrome
      // tags around it.
      (page) => bloatOpenerHtml(page, 100_000).then(() => undefined),
      1024,
    );

    // Save HTML row disabled, has-error class, tooltip matches the
    // "Content too large for Capture page: X KB (limit 1 KB)." message
    // verbatim, followed by the capture-directly hint on a second line.
    // Regression catch — without the cap the body would land in
    // storage and the row would render as a normal "HTML · N KB"
    // entry, masking the quota failure that would follow.
    const htmlBox = capturePage.locator('#cap-html');
    await expect(htmlBox).toBeDisabled();
    await expect(htmlBox).not.toBeChecked();
    await expect(capturePage.locator('#row-html')).toHaveClass(/has-error/);
    await expect(capturePage.locator('#error-html')).toHaveAttribute(
      'title',
      /Content too large for Capture page: \d+(?:\.\d+)? (?:KB|MB) \(limit 1 KB\)\./,
    );
    await expect(capturePage.locator('#error-html')).toHaveAttribute(
      'title',
      /Content can still be captured directly using 'Save' actions/,
    );
    await expect(capturePage.locator('#copy-html-name')).toBeDisabled();
    await expect(capturePage.locator('#edit-html')).toBeDisabled();
    await expect(capturePage.locator('#html-size-badge')).toBeHidden();

    await capturePage.close();
    await openerPage.close();
  });

  test('under-cap HTML rides through unchanged: size badge reports the actual byte count', async ({
    extensionContext,
    fixtureServer,
    getServiceWorker,
  }) => {
    const sw0 = await getServiceWorker();
    await sw0.evaluate(() => chrome.storage.local.clear());

    const sw = await getServiceWorker();
    // Cap left at production default — `purple.html` (small solid
    // page) is well under, so the row should render normally.
    const { openerPage, capturePage } = await openCapturePageForTest(
      extensionContext,
      fixtureServer,
      sw,
      'purple.html',
    );

    await expect(capturePage.locator('#cap-html')).toBeEnabled();
    await expect(capturePage.locator('#row-html')).not.toHaveClass(/has-error/);
    await expect(capturePage.locator('#html-size-badge')).toBeVisible();
    await expect(capturePage.locator('#html-size-badge')).toContainText(/HTML · /);

    await capturePage.close();
    await openerPage.close();
  });

  test('edit-save: pasting over-cap content into Edit HTML returns an error and leaves the body intact', async ({
    extensionContext,
    fixtureServer,
    getServiceWorker,
  }) => {
    const sw0 = await getServiceWorker();
    await sw0.evaluate(() => chrome.storage.local.clear());

    const sw = await getServiceWorker();
    const { openerPage, capturePage } = await openCapturePageForTest(
      extensionContext,
      fixtureServer,
      sw,
      'purple.html',
    );

    // Lower the cap AFTER the initial capture lands so the
    // first round wasn't itself rejected. The next
    // `updateArtifact` for kind `html` runs against the lowered
    // cap and must return the user-facing error message.
    await sw.evaluate(() => {
      const api = (self as unknown as { SeeWhatISee: SizeCapApi }).SeeWhatISee;
      api._setHtmlSizeCapForTest(1024);
    });

    const result = (await capturePage.evaluate(async () => {
      // 100 KiB of random ASCII → safely over the 1 KiB cap.
      const buf = new Uint8Array(100_000);
      const CHUNK = 65_536;
      for (let off = 0; off < buf.length; off += CHUNK) {
        crypto.getRandomValues(buf.subarray(off, Math.min(off + CHUNK, buf.length)));
      }
      let s = '';
      for (let i = 0; i < buf.length; i++) {
        s += String.fromCharCode(33 + (buf[i] % 94));
      }
      return await chrome.runtime.sendMessage({
        action: 'updateArtifact',
        kind: 'html',
        value: s,
      });
    })) as { ok?: true; error?: string };
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/^Content too large for Capture page: /);
    expect(result.error).toMatch(/\(limit 1 KB\)/);

    await capturePage.close();
    await openerPage.close();
  });

  test('multi-MB compressible HTML is kept, stored packed, and saved as plain HTML', async ({
    extensionContext,
    fixtureServer,
    getServiceWorker,
  }) => {
    const sw0 = await getServiceWorker();
    await sw0.evaluate(() => chrome.storage.local.clear());

    const sw = await getServiceWorker();
    let rawLength = 0;
    // 6 MB of repetitive markup — comfortably past the 4 MiB stored
    // cap in raw terms, but a fraction of it once gzipped. The size
    // has to clear the cap for this test to mean anything: under it,
    // the capture would pass with compression disabled entirely.
    //
    // Deliberately not shrunk with a lowered cap, even though this is
    // the slowest case in the file. Running against the *production*
    // cap is the claim under test — "a real 6 MB page now captures" —
    // and a lowered-cap version would stop proving it.
    const { openerPage, capturePage } = await openCapturePageForTest(
      extensionContext,
      fixtureServer,
      sw,
      'purple.html',
      async (page) => { rawLength = await bloatOpenerHtmlCompressible(page, 6_000_000); },
    );
    expect(rawLength).toBeGreaterThan(4 * 1024 * 1024);

    // The row is live and the pill reports the *original* size — the
    // user is told what they captured, not what we managed to squeeze
    // it into.
    await expect(capturePage.locator('#cap-html')).toBeEnabled();
    await expect(capturePage.locator('#row-html')).not.toHaveClass(/has-error/);
    await expect(capturePage.locator('#html-size-badge')).toContainText(/HTML · \d(?:\.\d)? MB/);

    // Storage holds the packed form, and holds it for a fraction of
    // the raw cost. Without this assertion the test would also pass
    // on a naively-raised cap, which is the outcome we're avoiding.
    const tabId = await capturePage.evaluate(
      async () => (await chrome.tabs.getCurrent())!.id!,
    );
    const stored = (await storedHtmlForTab(sw, tabId)) as { z?: string; n?: number };
    expect(stored?.z).toBe('gzip');
    expect(stored?.n).toBeGreaterThan(4 * 1024 * 1024);
    expect(JSON.stringify(stored).length).toBeLessThan(rawLength / 4);

    // The file on disk is plain HTML — compression stops at the
    // storage boundary, so an agent reading the snapshot never has
    // to know about it.
    const result = (await capturePage.evaluate(async () =>
      await chrome.runtime.sendMessage({ action: 'ensureDownloaded', kind: 'html' }),
    )) as { path?: string; error?: string };
    expect(result.error).toBeUndefined();
    const onDisk = fs.readFileSync(result.path!, 'utf8');
    expect(onDisk.startsWith('<html')).toBe(true);
    // The filler went in as `textContent`, so it comes back out
    // entity-escaped — which is exactly what the browser serialized
    // and therefore what the file should hold.
    expect(onDisk).toContain('&lt;span class="label"&gt;Name&lt;/span&gt;');
    // Byte-for-byte with what the page mirrored, so a lossy or
    // truncated round-trip can't slip through.
    const inPage = await capturePage.evaluate(
      async () =>
        ((await chrome.runtime.sendMessage({ action: 'getDetailsData' })) as { html: string })
          .html,
    );
    expect(onDisk).toBe(inPage);

    await capturePage.close();
    await openerPage.close();
  });

  test('over-cap even after compression: the error quotes the raw and compressed sizes', async ({
    extensionContext,
    fixtureServer,
    getServiceWorker,
  }) => {
    const sw0 = await getServiceWorker();
    await sw0.evaluate(() => chrome.storage.local.clear());

    const sw = await getServiceWorker();
    // Compressible, so packing wins and the packed form is what gets
    // measured — but 400 KB still packs to more than the 1 KB cap.
    const { openerPage, capturePage } = await openCapturePageForTest(
      extensionContext,
      fixtureServer,
      sw,
      'purple.html',
      (page) => bloatOpenerHtmlCompressible(page, 400_000).then(() => undefined),
      1024,
    );

    await expect(capturePage.locator('#cap-html')).toBeDisabled();
    await expect(capturePage.locator('#row-html')).toHaveClass(/has-error/);
    // Both figures, so "400 KB rejected against a 1 KB limit" reads
    // as arithmetic the user can follow rather than as a wild margin.
    await expect(capturePage.locator('#error-html')).toHaveAttribute(
      'title',
      /Content too large for Capture page: \d+(?:\.\d+)? KB \(\d+(?:\.\d+)? KB compressed; limit 1 KB\)\./,
    );

    await capturePage.close();
    await openerPage.close();
  });

  test('over the raw cap: refused before compression is tried, so no compressed figure', async ({
    extensionContext,
    fixtureServer,
    getServiceWorker,
  }) => {
    const sw0 = await getServiceWorker();
    await sw0.evaluate(() => chrome.storage.local.clear());

    const sw = await getServiceWorker();
    // Raw cap at 50 KB, stored cap left at the production 4 MiB. The
    // 400 KB body would sail past the stored cap once gzipped, so
    // only the raw gate can be what rejects it.
    const { openerPage, capturePage } = await openCapturePageForTest(
      extensionContext,
      fixtureServer,
      sw,
      'purple.html',
      (page) => bloatOpenerHtmlCompressible(page, 400_000).then(() => undefined),
      undefined,
      50_000,
    );

    await expect(capturePage.locator('#cap-html')).toBeDisabled();
    await expect(capturePage.locator('#row-html')).toHaveClass(/has-error/);
    // Single-figure wording, quoting the raw limit. The absence of a
    // "compressed" clause is the assertion that matters: it's what
    // proves the raw gate ran *before* `packText`, not after.
    await expect(capturePage.locator('#error-html')).toHaveAttribute(
      'title',
      /Content too large for Capture page: \d+(?:\.\d+)? KB \(limit 49 KB\)\./,
    );

    await capturePage.close();
    await openerPage.close();
  });

  test('edit-save packs too: a large pasted body lands compressed and reads back verbatim', async ({
    extensionContext,
    fixtureServer,
    getServiceWorker,
  }) => {
    const sw0 = await getServiceWorker();
    await sw0.evaluate(() => chrome.storage.local.clear());

    const sw = await getServiceWorker();
    const { openerPage, capturePage } = await openCapturePageForTest(
      extensionContext,
      fixtureServer,
      sw,
      'purple.html',
    );
    const tabId = await capturePage.evaluate(
      async () => (await chrome.tabs.getCurrent())!.id!,
    );

    // `updateArtifact` is the second `packHtmlForStorage` call site
    // and the only one that writes through `applyArtifactEdit`;
    // without this the edit path's packing is untested.
    const body = await capturePage.evaluate(async () => {
      const chunk = '<p class="para">Lorem ipsum dolor sit amet.</p>\n';
      const text = chunk.repeat(6000);
      const res = await chrome.runtime.sendMessage({
        action: 'updateArtifact',
        kind: 'html',
        value: text,
      });
      return { text, res: res as { ok?: true; error?: string } };
    });
    expect(body.res.error).toBeUndefined();
    expect(body.text.length).toBeGreaterThan(64 * 1024);

    const stored = (await storedHtmlForTab(sw, tabId)) as { z?: string };
    expect(stored?.z).toBe('gzip');
    // Round-trips byte-for-byte back out through `getDetailsData`.
    const readBack = await capturePage.evaluate(
      async () =>
        ((await chrome.runtime.sendMessage({ action: 'getDetailsData' })) as { html: string })
          .html,
    );
    expect(readBack).toBe(body.text);

    await capturePage.close();
    await openerPage.close();
  });

  test('corrupt packed body: degrades to the Save HTML error row, not a blank capture', async ({
    extensionContext,
    fixtureServer,
    getServiceWorker,
  }) => {
    const sw0 = await getServiceWorker();
    await sw0.evaluate(() => chrome.storage.local.clear());

    const sw = await getServiceWorker();
    const { openerPage, capturePage } = await openCapturePageForTest(
      extensionContext,
      fixtureServer,
      sw,
      'purple.html',
      (page) => bloatOpenerHtmlCompressible(page, 400_000).then(() => undefined),
    );
    const tabId = await capturePage.evaluate(
      async () => (await chrome.tabs.getCurrent())!.id!,
    );
    expect(((await storedHtmlForTab(sw, tabId)) as { z?: string })?.z).toBe('gzip');

    // Corrupt the base64 in place, then reload so the page re-runs
    // `getDetailsData` against it.
    await sw.evaluate(async (id) => {
      const key = `captureDetails_${id}`;
      const got = await chrome.storage.session.get(key);
      const rec = got[key] as { capture: { html: { d: string } } };
      rec.capture.html.d = '!!!not-base64!!!';
      await chrome.storage.session.set({ [key]: rec });
    }, tabId);
    await capturePage.reload();
    await capturePage.waitForLoadState('domcontentloaded');

    // The capture survives — only the HTML row is lost.
    await expect(capturePage.locator('#cap-html')).toBeDisabled();
    await expect(capturePage.locator('#row-html')).toHaveClass(/has-error/);
    await expect(capturePage.locator('#error-html')).toHaveAttribute(
      'title',
      /Unable to capture HTML contents: the stored copy could not be decompressed\./,
    );
    // Reads as one sentence after the page's prefix, and still points
    // at the context-menu escape hatch.
    await expect(capturePage.locator('#error-html')).toHaveAttribute(
      'title',
      /Content can still be captured directly using 'Save' actions/,
    );
    await expect(capturePage.locator('#capture-failed-error')).toBeHidden();
    await expect(capturePage.locator('#cap-screenshot')).toBeEnabled();

    // The failure was persisted, so a stale Save/Copy hits the
    // friendly precondition rather than a raw decode error.
    const dl = (await capturePage.evaluate(async () =>
      await chrome.runtime.sendMessage({ action: 'ensureDownloaded', kind: 'html' }),
    )) as { path?: string; error?: string };
    expect(dl.error).toMatch(/HTML not captured: the stored copy could not be decompressed/);

    await capturePage.close();
    await openerPage.close();
  });

  test('error page: the capture-directly hint renders "Save" as italics with the quotes dropped', async ({
    extensionContext,
    extensionId,
  }) => {
    // Drive the `?error=` pane directly (the SW builds this URL for
    // the quota-refusal paths). The message mirrors production: a
    // quota line + the `CAPTURE_DIRECTLY_HINT` second line, whose
    // quoted `'Save'` the page should upgrade to an <em>.
    const message =
      "Capture is too large (8 MB image; only 1 MB of 10 MB extension storage free).\n" +
      "Content can still be captured directly using 'Save' actions (on the extension's context menu).";
    const page = await extensionContext.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/capture.html?error=${encodeURIComponent(message)}`,
    );

    await expect(page.locator('#capture-failed-error')).toBeVisible();
    const em = page.locator('#capture-failed-message em');
    await expect(em).toHaveText('Save');
    // The literal quotes are consumed by the render — only the <em>
    // carries the emphasis now.
    await expect(page.locator('#capture-failed-message')).not.toContainText(
      "'Save'",
    );
    await page.close();
  });
});
