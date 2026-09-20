// Capture-page half of the out-of-sync log prompt.
//
// A blocked capture saved its files but couldn't write `log.json`
// (`LogWriteBlockedError`), and this dialog asks what to do — right
// then, for that one capture. Nothing is stored behind it: closing the
// dialog abandons the record, and the two buttons act on state the
// dialog itself holds.
//
// Two ways in:
//
//   - A save from this page hits the block. The saveDetails response
//     carries the reason, and Retry / Overwrite simply re-run the same
//     save (`capture-page.ts` passes the callbacks).
//   - A context-menu / hotkey capture hits it. The error page it opens
//     carries the reason *and the record* in its `?logsync=` URL
//     param, and Retry / Overwrite send the record back to the service
//     worker to write. Closing the tab is the Cancel gesture.

import { type CaptureRecord } from '../capture/types.js';
import { type LogSyncBlockedReason } from '../capture/log-reconcile.js';
import { canReadFiles } from '../capture/downloads.js';
import {
  type LogSyncPrompt,
  isLogSyncReason,
  logSyncPathText,
  requestLogSyncWrite,
} from '../capture/log-sync-client.js';
import { wireFileAccessLink } from '../capture/file-access.js';

/** What the dialog's buttons should do, chosen by the caller. */
export interface LogSyncHandlers {
  onRetry: () => void;
  onOverwrite: () => void;
}

let dialog: HTMLDialogElement;
let pathEl: HTMLElement;
/** One hidden <span> per reason; `show` unhides the one that applies. */
let reasonEls: Record<LogSyncBlockedReason, HTMLElement>;
let optionAEl: HTMLElement;
let fixAccessEl: HTMLElement;
let fixFileEl: HTMLElement;
let stepAccessEl: HTMLElement;
let stepFileEl: HTMLElement;
let retryBtn: HTMLButtonElement;
let overwriteBtn: HTMLButtonElement;
let handlers: LogSyncHandlers | null = null;

/**
 * `show` re-arms itself until the page is visible, so it needs a
 * bound: a load path that throws before the reveal would otherwise
 * leave a timer running for the life of the tab.
 */
const SHOW_RETRY_LIMIT = 100; // ~10s at 100ms

/**
 * Open the dialog for `prompt`, with the buttons wired to `h`.
 * Re-renders in place if the dialog is already open (a Retry that
 * came back still blocked, possibly with an updated directory).
 *
 * Async only for the file-access check that shapes option A; callers
 * fire and forget.
 */
export async function showLogSyncDialog(
  prompt: LogSyncPrompt,
  h: LogSyncHandlers,
  attempt = 0,
): Promise<void> {
  handlers = h;
  pathEl.textContent = logSyncPathText(prompt.directory);
  for (const [reason, el] of Object.entries(reasonEls)) {
    el.hidden = reason !== prompt.reason;
  }
  // Option A takes one of three shapes. "Enable file reads" is the
  // advice when the toggle is off, since reading the file resolves
  // every reason but corrupt-file. With the toggle already on that
  // advice would be wrong, so: the corrupt-file reason asks for the
  // file to be fixed, and any other reason (an unreadable file, or a
  // Retry that landed here after the user enabled reads) collapses to
  // the bare Retry button. The rest of the list is static markup.
  const readsOn = await canReadFiles();
  const corrupt = prompt.reason === 'corrupt-file';
  const retryOnly = readsOn && !corrupt;
  // `|| corrupt`: the reason itself proves reads were on when it was
  // computed, so even a failed toggle check (which reads as off)
  // mustn't show "enable reads" beside "fix the file".
  fixAccessEl.hidden = readsOn || corrupt;
  stepAccessEl.hidden = readsOn || corrupt;
  fixFileEl.hidden = !corrupt;
  stepFileEl.hidden = !corrupt;
  optionAEl.classList.toggle('log-sync-retry-only', retryOnly);
  if (dialog.open) return;
  // The page starts `visibility: hidden` until `loadData` finishes.
  // A modal opened before that is invisible but still traps clicks
  // and Esc, so wait for the reveal rather than showing into a blank
  // page. Polling is fine here: this only runs in the rare blocked
  // case, and only until the load resolves (which happens whether it
  // succeeded or threw).
  if (document.body.style.visibility !== 'visible') {
    if (attempt >= SHOW_RETRY_LIMIT) return;
    setTimeout(() => void showLogSyncDialog(prompt, h, attempt + 1), 100);
    return;
  }
  dialog.showModal();
}

export function closeLogSyncDialog(): void {
  if (dialog.open) dialog.close();
}

