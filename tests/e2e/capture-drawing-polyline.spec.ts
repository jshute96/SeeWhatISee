// E2E coverage for multi-segment Line and Arrow chains drawn with the
// Polyline / Poly-arrow tools, plus the legacy Ctrl-promote shortcut
// that turns a plain Line / Arrow draw into a chain on mouseup.
//
// Topics:
//   - Chain construction: drag and pure-click segments, segment N
//     anchoring at segment N-1's endpoint regardless of the
//     mousedown location, parallel coverage for the Arrow tool.
//   - Chain termination: Esc, double-click, zero-length click on the
//     chain head, window blur, tool switch, releasing Ctrl mid-drag
//     (Ctrl-promoted entry only), Polyline tool ignoring incidental
//     Ctrl release.
//   - Chain-lifetime edge cases at the image boundary: edge-commit
//     buffer outside the image, scrollbar-gutter clicks (zoomed),
//     palette Save / prompt textarea clicks ending the chain.
//   - Arrow-key fine-adjustment inside an alive chain.
//
// See `capture-drawing-snap.spec.ts` for polyline loop-closing snap,
// and `capture-drawing-resize-nudge.spec.ts` for the visible-pane
// clamp tests that share the zoomed-overflow setup used here.

import { test, expect } from '../fixtures/extension';
import {
  installPageDownloadSpy,
  openDetailsFlow,
  readPageDownloads,
  waitForPageDownloads,
} from './details-helpers';
import {
  readAllLines,
  readEditKinds,
  readPreviewRect,
} from './capture-drawing-helpers';

// ─── Chain construction & termination ────────────────────────────

test('drawing: Polyline tool chains a polyline of Line segments', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Polyline tool: each mouseup commits a segment and re-anchors
  // the chain head at the just-committed endpoint. A second drag
  // commits a segment whose start is segment 1's end — even if the
  // second drag's mousedown is at a different point. Esc finishes
  // the chain.
  await capturePage.locator('#tool-polyline').click();
  const r = await readPreviewRect(capturePage);

  const A = { x: r.x + 100, y: r.y + 100 };
  const B = { x: r.x + 200, y: r.y + 100 };
  const C = { x: r.x + 250, y: r.y + 130 };  // mousedown for segment 2 — ignored
  const D = { x: r.x + 300, y: r.y + 200 };

  // Segment 1: A → B.
  await capturePage.mouse.move(A.x, A.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move((A.x + B.x) / 2, (A.y + B.y) / 2);
  await capturePage.mouse.move(B.x, B.y);
  await capturePage.mouse.up();
  // Segment 2: chain start is B; the second mousedown's location
  // (C) doesn't anchor the segment — only its release point does.
  await capturePage.mouse.move(C.x, C.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move((C.x + D.x) / 2, (C.y + D.y) / 2);
  await capturePage.mouse.move(D.x, D.y);
  await capturePage.mouse.up();
  await capturePage.keyboard.press('Escape');

  const lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(2);
  // Helper: convert percent-space line coords back to viewport
  // CSS px so the assertions read like the input coordinates.
  const toCss = (ln: { x1: number; y1: number; x2: number; y2: number }) => ({
    x1: r.x + (ln.x1 / 100) * r.w,
    y1: r.y + (ln.y1 / 100) * r.h,
    x2: r.x + (ln.x2 / 100) * r.w,
    y2: r.y + (ln.y2 / 100) * r.h,
  });
  const seg1 = toCss(lines[0]!);
  const seg2 = toCss(lines[1]!);
  expect(seg1.x1).toBeCloseTo(A.x, 0);
  expect(seg1.y1).toBeCloseTo(A.y, 0);
  expect(seg1.x2).toBeCloseTo(B.x, 0);
  expect(seg1.y2).toBeCloseTo(B.y, 0);
  expect(seg2.x1).toBeCloseTo(B.x, 0);
  expect(seg2.y1).toBeCloseTo(B.y, 0);
  expect(seg2.x2).toBeCloseTo(D.x, 0);
  expect(seg2.y2).toBeCloseTo(D.y, 0);

  // After Esc, polyline state is gone.
  const polyKind = await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineKind: () => string | null };
    }).__seeState.polylineKind(),
  );
  expect(polyKind).toBeNull();

  await openerPage.close();
});

