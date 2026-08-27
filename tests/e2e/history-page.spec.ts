// Tests for the History page (`history.html` / `history.ts`) — the
// table view over the capture log.
//
// The page opens from `log.json` when it can, but with no capture
// directory to resolve (see the reset below) it falls back to reading
// the `captureLog` cache in `chrome.storage.local` directly (no SW
// round-trip) — so the tests seed synthetic records through the
// service worker rather than running real captures. That keeps them fast and lets us cover the
// mixed shapes a real log holds — screenshot-only, HTML+selection,
// missing URL/title, long prompt — without orchestrating one capture
// per case.
//
// Not covered here: anything that needs real files on disk. These
// tests seed the log directly and never run a capture, so there is no
// cached directory or download record for `peekCaptureDirectory()` to
// resolve against —
// the page falls back from reading `log.json` to the seeded storage
// cache (the disk-first open is covered by `log-history-files.spec.ts`),
// and every file-backed cell renders its no-directory fallback (bare
// filename / unlinked label), which is what these tests assert. For
// the same reason `chrome.downloads` knows nothing about the seeded
// filenames, so the `(deleted)` markers never fire and the file-access
// banner stays hidden.
//
// *Load older captures* with something to load is out of reach for the
// same reason: with no capture there is no directory for
// `listHistoryFiles()` to read and no download record for the
// `getHistoryFilePaths()` fallback, so both discovery routes come up
// empty. Both the flushing and loading the flushed file back are
// covered by `log-history-files.spec.ts` (which does run a capture)
// and `tests/unit/log-history-files.test.mjs`. Its *absence* — the
// control hidden, and the plain empty-log notice — is covered below.

import { stat } from 'node:fs/promises';
import { type Page, type Worker } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { resetCaptureState } from '../fixtures/files';
import {
  configureAndCapture,
  dragRect,
  openDetailsFlow,
  seedSelection,
} from './details-helpers';

interface SeededRecord {
  timestamp: string;
  screenshot?: { filename: string };
  contents?: { filename: string };
  selection?: { filename: string; format: 'html' | 'text' | 'markdown' };
  prompt?: string;
  url?: string;
  title?: string;
}

// Oldest-first, matching how the capture pipeline appends. The page is
// expected to reverse this.
const SEED: SeededRecord[] = [
  {
    timestamp: '2026-01-02T03:04:05.000Z',
    screenshot: { filename: 'screenshot-20260102-030405-000.png' },
    url: 'https://example.com/alpha',
    title: 'Alpha page',
    prompt: 'What is wrong with this layout?',
  },
  {
    timestamp: '2026-01-03T03:04:05.000Z',
    contents: { filename: 'contents-20260103-030405-000.html' },
    selection: { filename: 'selection-20260103-030405-000.md', format: 'markdown' },
    url: 'https://example.org/beta',
    title: 'Beta docs',
  },
  {
    timestamp: '2026-01-04T03:04:05.000Z',
    screenshot: { filename: 'screenshot-20260104-030405-000.png' },
    url: '',
    title: '',
    prompt: 'summarize the gamma report',
  },
];

async function seedLog(sw: Worker, records: SeededRecord[]): Promise<void> {
  await sw.evaluate(
    (recs) => chrome.storage.local.set({ captureLog: recs }),
    records,
  );
}

async function openHistory(page: Page, extensionId: string): Promise<void> {
  await page.goto(`chrome-extension://${extensionId}/history.html`);
  // The controller renders after an async storage read; wait for the
  // count line, which is written on every render.
  await expect(page.locator('#count')).not.toBeEmpty();
}

// A full reset, not just the log key: the worker's profile is shared
// across spec files, and leftover downloads from one that captures
// for real (`log-history-files.spec.ts`) would give
// `peekCaptureDirectory()` a directory to resolve — flipping these
// tests from the seeded cache they assert against to whatever
// `log.json` is (or isn't) on disk.
test.beforeEach(async ({ getServiceWorker }) => {
  await resetCaptureState(await getServiceWorker());
});

test.afterEach(async ({ getServiceWorker }) => {
  const sw = await getServiceWorker();
  await sw.evaluate(() => chrome.storage.local.remove('captureLog'));
});

