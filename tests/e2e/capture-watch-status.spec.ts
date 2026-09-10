// E2E coverage for the Capture page's running-watch-script indicator
// and its Stop button. See `docs/watch-protocol.md`.
//
// The watch script isn't running here — the test plays its part by
// writing and removing `.watch-status.json` in the capture directory,
// which is the whole of what the extension can see. What is real is
// the reading: the page finds the file over `file://` (the harness
// grants file access to a `--load-extension` build), and its Stop
// button writes a real `watch-stop.json` download the script would pick up.

import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../fixtures/extension';
import { findCapturedDownload, openDetailsFlow } from './details-helpers';

/** The status file a live run of a watch session would be publishing. */
function liveStatus(pid: number, session = new Date().toISOString()): string {
  const expires = new Date(Date.now() + 90_000).toISOString();
  return `${JSON.stringify({ sessionStarted: session, pid, expires })}\n`;
}

/**
 * The status file a single-shot loop leaves while the agent works
 * through the capture it was just handed: no run in flight, a long
 * lease, and the `--after` its next run will carry.
 */
function gapStatus(session: string): string {
  const expires = new Date(Date.now() + 300_000).toISOString();
  return `${JSON.stringify({
    sessionStarted: session, pid: null, expires,
    resumeAfter: '2026-08-30T11:59:00.000Z',
  })}\n`;
}

/**
 * Nudge the page into re-reading the status file until the block
 * settles into `visible`.
 *
 * The page re-checks on focus rather than on a timer, and throttles
 * those checks — so a single dispatched event can legitimately be
 * swallowed. Polling the gesture, rather than sleeping out the
 * throttle, keeps the test off a hard-coded interval.
 */
async function waitForWatchBlock(page: Page, visible: boolean): Promise<void> {
  await expect.poll(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    return await page.locator('#watch-status').isVisible();
  }, { timeout: 15_000 }).toBe(visible);
}

test('shows a running watch script, and its Stop button stops it', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  test.setTimeout(90_000);

  // One real capture, purely to learn where captures land on this
  // profile — the page can only look for the status file in the
  // capture directory.
  const first = await openDetailsFlow(extensionContext, fixtureServer, getServiceWorker);
  await Promise.all([
    first.capturePage.waitForEvent('close'),
    first.capturePage.locator('#capture').click(),
  ]);
  const sw = await getServiceWorker();
  const dir = path.dirname(await findCapturedDownload(sw, 'log.json'));
  const statusFile = path.join(dir, '.watch-status.json');
  const SESSION = '2026-08-30T12:00:00.123456Z';
  const stopFile = path.join(dir, 'watch-stop.json');
  fs.rmSync(stopFile, { force: true });

  try {
    const { capturePage } = await openDetailsFlow(
      extensionContext, fixtureServer, getServiceWorker,
    );
    // `openDetailsFlow` clears storage, taking the cached capture
    // directory with it. Put it back rather than making the page
    // rediscover it: this test is about the status file, not about
    // directory discovery.
    await sw.evaluate((d) => chrome.storage.local.set({ captureDirectory: d }), dir);

    // Nothing running: no indicator, and nothing to stop.
    await expect(capturePage.locator('#watch-status')).toBeHidden();

    fs.writeFileSync(statusFile, liveStatus(424242, SESSION));
    await waitForWatchBlock(capturePage, true);
    // The row's tail, after the Ask buttons, with the Stop button
    // grouped inside the box rather than loose in the row.
    const lastChild = capturePage.locator('.button-row > *').last();
    await expect(lastChild).toHaveAttribute('id', 'watch-status');
    await expect(capturePage.locator('#watch-status #watch-stop-btn')).toBeVisible();
    // Both halves explain themselves on hover — the label says what a
    // watcher is, the button what it does.
    await expect(capturePage.locator('.watch-status-label'))
      .toHaveAttribute('title', /see-what-i-see-watch/);
    await expect(capturePage.locator('#watch-stop-btn'))
      .toHaveAttribute('title', /Stop/);
    // Showing the indicator must not have grown the button row.
    expect(await capturePage.evaluate(() => {
      const row = document.querySelector('.button-row') as HTMLElement;
      const box = document.getElementById('watch-status') as HTMLElement;
      const btn = document.getElementById('capture') as HTMLElement;
      return box.offsetHeight - btn.offsetHeight + (row.offsetHeight - btn.offsetHeight);
    })).toBe(0);

    await capturePage.locator('#watch-stop-btn').click();
    // Well inside the page's own 5s stop timeout: if the download were
    // slower than that, the page would already have reported failure
    // and the assertions below would fail for a confusing reason.
    await expect.poll(() => fs.existsSync(stopFile), { timeout: 3_000 }).toBe(true);
    // The request names the session it was aimed at, which is what a
    // run compares against to know the request is its own.
    const request = JSON.parse(fs.readFileSync(stopFile, 'utf8'));
    expect(request.pid).toBe(424242);
    expect(request.sessionStarted).toBe(SESSION);

    // The watcher answering: it clears both files on its way out, and
    // the indicator goes with them — silently, no status message.
    fs.rmSync(statusFile);
    fs.rmSync(stopFile);
    await expect(capturePage.locator('#watch-status')).toBeHidden({ timeout: 10_000 });
    await expect(capturePage.locator('#ask-status')).toHaveText('');

    // A watcher that never answers: the request lands, the status file
    // stays, and the page says so in its usual place.
    fs.writeFileSync(statusFile, liveStatus(424243));
    await waitForWatchBlock(capturePage, true);
    await capturePage.locator('#watch-stop-btn').click();
    await expect(capturePage.locator('#ask-status'))
      .toHaveText('Failed to stop watch script', { timeout: 15_000 });
    await expect(capturePage.locator('#watch-status')).toBeVisible();

    // The complaint doesn't outlive its subject: once the watcher is
    // gone, the status line clears itself.
    fs.rmSync(statusFile);
    fs.rmSync(stopFile, { force: true });
    await waitForWatchBlock(capturePage, false);
    await expect(capturePage.locator('#ask-status')).toHaveText('');

    // A single-shot loop between two captures is still a watch: the
    // indicator stays up with no run in flight, and Stop leaves a
    // request for the next run rather than waiting for an answer
    // nobody is there to give.
    const gapSession = '2026-08-30T11:00:00.123456Z';
    fs.writeFileSync(statusFile, gapStatus(gapSession));
    await waitForWatchBlock(capturePage, true);
    await capturePage.locator('#watch-stop-btn').click();
    await expect.poll(() => fs.existsSync(stopFile), { timeout: 3_000 }).toBe(true);
    expect(JSON.parse(fs.readFileSync(stopFile, 'utf8')).sessionStarted)
      .toBe(gapSession);
    // No "Failed to stop", and the indicator goes at once — the watch
    // is over as far as the user is concerned.
    await expect(capturePage.locator('#watch-status')).toBeHidden({ timeout: 10_000 });
    await expect(capturePage.locator('#ask-status')).toHaveText('');
  } finally {
    fs.rmSync(statusFile, { force: true });
    fs.rmSync(stopFile, { force: true });
  }
});

