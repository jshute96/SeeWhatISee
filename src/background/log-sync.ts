// Service-worker-load housekeeping for the `log.json` download
// record. See `docs/log-consistency.md`.

import { getLogFileRecord } from '../capture/downloads.js';

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
    // Only the search's side effect is wanted here; release the
    // lookup's `onChanged` watch instead of leaving it registered.
    (await getLogFileRecord()).release();
  } catch (err) {
    console.info('[SeeWhatISee] log.json existence re-check failed:', err);
  }
}