test('renders the log newest-first with per-column fallbacks', async ({
  extensionContext,
  extensionId,
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  await seedLog(sw, SEED);

  const page = await extensionContext.newPage();
  await openHistory(page, extensionId);

  const rows = page.locator('#rows tr');
  await expect(rows).toHaveCount(3);
  await expect(page.locator('#count')).toHaveText('3 captures');

  // The noun agrees with the count it follows.
  await sw.evaluate(() => chrome.storage.local.set({ captureLog: [
    { timestamp: '2026-01-02T03:04:05.000Z', url: 'https://example.com/solo', title: 'Solo' },
  ] }));
  await expect(page.locator('#count')).toHaveText('1 capture');
  await seedLog(sw, SEED);
  await expect(page.locator('#count')).toHaveText('3 captures');

  // Newest first: the gamma capture (Jan 4) leads.
  await expect(rows.nth(0).locator('.prompt-box')).toHaveText('summarize the gamma report');
  await expect(rows.nth(1).locator('.page-cell .title')).toHaveText('Beta docs');
  await expect(rows.nth(2).locator('.page-cell .title')).toHaveText('Alpha page');

  // Row 0 has a screenshot but no URL/title → Page cell falls back to N/A.
  // The screenshot cell names the file: this harness has never run a
  // real capture, so there's no `log.json` download record to derive
  // the capture directory from and the cell degrades from a thumbnail
  // to the bare filename (same path a user hits before their first
  // capture).
  await expect(rows.nth(0).locator('.shot-cell')).toHaveText(
    'screenshot-20260104-030405-000.png',
  );
  await expect(rows.nth(0).locator('.page-cell .na')).toHaveText('N/A');

  // Row 1 saved HTML + a markdown selection but no screenshot and no
  // prompt → two file links, N/A in the screenshot and prompt columns.
  await expect(rows.nth(1).locator('.files-cell a, .files-cell .flag')).toHaveText([
    'HTML',
    'Selection (md)',
  ]);
  await expect(rows.nth(1).locator('.shot-cell .na')).toHaveText('N/A');
  await expect(rows.nth(1).locator('.prompt-cell .na')).toHaveText('N/A');

  // Row 2 has a screenshot and a prompt but saved no HTML/selection.
  await expect(rows.nth(2).locator('.files-cell .na')).toHaveText('N/A');

  await page.close();
});

test('search filters on URL, title, and prompt text', async ({
  extensionContext,
  extensionId,
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  await seedLog(sw, SEED);

  const page = await extensionContext.newPage();
  await openHistory(page, extensionId);

  const rows = page.locator('#rows tr');
  const search = page.locator('#search');

  // URL substring.
  await search.fill('example.org');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0).locator('.page-cell .title')).toHaveText('Beta docs');
  await expect(page.locator('#count')).toHaveText('1 of 3 captures');

  // Title, case-insensitively.
  await search.fill('ALPHA');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0).locator('.page-cell .title')).toHaveText('Alpha page');

  // Prompt text.
  await search.fill('gamma');
  await expect(rows).toHaveCount(1);

  // Multiple terms must all match, across fields and in any order.
  await search.fill('layout example.com');
  await expect(rows).toHaveCount(1);
  await search.fill('layout example.org');
  await expect(rows).toHaveCount(0);
  await expect(page.locator('#no-matches')).toBeVisible();
  await expect(page.locator('#table')).toBeHidden();

  // Clearing restores every row.
  await search.fill('');
  await expect(rows).toHaveCount(3);

  await page.close();
});

