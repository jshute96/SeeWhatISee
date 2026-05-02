// Tests for the error-reporting surface in src/background.ts:
// reportCaptureError, clearCaptureError, and runWithErrorReporting.
//
// The production click handlers wrap captureVisible/savePageContents
// in runWithErrorReporting so failures surface as:
//   - a swapped toolbar icon (small red `!` painted on the base
//     camera, via chrome.action.setIcon)
//   - an "ERROR: ..." line slotted under the app title, with a blank
//     line separating it from the per-action lines that follow
//
// and successes restore the base icon + default tooltip. We exercise
// the helpers directly from the service worker rather than trying to
// get a real captureVisible to fail on demand — the helpers are where
// the logic lives, and the click-handler wiring is a one-line
// pass-through on top.
//
// Note: chrome.action has no `getIcon` API, so we cannot directly
// assert which icon is currently displayed. Instead we verify that
// (a) the helpers don't throw, (b) the tooltip updates match the
// expected state transitions, and (c) a sentinel script-side
// observation (tracking setIcon calls via a monkey-patch in the SW)
// confirms the intended icon swap happened. The monkey-patch is
// scoped to a single test run and is torn down in beforeEach.

import { test, expect } from '../fixtures/extension';

// Default tooltip on the `save-screenshot` click action. The background
// script derives the toolbar title from the four stored defaults;
// the tests here pin them in beforeEach so the expected baseline is
// stable. Layout (per the algorithm in src/background/tooltip.ts):
//
//   SeeWhatISee
//   <blank>
//   Click:                                                (Case 2 row, header)
//     Save screenshot                                     (Case 2 row, primary)
//     (or selection HTML)                                 (Case 2 row, addendum)
//   Double-click: Capture...                              (Case 1, single line)
//   <blank trailing line>
//
// The Click row's with-sel slot is `save-selection-html` (set in
// beforeEach), so the algorithm renders a 3-line block. Both
// Double-click slots are `capture`, so that row collapses to a
// single line.
const ACTION_LINES = [
  'Click:',
  '  Save screenshot',
  '  (or selection HTML)',
  'Double-click: Capture...',
];
const DEFAULT_TITLE = ['SeeWhatISee', '', ...ACTION_LINES, ''].join('\n');

// Tooltip shown while an error is pending: the `ERROR: <msg>` line
// is bracketed by blanks of its own, between the app title and the
// action block.
function titleWithError(message: string): string {
  return ['SeeWhatISee', '', `ERROR: ${message}`, '', ...ACTION_LINES, ''].join('\n');
}

interface ErrorApi {
  reportCaptureError: (err: unknown) => Promise<void>;
  clearCaptureError: () => Promise<void>;
  runWithErrorReporting: (fn: () => Promise<unknown>) => Promise<void>;
  setDefaultWithSelectionId: (id: string) => Promise<void>;
  setDefaultWithoutSelectionId: (id: string) => Promise<void>;
  setDefaultDblWithSelectionId: (id: string) => Promise<void>;
  setDefaultDblWithoutSelectionId: (id: string) => Promise<void>;
}

// Per-test harness that hooks chrome.action.setIcon in the service
// worker, records every call's `path` argument, and returns a
// function to read the recorded log from the test side. The hook is
// installed at the start of each test and reset between them.
async function installSetIconSpy(sw: import('@playwright/test').Worker): Promise<void> {
  await sw.evaluate(() => {
    interface Spied {
      __origSetIcon?: typeof chrome.action.setIcon;
      __setIconCalls?: unknown[];
    }
    const g = self as unknown as Spied;
    // If a previous test left the spy installed, restore it first so
    // the original function is always the one we wrap.
    if (g.__origSetIcon) {
      chrome.action.setIcon = g.__origSetIcon;
    }
    g.__origSetIcon = chrome.action.setIcon.bind(chrome.action);
    g.__setIconCalls = [];
    chrome.action.setIcon = ((details: chrome.action.TabIconDetails) => {
      g.__setIconCalls!.push(details);
      return g.__origSetIcon!(details);
    }) as typeof chrome.action.setIcon;
  });
}

async function getSetIconCalls(
  sw: import('@playwright/test').Worker,
): Promise<Array<{ path?: Record<string, string> }>> {
  return sw.evaluate(() => {
    const g = self as unknown as { __setIconCalls?: unknown[] };
    return (g.__setIconCalls ?? []) as Array<{ path?: Record<string, string> }>;
  });
}

