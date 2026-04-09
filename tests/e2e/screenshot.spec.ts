import { test, expect } from '../fixtures/extension';

test('captures the visible tab via the service worker', async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.goto('https://example.com');
  // Make sure the page is the active tab so captureVisibleTab grabs it.
  await page.bringToFront();

  const result = await serviceWorker.evaluate(async () => {
    // `SeeWhatISee` is attached to `self` in src/background.ts.
    const api = (self as unknown as {
      SeeWhatISee: {
        captureVisible: () => Promise<{ downloadId: number; filename: string }>;
      };
    }).SeeWhatISee;
    return api.captureVisible();
  });

  expect(result.downloadId).toBeGreaterThan(0);
  expect(result.filename).toMatch(/^SeeWhatISee\/screenshot-\d{8}-\d{6}\.png$/);
});
