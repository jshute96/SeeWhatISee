// Tests for the History page (`history.html` / `history.ts`) — the
// table view over the `captureLog` array in `chrome.storage.local`.
//
// The page reads storage directly (no SW round-trip), so the tests
// seed synthetic records through the service worker rather than
// running real captures. That keeps them fast and lets us cover the
// mixed shapes a real log holds — screenshot-only, HTML+selection,
// missing URL/title, long prompt — without orchestrating one capture
// per case.
//
// Not covered here: anything that needs real files on disk. The
// harness never runs a real capture, so there's no `log.json` download
// record for `getCaptureDirectory()` to resolve against — every
// file-backed cell renders its no-directory fallback (bare filename /
// unlinked label), which is what these tests assert. For the same
// reason `chrome.downloads` knows nothing about the seeded filenames,
// so the `(deleted)` markers never fire and the file-access banner
// stays hidden.
//
// The "load older captures" row is out of reach for a second reason:
// Playwright rewrites every download into its own artifacts directory
// under a UUID, so the `history-*.json` archives a real capture writes
// never match the path `getArchiveFilePaths()` looks for. The
// archiving itself is covered by `log-archive.spec.ts` and
// `tests/unit/log-archive.test.mjs`.

import { type Page, type Worker } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { openDetailsFlow } from './details-helpers';

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