test('drawing: Polyline tool: click adds a polyline segment from the previous endpoint', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // After the first drag, the chain is alive. A subsequent click
  // (mousedown + mouseup at the same point, no drag) commits a
  // segment from the previous endpoint to the click point. Esc
  // ends the chain.
  await capturePage.locator('#tool-polyline').click();
  const r = await readPreviewRect(capturePage);

  const A = { x: r.x + 80, y: r.y + 80 };
  const B = { x: r.x + 180, y: r.y + 80 };
  const Cclick = { x: r.x + 250, y: r.y + 150 };

  // Segment 1 — drag A → B.
  await capturePage.mouse.move(A.x, A.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move(B.x, B.y);
  await capturePage.mouse.up();
  // Segment 2 — pure click at Cclick. Mousemove first so dragCurrent
  // reaches Cclick before the click commit.
  await capturePage.mouse.move(Cclick.x, Cclick.y);
  await capturePage.mouse.down();
  await capturePage.mouse.up();
  await capturePage.keyboard.press('Escape');

  const lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(2);
  const toCssX = (xPct: number) => r.x + (xPct / 100) * r.w;
  const toCssY = (yPct: number) => r.y + (yPct / 100) * r.h;
  expect(toCssX(lines[1]!.x1)).toBeCloseTo(B.x, 0);
  expect(toCssY(lines[1]!.y1)).toBeCloseTo(B.y, 0);
  expect(toCssX(lines[1]!.x2)).toBeCloseTo(Cclick.x, 0);
  expect(toCssY(lines[1]!.y2)).toBeCloseTo(Cclick.y, 0);

  await openerPage.close();
});

test('drawing: Ctrl-promote: holding Ctrl at mouseup of a Line draw enters polyline', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Line tool + Ctrl held at mouseup promotes the just-committed
  // segment to a polyline chain (legacy power-user shortcut). The
  // chain is then driven by the same state as the dedicated tool,
  // but releasing Ctrl ends it. Two distinct entry paths converge
  // on the same machine.
  await capturePage.locator('#tool-line').click();
  const r = await readPreviewRect(capturePage);

  const A = { x: r.x + 60, y: r.y + 60 };
  const B = { x: r.x + 160, y: r.y + 60 };
  const C = { x: r.x + 220, y: r.y + 200 };
  const D = { x: r.x + 320, y: r.y + 220 };

  // Plain Line draw (mousedown without Ctrl — so it doesn't pan)…
  await capturePage.mouse.move(A.x, A.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move(B.x, B.y);
  // …but Ctrl held by the time mouseup fires.
  await capturePage.keyboard.down('Control');
  await capturePage.mouse.up();

  // Chain is alive and tagged as Ctrl-entered.
  const entryAfterPromote = await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineEntry: () => string | null };
    }).__seeState.polylineEntry(),
  );
  expect(entryAfterPromote).toBe('ctrl');

  // Releasing Ctrl ends the Ctrl-promoted chain immediately.
  await capturePage.keyboard.up('Control');
  const entryAfterRelease = await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineEntry: () => string | null };
    }).__seeState.polylineEntry(),
  );
  expect(entryAfterRelease).toBeNull();

  // A subsequent (no-Ctrl) Line drag: fresh segment from C to D,
  // *not* chained from B.
  await capturePage.mouse.move(C.x, C.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move(D.x, D.y);
  await capturePage.mouse.up();

  const lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(2);
  const toCssX = (xPct: number) => r.x + (xPct / 100) * r.w;
  const toCssY = (yPct: number) => r.y + (yPct / 100) * r.h;
  expect(toCssX(lines[1]!.x1)).toBeCloseTo(C.x, 0);
  expect(toCssY(lines[1]!.y1)).toBeCloseTo(C.y, 0);
  expect(toCssX(lines[1]!.x2)).toBeCloseTo(D.x, 0);
  expect(toCssY(lines[1]!.y2)).toBeCloseTo(D.y, 0);

  await openerPage.close();
});

