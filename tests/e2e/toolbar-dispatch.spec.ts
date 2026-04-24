// E2E coverage for the toolbar action's click-routing layer — the
// `handleActionClick` dispatcher on the SW and its supporting
// default-id storage + migration helpers. These tests drive the
// dispatcher directly via `self.SeeWhatISee` (Playwright can't
// click the toolbar itself) and observe the side effect (a
// screenshot written, a capture.html tab opening, a selection
// file produced, etc.).
//
// Scope:
//   - `handleActionClick` with each without-selection default id.
//   - Tooltip text reflects the configured default ids.
//   - `captureBothToMemory(delayMs)` — the in-memory primitive that
//     the details flow's delayed path shares.
//   - Selection-aware click dispatch: with-sel × single vs double
//     click × ignore-selection opt-out.
//   - `getDefaultWithoutSelectionId` fallback + legacy id migration.
//   - `copyLastSelectionFilename` log lookup + offscreen forwarding.

import type { Page, Worker } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { SCREENSHOT_PATTERN, seedSelection } from './details-helpers';

// chrome.tabs.captureVisibleTab is rate-limited (~2/s per window).
// Several tests here fire a capture via handleActionClick; without
// a small cushion the suite occasionally trips the quota.
test.beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 600));
});

// ─── captureBothToMemory + handleActionClick dispatch ─────────────

test('captureBothToMemory(delayMs) sleeps before snapshotting', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const page = await extensionContext.newPage();
  await page.goto(`${fixtureServer.baseUrl}/green.html`);
  await page.bringToFront();

  const sw = await getServiceWorker();
  const elapsedMs = await sw.evaluate(async () => {
    const api = (
      self as unknown as {
        SeeWhatISee: {
          captureBothToMemory: (delayMs?: number) => Promise<{
            screenshotDataUrl: string;
            html: string;
            url: string;
          }>;
        };
      }
    ).SeeWhatISee;
    const start = performance.now();
    const data = await api.captureBothToMemory(200);
    const elapsed = performance.now() - start;
    // Sanity check: we actually grabbed something. The data URL
    // prefix and a non-empty HTML body prove both legs ran.
    if (!data.screenshotDataUrl.startsWith('data:image/png')) {
      throw new Error('missing screenshot data URL');
    }
    if (!data.html.includes('background: #00c000')) {
      throw new Error('html scrape did not land on green.html');
    }
    return elapsed;
  });

  // Delay must actually fire — the details-flow delayed path shares
  // the same timer. A missing `await` on the setTimeout would make
  // this near-zero.
  expect(elapsedMs).toBeGreaterThanOrEqual(190);
  expect(elapsedMs).toBeLessThan(500);

  await page.close();
});

test('default click action set to capture-screenshot: handleActionClick takes a direct screenshot', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw0 = await getServiceWorker();
  await sw0.evaluate(async () => {
    await chrome.storage.local.clear();
    await (
      self as unknown as {
        SeeWhatISee: { setDefaultWithoutSelectionId: (id: string) => Promise<void> };
      }
    ).SeeWhatISee.setDefaultWithoutSelectionId('capture-screenshot');
  });

  const openerPage = await extensionContext.newPage();
  await openerPage.goto(`${fixtureServer.baseUrl}/purple.html`);
  await openerPage.bringToFront();

  // If a capture.html tab opens, the test should fail — capture-screenshot
  // should dispatch directly, not open the details flow.
  let detailsOpened = false;
  const onPage = (p: Page) => {
    if (p.url().endsWith('/capture.html')) detailsOpened = true;
  };
  extensionContext.on('page', onPage);

  const sw = await getServiceWorker();
  await sw.evaluate(async () => {
    await (
      self as unknown as {
        SeeWhatISee: { handleActionClick: () => Promise<void> };
      }
    ).SeeWhatISee.handleActionClick();
  });

  // Give Chrome a moment to fire any stray page event before
  // checking the flag.
  await new Promise((r) => setTimeout(r, 200));
  extensionContext.off('page', onPage);
  expect(detailsOpened).toBe(false);

  // The screenshot should have landed via the direct path.
  const sw2 = await getServiceWorker();
  const stored = await sw2.evaluate(async () => {
    return await chrome.storage.local.get('captureLog');
  });
  const log = (stored.captureLog ?? []) as { screenshot?: { filename: string } }[];
  expect(log.length).toBeGreaterThan(0);
  expect(log[log.length - 1].screenshot?.filename).toMatch(SCREENSHOT_PATTERN);

  await openerPage.close();
});

