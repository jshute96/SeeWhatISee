// Capture-page "a watch script is running" indicator and its Stop
// button — the UI half of `src/capture/watch-status.ts`.
//
// It sits at the right end of `.button-row`, after the Ask buttons,
// and is hidden whenever no watcher is visible. That is the whole
// success story for Stop as well: the watcher exits, the status file
// goes with it, and the block disappears. Nothing is announced —
// stopping something you asked to stop needs no confirmation.
//
// State is re-read on load and whenever the page is brought back to
// the front, not on a timer: a watcher starts or stops in another
// window, and the moment the user looks at this page again is when the
// answer has to be right.

import {
  type WatchStatus,
  readWatchStatus,
  requestWatchStop,
} from '../capture/watch-status.js';

export interface WatchStatusCtx {
  /** `#watch-status` — the label + Stop button wrapper. */
  container: HTMLElement;
  stopBtn: HTMLButtonElement;
  setStatusMessage(text: string, kind: 'ok' | 'error' | 'info'): void;
  /** What the shared status line reads right now. */
  statusText(): string;
  /** Re-fit the image after the row's height may have changed. */
  refit(): void;
}

/** Shortest gap between refreshes, so alt-tabbing doesn't spam reads. */
const REFRESH_THROTTLE_MS = 2_000;

/** How long the watcher gets to notice `watch-stop.json` and exit. */
const STOP_TIMEOUT_MS = 5_000;

/** How often we re-check for the status file while waiting on a stop. */
const STOP_POLL_MS = 250;

const STOP_FAILED_MESSAGE = 'Failed to stop watch script';

export function initWatchStatus(ctx: WatchStatusCtx): void {
  let current: WatchStatus | null = null;
  let lastRefresh = 0;
  let refreshing = false;
  let stopping = false;
  /**
   * Drop our own "Failed to stop" message once the watcher is gone —
   * a stale complaint about something that has since happened would
   * outlive its subject, and the status line has no expiry of its own.
   *
   * The line is shared with the Capture and Ask flows, so the test is
   * what it currently reads, not a flag we set: anything written since
   * is theirs, and stays.
   */
  function clearFailureMessage(): void {
    if (ctx.statusText() !== STOP_FAILED_MESSAGE) return;
    ctx.setStatusMessage('', 'info');
  }

  function show(status: WatchStatus | null): void {
    current = status;
    if (status === null) clearFailureMessage();
    const hidden = status === null;
    if (ctx.container.hidden === hidden) return;
    ctx.container.hidden = hidden;
    // Showing or hiding the block can wrap `.button-row` onto another
    // line, which takes height away from the image below it.
    ctx.refit();
  }

  async function refresh(force = false): Promise<void> {
    // A stop in flight is already polling; a refresh landing in the
    // middle of it would only race its own answer.
    if (refreshing || stopping) return;
    const now = Date.now();
    if (!force && now - lastRefresh < REFRESH_THROTTLE_MS) return;
    lastRefresh = now;
    refreshing = true;
    try {
      show(await readWatchStatus());
    } finally {
      refreshing = false;
    }
  }

  function reportFailure(): void {
    ctx.setStatusMessage(STOP_FAILED_MESSAGE, 'error');
  }

  async function stop(): Promise<void> {
    const target = current;
    if (!target || stopping) return;
    stopping = true;
    ctx.stopBtn.disabled = true;
    try {
      await requestWatchStop(target);
      const deadline = Date.now() + STOP_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
        if ((await readWatchStatus()) === null) {
          show(null);
          return;
        }
      }
      // Either nothing was listening (a watcher killed in a way that
      // left its files behind, its heartbeat not yet stale) or it is
      // wedged. Leave the block up: it still reflects what we can see,
      // and the user can try again or stop it from their agent.
      reportFailure();
    } catch (err) {
      console.info('[SeeWhatISee] watch stop request failed:', err);
      reportFailure();
    } finally {
      stopping = false;
      ctx.stopBtn.disabled = false;
      lastRefresh = Date.now();
    }
  }

  ctx.stopBtn.addEventListener('click', () => { void stop(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh();
  });
  window.addEventListener('focus', () => { void refresh(); });
  void refresh(true);
}