test('drawing: Polyline tool: Esc finishes the chain', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Esc is the universal "I'm done" gesture for a polyline tool
  // chain. Verify the chain is alive after segment 1's commit,
  // then Esc clears it.
  await capturePage.locator('#tool-polyline').click();
  const r = await readPreviewRect(capturePage);
  await capturePage.mouse.move(r.x + 60, r.y + 60);
  await capturePage.mouse.down();
  await capturePage.mouse.move(r.x + 200, r.y + 60);
  await capturePage.mouse.up();

  const kindAlive = await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineKind: () => string | null };
    }).__seeState.polylineKind(),
  );
  expect(kindAlive).toBe('line');

  await capturePage.keyboard.press('Escape');
  const kindDead = await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineKind: () => string | null };
    }).__seeState.polylineKind(),
  );
  expect(kindDead).toBeNull();

  await openerPage.close();
});

test('drawing: Polyline tool: zero-length click on chain head finishes the chain', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // After segment 1 commits, a click that doesn't move (≤ CLICK_THRESHOLD_PX
  // from the chain head) means "I'm done". Covers both the "click
  // the previous endpoint" and "double-click" patterns — a
  // double-click's first click commits a segment, the second click
  // sits at the same place and ends the chain.
  await capturePage.locator('#tool-polyline').click();
  const r = await readPreviewRect(capturePage);
  const A = { x: r.x + 80, y: r.y + 80 };
  const B = { x: r.x + 220, y: r.y + 80 };

  await capturePage.mouse.move(A.x, A.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move(B.x, B.y);
  await capturePage.mouse.up();
  // Click at B again — zero-length from chain head, ends chain.
  await capturePage.mouse.down();
  await capturePage.mouse.up();

  const lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(1);  // The click-on-head didn't commit a segment.
  const polyKind = await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineKind: () => string | null };
    }).__seeState.polylineKind(),
  );
  expect(polyKind).toBeNull();

  await openerPage.close();
});

test('drawing: Polyline tool: double-click ends the chain after committing the segment', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Double-click after some segments: the first click commits a
  // segment ending at the click point, the second click (same place)
  // is zero-length and ends the chain. Net effect: a segment ending
  // at the double-click position, then exit.
  await capturePage.locator('#tool-polyline').click();
  const r = await readPreviewRect(capturePage);
  const A = { x: r.x + 60, y: r.y + 60 };
  const B = { x: r.x + 200, y: r.y + 60 };
  const C = { x: r.x + 260, y: r.y + 200 };

  await capturePage.mouse.move(A.x, A.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move(B.x, B.y);
  await capturePage.mouse.up();
  // Move to C, then double-click. Playwright's dblclick is two fast
  // mousedown/mouseup pairs at the same location.
  await capturePage.mouse.move(C.x, C.y);
  await capturePage.mouse.down();
  await capturePage.mouse.up();
  await capturePage.mouse.down();
  await capturePage.mouse.up();

  const lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(2);  // A→B and B→C.
  const polyKind = await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineKind: () => string | null };
    }).__seeState.polylineKind(),
  );
  expect(polyKind).toBeNull();

  await openerPage.close();
});