test('default click action set to capture-with-details: handleActionClick opens the details page', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw0 = await getServiceWorker();
  await sw0.evaluate(async () => {
    await chrome.storage.local.clear();
    await (
      self as unknown as {
        SeeWhatISee: { setDefaultWithoutSelectionId: (id: string) => Promise<void> };
      }
    ).SeeWhatISee.setDefaultWithoutSelectionId('capture-with-details');
  });

  const openerPage = await extensionContext.newPage();
  await openerPage.goto(`${fixtureServer.baseUrl}/purple.html`);
  await openerPage.bringToFront();

  const capturePagePromise = extensionContext.waitForEvent('page', {
    predicate: (p) => p.url().endsWith('/capture.html'),
    timeout: 5000,
  });

  const sw = await getServiceWorker();
  await sw.evaluate(async () => {
    await (
      self as unknown as {
        SeeWhatISee: { handleActionClick: () => Promise<void> };
      }
    ).SeeWhatISee.handleActionClick();
  });

  const capturePage = await capturePagePromise;
  await capturePage.waitForLoadState('domcontentloaded');

  // Close the details tab cleanly so it doesn't leak into the next
  // test.
  await Promise.all([
    capturePage.waitForEvent('close'),
    capturePage.locator('#capture').click(),
  ]);

  // Reset the preference so subsequent tests in this worker get
  // the default behavior.
  const sw2 = await getServiceWorker();
  await sw2.evaluate(async () => {
    await (
      self as unknown as {
        SeeWhatISee: { setDefaultWithoutSelectionId: (id: string) => Promise<void> };
      }
    ).SeeWhatISee.setDefaultWithoutSelectionId('capture-screenshot');
  });

  await openerPage.close();
});

