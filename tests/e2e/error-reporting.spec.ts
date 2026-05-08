// Tests for the error-reporting surface in
// `src/background/error-reporting.ts`: `reportCaptureError`,
// `runWithErrorReporting`, and `friendlyErrorMessage`.
//
// The production click handlers wrap captureVisible / savePageContents
// / etc. in `runWithErrorReporting`, so failures surface as a fresh
// Capture-page tab on `?error=<friendly message>` — the page renders
// its `#capture-failed-error` pane with the message. We exercise the
// helpers directly from the SW rather than trying to get a real
// captureVisible to fail on demand: the helpers are where the logic
// lives and the click-handler wiring is a one-line pass-through.
//
// We assert by listening for the new tab via `chrome.tabs.onCreated`
// (installed in the SW from the test side), reading its URL, and
// pulling the `error` query parameter back out.

import { test, expect } from '../fixtures/extension';

interface ErrorApi {
  reportCaptureError: (err: unknown) => Promise<void>;
  runWithErrorReporting: (fn: () => Promise<unknown>) => Promise<void>;
}

interface CapturedTab {
  id?: number;
  url: string;
}

/**
 * Listen for the *next* `tabs.onCreated` whose URL is the extension's
 * `capture.html?error=...`, return the captured `error` param, and
 * close the tab so it doesn't leak between tests. Installed before
 * the SW action runs so we don't miss the create event.
 */
async function captureNextErrorTab(
  sw: import('@playwright/test').Worker,
): Promise<{ install: () => Promise<void>; read: () => Promise<string> }> {
  const install = async (): Promise<void> => {
    await sw.evaluate(() => {
      interface Spied {
        __errTabPromise?: Promise<CapturedTab>;
      }
      const g = self as unknown as Spied;
      g.__errTabPromise = new Promise<CapturedTab>((resolve) => {
        const onCreated = (tab: chrome.tabs.Tab): void => {
          const url = tab.url ?? tab.pendingUrl ?? '';
          if (!url.includes('capture.html?error=')) return;
          chrome.tabs.onCreated.removeListener(onCreated);
          resolve({ id: tab.id, url });
        };
        chrome.tabs.onCreated.addListener(onCreated);
      });
    });
  };
  const read = async (): Promise<string> => {
    const errorParam = await sw.evaluate(async () => {
      const g = self as unknown as { __errTabPromise?: Promise<CapturedTab> };
      const captured = await g.__errTabPromise!;
      // Best-effort cleanup so the test's tab strip stays small.
      if (captured.id !== undefined) {
        try {
          await chrome.tabs.remove(captured.id);
        } catch {
          // Ignored — tab may already be gone.
        }
      }
      const params = new URLSearchParams(captured.url.split('?')[1] ?? '');
      return params.get('error') ?? '';
    });
    return errorParam;
  };
  return { install, read };
}

test('reportCaptureError opens a Capture-page tab with the friendly message', async ({
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  const { install, read } = await captureNextErrorTab(sw);
  await install();
  await sw.evaluate(async () => {
    const api = (self as unknown as { SeeWhatISee: ErrorApi }).SeeWhatISee;
    await api.reportCaptureError(new Error('No active tab found to capture'));
  });
  const message = await read();
  // Friendly rewrite — the raw "No active tab found to capture"
  // becomes a sentence that explains why and names the common case
  // (browser-internal / chrome:// pages).
  expect(message).toContain("Couldn't find a tab to capture");
  expect(message).toContain('Browser-internal and chrome:// pages cannot be captured');
});

test('runWithErrorReporting opens an error tab on rejection', async ({
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  const { install, read } = await captureNextErrorTab(sw);
  await install();
  await sw.evaluate(async () => {
    const api = (self as unknown as { SeeWhatISee: ErrorApi }).SeeWhatISee;
    await api.runWithErrorReporting(() =>
      Promise.reject(new Error('simulated failure')),
    );
  });
  const message = await read();
  // No rewrite for unrecognised messages — passes through verbatim.
  expect(message).toBe('simulated failure');
});

test('runWithErrorReporting on success opens no tab', async ({
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  // Watch for *any* new tab in the next 500ms after the success
  // call. We don't expect one — if we see one, the "no error"
  // branch incorrectly opened something.
  const tabsCreated = await sw.evaluate(async () => {
    let count = 0;
    const onCreated = (): void => {
      count += 1;
    };
    chrome.tabs.onCreated.addListener(onCreated);
    const api = (self as unknown as { SeeWhatISee: ErrorApi }).SeeWhatISee;
    await api.runWithErrorReporting(() => Promise.resolve('ok'));
    // Small drain in case the listener fires async.
    await new Promise((r) => setTimeout(r, 100));
    chrome.tabs.onCreated.removeListener(onCreated);
    return count;
  });
  expect(tabsCreated).toBe(0);
});

test('friendly rewrites cover the common throw-site strings', async ({
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  // Drive each rewrite through `reportCaptureError` and read the
  // `error=` param back out — the same path the production code
  // exercises.
  const cases: Array<[string, string]> = [
    ['Failed to retrieve page contents', "Couldn't read this page's contents"],
    ['No text selected', 'No text is selected'],
    ['No selection markdown content', "didn't include anything in this format"],
    ['No captures in the log to copy from', 'No captures yet'],
  ];
  for (const [raw, expected] of cases) {
    const { install, read } = await captureNextErrorTab(sw);
    await install();
    await sw.evaluate(async (m: string) => {
      const api = (self as unknown as { SeeWhatISee: ErrorApi }).SeeWhatISee;
      await api.reportCaptureError(new Error(m));
    }, raw);
    const message = await read();
    expect(message).toContain(expected);
  }
});