test('drawing: Ctrl-promote works for the Arrow tool too', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Promote path is symmetric for the Arrow tool — selecting Arrow
  // and holding Ctrl at mouseup advances the segment into an arrow
  // chain. Locks down the parallel branch the Line test covers.
  await capturePage.locator('#tool-arrow').click();
  const r = await readPreviewRect(capturePage);
  await capturePage.mouse.move(r.x + 70, r.y + 70);
  await capturePage.mouse.down();
  await capturePage.mouse.move(r.x + 170, r.y + 70);
  await capturePage.keyboard.down('Control');
  await capturePage.mouse.up();
  const state = await capturePage.evaluate(() => {
    const s = (window as unknown as {
      __seeState: {
        polylineKind: () => string | null;
        polylineEntry: () => string | null;
      };
    }).__seeState;
    return { kind: s.polylineKind(), entry: s.polylineEntry() };
  });
  expect(state.kind).toBe('arrow');
  expect(state.entry).toBe('ctrl');
  await capturePage.keyboard.up('Control');

  await openerPage.close();
});

test('drawing: window blur ends an active polyline chain', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Window blur is the defensive cleanup path — if focus leaves the
  // capture page mid-chain (alt-tab, focus another window), the chain
  // must clear so a stuck ghost segment doesn't haunt the next
  // focus-in. Simulated by firing a blur event on the page.
  await capturePage.locator('#tool-polyline').click();
  const r = await readPreviewRect(capturePage);
  await capturePage.mouse.move(r.x + 80, r.y + 80);
  await capturePage.mouse.down();
  await capturePage.mouse.move(r.x + 180, r.y + 80);
  await capturePage.mouse.up();
  // Chain alive.
  expect(await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineKind: () => string | null };
    }).__seeState.polylineKind(),
  )).toBe('line');

  // Dispatch blur — the window listener clears the chain.
  await capturePage.evaluate(() => window.dispatchEvent(new Event('blur')));
  expect(await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineKind: () => string | null };
    }).__seeState.polylineKind(),
  )).toBeNull();

  await openerPage.close();
});

test('drawing: Polyline tool ignores Ctrl release (only Ctrl-promoted chains exit on Ctrl)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // A chain entered via the Polyline tool button is independent of
  // Ctrl — even if the user incidentally taps Ctrl/Cmd between
  // segments, the chain must stay alive. The exit is Esc / click on
  // chain head / tool switch.
  await capturePage.locator('#tool-polyline').click();
  const r = await readPreviewRect(capturePage);
  // Segment 1.
  await capturePage.mouse.move(r.x + 60, r.y + 60);
  await capturePage.mouse.down();
  await capturePage.mouse.move(r.x + 160, r.y + 60);
  await capturePage.mouse.up();

  // Tap Ctrl on and off — must not end the chain.
  await capturePage.keyboard.down('Control');
  await capturePage.keyboard.up('Control');
  const entry = await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineEntry: () => string | null };
    }).__seeState.polylineEntry(),
  );
  expect(entry).toBe('tool');

  await capturePage.keyboard.press('Escape');

  await openerPage.close();
});

test('drawing: Poly-arrow tool chains arrows the same way Polyline chains lines', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Same chain semantics as Polyline, but each commit is an Arrow.
  // Two drags should produce two arrows whose endpoints chain.
  await capturePage.locator('#tool-polyarrow').click();
  const r = await readPreviewRect(capturePage);
  const A = { x: r.x + 90, y: r.y + 90 };
  const B = { x: r.x + 190, y: r.y + 110 };
  const D = { x: r.x + 280, y: r.y + 200 };

  await capturePage.mouse.move(A.x, A.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move(B.x, B.y);
  await capturePage.mouse.up();
  await capturePage.mouse.move(D.x, D.y);
  await capturePage.mouse.down();
  await capturePage.mouse.up();
  await capturePage.keyboard.press('Escape');

  const arrows = await readAllLines(capturePage, 'arrow');
  expect(arrows).toHaveLength(2);
  const kinds = await readEditKinds(capturePage);
  expect(kinds).toEqual(['arrow', 'arrow']);
  const toCssX = (xPct: number) => r.x + (xPct / 100) * r.w;
  const toCssY = (yPct: number) => r.y + (yPct / 100) * r.h;
  // Arrow #2 chains from arrow #1's endpoint.
  expect(toCssX(arrows[1]!.x1)).toBeCloseTo(B.x, 0);
  expect(toCssY(arrows[1]!.y1)).toBeCloseTo(B.y, 0);

  await openerPage.close();
});