test('shows the empty state with no log, and picks up a later capture', async ({
  extensionContext,
  extensionId,
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  await sw.evaluate(() => chrome.storage.local.remove('captureLog'));

  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/history.html`);
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#table')).toBeHidden();

  // A capture landing while the tab is open re-renders via the
  // `chrome.storage.onChanged` listener — no reload needed.
  await seedLog(sw, SEED.slice(0, 1));
  await expect(page.locator('#rows tr')).toHaveCount(1);
  await expect(page.locator('#empty')).toBeHidden();

  await page.close();
});

// The app-header of every page carries the same trailing button group
// — Options | History | Help — minus a link to the page you're on.
// Both History buttons go through the SW so they behave exactly like
// the More → History menu entry (focus an open tab, else create one).

test('the Options page History button opens the History page, once', async ({
  extensionContext,
  extensionId,
}) => {
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);

  // Options page links out to History and Help but not to itself.
  await expect(page.locator('.app-header .header-btn')).toHaveText(['History', 'Help']);

  const historyUrl = `chrome-extension://${extensionId}/history.html`;
  const opened = extensionContext.waitForEvent('page', {
    predicate: (p) => p.url() === historyUrl,
    timeout: 10000,
  });
  await page.locator('#history-btn').click();
  const historyPage = await opened;

  // A second click focuses the tab that's already open rather than
  // stacking another one.
  //
  // Asserted as the *absence* of a second `page` event. Polling a tab
  // count instead would pass on its first observation — taken
  // immediately after the click, before a duplicate tab could
  // possibly have opened — and so would go green whether or not the
  // reuse path works. Here a broken reuse path actively fires the
  // event and fails the test. (`document.visibilityState` would be
  // the more direct signal, but background tabs in this harness stay
  // `visible`, so it can't distinguish focused from not.)
  await page.bringToFront();
  const duplicate = extensionContext
    .waitForEvent('page', { predicate: (p) => p.url() === historyUrl, timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  await page.locator('#history-btn').click();
  expect(await duplicate).toBe(false);
  expect(extensionContext.pages().filter((p) => p.url() === historyUrl)).toHaveLength(1);

  // Once that tab is gone the stored id is stale, and the next click
  // has to open a fresh tab rather than trying to focus a dead one.
  await historyPage.close();
  const reopened = extensionContext.waitForEvent('page', {
    predicate: (p) => p.url() === historyUrl,
    timeout: 10000,
  });
  await page.locator('#history-btn').click();
  const historyPage2 = await reopened;

  await historyPage2.close();
  await page.close();
});

test('the Capture page History button opens the History page', async ({
  extensionContext,
  extensionId,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Capture page links out to all three peers except itself.
  await expect(capturePage.locator('.app-header .header-btn')).toHaveText([
    'Options',
    'History',
    'Help',
  ]);

  const historyUrl = `chrome-extension://${extensionId}/history.html`;
  const opened = extensionContext.waitForEvent('page', {
    predicate: (p) => p.url() === historyUrl,
    timeout: 10000,
  });
  await capturePage.locator('#history-btn').click();
  const historyPage = await opened;

  await historyPage.close();
  await capturePage.close();
  await openerPage.close();
});

test('the History page links out to Options and Help but not itself', async ({
  extensionContext,
  extensionId,
}) => {
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/history.html`);
  await expect(page.locator('.app-header .header-btn')).toHaveText(['Options', 'Help']);
  await page.close();
});

// The history files themselves are out of reach here (see the file
// header), so this covers the other half: with nothing to load, the
// control must not be on screen at all. It used to be — `.older`'s
// `display: flex` outranks the UA `[hidden]` rule, so the row showed
// with an empty note beside a disabled button.
test('Load older captures stays hidden when there are no history files', async ({
  extensionContext,
  extensionId,
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  await seedLog(sw, SEED);
  const page = await extensionContext.newPage();
  await openHistory(page, extensionId);
  await expect(page.locator('#older')).toBeHidden();
  // It lives in the toolbar now, not under the table — a move back
  // would leave every other assertion here passing.
  await expect(page.locator('.toolbar #older')).toHaveCount(1);
  await expect(page.locator('main #older')).toHaveCount(0);
  // With no history files the plain empty-log notice is the right story;
  // the history-files-are-waiting one stays out of the way.
  await seedLog(sw, []);
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#empty-history-files')).toBeHidden();
  await page.close();
});

// The table scrolls inside `<main>`, not on the document, so the
// scrolling keys only reach it because `history.ts` routes them there
// by hand. Everything here is about *where* a key lands.
const TALL_SEED: SeededRecord[] = Array.from({ length: 40 }, (_, i) => ({
  timestamp: `2026-01-02T03:04:${String(i).padStart(2, '0')}.000Z`,
  url: `https://example.com/row-${i}`,
  title: `Row ${i}`,
}));

async function scrollTopOfMain(page: Page): Promise<number> {
  return page.locator('main').evaluate((el) => el.scrollTop);
}

test('scrolling keys scroll the table whatever has focus', async ({
  extensionContext,
  extensionId,
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  await seedLog(sw, TALL_SEED);
  const page = await extensionContext.newPage();
  await openHistory(page, extensionId);
  const main = page.locator('main');
  await expect(main).toHaveJSProperty('scrollTop', 0);

  // Nothing clicked yet, so focus is on <body>, which has no
  // scrollable ancestor. This is the case that was broken.
  await page.keyboard.press('PageDown');
  const paged = await scrollTopOfMain(page);
  expect(paged).toBeGreaterThan(0);

  await page.keyboard.press('ArrowUp');
  expect(await scrollTopOfMain(page)).toBeLessThan(paged);

  // A focused header button doesn't swallow the keys either.
  await page.locator('#options-btn').focus();
  await expect(page.locator('#options-btn')).toBeFocused();
  await page.keyboard.press('End');
  const ended = await scrollTopOfMain(page);
  expect(ended).toBeGreaterThan(paged);

  await page.keyboard.press('Home');
  await expect(main).toHaveJSProperty('scrollTop', 0);

  // Chrome's own chords are left alone: Ctrl-Page Down switches
  // browser tabs, and Alt-Down is not ours either.
  await page.keyboard.press('Control+PageDown');
  await page.keyboard.press('Alt+ArrowDown');
  await expect(main).toHaveJSProperty('scrollTop', 0);
  // Ctrl-End is the exception — the familiar jump-to-the-bottom chord.
  await page.keyboard.press('Control+End');
  expect(await scrollTopOfMain(page)).toBe(ended);

  await page.close();
});

test('the search box keeps the caret keys but not Page Up/Down', async ({
  extensionContext,
  extensionId,
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  await seedLog(sw, TALL_SEED);
  const page = await extensionContext.newPage();
  await openHistory(page, extensionId);
  const main = page.locator('main');

  await page.locator('#search').click();
  await page.locator('#search').fill('example');
  // Caret keys stay with the input: the table must sit still.
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#search')).toBeFocused();
  await expect(main).toHaveJSProperty('scrollTop', 0);

  // Page Up/Down do nothing in a single-line input, so they scroll the
  // results the search just filtered — without taking focus away.
  await page.keyboard.press('PageDown');
  expect(await scrollTopOfMain(page)).toBeGreaterThan(0);
  await expect(page.locator('#search')).toBeFocused();

  await page.close();
});

test('a focused cell scroll-box takes the keys, but only if it overflows', async ({
  extensionContext,
  extensionId,
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  const longUrl = `https://example.com/search?${'utm_source=a&utm_medium=b&'.repeat(30)}q=cow`;
  await seedLog(sw, [
    ...TALL_SEED,
    { timestamp: '2026-02-01T00:00:00.000Z', url: longUrl, title: 'Long' },
  ]);
  const page = await extensionContext.newPage();
  await openHistory(page, extensionId);
  const main = page.locator('main');

  // Newest first, so the long-URL row leads. Clicking its box aims the
  // keys at the box: it scrolls, and the table underneath doesn't.
  const longBox = page.locator('#rows tr').first().locator('.page-cell .scroll-box');
  await longBox.click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('PageDown');
  await expect(longBox).not.toHaveJSProperty('scrollTop', 0);
  await expect(main).toHaveJSProperty('scrollTop', 0);

  // The subtle half: a box whose content fits has nothing to scroll,
  // so the key must fall through to the table rather than being eaten.
  const shortBox = page.locator('#rows tr').nth(1).locator('.page-cell .scroll-box');
  await shortBox.click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('PageDown');
  expect(await scrollTopOfMain(page)).toBeGreaterThan(0);

  await page.close();
});

test('the Snapshots directory tooltip explains the disabled state', async ({
  extensionContext,
  extensionId,
}) => {
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/history.html`);
  // On the wrapper, not the button: Chrome shows no tooltip for a
  // disabled control.
  await expect(page.locator('#snapshots-dir-wrap'))
    .toHaveAttribute('title', /no directory to open/);
  await page.close();
});

// The enabled case needs a resolvable capture directory, which this
// harness can't produce even from a real capture: Playwright rewrites
// every download into its own artifacts directory, so the `log.json`
// record's path doesn't end in `SeeWhatISee/log.json` and
// `peekCaptureDirectory()`'s directory search never matches it (see
// the file header). So this covers the button's presence, its place at the
// end of the toolbar row, and the no-directory state.
test('the Snapshots directory button sits at the end of the toolbar', async ({
  extensionContext,
  extensionId,
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  await seedLog(sw, SEED);
  const page = await extensionContext.newPage();
  await openHistory(page, extensionId);

  const btn = page.locator('#snapshots-dir');
  await expect(btn).toHaveText('Snapshots directory');
  await expect(btn).toBeDisabled();

  const toolbar = await page.locator('.toolbar').boundingBox();
  const box = await btn.boundingBox();
  const search = await page.locator('#search').boundingBox();
  // Right-justified: sitting on the toolbar's 24px right padding (not
  // past the edge, which a one-sided upper bound would also accept),
  // and well clear of the search box on the left.
  const rightGap = toolbar!.x + toolbar!.width - (box!.x + box!.width);
  expect(rightGap).toBeGreaterThan(16);
  expect(rightGap).toBeLessThan(32);
  expect(box!.x).toBeGreaterThan(search!.x + search!.width);

  await page.close();
});

test('a long URL scrolls inside the Page cell instead of stretching the row', async ({
  extensionContext,
  extensionId,
  getServiceWorker,
}) => {
  const sw = await getServiceWorker();
  // A real search URL's worth of tracking parameters — enough to wrap
  // to well past the cap.
  const longUrl = `https://example.com/search?q=cow&${'gs_lcrp=EgZjaHJvbWUqBggAEEUYOzIGCAAQRRg7&'.repeat(20)}ie=UTF-8`;
  await seedLog(sw, [
    { timestamp: '2026-01-02T03:04:05.000Z', url: 'https://example.com/short', title: 'Short' },
    { timestamp: '2026-01-03T03:04:05.000Z', url: longUrl, title: 'Long' },
  ]);

  const page = await extensionContext.newPage();
  await openHistory(page, extensionId);

  const rows = page.locator('#rows tr');
  // Newest first, so the long-URL capture leads.
  const box = rows.nth(0).locator('.page-cell .scroll-box');
  const size = await box.evaluate((el) => ({
    client: el.clientHeight,
    scroll: el.scrollHeight,
    cap: parseFloat(getComputedStyle(el).maxHeight),
  }));
  // The content really does overflow, and the box really does cap it —
  // asserting only the height would pass on a URL that happened to fit.
  expect(size.scroll).toBeGreaterThan(size.client);
  expect(size.client).toBeLessThanOrEqual(size.cap);
  // Same cap as the Prompt box: both read `--thumb-h`.
  expect(size.cap).toBe(144);

  // The row is no taller than the cap plus cell padding, i.e. the long
  // URL bought no extra height over the short one.
  const heights = await rows.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  expect(Math.max(...heights)).toBeLessThan(size.cap + 40);

  // No capture directory in this harness, so flipping the file-URL
  // toggle would change nothing — the banner stays hidden.
  await expect(page.locator('#file-access-hint')).toBeHidden();

  await page.close();
});

// The Restore button needs a *real* capture, not a seeded log: the row
// is identified by `logKey` — the serialized `log.json` record the
// Capture-page save wrote — which only the real save path produces.
//
// The row the button lands on is the point of the whole design, so the
// interesting assertion is the one with a *newer* row above the
// restorable one. That also covers the negative case (a seeded record,
// which has no `logKey`, must not light up) deterministically: the
// button is provably live by then, so "no button here" means something.
test('the Restore button lands on the restorable row, not the newest', async ({
  extensionContext,
  extensionId,
  fixtureServer,
  getServiceWorker,
}) => {
  // A real capture, saved and closed → its session promotes into the
  // `lastCapture` slot carrying the `logKey` of the row it just wrote.
  // `openDetailsFlow` clears `storage.local` first, so this capture is
  // the only row to start with.
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  // Opened before the save so the button has to arrive by push rather
  // than by first paint. Can't use `openHistory` here — it waits on
  // `#count`, which stays empty until there's a record, and
  // `openDetailsFlow` just cleared the log. The empty notice is the
  // first-render signal on this side of the capture.
  const historyPage = await extensionContext.newPage();
  await historyPage.goto(`chrome-extension://${extensionId}/history.html`);
  await expect(historyPage.locator('#empty')).toBeVisible();
  const rows = historyPage.locator('#rows tr');
  const restoreBtn = historyPage.locator('.restore-btn');

  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'restore me from the history page',
  });

  // The button arrives on the open tab without a reload: the SW pushes
  // `restorableCaptureChanged` from the same storage listener that
  // re-enables the toolbar menu entry.
  await expect(rows).toHaveCount(1);
  await expect(restoreBtn).toHaveCount(1);
  // In the Date cell, under the timestamp.
  await expect(rows.nth(0).locator('.date-cell .restore-btn')).toHaveText('Restore');

  // Now stack a newer row on top — the shape every quick-capture menu
  // entry produces: a log record with no Capture-page session behind
  // it, so nothing promoted and it can't be the restorable one.
  const sw = await getServiceWorker();
  const log = await sw.evaluate(async () => {
    const data = await chrome.storage.local.get('captureLog');
    return (data.captureLog ?? []) as unknown[];
  });
  expect(log).toHaveLength(1);
  await sw.evaluate((existing) => chrome.storage.local.set({
    captureLog: [...existing, {
      timestamp: '2026-06-07T08:09:10.000Z',
      screenshot: { filename: 'screenshot-20260607-080910-000.png' },
      url: 'https://example.com/newer',
      title: 'Newer quick capture',
    }],
  }), log);

  // Newest first, so the quick capture leads — and the button stays
  // put on the row below it rather than following the top of the table.
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('.page-cell .title')).toHaveText('Newer quick capture');
  await expect(restoreBtn).toHaveCount(1);
  await expect(rows.nth(1).locator('.date-cell .restore-btn')).toHaveText('Restore');
  await expect(rows.nth(1).locator('.prompt-box')).toHaveText(
    'restore me from the history page',
  );

  // Clicking it does what the More-submenu entry does: re-opens the
  // Capture page with the state it was closed with.
  const restored = extensionContext.waitForEvent('page', {
    predicate: (p) => p.url().endsWith('/capture.html'),
    timeout: 20000,
  });
  await rows.nth(1).locator('.restore-btn').click();
  const restoredPage = await restored;
  await expect(restoredPage.locator('#prompt-text')).toHaveValue(
    'restore me from the history page',
  );

  // A restore consumes the slot, so the button leaves with it — the
  // page is told, rather than having to be reloaded to find out.
  await expect(restoreBtn).toHaveCount(0);
  await expect(rows).toHaveCount(2);

  await restoredPage.close();
  await historyPage.close();
  await openerPage.close();
});


// ─────────────── "Allow access to file URLs" turned off ───────────────
//
// Chrome refuses every `file://` open from this page when that toggle
// is off, and each refusal lands on the extension's Errors page. The
// page's job is therefore to not *start* those loads — see
// `docs/history-page.md`, "Not starting blocked loads".
//
// The toggle itself can't be flipped from a test (it lives in
// `chrome://extensions` and changing it reloads the extension), and the
// harness runs with it on. So `isAllowedFileSchemeAccess` is overridden
// before `history.ts` reads it. That covers our branch — which is what
// regressed — rather than Chrome's refusal, which is the browser's.
async function blockFileAccess(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(chrome.extension, 'isAllowedFileSchemeAccess', {
      configurable: true,
      value: async () => false,
    });
  });
}

test('with file access off, nothing on the page starts a file:// load', async ({
  extensionContext,
  extensionId,
  fixtureServer,
  getServiceWorker,
}) => {
  // A real capture, so the capture directory resolves and the rows
  // render actual links rather than the no-directory fallback.
  const { capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: true,
    prompt: 'blocked file access',
  });

  const historyPage = await extensionContext.newPage();
  await blockFileAccess(historyPage);
  await openHistory(historyPage, extensionId);
  await expect(historyPage.locator('#rows tr')).toHaveCount(1);

  // The banner explains the whole situation, so it must be up.
  const banner = historyPage.locator('#file-access-hint');
  await expect(banner).toBeVisible();

  // No <img> at all — not a broken one. Pointing it at a URL Chrome
  // won't serve is the single biggest source of console noise, since
  // it needs no user action.
  await expect(historyPage.locator('#rows img.thumb')).toHaveCount(0);
  // The filename shows in its place, inside the surviving link.
  const thumbLink = historyPage.locator('#rows .thumb-link');
  await expect(thumbLink).toHaveCount(1);
  await expect(thumbLink).toContainText('.png');

  // The href stays: right-click → Copy link address is the way out.
  const htmlLink = historyPage.locator('#rows .files-cell a', { hasText: 'HTML' });
  await expect(htmlLink).toHaveAttribute('href', /^file:\/\/.*\.html$/);

  // Clicking navigates nowhere and flashes the banner instead.
  const pagesBefore = extensionContext.pages().length;
  await htmlLink.click();
  await expect(banner).toHaveClass(/flash/);
  expect(extensionContext.pages()).toHaveLength(pagesBefore);
  expect(historyPage.url()).toContain('history.html');

  // Same for the Snapshots directory button, which stays enabled
  // precisely so the click can land and flash.
  const snapshotsBtn = historyPage.locator('#snapshots-dir');
  await expect(snapshotsBtn).toBeEnabled();
  await expect(historyPage.locator('#snapshots-dir-wrap'))
    .toHaveAttribute('title', /Allow access to file URLs/);

  await historyPage.close();
});


