import { noSelectionContentMessage } from '../capture/types.js';

// User-visible error reporting for failed captures.
//
// Every toolbar / hotkey / context-menu capture path runs through
// `runWithErrorReporting`. On failure we open a Capture-page tab on
// `?error=<message>` so the page renders its "Capture failed" pane
// — the user lands on a clear, selectable, copy-pasteable surface
// instead of having to notice and hover the toolbar icon.
//
// An earlier design flipped the toolbar icon to a red `!` and
// slotted "ERROR: …" into the toolbar tooltip. Both signals turned
// out to be hard to notice in practice, and the tooltip text wasn't
// selectable so reporting an error required digging through the
// devtools console. The dedicated error page replaces both.
//
// One Capture-page tab per failure — no reuse of an existing
// Capture page even if one is open. A fresh tab adjacent to the
// active source tab keeps the error visually anchored to whatever
// the user just tried to act on, and avoids a stale error stomping
// on a Capture page the user may already be working in.

const ERROR_PAGE_PATH = 'capture.html';

/**
 * Map a raw thrown error to a user-facing string. The throw sites
 * are written for developers — "No active tab found to capture",
 * "Failed to retrieve page contents" — so we translate the
 * common ones into something a non-developer can act on.
 *
 * Anything we don't recognize falls through verbatim. New rewrites
 * should match exactly (or with a tight regex) so a future throw
 * site renaming doesn't silently strip a translation.
 */
export function friendlyErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  // No active tab — typical when the user fires the hotkey while a
  // chrome:// page is focused (activeTab permission can't grant
  // scrape access there) or while devtools is the focused window.
  if (raw === 'No active tab found to capture') {
    return "Couldn't find a tab to capture. Browser-internal and chrome:// pages cannot be captured.";
  }

  // Page-contents scrape returned nothing — restricted URL, crashed
  // tab, sandboxed PDF viewer, etc. We don't enumerate the cases in
  // the user-facing string: the chrome:// rule covers the common
  // hit, and the rest are rare enough that listing them adds noise
  // without adding clarity.
  if (raw === 'Failed to retrieve page contents') {
    return "Couldn't read this page's contents. Browser-internal and chrome:// pages cannot be captured.";
  }

  // User asked for a selection-only action with no text highlighted.
  if (raw === 'No text selected') {
    return 'No text is selected. Highlight some text on the page first, then try again.';
  }

  // No-selection-content variants — match the three-format fan-out
  // produced by `noSelectionContentMessage`. Generated rather than
  // hand-listed so the suppression-list in this file and the throw
  // sites can't drift apart.
  const noContentSet = new Set(
    (['html', 'text', 'markdown'] as const).map(noSelectionContentMessage),
  );
  if (noContentSet.has(raw)) {
    return `${raw} — the selection didn't include anything in this format.`;
  }

  // Copy-last-… entries fired with an empty log.
  if (raw === 'No captures in the log to copy from') {
    return "No captures yet. Save a screenshot or HTML first, then try Copy last.";
  }
  // The sibling `Latest capture has no <kind> to copy` strings (no
  // screenshot / no HTML snapshot / no selection) read fine on
  // their own, so we leave them to the verbatim-passthrough at the
  // bottom rather than dressing them up.

  // chrome.scripting.executeScript on a restricted URL.
  if (/Cannot access contents of the page/.test(raw)) {
    return "Couldn't access this page. Browser-internal and chrome:// pages cannot be captured.";
  }

  // Tab strip is mid-drag — captureVisibleTab refuses while the
  // user is rearranging tabs. Rare but recoverable; tell the user
  // what to do.
  if (/Tabs cannot be edited right now/.test(raw)) {
    return 'Browser is busy (tab drag in progress). Try again in a moment.';
  }

  return raw;
}

/**
 * Open the Capture page on `?error=<encoded message>` so the user
 * sees the failure on a real page they can read and copy from.
 *
 * `opener` is the source tab (the one the user was on when they
 * triggered the action). When provided, the error tab is placed
 * immediately to its right so the visual relationship matches the
 * normal Capture-page flow. When absent (e.g. no active-tab lookup
 * available), Chrome picks the position.
 */
export async function reportCaptureError(
  err: unknown,
  opener?: chrome.tabs.Tab,
): Promise<void> {
  const message = friendlyErrorMessage(err);
  // Always log the original error to the SW console — the friendly
  // string is for the user, but the developer message is what
  // someone debugging will look for. `console.info` because the
  // failure is already handled via the error page.
  console.info('[SeeWhatISee] capture failed:', err);
  const url = `${chrome.runtime.getURL(ERROR_PAGE_PATH)}?error=${encodeURIComponent(message)}`;
  const createProps: chrome.tabs.CreateProperties = { url };
  if (opener?.index !== undefined) createProps.index = opener.index + 1;
  if (opener?.id !== undefined) createProps.openerTabId = opener.id;
  try {
    await chrome.tabs.create(createProps);
  } catch (e) {
    // If even the tab open fails (very rare — manifest restriction,
    // SW shutdown mid-call), we have no surface left. Log and move
    // on; rejecting from here would just be a different kind of
    // unhandled rejection.
    console.warn('[SeeWhatISee] could not open error tab:', e);
  }
}

/**
 * Run a capture-like action with unified error reporting. A
 * successful run is a no-op (nothing to clean up — there's no
 * persistent error icon or tooltip anymore); a failure opens an
 * error Capture page anchored next to the active source tab.
 *
 * Used by every user-initiated capture path (toolbar click,
 * hotkey, context-menu entries). Paths that have their own
 * inline-error surface (saveDetails on the Capture page, Ask flow)
 * deliberately don't go through here — see the comments at those
 * call sites.
 */
export async function runWithErrorReporting(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    // Best-effort active-tab lookup for tab placement. A failure
    // here just means the error tab opens in the default position.
    let opener: chrome.tabs.Tab | undefined;
    try {
      [opener] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    } catch {
      // Ignored — `opener` stays undefined.
    }
    await reportCaptureError(err, opener);
  }
}

// Targeted suppression for one specific user-actionable failure.
// Manually poking captureVisible from the SW devtools console (e.g.
// `SeeWhatISee.captureVisible()` while DevTools itself is the focused
// window) makes the active-tab lookup fail; without this handler, that
// rejection bubbles up as unhandled and Chrome promotes it onto the
// chrome://extensions Errors page, looking like an extension bug.
//
// `preventDefault()` stops the promotion; the log below must stay at
// `console.info` (not `warn`), or it would re-promote the same line
// and defeat the suppression.
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
      console.info('[SeeWhatISee] capture failed:', event.reason);
      event.preventDefault();
    }
  });
}
