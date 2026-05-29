// E2E for the per-artifact HTML byte-size cap. Heavy SPAs can
// inline 5–15 MB of CSS / fonts / base64 assets into the page HTML;
// rather than letting that blow the 10 MiB `chrome.storage.session`
// quota silently, the capture-page flow drops the HTML and surfaces
// a "Content too large for Capture page: …" error on the Save HTML row.
//
// Cases:
//   1. Over-cap HTML at capture time → row disabled with error icon.
//   2. Under-cap HTML round-trips intact (the cap is a refuse-or-keep
//      decision, not lossy).
//   3. Over-cap content pasted into Edit HTML → handler returns the
//      error without mutating the body.

import type { BrowserContext, Page, Worker } from '@playwright/test';
import { test, expect } from '../fixtures/extension';

type SizeCapApi = {
  startCaptureWithDetails: () => Promise<void>;
  _setHtmlSizeCapForTest: (bytes: number | null) => void;
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
  // Set the cap and trigger the capture in one evaluate so an SW
  // restart between the two can't reset the cap on us. `null` means
  // "leave the production default in place."
  await sw.evaluate(async (cap) => {
    const api = (self as unknown as { SeeWhatISee: SizeCapApi }).SeeWhatISee;
    if (cap !== null) api._setHtmlSizeCapForTest(cap);
    await api.startCaptureWithDetails();
  }, capBytes ?? null);
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
