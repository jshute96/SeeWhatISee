// E2E coverage for the Capture-page prompt textarea's auto-grow
// sizing (`autoGrowPrompt`).
//
// Regression: the box flapped between one and two rows as the user
// typed past the wrap boundary, and at one character count stood two
// rows tall around a single row of text. See `docs/capture-page.md`
// § Prompt textarea for the mechanism.
//
// Typing is driven one character at a time — each keystroke fires its
// own `input` event and the committed size is recorded after each — so
// the box crosses the wrap boundary the way the user hit it. The
// assertions carry no pixel or character-count copies; the row height
// and the cap are read from the same computed style the implementation
// reads.

import { test, expect } from '../fixtures/extension';
import { openDetailsFlow } from './details-helpers';

// Heights where the old code reproduced. What makes them special is
// that `fitImage` leaves the page with no vertical slack there, which
// is the precondition for the measurement to raise a page scrollbar —
// the `noSlack` assertion below fails loudly if a layout change ever
// moves them out of that band.
const VIEWPORT_HEIGHTS = [760, 780];

type Sample = {
  len: number;
  box: number;
  client: number;
  content: number;
  slack: number;
  measureWidth: number;
  renderWidth: number;
};

test('prompt textarea grows monotonically and matches its content', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  // 200 keystrokes per viewport, each triggering a full relayout plus
  // `fitImage`, so this needs more room than the suite's usual budget.
  test.setTimeout(90_000);
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  for (const height of VIEWPORT_HEIGHTS) {
    await capturePage.setViewportSize({ width: 1421, height });
    await capturePage.evaluate(() => {
      const ta = document.getElementById('prompt-text') as HTMLTextAreaElement;
      ta.value = '';
      ta.style.height = '';
      ta.style.overflowY = '';
      const w = window as Window & { __samples?: unknown[]; __wired?: boolean };
      w.__samples = [];
      if (!w.__wired) {
        w.__wired = true;
        // Registered after the page's own handler, so it observes the
        // committed size rather than a mid-measurement one.
        ta.addEventListener('input', () => {
          const doc = document.documentElement;
          const renderWidth = ta.getBoundingClientRect().width;
          // `scrollHeight` is clamped up to `clientHeight`, so it can
          // never report content *shorter* than the box — measure the
          // content against an off-page mirror instead, which is what
          // catches a blank row below the text. An absolutely
          // positioned mirror adds nothing to page height, so it can't
          // disturb the layout being measured.
          const cs = getComputedStyle(ta);
          const mirror = document.createElement('div');
          mirror.style.cssText = `position:absolute;visibility:hidden;
            top:0;left:-9999px;white-space:pre-wrap;overflow-wrap:break-word;
            font:${cs.font};line-height:${cs.lineHeight};padding:${cs.padding};
            border:${cs.borderWidth} solid;box-sizing:border-box;
            width:${renderWidth}px;`;
          // A trailing newline needs its own row; a bare textContent
          // would drop it.
          mirror.textContent = ta.value + '​';
          document.body.appendChild(mirror);
          const content = mirror.scrollHeight;
          mirror.remove();

          // What the fix restores: collapsing the box to measure must
          // not change the page's layout width. When it does, the
          // measurement is taken at a width the box will never render
          // at, and the row count comes out wrong.
          const applied = ta.style.height;
          ta.style.height = 'auto';
          const measureWidth = ta.getBoundingClientRect().width;
          ta.style.height = applied;

          w.__samples!.push({
            len: ta.value.length,
            box: ta.getBoundingClientRect().height,
            client: ta.clientHeight,
            content,
            slack: doc.scrollHeight - doc.clientHeight,
            measureWidth,
            renderWidth,
          });
        });
      }
      ta.focus();
    });

    // A single unbroken run wraps at an exact character boundary,
    // which is what walks the box across the wrap point one character
    // at a time.
    await capturePage.keyboard.type('x'.repeat(200), { delay: 0 });

    const samples: Sample[] = await capturePage.evaluate(
      () => (window as Window & { __samples?: Sample[] }).__samples!,
    );
    // Guards against dropped input events silently emptying the run.
    expect(samples.length).toBe(200);

    const { row, cap } = await capturePage.evaluate(() => {
      const cs = getComputedStyle(document.getElementById('prompt-text')!);
      return { row: parseFloat(cs.lineHeight), cap: parseFloat(cs.maxHeight) };
    });
    const at = (s: Sample) => `viewport ${height}px, ${s.len} chars`;

    // The cause. Measuring must not move the layout width.
    const widthShifts = samples.filter(
      (s) => Math.abs(s.measureWidth - s.renderWidth) > 0.5,
    );
    expect(
      widthShifts.map((s) => `${at(s)}: ${s.measureWidth} vs ${s.renderWidth}`),
    ).toEqual([]);

    // The precondition that makes the cause reachable: `fitImage`
    // leaves the page exactly filled. If this fails the viewport
    // heights have drifted and the test is no longer reproducing.
    const withSlack = samples.filter((s) => s.slack !== 0);
    expect(
      withSlack.map((s) => `${at(s)}: ${s.slack}px of page overflow`),
    ).toEqual([]);

    // The symptom. Box vs content, in both directions.
    const mismatched = samples.filter(
      (s) => Math.abs(s.client - s.content) > 1 && s.box < cap,
    );
    expect(
      mismatched.map((s) => `${at(s)}: box ${s.client} vs content ${s.content}`),
    ).toEqual([]);

    // Text is only ever appended, so the box must never shrink.
    const shrinks = samples.filter((s, i) => i > 0 && s.box < samples[i - 1].box);
    expect(shrinks.map(at)).toEqual([]);

    // A box frozen at one row would satisfy "never shrinks" on its own.
    expect(samples[samples.length - 1].box).toBeGreaterThan(samples[0].box);

    // Every growth step is one whole row: a partial-row step means the
    // height came from a truncated `scrollHeight` again, a two-row jump
    // means a step was mis-measured and skipped.
    const badSteps = samples
      .map((s, i) => ({ s, delta: i > 0 ? s.box - samples[i - 1].box : 0 }))
      .filter(({ delta }) => delta !== 0 && Math.abs(delta - row) > 1);
    expect(
      badSteps.map(({ s, delta }) => `${at(s)}: grew ${delta}px, not ${row}px`),
    ).toEqual([]);

    // Past the cap the box stops growing and scrolls its own content.
    const capped = await capturePage.evaluate(() => {
      const ta = document.getElementById('prompt-text') as HTMLTextAreaElement;
      ta.value = 'line\n'.repeat(40);
      ta.dispatchEvent(new Event('input'));
      return {
        height: ta.getBoundingClientRect().height,
        overflowY: getComputedStyle(ta).overflowY,
        scrolls: ta.scrollHeight > ta.clientHeight,
      };
    });
    expect(capped.height).toBeLessThanOrEqual(cap + 1);
    expect(capped.overflowY).toBe('auto');
    expect(capped.scrolls).toBe(true);
  }

  await capturePage.close();
  await openerPage.close();
});