test('setDefaultWithoutSelectionId updates the toolbar tooltip to match', async ({
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  const titles = await sw.evaluate(async () => {
    const api = (
      self as unknown as {
        SeeWhatISee: {
          setDefaultWithSelectionId: (id: string) => Promise<void>;
          setDefaultWithoutSelectionId: (id: string) => Promise<void>;
        };
      }
    ).SeeWhatISee;
    // Pin the with-selection default so the middle tooltip line
    // stays stable regardless of the starting storage state.
    await api.setDefaultWithSelectionId('capture-selection-html');
    await api.setDefaultWithoutSelectionId('capture-screenshot');
    const a = await chrome.action.getTitle({});
    await api.setDefaultWithoutSelectionId('capture-screenshot-2s');
    const b = await chrome.action.getTitle({});
    await api.setDefaultWithoutSelectionId('capture-page-contents');
    const c = await chrome.action.getTitle({});
    await api.setDefaultWithoutSelectionId('capture-with-details');
    const d = await chrome.action.getTitle({});
    // Restore default so the rest of the suite is unaffected.
    await api.setDefaultWithoutSelectionId('capture-screenshot');
    return { a, b, c, d };
  });

  // Tooltip layout (bracketed by blank lines above and below the
  // action block — see `getDefaultActionTooltip`):
  //
  //   SeeWhatISee
  //   <blank>
  //   Click: <…>
  //   Double-click: <…>
  //   With selection: <…>
  //   <blank trailing line>
  const withSelLine = 'With selection: Capture as HTML';
  const expected = (click: string, dbl: string) =>
    ['SeeWhatISee', '', `Click: ${click}`, `Double-click: ${dbl}`, withSelLine, ''].join('\n');
  expect(titles.a).toBe(expected('Take screenshot', 'Capture with details'));
  expect(titles.b).toBe(expected('Take screenshot in 2s', 'Capture with details'));
  expect(titles.c).toBe(expected('Save HTML contents', 'Capture with details'));
  expect(titles.d).toBe(expected('Capture with details', 'Take screenshot'));
});

// ─── Selection-aware click dispatch ──────────────────────────────
//
// These tests cover the toolbar-click behavior when the active page
// has a text selection. Matrix:
//
//   - `with-sel` default × selection present × single / double-click,
//     verifying both what runs and what *doesn't* (ignore-selection
//     must not probe; double-click on selection always opens details).
//   - `copyLastSelectionFilename` menu action.
//   - Stale storage: a `capture-selection-*` id stashed in the
//     without-selection slot should fall back (the setter normally
//     rejects it, but storage migrations or manual edits could leak
//     one in).
//
// Shared setup pattern: each test clears `chrome.storage.local`,
// pins the two click defaults it cares about, seeds a selection on
// the opener page via `seedSelection`, and then drives
// `handleActionClick` from the SW. Assertions read the in-memory
// log (`chrome.storage.local.get('captureLog')`) rather than
// log.json — no need for the download-spy setup that the details
// flow uses, since we only care about what was recorded.

type ClickApi = {
  handleActionClick: () => Promise<void>;
  setDefaultWithSelectionId: (id: string) => Promise<void>;
  setDefaultWithoutSelectionId: (id: string) => Promise<void>;
};

async function pinClickDefaults(
  sw: Worker,
  withId: string,
  withoutId: string,
): Promise<void> {
  await sw.evaluate(
    async ({ withId, withoutId }: { withId: string; withoutId: string }) => {
      await chrome.storage.local.clear();
      const api = (self as unknown as { SeeWhatISee: ClickApi }).SeeWhatISee;
      await api.setDefaultWithSelectionId(withId);
      await api.setDefaultWithoutSelectionId(withoutId);
    },
    { withId, withoutId },
  );
}

async function runSingleClick(sw: Worker): Promise<void> {
  await sw.evaluate(async () => {
    const api = (self as unknown as { SeeWhatISee: ClickApi }).SeeWhatISee;
    await api.handleActionClick();
  });
}

// Fire two clicks tight enough that the second lands before the
// 250ms `DOUBLE_CLICK_MS` timer expires. The first call's promise
// never resolves once the timer is cleared (that's the production
// reality too — a real double-click leaks a pending promise inside
// the SW), so we fire-and-forget it and only await the second.
async function runDoubleClick(sw: Worker): Promise<void> {
  await sw.evaluate(async () => {
    const api = (self as unknown as { SeeWhatISee: ClickApi }).SeeWhatISee;
    void api.handleActionClick().catch(() => {});
    // Micro-pause so the first call registers its timer before the
    // second clears it. Same-worker single-threaded — the `await`
    // is defensive against any future microtask shuffle.
    await new Promise((r) => setTimeout(r, 20));
    await api.handleActionClick();
  });
}

type LogRecord = {
  screenshot?: { filename: string };
  contents?: { filename: string };
  selection?: { filename: string; format: string };
};

async function latestLogRecord(sw: Worker): Promise<LogRecord | undefined> {
  const stored = await sw.evaluate(() => chrome.storage.local.get('captureLog'));
  const log = (stored.captureLog ?? []) as LogRecord[];
  return log[log.length - 1];
}

for (const { id, format, ext } of [
  { id: 'capture-selection-html', format: 'html', ext: 'html' },
  { id: 'capture-selection-text', format: 'text', ext: 'txt' },
  { id: 'capture-selection-markdown', format: 'markdown', ext: 'md' },
] as const) {
  test(`click with selection: with-sel=${id} saves selection as .${ext}`, async ({
    extensionContext,
    fixtureServer,
    getServiceWorker,
  }) => {
    const sw = await getServiceWorker();
    await pinClickDefaults(sw, id, 'capture-with-details');

    const openerPage = await extensionContext.newPage();
    await openerPage.goto(`${fixtureServer.baseUrl}/purple.html`);
    await openerPage.bringToFront();
    await seedSelection(openerPage);

    await runSingleClick(sw);

    const r = await latestLogRecord(sw);
    expect(r?.selection?.filename, 'selection file written').toMatch(
      new RegExp(`^selection-\\d{8}-\\d{6}-\\d{3}\\.${ext}$`),
    );
    expect(r?.selection?.format).toBe(format);
    expect(r?.screenshot).toBeUndefined();
    expect(r?.contents).toBeUndefined();

    await openerPage.close();
  });
}

test('click with selection: with-sel=capture-with-details opens details with selection pre-checked', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  await pinClickDefaults(sw, 'capture-with-details', 'capture-screenshot');

  const openerPage = await extensionContext.newPage();
  await openerPage.goto(`${fixtureServer.baseUrl}/purple.html`);
  await openerPage.bringToFront();
  await seedSelection(openerPage);

  const capturePagePromise = extensionContext.waitForEvent('page', {
    predicate: (p) => p.url().endsWith('/capture.html'),
    timeout: 5000,
  });

  await runSingleClick(sw);
  const capturePage = await capturePagePromise;
  await capturePage.waitForLoadState('domcontentloaded');

  // With a selection present, the details page opens focused on
  // capturing it: Save selection master checked, screenshot
  // unchecked. HTML is unchecked by default regardless of
  // selection state.
  await expect(capturePage.locator('#cap-screenshot')).not.toBeChecked();
  await expect(capturePage.locator('#cap-html')).not.toBeChecked();
  await expect(capturePage.locator('#cap-selection')).toBeChecked();

  // Close the details tab without saving so nothing leaks into the
  // log / file system.
  await capturePage.close();
  await openerPage.close();
});