test('drawing: arrow keys nudge polyline endpoints — mid-drag and between segments', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Polyline mode keeps `dragStart` non-null between segments, so
  // the arrow-key handler can nudge `dragCurrent` whether or not
  // the mouse button is pressed. Each press = one natural-pixel
  // step; the segment commit uses the *nudged* endpoint, and the
  // next segment continues from that nudged point.
  await capturePage.locator('#tool-polyline').click();
  const r = await readPreviewRect(capturePage);
  const A = { x: r.x + 80, y: r.y + 80 };
  const Bdrag = { x: r.x + 180, y: r.y + 80 };
  const Cphys = { x: r.x + 240, y: r.y + 130 };
  const NUDGE_MID = 4;     // ArrowRight presses while dragging seg 1
  const NUDGE_BETWEEN = 3; // ArrowDown presses while between segments

  // Segment 1: drag A → near B, then nudge right by 4 natural pixels.
  await capturePage.mouse.move(A.x, A.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move(Bdrag.x, Bdrag.y);
  for (let i = 0; i < NUDGE_MID; i++) await capturePage.keyboard.press('ArrowRight');
  await capturePage.mouse.up();
  // Between segments: no mouse held but `dragStart` is alive.
  // ArrowDown nudges `dragCurrent` so segment 2's endpoint shifts
  // even though the OS cursor is at Cphys. Move first so the
  // physical-pointer reset on the previous mouseup doesn't leave
  // us at Bdrag.
  await capturePage.mouse.move(Cphys.x, Cphys.y);
  for (let i = 0; i < NUDGE_BETWEEN; i++) await capturePage.keyboard.press('ArrowDown');
  // Click commits segment 2 from the (nudged) seg-1 endpoint to
  // the (nudged) current synthetic cursor.
  await capturePage.mouse.down();
  await capturePage.mouse.up();
  await capturePage.keyboard.press('Escape');

  const lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(2);
  // Segment 1's endpoint is Bdrag shifted right by NUDGE_MID natural
  // pixels. Compare in natural-pixel space so the assertion is
  // independent of the test viewport's display scale.
  const seg1EndXNat = lines[0]!.x2 * r.natW / 100;
  expect(seg1EndXNat).toBeCloseTo(
    (Bdrag.x - r.x) * r.natW / r.w + NUDGE_MID,
    0,
  );
  // Segment 2 starts where segment 1 ended (chain anchor) — the
  // chain re-anchors to the nudged endpoint, not the physical
  // mouse position at mouseup.
  expect(lines[1]!.x1).toBeCloseTo(lines[0]!.x2, 1);
  expect(lines[1]!.y1).toBeCloseTo(lines[0]!.y2, 1);
  // Segment 2's endpoint is Cphys shifted down by NUDGE_BETWEEN
  // natural pixels. Cphys's CSS-pixel y on the image rect plus the
  // nudge in natural-pixel terms.
  const seg2EndYNat = lines[1]!.y2 * r.natH / 100;
  expect(seg2EndYNat).toBeCloseTo(
    (Cphys.y - r.y) * r.natH / r.h + NUDGE_BETWEEN,
    0,
  );

  await openerPage.close();
});

