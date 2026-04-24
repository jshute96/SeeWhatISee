import { noSelectionContentMessage } from '../capture.js';
import { getDefaultActionTooltip } from './default-action.js';

// User-visible error reporting for failed captures.
//
// The service worker has no modal-dialog API. We surface failures on
// two `chrome.action` channels so the user can see both *that*
// something failed and *what* failed, without requesting a noisy
// permission like `notifications`:
//   - The icon itself is the glanceable signal: we swap in a
//     pre-rendered "error" variant of each icon size (small red `!`
//     painted in the bottom-right corner) until the *next*
//     successful capture restores the originals. We deliberately
//     avoid `chrome.action.setBadgeText` for error state because
//     Chrome's badge pill is uncomfortably large relative to the
//     icon and there's no API to shrink it; `setIcon` gives us
//     pixel-level control. (The badge *is* used for the countdown
//     timer during delayed captures — see `countdownSleep` in
//     capture.ts — where the large size is actually a plus.)
//   - The tooltip (action title) is the reference channel: hovering
//     the icon shows the default tooltip plus a second line with
//     the last error message, so the user can go back and read
//     *what* failed without digging through the devtools console.
//
// Both calls are fire-and-forget: a follow-on error here shouldn't
// mask the original capture error. Logged to console but not
// re-thrown.
//
// Icon paths (relative to the extension root) for the normal and
// error states. Same three sizes as in the manifest's
// `action.default_icon`; the error variants are committed alongside
// the base icons in `src/icons/` and produced by
// `scripts/generate-error-icons.mjs` (re-run only when the base
// icons change).
const NORMAL_ICON_PATHS = {
  16: 'icons/icon-16.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png',
};
const ERROR_ICON_PATHS = {
  16: 'icons/icon-error-16.png',
  48: 'icons/icon-error-48.png',
  128: 'icons/icon-error-128.png',
};

export async function reportCaptureError(err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  console.warn('[SeeWhatISee] capture failed:', err);
  try {
    await chrome.action.setIcon({ path: ERROR_ICON_PATHS });
  } catch (iconErr) {
    console.warn('[SeeWhatISee] failed to set error icon:', iconErr);
  }
  try {
    // `getDefaultActionTooltip` does the layout (slots ERROR under
    // the app title, brackets the action block with blanks). Chrome's
    // toolbar tooltip honors embedded newlines on macOS / Windows /
    // most Linux DEs.
    await chrome.action.setTitle({ title: await getDefaultActionTooltip(message) });
  } catch (titleErr) {
    console.warn('[SeeWhatISee] failed to set error tooltip:', titleErr);
  }
}

export async function clearCaptureError(): Promise<void> {
  try {
    await chrome.action.setIcon({ path: NORMAL_ICON_PATHS });
  } catch (err) {
    console.warn('[SeeWhatISee] failed to restore normal icon:', err);
  }
  try {
    // Dynamic: reflects the user's currently selected default
    // click action, not a hardcoded manifest string.
    await chrome.action.setTitle({ title: await getDefaultActionTooltip() });
  } catch (err) {
    console.warn('[SeeWhatISee] failed to reset tooltip:', err);
  }
}

/**
 * Run a capture-like action with unified error reporting. A
 * successful run clears any lingering error state (restores the
 * normal icon + default tooltip); a failure swaps in the error
 * icon variant and slots an `ERROR: …` line under the app title in
 * the tooltip.
 * Used by every user-initiated capture path (toolbar click,
 * context-menu entries).
 */
export async function runWithErrorReporting(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    await clearCaptureError();
  } catch (err) {
    await reportCaptureError(err);
  }
}

// Targeted suppression for one specific user-actionable failure.
// Manually poking captureVisible from the SW devtools console (e.g.
// `SeeWhatISee.captureVisible()` while DevTools itself is the focused
// window) makes the active-tab lookup fail; without this handler, that
// rejection bubbles up as unhandled and Chrome promotes it onto the
// chrome://extensions Errors page, looking like an extension bug.
//
// We deliberately match on the error message rather than swallowing
// every unhandled rejection: a blanket catch would also silence
// genuine bugs (failed downloads, storage quota errors, future
// listener bodies that forget their try/catch) — and the Errors page
// is the only async signal most developers have. Anything we don't
// recognize is left alone so it still surfaces.
const SUPPRESSED_UNHANDLED = [
  'No active tab found to capture',
  'Failed to retrieve page contents',
  'No text selected',
  // Per-format "No selection X content" strings — generated from
  // the same helper the throw sites use, so rewording the message
  // in one place can't drift away from the suppression list.
  ...(['html', 'text', 'markdown'] as const).map(noSelectionContentMessage),
];

export function installUnhandledRejectionHandler(): void {
  self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const message = String((event.reason as Error)?.message ?? event.reason);
    if (SUPPRESSED_UNHANDLED.some((s) => message.includes(s))) {
      console.warn('[SeeWhatISee] capture failed:', event.reason);
      event.preventDefault();
    }
  });
}
