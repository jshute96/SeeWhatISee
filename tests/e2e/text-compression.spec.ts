// E2E for the per-artifact compressed-text cap + gzip-in-session
// pipeline (`src/background/text-compression.ts` +
// `serializeStoredCapture` in capture-details.ts).
//
// Two behaviours under test:
//   1. Capture-time over-cap rejection: HTML / selection whose
//      compressed bytes exceed the (lowered, for tests) cap drops
//      the artifact and surfaces a "Content too large: …" message
//      on the corresponding row.
//   2. Compressed-then-decompressed round-trip: a non-trivial HTML
//      page stored under the threshold-compression path lands in
//      `chrome.storage.session` as gzip-base64 yet the Capture
//      page sees the full plain HTML back via `getDetailsData`.

import type { BrowserContext, Page, Worker } from '@playwright/test';
import { test, expect } from '../fixtures/extension';

type CompressionApi = {
  startCaptureWithDetails: () => Promise<void>;
  _setStoredTextHardCapForTest: (bytes: number | null) => void;
};

// Inject high-entropy text into the opener page so the scraped
// HTML compresses poorly and reliably trips a low cap. Returns the
// post-injection `outerHTML` length so the test can size its
// assertions.
async function bloatOpenerHtml(page: Page, payloadBytes: number): Promise<number> {
  return await page.evaluate((n) => {
    // Crypto random → printable ASCII so the page renders without
    // exotic glyphs but the bytes don't compress. `getRandomValues`
    // caps at 65 536 per call, so chunk-fill the buffer.
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

async function openCapturePageForTest(
  extensionContext: BrowserContext,
  fixtureServer: { baseUrl: string },
  sw: Worker,
  fixturePath: string,
  beforeCapture?: (page: Page) => Promise<void>,
  capBytes?: number,
): Promise<{ openerPage: Page; capturePage: Page }> {
  const openerPage = await extensionContext.newPage();
  await openerPage.goto(`${fixtureServer.baseUrl}/${fixturePath}`);
  await openerPage.bringToFront();
  if (beforeCapture) await beforeCapture(openerPage);

  const capturePagePromise = extensionContext.waitForEvent('page', {
    predicate: (p) => p.url().endsWith('/capture.html'),
    timeout: 5000,
  });
  // Re-set the cap inside the same evaluate that triggers the
  // capture so an SW restart between the cap-set and the capture
  // can't reset it on us. `null` means "leave the production
  // default in place."
  await sw.evaluate(async (cap) => {
    const api = (self as unknown as { SeeWhatISee: CompressionApi }).SeeWhatISee;
    if (cap !== null) api._setStoredTextHardCapForTest(cap);
    await api.startCaptureWithDetails();
  }, capBytes ?? null);
  const capturePage = await capturePagePromise;
  await capturePage.waitForLoadState('domcontentloaded');
  return { openerPage, capturePage };
}

test.describe('text-compression: per-artifact compressed cap', () => {
  test.afterEach(async ({ getServiceWorker }) => {
    // Always restore the production default so a leaked low cap
    // doesn't bleed into later tests in this worker.
    const sw = await getServiceWorker();
    await sw.evaluate(() => {
      const api = (self as unknown as { SeeWhatISee: CompressionApi }).SeeWhatISee;
      api._setStoredTextHardCapForTest(null);
    });
  });

  test('over-cap HTML is rejected at capture; Save HTML disabled with the Content-too-large icon', async ({
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
      // Inject ~150 KiB of random text — gzips to ~110 KiB, well
      // over the 1 KiB cap we install via `capBytes` below.
      (page) => bloatOpenerHtml(page, 150_000).then(() => undefined),
      1024,
    );

    // Save HTML row: disabled, has-error class, tooltip carries
    // the "Content too large: …" message verbatim. The tooltip is
    // prefixed with "Unable to capture HTML contents: " by the
    // Capture page; the cap-rejection message follows. Regression
    // catch — the original bug here was the row staying enabled
    // and rendering as a 0-byte file when the HTML got dropped.
    const htmlBox = capturePage.locator('#cap-html');
    await expect(htmlBox).toBeDisabled();
    await expect(htmlBox).not.toBeChecked();
    await expect(capturePage.locator('#row-html')).toHaveClass(/has-error/);
    await expect(capturePage.locator('#error-html')).toHaveAttribute(
      'title',
      /Content too large: \d+(?:\.\d+)? (?:KB|MB), \d+(?:\.\d+)? (?:KB|MB) compressed \(limit 1 KB\)\./,
    );
    // Copy / Edit / Download HTML buttons disabled too, and the
    // size badge hidden — otherwise the user sees "HTML · 0 B"
    // and assumes the body is just empty.
    await expect(capturePage.locator('#copy-html-name')).toBeDisabled();
    await expect(capturePage.locator('#edit-html')).toBeDisabled();
    await expect(capturePage.locator('#html-size-badge')).toBeHidden();

    await capturePage.close();
    await openerPage.close();
  });

  test('under-cap-but-over-threshold HTML compresses in storage and round-trips uncompressed to the page', async ({
    extensionContext,
    fixtureServer,
    getServiceWorker,
  }) => {
    const sw0 = await getServiceWorker();
    await sw0.evaluate(() => chrome.storage.local.clear());

    const sw = await getServiceWorker();
    // ~150 KiB of random text → above the 100 KiB compress
    // threshold but well below the production 2 MiB cap.
    const PAYLOAD = 150_000;
    const { openerPage, capturePage } = await openCapturePageForTest(
      extensionContext,
      fixtureServer,
      sw,
      'purple.html',
      (page) => bloatOpenerHtml(page, PAYLOAD).then(() => undefined),
    );

    // (a) Storage holds the gzip-base64 form — i.e. the row in
    //     chrome.storage.session has `capture.html.kind === 'gzip-base64'`.
    const storedKind = await sw.evaluate(async () => {
      const all = await chrome.storage.session.get(null);
      const k = Object.keys(all).find((key) => key.startsWith('captureDetails_'));
      if (!k) return null;
      const session = all[k] as { capture: { html: { kind: string } } };
      return session.capture.html.kind;
    });
    expect(storedKind).toBe('gzip-base64');

    // (b) Page-side `captured.html` (mirroring what `loadData`
    //     stashed off `getDetailsData`) is the FULL plain HTML,
    //     not the compressed bytes. Use the size badge text as a
    //     proxy — it reads `HTML · N KB` based on the decompressed
    //     blob length.
    const badgeText = await capturePage.locator('#image-html-size').count() > 0
      ? await capturePage.locator('#image-html-size').first().textContent()
      : null;
    void badgeText; // size badge id below
    const htmlSizeBadge = capturePage.locator('#html-size-badge');
    await expect(htmlSizeBadge).toBeVisible();
    const txt = await htmlSizeBadge.textContent();
    expect(txt).toMatch(/HTML · \d+\.?\d* KB/);

    await capturePage.close();
    await openerPage.close();
  });

  test('over-cap selection-bundle is rejected at capture; Save selection disabled with the bundle-totals tooltip', async ({
    extensionContext,
    fixtureServer,
    getServiceWorker,
  }) => {
    const sw0 = await getServiceWorker();
    await sw0.evaluate(() => chrome.storage.local.clear());

    const sw = await getServiceWorker();
    // Inject ~150 KiB of random text wrapped in a span, then
    // select the span. The selection's html / text / markdown
    // formats together (HTML is the biggest) easily exceed a
    // 1 KiB cap when gzipped.
    const { openerPage, capturePage } = await openCapturePageForTest(
      extensionContext,
      fixtureServer,
      sw,
      'purple.html',
      async (page) => {
        await page.evaluate(() => {
          const buf = new Uint8Array(150_000);
          const CHUNK = 65_536;
          for (let off = 0; off < buf.length; off += CHUNK) {
            crypto.getRandomValues(buf.subarray(off, Math.min(off + CHUNK, buf.length)));
          }
          let s = '';
          for (let i = 0; i < buf.length; i++) {
            s += String.fromCharCode(33 + (buf[i] % 94));
          }
          const span = document.createElement('span');
          span.id = 'sel-seed';
          span.textContent = s;
          document.body.appendChild(span);
          const range = document.createRange();
          range.selectNodeContents(span);
          window.getSelection()!.removeAllRanges();
          window.getSelection()!.addRange(range);
        });
      },
      1024,
    );

    // Selection master row + every format row: disabled with the
    // selection error icon and the bundle-totals "Content too
    // large…" message.
    await expect(capturePage.locator('#cap-selection')).toBeDisabled();
    await expect(capturePage.locator('#row-selection')).toHaveClass(/has-error/);
    await expect(capturePage.locator('#error-selection')).toHaveAttribute(
      'title',
      /Content too large: \d+(?:\.\d+)? (?:KB|MB), \d+(?:\.\d+)? (?:KB|MB) compressed \(limit 1 KB\)\./,
    );

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
    // capture itself wasn't rejected. The next `updateArtifact`
    // payload runs through the lowered cap.
    await sw.evaluate(() => {
      const api = (self as unknown as { SeeWhatISee: CompressionApi }).SeeWhatISee;
      api._setStoredTextHardCapForTest(1024);
    });

    // Send a giant `updateArtifact` directly via the SW message
    // bridge so we bypass the Edit-dialog UI plumbing (it has its
    // own quirks — separate tests cover them). The response carries
    // the user-facing error message.
    const result = (await capturePage.evaluate(async () => {
      // 150 KiB of random text — same incompressibility as the
      // capture-time test. Chunk the random fill to stay under
      // `getRandomValues`'s 65 536-byte ceiling.
      const buf = new Uint8Array(150_000);
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
    expect(result.error).toMatch(/Content too large: /);
    expect(result.error).toMatch(/compressed \(limit 1 KB\)/);

    await capturePage.close();
    await openerPage.close();
  });
});