test('drawing: releasing Ctrl mid-segment-drag commits the segment and ends the chain', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Exercises the keyup handler's *mid-drag* branch — which only
  // fires when `polylineLineKind !== null` AND the chain was entered
  // via Ctrl-promote. Segment 1 must have already committed (with
  // Ctrl held at its mouseup, promoting to a chain) before we
  // release Ctrl during segment 2's drag. The keyup clears
  // `polylineLineKind` but leaves `dragStart` / `dragCurrent` alone
  // so the upcoming mouseup can still commit segment 2; that mouseup
  // then sees `ctrlKey === false` and ends the chain.
  await capturePage.locator('#tool-line').click();
  const r = await readPreviewRect(capturePage);
  const A = { x: r.x + 80, y: r.y + 80 };
  const B = { x: r.x + 200, y: r.y + 80 };
  const Cdown = { x: r.x + 220, y: r.y + 110 };
  const Dup = { x: r.x + 340, y: r.y + 200 };
  const E = { x: r.x + 380, y: r.y + 260 };
  const F = { x: r.x + 460, y: r.y + 300 };

  // Segment 1: plain Line draw A→B, but Ctrl held at mouseup so the
  // segment is promoted to a chain.
  await capturePage.mouse.move(A.x, A.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move(B.x, B.y);
  await capturePage.keyboard.down('Control');
  await capturePage.mouse.up();
  // Chain is alive — verify before continuing.
  const polyKindMid = await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineKind: () => string | null };
    }).__seeState.polylineKind(),
  );
  expect(polyKindMid).toBe('line');

  // Segment 2: Ctrl-drag from Cdown toward Dup. While the mouse is
  // still pressed, release Ctrl — this is the mid-drag keyup case.
  // The polyline state machine should clear `polylineLineKind`
  // immediately but leave `dragStart` / `dragCurrent` alive so
  // mouseup can still commit segment 2 (anchored at the chain's
  // prior endpoint B, not at Cdown).
  await capturePage.mouse.move(Cdown.x, Cdown.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move(Dup.x, Dup.y);
  await capturePage.keyboard.up('Control');
  // Inline assertion — at this moment, `polylineLineKind` should
  // already be null (mid-drag keyup branch), but the in-flight
  // drag is preserved.
  const polyKindAfterKeyup = await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineKind: () => string | null };
    }).__seeState.polylineKind(),
  );
  expect(polyKindAfterKeyup).toBeNull();
  await capturePage.mouse.up();

  // Segment 2 should have committed, anchored at B (chain anchor).
  let lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(2);
  const toCssX = (xPct: number) => r.x + (xPct / 100) * r.w;
  const toCssY = (yPct: number) => r.y + (yPct / 100) * r.h;
  expect(toCssX(lines[1]!.x1)).toBeCloseTo(B.x, 0);
  expect(toCssY(lines[1]!.y1)).toBeCloseTo(B.y, 0);
  expect(toCssX(lines[1]!.x2)).toBeCloseTo(Dup.x, 0);
  expect(toCssY(lines[1]!.y2)).toBeCloseTo(Dup.y, 0);

  // Chain is dead — a subsequent (no-Ctrl) Line drag should
  // commit fresh from E, not chained from Dup.
  await capturePage.mouse.move(E.x, E.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move(F.x, F.y);
  await capturePage.mouse.up();
  lines = await readAllLines(capturePage, 'line');
  expect(lines).toHaveLength(3);
  expect(toCssX(lines[2]!.x1)).toBeCloseTo(E.x, 0);
  expect(toCssY(lines[2]!.y1)).toBeCloseTo(E.y, 0);

  await openerPage.close();
});

test('drawing: switching tools mid-polyline ends the chain', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // After committing the first polyline segment, switching to
  // another tool must clear the chain state so a subsequent draw
  // with the new tool isn't contaminated by the previous chain.
  await capturePage.locator('#tool-polyline').click();
  const r = await readPreviewRect(capturePage);

  await capturePage.mouse.move(r.x + 80, r.y + 80);
  await capturePage.mouse.down();
  await capturePage.mouse.move(r.x + 180, r.y + 80);
  await capturePage.mouse.up();
  // Switch tools — chain should end here.
  await capturePage.locator('#tool-box').click();
  const polyKind = await capturePage.evaluate(() =>
    (window as unknown as {
      __seeState: { polylineKind: () => string | null };
    }).__seeState.polylineKind(),
  );
  expect(polyKind).toBeNull();

  await openerPage.close();
});