test('click with selection: with-sel=ignore-selection runs the without-selection default', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  // ignore-selection + capture-screenshot should take a screenshot even
  // though a selection is present — the probe is skipped entirely.
  await pinClickDefaults(sw, 'ignore-selection', 'capture-screenshot');

  const openerPage = await extensionContext.newPage();
  await openerPage.goto(`${fixtureServer.baseUrl}/purple.html`);
  await openerPage.bringToFront();
  await seedSelection(openerPage);

  // If the probe *did* run and kicked us into a with-selection
  // branch, we'd either open a details page or save a selection
  // file. Guard against the details path opening.
  let detailsOpened = false;
  const onPage = (p: Page): void => {
    if (p.url().endsWith('/capture.html')) detailsOpened = true;
  };
  extensionContext.on('page', onPage);

  await runSingleClick(sw);

  await new Promise((r) => setTimeout(r, 150));
  extensionContext.off('page', onPage);
  expect(detailsOpened, 'no details page opens in ignore-selection mode').toBe(false);

  const r = await latestLogRecord(sw);
  expect(r?.screenshot?.filename).toMatch(SCREENSHOT_PATTERN);
  expect(r?.selection, 'selection NOT saved in ignore-selection mode').toBeUndefined();

  await openerPage.close();
});

test('double-click with selection: always opens details (even when without-sel=capture-with-details)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // Without-sel = capture-with-details → classic alternate is
  // capture-screenshot (screenshot). With a selection present and
  // with-sel != ignore-selection, the new rule overrides that
  // alternate and routes double-click to details. This test
  // regression-guards the override.
  const sw = await getServiceWorker();
  await pinClickDefaults(sw, 'capture-selection-html', 'capture-with-details');

  const openerPage = await extensionContext.newPage();
  await openerPage.goto(`${fixtureServer.baseUrl}/purple.html`);
  await openerPage.bringToFront();
  await seedSelection(openerPage);

  const capturePagePromise = extensionContext.waitForEvent('page', {
    predicate: (p) => p.url().endsWith('/capture.html'),
    timeout: 5000,
  });

  await runDoubleClick(sw);

  const capturePage = await capturePagePromise;
  await capturePage.waitForLoadState('domcontentloaded');

  // When a selection is present, the details page opens focused
  // on capturing it: Save selection master checked, screenshot
  // unchecked. The user can still tick screenshot back on before
  // clicking Capture.
  await expect(capturePage.locator('#cap-screenshot')).not.toBeChecked();
  await expect(capturePage.locator('#cap-selection')).toBeChecked();

  await capturePage.close();
  await openerPage.close();
});