// ───────────────────────── Reopen from a row ─────────────────────────
//
// Reopen is the sibling of Restore for every row that isn't the
// restorable one: it reads the record's saved files back off disk and
// opens a Capture page seeded from them. Needs a *real* capture so
// there are real files in a real capture directory to read back.
test('Reopen re-opens an older capture from its saved files', async ({
  extensionContext,
  extensionId,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: true,
    prompt: 'reopen me later',
  });

  const historyPage = await extensionContext.newPage();
  await historyPage.goto(`chrome-extension://${extensionId}/history.html`);
  const rows = historyPage.locator('#rows tr');
  await expect(rows).toHaveCount(1);

  // That row is the restorable one, so it carries Restore, not Reopen —
  // the two are mutually exclusive per row.
  await expect(rows.nth(0).locator('.date-cell .restore-btn')).toHaveText('Restore');
  await expect(historyPage.locator('.reopen-btn')).toHaveCount(0);

  // Consume the slot, which is what turns that row into an ordinary
  // one. Restoring and closing is the honest way to get there: the row
  // keeps its real files, and only the `lastCapture` slot moves.
  const sw = await getServiceWorker();
  await sw.evaluate(() => chrome.storage.session.remove('lastCapture'));
  await expect(historyPage.locator('.restore-btn')).toHaveCount(0);
  await expect(rows.nth(0).locator('.date-cell .reopen-btn')).toHaveText('Reopen');

  // The record we're about to reopen, so we can compare against it.
  const before = await sw.evaluate(async () => {
    const data = await chrome.storage.local.get('captureLog');
    return (data.captureLog ?? []) as { timestamp: string; screenshot?: { filename: string } }[];
  });
  expect(before).toHaveLength(1);

  const reopened = extensionContext.waitForEvent('page', {
    predicate: (p) => p.url().endsWith('/capture.html'),
    timeout: 20000,
  });
  await rows.nth(0).locator('.reopen-btn').click();
  const reopenedPage = await reopened;

  // Seeded from the record: the prompt comes back, and the preview is
  // the saved screenshot rather than a fresh capture of anything.
  await expect(reopenedPage.locator('#prompt-text')).toHaveValue('reopen me later');
  await expect(reopenedPage.locator('#preview')).toHaveJSProperty('complete', true);
  await expect(reopenedPage.locator('#preview')).not.toHaveJSProperty('naturalWidth', 0);

  // Nothing has been drawn, so there is nothing to undo — the whole
  // point of Reopen versus Restore.
  await expect(reopenedPage.locator('#undo')).toBeDisabled();

  // Reopening consumes nothing, so the button is still on the row.
  await expect(rows.nth(0).locator('.date-cell .reopen-btn')).toHaveText('Reopen');

  await reopenedPage.close();
  await historyPage.close();
  await openerPage.close();
});