export function initLogSync(): void {
  dialog = document.getElementById('log-sync-dialog') as HTMLDialogElement;
  pathEl = document.getElementById('log-sync-path') as HTMLElement;
  reasonEls = {
    'unknown-file': document.getElementById('log-sync-reason-unknown-file') as HTMLElement,
    'size-mismatch': document.getElementById('log-sync-reason-size-mismatch') as HTMLElement,
    'unreadable': document.getElementById('log-sync-reason-unreadable') as HTMLElement,
    'corrupt-file': document.getElementById('log-sync-reason-corrupt-file') as HTMLElement,
  };
  optionAEl = document.getElementById('log-sync-option-a') as HTMLElement;
  fixAccessEl = document.getElementById('log-sync-fix-access') as HTMLElement;
  fixFileEl = document.getElementById('log-sync-fix-file') as HTMLElement;
  stepAccessEl = document.getElementById('log-sync-step-access') as HTMLElement;
  stepFileEl = document.getElementById('log-sync-step-file') as HTMLElement;
  retryBtn = document.getElementById('log-sync-retry') as HTMLButtonElement;
  overwriteBtn = document.getElementById('log-sync-overwrite') as HTMLButtonElement;
  const settingsLink = document.getElementById('log-sync-settings') as HTMLAnchorElement;
  const cancelBtn = document.getElementById('log-sync-cancel') as HTMLButtonElement;

  wireFileAccessLink(settingsLink);
  retryBtn.addEventListener('click', () => handlers?.onRetry());
  overwriteBtn.addEventListener('click', () => handlers?.onOverwrite());
  // Cancel (the button or Esc, which closes a modal <dialog>
  // natively) abandons the record: this capture stays out of the log.
  cancelBtn.addEventListener('click', () => dialog.close());

  initFromErrorUrl();
}

/**
 * The `?logsync=` payload a blocked context-menu / hotkey capture
 * rides in on: the record that couldn't be written, plus what to tell
 * the user. Built by `reportCaptureError`.
 */
function initFromErrorUrl(): void {
  const param = new URLSearchParams(window.location.search).get('logsync');
  if (!param) return;
  let payload: LogSyncPrompt & { record?: CaptureRecord };
  try {
    payload = JSON.parse(param) as LogSyncPrompt & { record?: CaptureRecord };
  } catch {
    console.info('[SeeWhatISee] unparseable logsync param ignored');
    return;
  }
  const record = payload.record;
  // The param is user-editable, so the reason is checked against the
  // known set rather than merely for being present: an unrecognized one
  // renders an empty explanation above live Retry / Overwrite buttons.
  if (!isLogSyncReason(payload.reason) || !record) return;
  const reason = payload.reason;

  // Declared up front so `write` can pass them to `showLogSyncDialog`
  // on the re-render instead of reaching back for the module-level
  // `handlers` through a non-null assertion.
  const dialogHandlers = {
    onRetry: () => void write(false),
    onOverwrite: () => void write(true),
  };

  const write = async (force: boolean): Promise<void> => {
    // Close right away: the click's visible feedback is the dialog
    // going down, and it comes back up only if the write is still
    // blocked. Everything else reports through the error page's own
    // message slot, the same place any capture failure shows.
    closeLogSyncDialog();
    const result = await requestLogSyncWrite(record, force);
    if (result.kind === 'resolved') {
      // The capture is fully logged now, so a page saying "Capture
      // failed" has nothing left to say. Close the tab if we can;
      // when Chrome refuses (tab drag in progress, invalidated
      // context), say what happened where the user is looking.
      try {
        const tab = await chrome.tabs.getCurrent();
        if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
      } catch {
        setErrorPaneMessage('Capture log updated. You can close this tab.');
      }
      return;
    }
    if (result.kind === 'blocked') {
      // Usually Retry before anything actually changed. Reopen,
      // re-rendered — the path or reason may have been learned.
      void showLogSyncDialog(result.prompt, dialogHandlers);
      return;
    }
    // The round-trip itself failed. The record is abandoned with the
    // dialog; the user can read why here and capture again.
    setErrorPaneMessage(result.message);
  };

  void showLogSyncDialog({ reason, directory: payload.directory }, dialogHandlers);
}

/**
 * Replace the "Capture failed" pane's message — the error page's usual
 * failure slot. Used only on the `?error=` page, which is the only
 * place `initFromErrorUrl` runs.
 */
function setErrorPaneMessage(text: string): void {
  const el = document.getElementById('capture-failed-message');
  if (el) el.textContent = text;
}