test.beforeEach(async ({ getServiceWorker }) => {
  // Pin the stored default click action to `save-screenshot` so
  // `clearCaptureError()`'s dynamic tooltip resolves to the
  // expected baseline, then reset the icon-swap spy. Lives in the
  // service worker so we don't have to bridge chrome.* APIs across
  // the test boundary.
  const sw = await getServiceWorker();
  await sw.evaluate(async () => {
    const api = (self as unknown as {
      SeeWhatISee: {
        setDefaultWithSelectionId: (id: string) => Promise<void>;
        setDefaultWithoutSelectionId: (id: string) => Promise<void>;
        setDefaultDblWithSelectionId: (id: string) => Promise<void>;
        setDefaultDblWithoutSelectionId: (id: string) => Promise<void>;
      };
    }).SeeWhatISee;
    await api.setDefaultWithoutSelectionId('save-screenshot');
    // Pin all three remaining defaults too so every tooltip line
    // stays stable regardless of the starting storage state.
    await api.setDefaultWithSelectionId('save-selection-html');
    await api.setDefaultDblWithoutSelectionId('capture');
    await api.setDefaultDblWithSelectionId('capture');
  });
  await installSetIconSpy(sw);
});

test('reportCaptureError swaps to the error icon and sets the tooltip', async ({
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  const title = await sw.evaluate(async () => {
    const api = (self as unknown as { SeeWhatISee: ErrorApi }).SeeWhatISee;
    await api.reportCaptureError(new Error('No active tab found to capture'));
    return chrome.action.getTitle({});
  });

  expect(title).toBe(titleWithError('No active tab found to capture'));

  const calls = await getSetIconCalls(sw);
  expect(calls).toHaveLength(1);
  expect(calls[0].path).toEqual({
    16: 'icons/icon-error-16.png',
    48: 'icons/icon-error-48.png',
    128: 'icons/icon-error-128.png',
  });
});

test('clearCaptureError restores the normal icon and tooltip', async ({ getServiceWorker }) => {
  const sw = await getServiceWorker();
  const title = await sw.evaluate(async () => {
    const api = (self as unknown as { SeeWhatISee: ErrorApi }).SeeWhatISee;
    await api.reportCaptureError(new Error('Failed to retrieve page contents'));
    await api.clearCaptureError();
    return chrome.action.getTitle({});
  });

  expect(title).toBe(DEFAULT_TITLE);

  const calls = await getSetIconCalls(sw);
  // One swap to error, one swap back to normal.
  expect(calls).toHaveLength(2);
  expect(calls[0].path).toEqual({
    16: 'icons/icon-error-16.png',
    48: 'icons/icon-error-48.png',
    128: 'icons/icon-error-128.png',
  });
  expect(calls[1].path).toEqual({
    16: 'icons/icon-16.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  });
});

test('runWithErrorReporting surfaces a rejection as an error state', async ({
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  const title = await sw.evaluate(async () => {
    const api = (self as unknown as { SeeWhatISee: ErrorApi }).SeeWhatISee;
    await api.runWithErrorReporting(() => Promise.reject(new Error('simulated failure')));
    return chrome.action.getTitle({});
  });

  expect(title).toBe(titleWithError('simulated failure'));
  const calls = await getSetIconCalls(sw);
  expect(calls).toHaveLength(1);
  expect(calls[0].path?.[128]).toBe('icons/icon-error-128.png');
});

test('runWithErrorReporting clears a stale error state on success', async ({
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  const title = await sw.evaluate(async () => {
    const api = (self as unknown as { SeeWhatISee: ErrorApi }).SeeWhatISee;
    // Plant an error first, then run a successful action through the
    // same wrapper. This is the exact sequence of "capture fails,
    // user re-clicks and it works" — we want the error icon gone and
    // the tooltip back to the manifest default.
    await api.reportCaptureError(new Error('first failure'));
    await api.runWithErrorReporting(() => Promise.resolve('ok'));
    return chrome.action.getTitle({});
  });

  expect(title).toBe(DEFAULT_TITLE);
  const calls = await getSetIconCalls(sw);
  // reportCaptureError (error) → runWithErrorReporting success path
  // calls clearCaptureError (normal).
  expect(calls).toHaveLength(2);
  expect(calls[0].path?.[128]).toBe('icons/icon-error-128.png');
  expect(calls[1].path?.[128]).toBe('icons/icon-128.png');
});

test('repeat failures always reflect the most recent error', async ({ getServiceWorker }) => {
  const sw = await getServiceWorker();
  const title = await sw.evaluate(async () => {
    const api = (self as unknown as { SeeWhatISee: ErrorApi }).SeeWhatISee;
    await api.reportCaptureError(new Error('first'));
    await api.reportCaptureError(new Error('second'));
    await api.reportCaptureError(new Error('third'));
    return chrome.action.getTitle({});
  });

  // Tooltip always reflects the *most recent* error — the last call wins.
  expect(title).toBe(titleWithError('third'));
});