// ─── Chain-lifetime at the image boundary ────────────────────────

test('drawing: polyline click in the edge-commit buffer outside the image commits at the edge instead of cancelling', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Commit segment 1 inside the image to make the chain alive.
  await capturePage.locator('#tool-polyline').click();
  const r = await readPreviewRect(capturePage);
  await capturePage.mouse.move(r.x + r.w * 0.2, r.y + r.h * 0.2);
  await capturePage.mouse.down();
  await capturePage.mouse.move(r.x + r.w * 0.4, r.y + r.h * 0.4);
  await capturePage.mouse.up();
  expect(
    await capturePage.evaluate(
      () => (window as unknown as {
        __seeState: { polylineKind: () => string | null };
      }).__seeState.polylineKind(),
    ),
  ).toBe('line');

  // Click 12 px past the image's right edge — inside the 16 px
  // edge-commit buffer, and inside `imageBox` (Fit mode keeps the
  // box wider than the image-wrap, so there's gray space here).
  // The chain should commit a second segment ending at the image's
  // right edge (clamped by `localCoords`) and stay alive.
  const aimX = r.x + r.w + 12;

  await capturePage.mouse.move(aimX, r.y + r.h * 0.4);
  await capturePage.mouse.down();
  await capturePage.mouse.up();

  // Chain is still alive — buffer hits don't cancel.
  expect(
    await capturePage.evaluate(
      () => (window as unknown as {
        __seeState: { polylineKind: () => string | null };
      }).__seeState.polylineKind(),
    ),
  ).toBe('line');
  const lines = await readAllLines(capturePage, 'line');
  // Two committed segments: segment 1, then segment 2 ending at
  // the visible-pane right edge.
  expect(lines).toHaveLength(2);
  // Segment 2's far x must be at the visible-pane right edge —
  // i.e., 100 % of natural width (within a fraction of a percent
  // for the round-trip CSS↔natural conversion).
  expect(lines[1]!.x2).toBeGreaterThan(99);

  await openerPage.close();
});

test('drawing: polyline click on the image-box scrollbar gutter neither commits nor cancels (zoomed)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Zoom in so the image overflows and `imageBox` shows a vertical
  // scrollbar. Then make the chain alive with a single segment.
  await capturePage.evaluate(
    () => (window as unknown as {
      __seeState: { setZoom: (m: number | 'fit') => void };
    }).__seeState.setZoom(2),
  );
  await capturePage.locator('#tool-polyline').click();
  const layout = await capturePage.evaluate(() => {
    const box = document.querySelector('.image-box') as HTMLElement;
    const br = box.getBoundingClientRect();
    return {
      boxLeft: br.left, boxTop: br.top, boxRight: br.right,
      boxBottom: br.bottom,
      // Right scrollbar gutter starts at (boxLeft + clientWidth)
      // and ends at boxRight.
      contentRight: br.left + box.clientWidth,
      contentBottom: br.top + box.clientHeight,
    };
  });
  // Sanity: a scrollbar must actually be present for this test to
  // exercise the carve-out.
  expect(layout.boxRight - layout.contentRight).toBeGreaterThan(2);

  // Commit segment 1 inside the visible image.
  const start = { x: layout.boxLeft + 40, y: layout.boxTop + 40 };
  const end1  = { x: layout.boxLeft + 80, y: layout.boxTop + 80 };
  await capturePage.mouse.move(start.x, start.y);
  await capturePage.mouse.down();
  await capturePage.mouse.move(end1.x, end1.y);
  await capturePage.mouse.up();
  expect(
    await capturePage.evaluate(
      () => (window as unknown as {
        __seeState: { polylineKind: () => string | null };
      }).__seeState.polylineKind(),
    ),
  ).toBe('line');
  const before = (await readAllLines(capturePage, 'line')).length;

  // Click in the middle of the right scrollbar gutter — inside
  // `imageBox`'s bounding rect but past its content area.
  const scrollX = (layout.contentRight + layout.boxRight) / 2;
  const scrollY = layout.boxTop + 40;
  await capturePage.mouse.move(scrollX, scrollY);
  await capturePage.mouse.down();
  await capturePage.mouse.up();

  // Chain unchanged: no segment committed, chain still alive.
  expect(
    await capturePage.evaluate(
      () => (window as unknown as {
        __seeState: { polylineKind: () => string | null };
      }).__seeState.polylineKind(),
    ),
  ).toBe('line');
  const after = (await readAllLines(capturePage, 'line')).length;
  expect(after).toBe(before);

  await openerPage.close();
});