// Details-page initial format radio tracks the with-selection
// click default. Double-click + selection reliably opens the
// details page regardless of what the click default is, so we use
// it as the vehicle here. `capture-with-details` is included to
// cover the fallthrough: any with-sel default that isn't a
// `capture-selection-<fmt>` shortcut lands on markdown.
for (const { withSel, expectRadio } of [
  { withSel: 'capture-selection-html', expectRadio: 'cap-selection-html' },
  { withSel: 'capture-selection-text', expectRadio: 'cap-selection-text' },
  { withSel: 'capture-selection-markdown', expectRadio: 'cap-selection-markdown' },
  { withSel: 'capture-with-details', expectRadio: 'cap-selection-markdown' },
] as const) {
  test(`details: initial format radio from with-sel=${withSel} is #${expectRadio}`, async ({
    extensionContext,
    fixtureServer,
    getServiceWorker,
  }) => {
    const sw = await getServiceWorker();
    await pinClickDefaults(sw, withSel, 'capture-screenshot');

    const openerPage = await extensionContext.newPage();
    await openerPage.goto(`${fixtureServer.baseUrl}/purple.html`);
    await openerPage.bringToFront();
    await seedSelection(openerPage);

    const capturePagePromise = extensionContext.waitForEvent('page', {
      predicate: (p) => p.url().endsWith('/capture.html'),
      timeout: 5000,
    });
    await runDoubleClick(sw);
    const capturePage = await capturePagePromise;
    await capturePage.waitForLoadState('domcontentloaded');

    await expect(capturePage.locator(`#${expectRadio}`)).toBeChecked();

    await capturePage.close();
    await openerPage.close();
  });
}

test('double-click with selection: ignore-selection keeps the classic alternate (screenshot)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // ignore-selection + without-sel=capture-with-details → classic
  // double-click alternate is capture-screenshot. The "selection present"
  // override must NOT trigger when the user has opted out via
  // ignore-selection, so a selection on the page shouldn't flip
  // the dispatch to details.
  const sw = await getServiceWorker();
  await pinClickDefaults(sw, 'ignore-selection', 'capture-with-details');

  const openerPage = await extensionContext.newPage();
  await openerPage.goto(`${fixtureServer.baseUrl}/purple.html`);
  await openerPage.bringToFront();
  await seedSelection(openerPage);

  let detailsOpened = false;
  const onPage = (p: Page): void => {
    if (p.url().endsWith('/capture.html')) detailsOpened = true;
  };
  extensionContext.on('page', onPage);

  await runDoubleClick(sw);

  await new Promise((r) => setTimeout(r, 150));
  extensionContext.off('page', onPage);
  expect(detailsOpened, 'details must NOT open in ignore-selection double-click').toBe(false);

  const r = await latestLogRecord(sw);
  expect(r?.screenshot?.filename).toMatch(SCREENSHOT_PATTERN);

  await openerPage.close();
});

// ─── getDefaultWithoutSelectionId storage migration ──────────────

