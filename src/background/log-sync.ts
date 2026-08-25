// Service-worker side of the out-of-sync log prompt.
//
// Answers the error page's Retry and Overwrite clicks for a capture
// whose `log.json` write was blocked (`LogWriteBlockedError`). The
// record travels with the request — nothing about the failure is
// stored anywhere. See `docs/log-consistency.md`.

import { getLogFileRecord } from '../capture/downloads.js';
import { LogWriteBlockedError } from '../capture/log-reconcile.js';
import { recordCapture } from '../capture/log-store.js';
import { type CaptureRecord } from '../capture/types.js';

/**
 * Ask Chrome to re-check whether our capture files are still there.
 *
 * `DownloadItem.exists` is stale until something prompts a re-check,
 * and `search()` is what prompts it (the refreshed value shows up in
 * later searches). Called on every service-worker load so a `log.json`
 * deletion that happened while the browser was closed is noticed by
 * the next capture's reconcile instead of reading as a stale
 * "still there".
 */
export async function refreshLogFileExistence(): Promise<void> {
  try {
    await getLogFileRecord();
  } catch (err) {
    console.info('[SeeWhatISee] log.json existence re-check failed:', err);
  }
}

export function installLogSyncMessageHandler(): void {
  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object' || !('action' in msg)) return false;
    if ((msg as { action: unknown }).action !== 'logSyncWrite') return false;

    // Retry (`force` absent/false) runs the normal reconcile-and-append
    // again; Overwrite (`force: true`) writes regardless. Either way
    // it is just `recordCapture` on the record the prompt carried.
    const { record, force } = msg as { record?: CaptureRecord; force?: unknown };
    void (async () => {
      try {
        if (!record) throw new Error('logSyncWrite without a record');
        await recordCapture(record, { force: force === true });
        sendResponse({ ok: true });
      } catch (err) {
        if (err instanceof LogWriteBlockedError) {
          // Still stuck — usually Retry before anything actually
          // changed. Report the (possibly updated) reason so the
          // prompt can re-render and stay up.
          sendResponse({ blocked: { reason: err.reason, directory: err.directory } });
          return;
        }
        sendResponse({ error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  });
}