// The two things Reopen has to get right that Restore never faces:
// flags for edits that are already baked into the pixels, and not
// duplicating a file the user never touched.
test('Reopen keeps the baked-in flags and reuses files until they are edited', async ({
  extensionContext,
  extensionId,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  // Draw a box, so the saved PNG carries a highlight and the record
  // says so. That highlight is what has to survive the round trip.
  await dragRect(capturePage, { xPct: 0.3, yPct: 0.3 }, { xPct: 0.6, yPct: 0.6 });
  await configureAndCapture(capturePage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'drawn on',
  });

  const sw = await getServiceWorker();
  const readLog = () => sw.evaluate(async () => {
    const data = await chrome.storage.local.get('captureLog');
    return (data.captureLog ?? []) as {
      timestamp: string;
      prompt?: string;
      screenshot?: { filename: string; hasHighlights?: true };
    }[];
  });
  const original = (await readLog())[0];
  expect(original.screenshot?.hasHighlights).toBe(true);
  // Both tests here need "Allow access to file URLs", which Reopen
  // reads the saved artifacts with. The harness profile has it on; a
  // profile without it would flash the page's banner instead of
  // opening anything.
  const fileSize = async (name: string): Promise<number> => {
    // Resolved through the download record rather than a fixed path:
    // the harness gives each run its own temp downloads directory.
    const path = await sw.evaluate(async (n) => {
      const items = await chrome.downloads.search({});
      const ours = items.filter(
        (i) => i.byExtensionId === chrome.runtime.id && i.filename.endsWith(n),
      );
      return ours.length ? ours[ours.length - 1].filename : null;
    }, name);
    if (!path) throw new Error(`no download record for ${name}`);
    return (await stat(path)).size;
  };
  const originalBytes = await fileSize(original.screenshot!.filename);

  await sw.evaluate(() => chrome.storage.session.remove('lastCapture'));
  const historyPage = await extensionContext.newPage();
  await historyPage.goto(`chrome-extension://${extensionId}/history.html`);
  const rows = historyPage.locator('#rows tr');
  await expect(rows.nth(0).locator('.reopen-btn')).toHaveText('Reopen');

  // ── Reopen and save with nothing changed ──
  const first = extensionContext.waitForEvent('page', {
    predicate: (p) => p.url().endsWith('/capture.html'),
    timeout: 20000,
  });
  await rows.nth(0).locator('.reopen-btn').click();
  const firstPage = await first;
  await expect(firstPage.locator('#prompt-text')).toHaveValue('drawn on');
  await configureAndCapture(firstPage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'reopened, unchanged',
  });

  const afterPlain = await readLog();
  expect(afterPlain).toHaveLength(2);
  const plain = afterPlain[1];
  // A new record with its own timestamp — not an edit of the old one,
  // and not a duplicate of its stamp.
  expect(plain.timestamp).not.toBe(original.timestamp);
  expect(plain.prompt).toBe('reopened, unchanged');
  // The highlight is baked into pixels this session never edited, and
  // the record still says so.
  expect(plain.screenshot?.hasHighlights).toBe(true);
  // Nothing was edited, so it points at the very same file: a reopen
  // to add a prompt must not duplicate a screenshot on disk.
  expect(plain.screenshot?.filename).toBe(original.screenshot?.filename);

  // ── Reopen the *same* row again and draw on it ──
  //
  // The same original record, reopened a second time and independently
  // edited: the case where two reopens must not collide on a filename.
  // It sits at row 1 now, under the row the save above just added
  // (which is the restorable one, so it carries Restore instead).
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('.date-cell .restore-btn')).toHaveText('Restore');
  const second = extensionContext.waitForEvent('page', {
    predicate: (p) => p.url().endsWith('/capture.html'),
    timeout: 20000,
  });
  await rows.nth(1).locator('.reopen-btn').click();
  const secondPage = await second;
  // Wait for the loaded image to decode and lay out: `dragRect` works
  // in percentages of the overlay, which is zero-sized until then.
  await expect(secondPage.locator('#prompt-text')).toHaveValue('drawn on');
  await expect(secondPage.locator('#preview')).toHaveJSProperty('complete', true);
  await expect(secondPage.locator('#preview')).not.toHaveJSProperty('naturalWidth', 0);
  await dragRect(secondPage, { xPct: 0.35, yPct: 0.55 }, { xPct: 0.6, yPct: 0.8 });
  await configureAndCapture(secondPage, {
    saveScreenshot: true,
    saveHtml: false,
    prompt: 'reopened and drawn on again',
  });

  const afterEdit = await readLog();
  expect(afterEdit).toHaveLength(3);
  const edited = afterEdit[2];
  expect(edited.screenshot?.hasHighlights).toBe(true);
  // Edited, so it must NOT overwrite the file the first two records
  // share — the new name comes off this session's own timestamp, which
  // is what keeps two independent reopens of one record apart.
  expect(edited.screenshot?.filename).not.toBe(original.screenshot?.filename);
  // And the shared file is untouched, byte for byte: the unedited
  // reopen re-wrote it with the bytes it loaded, and the edited one
  // went elsewhere. This is the property the reopen economy rests on,
  // and the one an ext-sync or bake regression would break silently.
  expect(await fileSize(original.screenshot!.filename)).toBe(originalBytes);

  await historyPage.close();
  await openerPage.close();
});