test('getDefaultWithoutSelectionId: stale capture-selection-* storage value falls back', async ({
  getServiceWorker,
}) => {
  // The setter rejects `capture-selection-*` baseIds, but a stale
  // value could leak in from a storage migration or manual edit.
  // The getter must refuse to hand it back — it'd error on every
  // click without a selection.
  const sw = await getServiceWorker();
  const id = await sw.evaluate(async () => {
    await chrome.storage.local.clear();
    // Bypass the setter to simulate a corrupt value.
    await chrome.storage.local.set({
      defaultClickWithoutSelection: 'capture-selection-html',
    });
    return await (
      self as unknown as {
        SeeWhatISee: { getDefaultWithoutSelectionId: () => Promise<string> };
      }
    ).SeeWhatISee.getDefaultWithoutSelectionId();
  });
  expect(id).toBe('capture-with-details');
});

test('getDefaultWithoutSelectionId: migrates legacy capture-now / save-page-contents ids', async ({
  getServiceWorker,
}) => {
  // Two base ids were renamed (`capture-now` → `capture-screenshot`,
  // `save-page-contents` → `capture-page-contents`). A user who had
  // customized the without-selection default via the pre-rename UI
  // would have one of these values in storage — the getter must
  // rewrite it in place so the next menu render / click uses the
  // current id, and `findCaptureAction` doesn't silently fall back
  // to the fresh-install default. Delay suffixes must survive the
  // rewrite too.
  const sw = await getServiceWorker();
  const cases = [
    { legacy: 'capture-now', current: 'capture-screenshot' },
    { legacy: 'capture-now-2s', current: 'capture-screenshot-2s' },
    { legacy: 'capture-now-5s', current: 'capture-screenshot-5s' },
    { legacy: 'save-page-contents', current: 'capture-page-contents' },
    { legacy: 'save-page-contents-2s', current: 'capture-page-contents-2s' },
  ];
  for (const { legacy, current } of cases) {
    const result = await sw.evaluate(async (stored: string) => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({ defaultClickWithoutSelection: stored });
      const id = await (
        self as unknown as {
          SeeWhatISee: { getDefaultWithoutSelectionId: () => Promise<string> };
        }
      ).SeeWhatISee.getDefaultWithoutSelectionId();
      const persisted = (
        await chrome.storage.local.get('defaultClickWithoutSelection')
      ).defaultClickWithoutSelection;
      return { id, persisted };
    }, legacy);
    expect(result.id, `getter returns new id for ${legacy}`).toBe(current);
    expect(result.persisted, `storage rewritten for ${legacy}`).toBe(current);
  }
});

// ─── copyLastSelectionFilename ───────────────────────────────────

