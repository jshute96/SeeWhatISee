// Capture-page "a watch is running" indicator and its Stop button —
// the UI half of `src/capture/watch-status.ts`.
//
// It sits at the right end of `.button-row`, after the Ask buttons,
// and is hidden whenever no watch is visible. That is the whole
// success story for Stop as well: the session record goes (or the
// request we just wrote makes it read as over), and the block
// disappears. Nothing is announced — stopping something you asked to
// stop needs no confirmation.
//
// Pause sits beside Stop and is a different kind of thing: it doesn't
// touch the watch at all, it marks the captures saved from this page
// (`skipInWatcher`) so the watcher passes them over. It lives here
// because it is armed from this box and is only meaningful while a
// watch is showing.
//
// What is shown is a *session*, which spans the gaps between the runs
// of a single-shot agent loop, so "no run in flight" is not "no
// watch". See `docs/watch-protocol.md`.
//
// State is re-read on load and whenever the page is brought back to
// the front, not on a timer: a watch starts or stops in another
// window, and the moment the user looks at this page again is when the
// answer has to be right.

import {
  type WatchStatus,
  readPublishedSession,
  readWatchStatus,
  requestWatchStop,
} from '../capture/watch-status.js';

export interface WatchStatusCtx {
  /** `#watch-status` — the label + Stop button wrapper. */
  container: HTMLElement;
  stopBtn: HTMLButtonElement;
  pauseBtn: HTMLButtonElement;
  setStatusMessage(text: string, kind: 'ok' | 'error' | 'info'): void;
  /** What the shared status line reads right now. */
  statusText(): string;
  /** Re-fit the image after the row's height may have changed. */
  refit(): void;
}

/** Shortest gap between refreshes, so alt-tabbing doesn't spam reads. */
const REFRESH_THROTTLE_MS = 2_000;

/** How long a *running* watcher gets to notice `watch-stop.json` and exit. */
const STOP_TIMEOUT_MS = 5_000;

/** How often we re-check for the status file while waiting on a stop. */
const STOP_POLL_MS = 250;

const STOP_FAILED_MESSAGE = 'Failed to stop watch script';

export interface WatchStatusHandle {
  /**
   * Whether Pause is armed right now — read by the save path, which
   * stamps `skipInWatcher` on the record it sends to the SW.
   */
  isPaused(): boolean;
}

export function initWatchStatus(ctx: WatchStatusCtx): WatchStatusHandle {
  let current: WatchStatus | null = null;
  let lastRefresh = 0;
  let refreshing = false;
  let stopping = false;
  let paused = false;
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

  /**
   * Arm / disarm Pause. Sticky: it stays on until the user turns it
   * off, or the watch it is showing goes away. That is only visible on
   * a save that keeps the page open (shift-click) — the ordinary
   * Capture closes the tab, and the arming, deliberately unpersisted,
   * goes with it.
   */
  function setPaused(next: boolean): void {
    if (paused === next) return;
    paused = next;
    ctx.pauseBtn.setAttribute('aria-pressed', String(next));
    ctx.container.classList.toggle('is-paused', next);
  }

  function show(status: WatchStatus | null): void {
    // Pause says "skip the next capture", whoever is watching — so a
    // watch being replaced by another doesn't clear it. Nothing
    // watching at all does: the box goes with it, and armed state the
    // user can neither see nor click off is worse than re-arming.
    if (status === null) setPaused(false);
    current = status;
    if (status === null) clearFailureMessage();
    if (status !== null) describeWatcher(status);
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

  /**
   * Say what is watching, from the session's `kind`. The whole tooltip lives
   * here rather than in the markup: half of it varies, and splitting it would
   * leave two copies of the half that doesn't.
   *
   * The second line holds either way — the MCP server's watch prompt has the
   * same name as the slash command.
   */
  function describeWatcher(status: WatchStatus): void {
    const label = ctx.container.querySelector('.watch-status-label');
    if (!(label instanceof HTMLElement)) return;
    const what = status.kind === 'server'
      ? 'An MCP server is collecting new captures as they are saved.'
      : 'A watch script is collecting new captures as they are saved.';
    label.title =
      `${what}\nThese are started with /see-what-i-see-watch in coding agents.`;
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
      // No run in flight: the session is between two iterations of an
      // agent loop, and the request waits on disk for the next one.
      // Nobody can answer within a timeout, and the watch is over as
      // far as the user is concerned, so say so now.
      if (target.pid === null) {
        show(null);
        return;
      }
      const deadline = Date.now() + STOP_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
        // The published record, not `readWatchStatus`: that one now
        // reads our own pending request as "no watch", which would
        // report success the moment we asked for it.
        const published = await readPublishedSession();
        // Gone, replaced, or handed on between runs — the last of
        // those is a click that landed while the run was emitting its
        // capture, and the request is waiting for the next run.
        if (published === null
            || published.pid === null
            || published.sessionStarted !== target.sessionStarted) {
          show(null);
          return;
        }
      }
      // Either nothing was listening (a run killed in a way that left
      // its files behind, its lease not yet expired) or it is wedged.
      // Leave the block up: it still reflects what we can see, and the
      // user can try again or stop it from their agent.
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

  ctx.pauseBtn.addEventListener('click', () => { setPaused(!paused); });
  ctx.stopBtn.addEventListener('click', () => { void stop(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh();
  });
  window.addEventListener('focus', () => { void refresh(); });
  void refresh(true);

  return { isPaused: () => paused };
}