// What an old capture *didn't* save is not a failure. A reopened
// record carries at most one selection format and may carry no
// screenshot at all; both cases quiet-grey their rows rather than
// flagging them, the way `htmlUnavailable` always has for HTML.
test('Reopen greys what a capture never saved, without calling it an error', async ({
  extensionContext,
  extensionId,
  fixtureServer,
  getServiceWorker,
}) => {
  // Capture a selection and no screenshot, so the reopened session has
  // both absences to render: no image at all, and exactly one of the
  // three selection formats.
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
    'purple.html',
    seedSelection,
  );
  await capturePage.locator('#cap-screenshot').setChecked(false);
  await capturePage.locator('#cap-selection').setChecked(true);
  await capturePage.locator('#cap-selection-markdown').check();
  await Promise.all([
    capturePage.waitForEvent('close'),
    capturePage.locator('#capture').click(),
  ]);

  const sw = await getServiceWorker();
  await sw.evaluate(() => chrome.storage.session.remove('lastCapture'));
  const historyPage = await extensionContext.newPage();
  await historyPage.goto(`chrome-extension://${extensionId}/history.html`);
  const rows = historyPage.locator('#rows tr');
  await expect(rows.nth(0).locator('.reopen-btn')).toHaveText('Reopen');

  const reopened = extensionContext.waitForEvent('page', {
    predicate: (p) => p.url().endsWith('/capture.html'),
    timeout: 20000,
  });
  await rows.nth(0).locator('.reopen-btn').click();
  const page = await reopened;

  // The format that was saved is live and selected.
  await expect(page.locator('#cap-selection-markdown')).toBeEnabled();
  await expect(page.locator('#cap-selection-markdown')).toBeChecked();

  // The other two were never captured: disabled, but not flagged.
  for (const other of ['html', 'text']) {
    await expect(page.locator(`#cap-selection-${other}`)).toBeDisabled();
    await expect(page.locator(`#row-selection-${other}`)).not.toHaveClass(/has-error/);
  }
  // No screenshot was saved: same deal.
  await expect(page.locator('#cap-screenshot')).toBeDisabled();
  await expect(page.locator('#row-screenshot')).not.toHaveClass(/has-error/);

  await page.close();
  await historyPage.close();
  await openerPage.close();
});