test('copyLastSelectionFilename: throws when no capture in the log', async ({
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  const err = await sw.evaluate(async () => {
    await chrome.storage.local.clear();
    try {
      await (
        self as unknown as {
          SeeWhatISee: { copyLastSelectionFilename: () => Promise<void> };
        }
      ).SeeWhatISee.copyLastSelectionFilename();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  });
  expect(err).toBe('No captures in the log to copy from');
});

test('copyLastSelectionFilename: throws when latest record has no selection', async ({
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  const err = await sw.evaluate(async () => {
    await chrome.storage.local.clear();
    // Seed a screenshot-only record — the latest has no selection.
    await chrome.storage.local.set({
      captureLog: [
        {
          timestamp: '2026-04-21T12:00:00.000Z',
          url: 'https://example.test/',
          screenshot: { filename: 'screenshot-20260421-120000-000.png' },
        },
      ],
    });
    try {
      await (
        self as unknown as {
          SeeWhatISee: { copyLastSelectionFilename: () => Promise<void> };
        }
      ).SeeWhatISee.copyLastSelectionFilename();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  });
  expect(err).toBe('Latest capture has no selection to copy');
});

test('copyLastSelectionFilename: forwards the selection filename to the offscreen copy target', async ({
  getServiceWorker,
}) => {
  // Intercept the three chrome.* calls that `copyLastSelectionFilename`
  // depends on so the test can read the payload handed to the
  // offscreen document without needing a real capture to have
  // written log.json (which is what `getCaptureDirectory` normally
  // looks up via `chrome.downloads.search`), and without needing
  // the offscreen doc to actually execute `execCommand('copy')`.
  //
  // Originals are saved and restored via a finally block so later
  // tests in the same worker see unpatched chrome.* APIs — the SW
  // is shared across tests in this single-worker setup.
  const sw = await getServiceWorker();
  try {
    const forwarded = await sw.evaluate(async () => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({
        captureLog: [
          {
            timestamp: '2026-04-21T12:00:00.000Z',
            url: 'https://example.test/',
            selection: { filename: 'selection-20260421-120000-000.md', format: 'markdown' },
          },
        ],
      });

      interface Spy {
        __seeCopyOrigSearch?: typeof chrome.downloads.search;
        __seeCopyOrigCreate?: typeof chrome.offscreen.createDocument;
        __seeCopyOrigSend?: typeof chrome.runtime.sendMessage;
        __seeOffscreenMsg?: unknown;
      }
      const g = self as unknown as Spy;
      g.__seeCopyOrigSearch = chrome.downloads.search.bind(chrome.downloads);
      g.__seeCopyOrigCreate = chrome.offscreen.createDocument.bind(chrome.offscreen);
      g.__seeCopyOrigSend = chrome.runtime.sendMessage.bind(chrome.runtime);

      // Fake the download-history lookup: return a single synthetic
      // log.json entry with byExtensionId = our id, so
      // `getCaptureDirectory` accepts it and strips to a directory.
      (chrome.downloads as { search: typeof chrome.downloads.search }).search =
        (async () => [
          {
            id: 0,
            byExtensionId: chrome.runtime.id,
            filename: '/tmp/fake-see-dir/log.json',
          } as chrome.downloads.DownloadItem,
        ]) as typeof chrome.downloads.search;
      (chrome.offscreen as { createDocument: typeof chrome.offscreen.createDocument }).createDocument =
        (async () => {}) as typeof chrome.offscreen.createDocument;
      (chrome.runtime as { sendMessage: typeof chrome.runtime.sendMessage }).sendMessage =
        (async (msg: unknown) => {
          g.__seeOffscreenMsg = msg;
          // `copyToClipboard` treats an `undefined` response as
          // "offscreen listener never registered"; return an ok
          // envelope so the success path runs to completion.
          return { ok: true };
        }) as typeof chrome.runtime.sendMessage;

      g.__seeOffscreenMsg = undefined;
      await (
        self as unknown as {
          SeeWhatISee: { copyLastSelectionFilename: () => Promise<void> };
        }
      ).SeeWhatISee.copyLastSelectionFilename();

      return g.__seeOffscreenMsg;
    });
    const msg = forwarded as { target?: string; text?: string } | undefined;
    expect(msg?.target).toBe('offscreen-copy');
    expect(msg?.text).toBe('/tmp/fake-see-dir/selection-20260421-120000-000.md');
  } finally {
    // Restore originals so later tests see unpatched APIs.
    await sw.evaluate(() => {
      interface Spy {
        __seeCopyOrigSearch?: typeof chrome.downloads.search;
        __seeCopyOrigCreate?: typeof chrome.offscreen.createDocument;
        __seeCopyOrigSend?: typeof chrome.runtime.sendMessage;
      }
      const g = self as unknown as Spy;
      if (g.__seeCopyOrigSearch) {
        (chrome.downloads as { search: typeof chrome.downloads.search }).search =
          g.__seeCopyOrigSearch;
      }
      if (g.__seeCopyOrigCreate) {
        (chrome.offscreen as { createDocument: typeof chrome.offscreen.createDocument }).createDocument =
          g.__seeCopyOrigCreate;
      }
      if (g.__seeCopyOrigSend) {
        (chrome.runtime as { sendMessage: typeof chrome.runtime.sendMessage }).sendMessage =
          g.__seeCopyOrigSend;
      }
    });
  }
});
