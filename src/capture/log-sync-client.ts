// Page side of the out-of-sync log prompt: the wording, and the
// service-worker round-trip behind the error page's buttons.
//
// The prompt appears in two places — the Capture page's save flow and
// the `?error=` page a blocked context-menu / hotkey capture opens —
// and both render the same situation, so the wording lives here.
//
// The wording is deliberately plain strings, not markup: each surface
// builds its own DOM.

import { type LogSyncBlockedReason } from './log-reconcile.js';
import { type CaptureRecord } from './types.js';
import { LOG_FILE_NAME } from './downloads.js';

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

/** What we found, in one sentence. */
export function logSyncReasonText(reason: LogSyncBlockedReason): string {
  switch (reason) {
    case 'unknown-file':
      return `A ${LOG_FILE_NAME} already exists in the capture directory, but this
        browser has no record of writing it — so its contents can't be read and
        overwriting it could destroy capture history.`.replace(/\s+/g, ' ');
    case 'size-mismatch':
      return `The ${LOG_FILE_NAME} on disk is a different size than the log this
        extension last wrote, so it may hold captures the browser doesn't
        know about.`.replace(/\s+/g, ' ');
    case 'unreadable':
      return `The ${LOG_FILE_NAME} on disk couldn't be read, so there's no way to
        tell what overwriting it would discard.`.replace(/\s+/g, ' ');
    case 'corrupt-file':
      return `The ${LOG_FILE_NAME} on disk has lines that aren't valid capture
        records. Appending to it means rewriting the whole file, which would
        drop those lines for good.`.replace(/\s+/g, ' ');
  }
}

/**
 * Whether a value off the wire is a reason we know how to render.
 *
 * The prompt's state can arrive through a `?logsync=` URL parameter,
 * which is user-editable. Without this check an unknown reason falls
 * off the end of `logSyncReasonText`'s switch and the dialog renders an
 * empty explanation above live Retry / Overwrite buttons.
 */
export function isLogSyncReason(value: unknown): value is LogSyncBlockedReason {
  return value === 'unknown-file'
    || value === 'size-mismatch'
    || value === 'unreadable'
    || value === 'corrupt-file';
}

/**
 * What the user can do about it. Names the file's directory when we
 * know it — "delete log.json" is only actionable if they can find it.
 *
 * The file-access remedy is dropped for `corrupt-file`, which is the
 * one reason only reachable with that permission already on: telling
 * the user to turn on something they've turned on is worse than saying
 * nothing.
 */
export function logSyncRemedyText(directory?: string, reason?: LogSyncBlockedReason): string {
  const path = directory ? `${directory}/${LOG_FILE_NAME}` : LOG_FILE_NAME;
  const enableAccess = reason === 'corrupt-file'
    ? ''
    : `turn on "Allow access to file URLs" in extension settings and choose Retry,
       so the existing log can be read and appended to; or `;
  return `This capture's files are saved, but it won't be in the capture log
    until this is resolved. To resolve it: ${enableAccess}fix or delete ${path}
    yourself and choose Retry; or choose Overwrite to replace it with the log the
    browser is holding. Cancel skips logging this capture.`.replace(/\s+/g, ' ');
}
