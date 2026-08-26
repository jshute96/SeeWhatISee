// Page side of the out-of-sync log prompt: the per-state wording, and
// the service-worker round-trip behind the error page's buttons.
//
// The prompt appears in two flows — the Capture page's save and the
// `?error=` page a blocked context-menu / hotkey capture opens — and
// both render the same situation. The dialog's wording — including the
// per-reason line — lives in capture.html as toggled markup; only the
// path string comes from here.

import { type LogSyncBlockedReason } from './log-reconcile.js';
import { type CaptureRecord } from './types.js';
import { LOG_FILE_NAME, joinCapturePath } from './downloads.js';

/** The state the prompt renders from. */
export interface LogSyncPrompt {
  reason: LogSyncBlockedReason;
  directory?: string;
}

/** Outcome of a Retry / Overwrite click on the error page. */
export type LogSyncWriteResult =
  /** It landed; the prompt can come down. */
  | { kind: 'resolved' }
  /** Still stuck — usually Retry before anything actually changed. */
  | { kind: 'blocked'; prompt: LogSyncPrompt }
  /** The round-trip itself failed (worker asleep, message rejected). */
  | { kind: 'error'; message: string };

/**
 * Ask the service worker to write `record` into the log: `force` is
 * the Overwrite button, without it the Retry button (which runs the
 * normal reconcile again).
 *
 * Never throws — the surface renders the failure in place rather than
 * losing it, and the user can click again.
 */
export async function requestLogSyncWrite(
  record: CaptureRecord,
  force: boolean,
): Promise<LogSyncWriteResult> {
  try {
    const reply = await chrome.runtime.sendMessage<
      unknown,
      { ok?: boolean; blocked?: LogSyncPrompt; error?: string }
    >({ action: 'logSyncWrite', record, force });
    if (reply?.ok) return { kind: 'resolved' };
    if (reply?.blocked) return { kind: 'blocked', prompt: reply.blocked };
    return { kind: 'error', message: reply?.error ?? 'No response from the extension.' };
  } catch (err) {
    // The service worker was asleep, or the message failed.
    console.info('[SeeWhatISee] log sync request failed:', err);
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Open the extension's details page, where "Allow access to file URLs"
 * lives. Chrome refuses a page-initiated navigation to `chrome://`, so
 * a link's `href` is only good for hover and copy-link — the actual
 * open has to go through `chrome.tabs.create`.
 *
 * Opened in a background tab so the page that offered the link (and
 * its prompt) stays in front of the user for the follow-up Retry.
 */
export function openFileAccessSettings(): void {
  void chrome.tabs.create({ url: fileAccessUrl(), active: false });
}

/** The extension's own details page — the toggle's home. */
export function fileAccessUrl(): string {
  return `chrome://extensions/?id=${chrome.runtime.id}`;
}

/**
 * The path shown in the dialog's first line ("Capture records are
 * written in …"), rendered in a code font by the dialog. Falls back to
 * the bare filename when the capture directory isn't known.
 */
export function logSyncPathText(directory?: string): string {
  return directory ? joinCapturePath(directory, LOG_FILE_NAME) : LOG_FILE_NAME;
}

/**
 * Whether a value off the wire is a reason we know how to render.
 *
 * The prompt's state can arrive through a `?logsync=` URL parameter,
 * which is user-editable. Without this check an unknown reason would
 * match none of the dialog's per-reason spans and it would render an
 * empty explanation above live Retry / Overwrite buttons.
 */
export function isLogSyncReason(value: unknown): value is LogSyncBlockedReason {
  return value === 'unknown-file'
    || value === 'size-mismatch'
    || value === 'unreadable'
    || value === 'corrupt-file';
}