test('Pause marks the next capture for the watcher to skip', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  test.setTimeout(90_000);

  const first = await openDetailsFlow(extensionContext, fixtureServer, getServiceWorker);
  await Promise.all([
    first.capturePage.waitForEvent('close'),
    first.capturePage.locator('#capture').click(),
  ]);
  const sw = await getServiceWorker();
  const logPath = await findCapturedDownload(sw, 'log.json');
  const dir = path.dirname(logPath);
  const statusFile = path.join(dir, '.watch-status.json');

  /** The record the last save appended to `log.json`. */
  const lastRecord = (): Record<string, unknown> => {
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    return JSON.parse(lines[lines.length - 1]);
  };

  // That save was made with no watcher in sight, so the flag is absent
  // entirely — it is never written as `false`.
  expect('skipInWatcher' in lastRecord()).toBe(false);

  try {
    const { capturePage } = await openDetailsFlow(
      extensionContext, fixtureServer, getServiceWorker,
    );
    await sw.evaluate((d) => chrome.storage.local.set({ captureDirectory: d }), dir);

    fs.writeFileSync(statusFile, liveStatus(424242, '2026-08-30T12:00:00.123456Z'));
    await waitForWatchBlock(capturePage, true);

    const pause = capturePage.locator('#watch-pause-btn');
    const box = capturePage.locator('#watch-status');
    await expect(pause).toHaveAttribute('aria-pressed', 'false');
    await expect(capturePage.locator('.watch-label-running')).toBeVisible();
    await expect(capturePage.locator('.watch-label-paused')).toBeHidden();
    const widthBefore = (await box.boundingBox())!.width;

    await pause.click();
    await expect(pause).toHaveAttribute('aria-pressed', 'true');
    // The label says which of the two states we are in, and swapping it
    // must not move the buttons beside it.
    await expect(capturePage.locator('.watch-label-paused')).toBeVisible();
    await expect(capturePage.locator('.watch-label-running')).toBeHidden();
    expect((await box.boundingBox())!.width).toBeCloseTo(widthBefore, 1);

    // A different watch taking over is still "whoever is watching", so
    // the arming stays: it is about the capture, not about that watcher.
    // The replacement is a server session, whose tooltip differs — that
    // is what shows the page really re-read the file, rather than the
    // assertion passing because nothing happened at all.
    fs.writeFileSync(statusFile, `${JSON.stringify({
      sessionStarted: '2026-08-30T13:00:00.123456Z',
      pid: null,
      kind: 'server',
      expires: new Date(Date.now() + 90_000).toISOString(),
    })}\n`);
    await expect.poll(async () => {
      await capturePage.evaluate(() => window.dispatchEvent(new Event('focus')));
      return await capturePage.locator('.watch-status-label').getAttribute('title');
    }, { timeout: 15_000 }).toContain('MCP server');
    await expect(pause).toHaveAttribute('aria-pressed', 'true');

    // Nothing watching at all does clear it — the box goes away, and
    // armed state behind a hidden box is state the user can't cancel.
    fs.rmSync(statusFile);
    await waitForWatchBlock(capturePage, false);
    fs.writeFileSync(statusFile, liveStatus(424245, '2026-08-30T14:00:00.123456Z'));
    await waitForWatchBlock(capturePage, true);
    await expect(pause).toHaveAttribute('aria-pressed', 'false');

    await pause.click();
    await expect(pause).toHaveAttribute('aria-pressed', 'true');
    await Promise.all([
      capturePage.waitForEvent('close'),
      capturePage.locator('#capture').click(),
    ]);

    // The whole point: the record a watcher reads carries the flag.
    await expect.poll(() => lastRecord().skipInWatcher ?? false,
                      { timeout: 10_000 }).toBe(true);
  } finally {
    fs.rmSync(statusFile, { force: true });
  }
});
