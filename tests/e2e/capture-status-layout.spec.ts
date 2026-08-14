// E2E coverage for the Capture page's status line (`#ask-status`) and
// the page layout around it. See `docs/capture-page.md` § Status line.
//
// Regression: showing a status message under the Capture button made
// the page a few pixels taller and popped a vertical scrollbar, because
// (a) the slot's `min-height: 1em` was shorter than a rendered line and
// (b) nothing re-fit the image the way `autoGrowPrompt` does when the
// prompt textarea gains a row.
//
// Every step measures two independent things:
//   - `overflow` — how far the document scrolls past the viewport. This
//     is the symptom, and it's the assertion with teeth.
//   - `unused` — how much viewport is left below the page's last block.
//     `fitImage` drives this to 0, which is what makes any growth show
//     up as overflow instead of being quietly absorbed. Asserted at the
//     start so the test fails loudly if a layout change ever leaves the
//     page with spare room and stops reproducing the bug.

import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { openDetailsFlow } from './details-helpers';

// `fitImage` fills whatever height is left over, so the page has no
// spare room at any viewport in this range — but the image must also
// stay taller than the tool-palette column beside it, or shrinking it
// can't give the space back. 900px leaves that headroom; the ~774px
// floor used by `capture-prompt-autogrow.spec.ts` does not.
const VIEWPORT = { width: 1421, height: 900 };

type Layout = {
  overflow: number;
  unused: number;
  statusHeight: number;
  imageHeight: number;
};

async function readLayout(page: Page): Promise<Layout> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const body = getComputedStyle(document.body);
    // `documentElement.scrollHeight` is clamped up to the viewport, so
    // it can only ever report overflow — never spare room. Spare room
    // has to be measured against the bottom of the real content.
    const contentBottom =
      document.body.getBoundingClientRect().bottom + parseFloat(body.marginBottom);
    return {
      overflow: doc.scrollHeight - doc.clientHeight,
      unused: Math.round(window.innerHeight - contentBottom),
      statusHeight: document.getElementById('ask-status')!.offsetHeight,
      imageHeight: document.getElementById('preview')!.getBoundingClientRect()
        .height,
    };
  });
}

// Waits out every re-fit the viewport change kicks off: first for the
// page to observe the new size at all (`setViewportSize` resolves over
// CDP, and the page's `resize` → `fitImage` chain runs later), then for
// the image height to hold still across consecutive samples.
async function waitForStableImage(page: Page, height: number): Promise<void> {
  await page.waitForFunction((h) => window.innerHeight === h, height);
  // Cleared first so a previous call's sample can't satisfy the very
  // first poll of this one.
  await page.evaluate(() => {
    delete (window as Window & { __lastImgH?: number }).__lastImgH;
  });
  await page.waitForFunction(() => {
    const w = window as Window & { __lastImgH?: number };
    const h = document.getElementById('preview')!.getBoundingClientRect().height;
    const stable = w.__lastImgH === h;
    w.__lastImgH = h;
    return stable;
  });
}

async function setStatus(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    (
      window as unknown as {
        __seeState: { setStatusMessage: (s: string, k: string) => void };
      }
    ).__seeState.setStatusMessage(t, 'ok');
  }, text);
}

test('status message never adds a page scrollbar', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await capturePage.setViewportSize(VIEWPORT);
  await capturePage.waitForFunction(
    () => (document.getElementById('preview') as HTMLImageElement)?.complete,
  );
  await waitForStableImage(capturePage, VIEWPORT.height);

  const empty = await readLayout(capturePage);
  // Precondition: the page exactly fills the viewport, so any growth
  // shows up as overflow rather than being swallowed by spare room.
  expect(empty.overflow, 'page overflow with an empty status line').toBe(0);
  expect(empty.unused, 'unused viewport below the page').toBe(0);

  // A one-line message must not move the layout at all — the reserved
  // height already matches a rendered line.
  await setStatus(capturePage, 'Saved.');
  const oneLine = await readLayout(capturePage);
  expect(oneLine.statusHeight).toBe(empty.statusHeight);
  expect(oneLine.overflow, 'page overflow with a one-line status').toBe(0);
  expect(oneLine.imageHeight).toBe(empty.imageHeight);

  // A message long enough to wrap does make the controls column
  // taller; the image has to give the space back. Kept to a few extra
  // rows on purpose: the image can only absorb growth until it hits
  // the tool-palette column's height, and a message long enough to
  // reach that floor would be testing the floor, not the re-fit.
  await setStatus(
    capturePage,
    // Repeated so it wraps regardless of how wide the controls column
    // ends up at this viewport — a realistic one-line error wouldn't.
    ('Could not copy to the clipboard because the document is not focused. ' +
      'Click back into the page and try again. ').repeat(4),
  );
  const wrapped = await readLayout(capturePage);
  expect(wrapped.statusHeight).toBeGreaterThan(empty.statusHeight);
  expect(wrapped.overflow, 'page overflow with a wrapped status').toBe(0);
  // The image gave back exactly what the status line took, so the page
  // still ends flush with the viewport — the re-fit ran, and it ran to
  // completion rather than part-way.
  expect(wrapped.unused, 'unused viewport with a wrapped status').toBe(0);
  expect(empty.imageHeight - wrapped.imageHeight).toBe(
    wrapped.statusHeight - empty.statusHeight,
  );

  // Clearing it gives the space back.
  await setStatus(capturePage, '');
  const cleared = await readLayout(capturePage);
  expect(cleared.statusHeight).toBe(empty.statusHeight);
  expect(cleared.overflow, 'page overflow after clearing the status').toBe(0);
  expect(cleared.imageHeight).toBe(empty.imageHeight);

  await openerPage.close();
});

// The rule's top margin hand-subtracts the invisible things stacked
// above it (the reserved status row, `.right-stack`'s row gap). That
// arithmetic is exact, but it assumes those are the *only* two — add a
// row to the stack, or let the checkbox column outgrow the right stack,
// and the compensation is silently wrong with nothing else to notice.
// This is the assertion that notices.
test('the separator sits centred between the button row and the image', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await capturePage.setViewportSize(VIEWPORT);
  await capturePage.waitForFunction(
    () => (document.getElementById('preview') as HTMLImageElement)?.complete,
  );
  await waitForStableImage(capturePage, VIEWPORT.height);

  const gaps = await capturePage.evaluate(() => {
    const rule = document.querySelector('hr')!.getBoundingClientRect();
    // The last *visible* thing above the rule and the first below it —
    // the empty status slot between them renders nothing.
    const buttons = document.querySelector('.button-row')!.getBoundingClientRect();
    const image = document
      .querySelector('.image-and-highlights')!
      .getBoundingClientRect();
    return { above: rule.top - buttons.bottom, below: image.top - rule.bottom };
  });

  // Equal, and equal to the `--rule-gap` the CSS is aiming for.
  const ruleGap = await capturePage.evaluate(() =>
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--rule-gap'),
    ),
  );
  expect(gaps.above, 'visible gap above the separator').toBe(ruleGap);
  expect(gaps.below, 'visible gap below the separator').toBe(ruleGap);

  await openerPage.close();
});