test('drawing: polyline chain ends when clicking the palette Save button (and Save still fires)', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );
  await installPageDownloadSpy(capturePage);

  // Make the chain alive: enter N-Line mode and commit segment 1.
  await capturePage.locator('#tool-polyline').click();
  const r = await readPreviewRect(capturePage);
  await capturePage.mouse.move(r.x + r.w * 0.2, r.y + r.h * 0.2);
  await capturePage.mouse.down();
  await capturePage.mouse.move(r.x + r.w * 0.4, r.y + r.h * 0.4);
  await capturePage.mouse.up();
  const aliveKind = await capturePage.evaluate(
    () => (window as unknown as {
      __seeState: { polylineKind: () => string | null };
    }).__seeState.polylineKind(),
  );
  expect(aliveKind).toBe('line');

  // Click the Save button. Should both (a) end the chain — the
  // document-capture mousedown listener fires first, ends the chain,
  // and doesn't preventDefault — and (b) still trigger the save
  // (the button's click handler runs as if no polyline was in flight).
  await capturePage.locator('#download-image-btn').click();
  await waitForPageDownloads(capturePage, 1);

  const endedKind = await capturePage.evaluate(
    () => (window as unknown as {
      __seeState: { polylineKind: () => string | null };
    }).__seeState.polylineKind(),
  );
  expect(endedKind).toBeNull();
  const dls = await readPageDownloads(capturePage);
  expect(dls).toHaveLength(1);
  expect(dls[0].filename).toBe('screenshot.png');

  await openerPage.close();
});

test('drawing: polyline chain ends when clicking the prompt textarea', async ({
  extensionContext,
  fixtureServer,
  getServiceWorker,
}) => {
  const { openerPage, capturePage } = await openDetailsFlow(
    extensionContext,
    fixtureServer,
    getServiceWorker,
  );

  // Commit segment 1 to make the chain alive.
  await capturePage.locator('#tool-polyline').click();
  const r = await readPreviewRect(capturePage);
  await capturePage.mouse.move(r.x + r.w * 0.2, r.y + r.h * 0.2);
  await capturePage.mouse.down();
  await capturePage.mouse.move(r.x + r.w * 0.4, r.y + r.h * 0.4);
  await capturePage.mouse.up();
  // Sanity: chain is alive before we click outside.
  expect(
    await capturePage.evaluate(
      () => (window as unknown as {
        __seeState: { polylineKind: () => string | null };
      }).__seeState.polylineKind(),
    ),
  ).toBe('line');

  // Click on the prompt textarea — a non-image, non-button click target.
  // Cancels the chain and lets the textarea receive focus normally.
  await capturePage.locator('#prompt-text').click();

  expect(
    await capturePage.evaluate(
      () => (window as unknown as {
        __seeState: { polylineKind: () => string | null };
      }).__seeState.polylineKind(),
    ),
  ).toBeNull();
  // The click should have given the textarea focus — the listener
  // never calls preventDefault, so default click→focus still runs.
  const focusedId = await capturePage.evaluate(
    () => (document.activeElement as HTMLElement | null)?.id ?? null,
  );
  expect(focusedId).toBe('prompt-text');

  await openerPage.close();
});
