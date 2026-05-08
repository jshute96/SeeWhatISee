// Smart wait for the `chrome.tabs.captureVisibleTab` rate limit.
//
// ## What Chrome enforces
// - `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` = 2.
// - A third call within any rolling one-second window throws.
// - The e2e suite hits this constantly: most tests issue exactly one
//   capture, and adjacent tests in the same persistent context land
//   back-to-back.
//
// ## Why this replaces the old `setTimeout(600)` cushion
// - The old fix slept 600 ms before every test unconditionally.
// - That paid the worst-case cost on every test (~30% of wall time
//   for a 10-test spec) — including the first test and any test
//   following a slow one, where the window had already drained.
//
// ## How the replacement works
// - `installCaptureQuotaTracker` patches SW-side
//   `chrome.tabs.captureVisibleTab` to (a) ring the last two
//   successful call timestamps and (b) auto-retry once on the quota
//   error using an exact wait derived from the ring.
// - `waitForCaptureQuota` reads the ring and sleeps the *minimum*
//   needed so a third call won't trip the quota.
// - Rule: with a ring of 2, a new call is safe iff
//   `now - oldest >= 1000` — earlier calls have aged out by the
//   time the ring evicts them.
//
// ## Caveats worth knowing
// - Stamps record the *call* time of a successful capture (matching
//   what Chrome's quota counter tracks). Resolution-time stamping
//   would make the ring lag by capture latency and force avoidable
//   backoff retries.
// - The patch lives on the SW global, so an SW respawn drops the
//   ring. With Chrome's ~30 s idle timeout vs the 1 s rate window
//   this is rare in practice; if it happens, the retry path covers
//   the next call.

import type { Worker } from '@playwright/test';

const CAPTURE_QUOTA_MS = 1000;
// Cushion above the exact ring-derived deadline to absorb clock
// skew between `Date.now()` and Chrome's internal quota timer.
// Applied both to the proactive `waitForCaptureQuota` (only at the
// boundary, so the common 0 ms path stays 0 ms) and the retry path.
const CAPTURE_QUOTA_JITTER_MS = 50;

/**
 * Patch `chrome.tabs.captureVisibleTab` on the SW so that:
 *
 *   - Each successful call pushes `Date.now()` into a ring of size 2
 *     (`globalThis.__seeCapTimes`). `waitForCaptureQuota` reads this.
 *   - Quota-exceeded errors trigger an internal retry computed from
 *     the ring: the older of the last two successful calls is what's
 *     blocking us, so we wait exactly until it slides out of the
 *     1-second window (plus a small jitter cushion). This is the
 *     safety net for cases where the proactive `waitForCaptureQuota`
 *     under-estimated — empirically rare (~1 in 60 capture-heavy
 *     tests in CI) but kept for resilience.
 *
 * Idempotent — guarded by a `__seeCapPatched` sentinel so calling it
 * before every test is cheap and safe.
 */
export async function installCaptureQuotaTracker(sw: Worker): Promise<void> {
  await sw.evaluate(({ quotaMs, jitterMs }) => {
    interface QuotaState {
      __seeCapTimes?: number[];
      __seeCapPatched?: true;
    }
    const g = self as unknown as QuotaState;
    if (g.__seeCapPatched) return;
    g.__seeCapPatched = true;
    g.__seeCapTimes ??= [];

    const orig = chrome.tabs.captureVisibleTab.bind(chrome.tabs);
    // Stamp at call-time, not resolution-time: Chrome's quota counts
    // when the call enters its API, not when it returns. Stamping
    // post-resolution would make the ring lag by the capture latency
    // (~tens to hundreds of ms) and force more backoff retries.
    const stamp = (callTime: number): void => {
      g.__seeCapTimes!.push(callTime);
      // Ring size 2 — the older one is what gates the next call.
      if (g.__seeCapTimes!.length > 2) g.__seeCapTimes!.shift();
    };
    const isQuotaErr = (err: unknown): boolean => {
      const msg = err instanceof Error ? err.message : String(err);
      return msg.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND');
    };

    const patched = async (
      ...args: Parameters<typeof chrome.tabs.captureVisibleTab>
    ): Promise<string> => {
      const callTime = Date.now();
      try {
        const out = await orig(...args);
        stamp(callTime);
        return out;
      } catch (err) {
        if (!isQuotaErr(err)) throw err;
        // A rejected call doesn't count against the quota, so we
        // don't stamp `callTime`. Compute the exact retry wait from
        // the ring: with ring size 2, `times[0]` is the older of the
        // last two successful calls; `times[1]` is by definition
        // still inside the 1 s window, so `times[0]`'s age is what
        // gates the next call. Once `now - times[0] >= quotaMs` the
        // older entry slides out and a third call is safe again.
        // Fall back to a full wait if the ring is somehow empty.
        // The `[capture-quota]` tag is matched by a console hook in
        // `tests/fixtures/extension.ts` so backoff hits show up in
        // the Playwright stdout.
        const times = g.__seeCapTimes!;
        const elapsed = times.length > 0 ? Date.now() - times[0] : 0;
        const wait = Math.max(0, quotaMs - elapsed) + jitterMs;
        console.warn(`[capture-quota] backoff retry, sleeping ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        const retryCallTime = Date.now();
        const out = await orig(...args);
        stamp(retryCallTime);
        return out;
      }
    };
    (chrome.tabs as { captureVisibleTab: typeof chrome.tabs.captureVisibleTab })
      .captureVisibleTab = patched as typeof chrome.tabs.captureVisibleTab;
  }, { quotaMs: CAPTURE_QUOTA_MS, jitterMs: CAPTURE_QUOTA_JITTER_MS });
}

/**
 * Sleep for the minimum time needed so the next
 * `chrome.tabs.captureVisibleTab` call won't trip the per-second
 * quota.
 *
 *   - 0 prior calls (fresh SW or only one in the recent ring): no
 *     sleep — the next call is at most the second within the window.
 *   - 1 prior call in ring: also no sleep — the next is the second.
 *   - 2 prior calls: sleep until the *older* of the two is > 1 s old,
 *     plus a small jitter cushion, so the next call slides it out of
 *     the window even with clock skew between Chrome's internal
 *     timer and `Date.now()`.
 *
 * Requires `installCaptureQuotaTracker` to have been called against
 * the same SW at least once during its lifetime; otherwise the ring
 * is empty and we conservatively sleep nothing (the patched retry is
 * the safety net).
 */
export async function waitForCaptureQuota(sw: Worker): Promise<void> {
  const sleepMs = await sw.evaluate(({ quotaMs, jitterMs }) => {
    interface QuotaState { __seeCapTimes?: number[] }
    const times = (self as unknown as QuotaState).__seeCapTimes ?? [];
    if (times.length < 2) return 0;
    const oldest = times[0];
    const remaining = quotaMs - (Date.now() - oldest);
    // The cushion only applies when we'd otherwise sleep a positive
    // (even tiny) amount — if the window has clearly drained
    // already (`remaining` is comfortably negative) there's no point
    // adding the cushion. The threshold `-jitterMs` keeps us
    // cushioning only the boundary where stamps could be off.
    return remaining > -jitterMs ? Math.max(0, remaining) + jitterMs : 0;
  }, { quotaMs: CAPTURE_QUOTA_MS, jitterMs: CAPTURE_QUOTA_JITTER_MS });
  if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
}
