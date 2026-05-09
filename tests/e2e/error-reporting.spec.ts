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
// We assert by spying on `chrome.tabs.create` rather than listening
// for `chrome.tabs.onCreated`. The extension only has the
// `activeTab` permission (no `tabs` permission), and without `tabs`
// Chrome strips the URL/pendingUrl fields from tabs delivered to
// `onCreated`/`onUpdated` listeners — so a listener that filters on
// `capture.html?error=` would never resolve. Stubbing `tabs.create`
// also avoids spawning real extension tabs across the suite, which
// matches the pattern in `upload-image.spec.ts`.

import { test, expect } from '../fixtures/extension';

interface ErrorApi {
  reportCaptureError: (err: unknown) => Promise<void>;
  runWithErrorReporting: (fn: () => Promise<unknown>) => Promise<void>;
}

// Action descriptor for `runAndCaptureErrorMessage`. `kind` selects
// the SW entry point; `raw` is the message we throw / reject with.
type ErrorAction =
  | { kind: 'report'; raw: string }
  | { kind: 'runReject'; raw: string };

/**
 * Spy on `chrome.tabs.create`, run the requested SW action, and
 * return the `error=` query param from the URL it asked Chrome to
 * open. Spy + action + read all happen inside one `sw.evaluate` so
 * the MV3 service worker can't recycle between the install and the
 * action and lose the spy state.
 *
 * Restores `chrome.tabs.create` before returning so later tests in
 * the same SW (success-path test, file-shared SW) see the original.
 */
async function runAndCaptureErrorMessage(
  sw: import('@playwright/test').Worker,
  action: ErrorAction,
): Promise<string> {
  return await sw.evaluate(async (act: ErrorAction) => {
    interface CreateSpy {
      __seeErrCreate?: chrome.tabs.CreateProperties[];
      __seeErrCreateOrig?: typeof chrome.tabs.create;
    }
    const g = self as unknown as CreateSpy;
    g.__seeErrCreateOrig = chrome.tabs.create.bind(chrome.tabs);
    g.__seeErrCreate = [];
    (chrome.tabs as { create: typeof chrome.tabs.create }).create = (async (
      props: chrome.tabs.CreateProperties,
    ) => {
      g.__seeErrCreate!.push(props);
      // Return a stub Tab — `reportCaptureError` only awaits the
      // call; it doesn't read fields off the result.
      return { id: 999, index: props.index ?? 0 } as chrome.tabs.Tab;
    }) as typeof chrome.tabs.create;

    try {
      const api = (self as unknown as { SeeWhatISee: ErrorApi }).SeeWhatISee;
      if (act.kind === 'report') {
        await api.reportCaptureError(new Error(act.raw));
      } else {
        await api.runWithErrorReporting(() => Promise.reject(new Error(act.raw)));
      }
      const calls = g.__seeErrCreate ?? [];
      if (calls.length !== 1) {
        throw new Error(`expected exactly 1 chrome.tabs.create call, got ${calls.length}`);
      }
      const url = calls[0].url ?? '';
      const params = new URLSearchParams(url.split('?')[1] ?? '');
      return params.get('error') ?? '';
    } finally {
      if (g.__seeErrCreateOrig) {
        (chrome.tabs as { create: typeof chrome.tabs.create }).create = g.__seeErrCreateOrig;
      }
      delete g.__seeErrCreate;
      delete g.__seeErrCreateOrig;
    }
  }, action);
}

test('reportCaptureError opens a Capture-page tab with the friendly message', async ({
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  const message = await runAndCaptureErrorMessage(sw, {
    kind: 'report',
    raw: 'No active tab found to capture',
  });
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
  const message = await runAndCaptureErrorMessage(sw, {
    kind: 'runReject',
    raw: 'simulated failure',
  });
  // No rewrite for unrecognised messages — passes through verbatim.
  expect(message).toBe('simulated failure');
});

test('runWithErrorReporting on success opens no tab', async ({
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  // Spy on `chrome.tabs.create` and assert it wasn't called by the
  // success path. Same stub shape as the failure helper above so the
  // two paths exercise the same surface.
  const createCalls = await sw.evaluate(async () => {
    interface CreateSpy {
      __seeOkCreate?: chrome.tabs.CreateProperties[];
      __seeOkCreateOrig?: typeof chrome.tabs.create;
    }
    const g = self as unknown as CreateSpy;
    g.__seeOkCreateOrig = chrome.tabs.create.bind(chrome.tabs);
    g.__seeOkCreate = [];
    (chrome.tabs as { create: typeof chrome.tabs.create }).create = (async (
      props: chrome.tabs.CreateProperties,
    ) => {
      g.__seeOkCreate!.push(props);
      return { id: 999, index: props.index ?? 0 } as chrome.tabs.Tab;
    }) as typeof chrome.tabs.create;
    try {
      const api = (self as unknown as { SeeWhatISee: ErrorApi }).SeeWhatISee;
      await api.runWithErrorReporting(() => Promise.resolve('ok'));
      return (g.__seeOkCreate ?? []).length;
    } finally {
      if (g.__seeOkCreateOrig) {
        (chrome.tabs as { create: typeof chrome.tabs.create }).create = g.__seeOkCreateOrig;
      }
      delete g.__seeOkCreate;
      delete g.__seeOkCreateOrig;
    }
  });
  expect(createCalls).toBe(0);
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
    const message = await runAndCaptureErrorMessage(sw, { kind: 'report', raw });
    expect(message).toContain(expected);
  }
});
