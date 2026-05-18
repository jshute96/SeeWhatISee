// "Restore last capture" feature: when a Capture-page tab closes
// (manually, via the Capture button, or via the Ask ctrl-click path),
// we snapshot the per-tab `DetailsSession` (plus the page's UI state
// pushed via `pushUiState`) into a single session-storage slot under
// `lastCapture`. The toolbar's More submenu surfaces a
// `Restore last capture` entry that re-opens a Capture page seeded
// from that snapshot — including the in-flight drawing edits + undo
// stack, the prompt text, the Save-checkbox state, the selected
// drawing tool, and the zoom mode.
//
// One slot only. New captures (and quota relief on Capture / Ask)
// freely clear `lastCapture` — the snapshot is best-effort, not
// a durable history.
//
// Stored under a `chrome.storage.session` key (same area the
// per-tab Capture-page sessions live in) so it shares the same
// 10 MiB quota and lifetime: gone on browser restart, just like a
// real Capture-page session would be.

import type { SelectionFormat, InMemoryCapture } from '../capture/types.js';
import {
  type DetailsSession,
  detailsStorageKey,
} from './capture-details.js';

export const LAST_CAPTURE_STORAGE_KEY = 'lastCapture';

/**
 * Subset of `DetailsSession.uiState` that the Capture page pushes
 * over the wire. Best-effort: every field is optional so a push
 * from a page mid-init (or a page that doesn't know about a newer
 * field) lands gracefully.
 *
 * The shapes match the on-page representations one-for-one:
 *   - `edits` / `editHistory` / `nextEditId` / `editVersion`
 *     mirror the drawing module's module-scope state.
 *   - `selectedTool` is the palette button's tool id.
 *   - `zoomMode` is the zoom dropdown's current value.
 *   - `prompt` is the literal textarea value (untrimmed — the user
 *     may want to keep trailing whitespace they were about to edit).
 *   - `saveCheckboxes` snapshot the three toggles + the chosen
 *     selection format radio.
 */
export interface CapturePageUiState {
  prompt?: string;
  saveCheckboxes?: {
    screenshot: boolean;
    html: boolean;
    selection: boolean;
    /** Which `.cap-selection-<fmt>` radio was checked, or `null`
     *  when the master checkbox is unchecked. */
    format: SelectionFormat | null;
  };
  /** Drawing-module state — typed as `unknown[]` here because the
   *  detailed `Edit` / `HistoryOp` types live in
   *  `capture-page/drawing.ts` (the page side); the SW only
   *  forwards them verbatim and doesn't introspect their shape. */
  edits?: unknown[];
  editHistory?: unknown[];
  nextEditId?: number;
  editVersion?: number;
  selectedTool?: string;
  zoomMode?: string;
}

/**
 * On-disk shape of the `lastCapture` session-storage record. The
 * `capture` half is everything the SW needs to rebuild a
 * `DetailsSession` on restore (minus the download caches, which
 * point at on-disk files this session no longer owns).
 *
 *   - `htmlEdited` / `selectionEdited` ride along because they're
 *     sticky flags the user set via the Edit dialogs.
 *   - `saved` / `revisions` / `bases` ride along so a "Capture-button
 *     close → restore → Capture again" round-trip honours the
 *     original multi-capture filename bump. `bases` is the
 *     un-bumped name pinned at original session creation; without
 *     it the new session would treat the already-bumped
 *     `capture.<x>Filename` as its base and produce names like
 *     `…-3-4.png` instead of `…-4.png`.
 *   - `uiState` is the page-side state pushed via `pushUiState`.
 */
export interface LastCaptureRecord {
  capture: InMemoryCapture;
  htmlEdited?: boolean;
  selectionEdited?: Partial<Record<SelectionFormat, boolean>>;
  saved?: DetailsSession['saved'];
  revisions?: DetailsSession['revisions'];
  bases?: DetailsSession['bases'];
  uiState?: CapturePageUiState;
}

/** Read the saved last-capture record, or `undefined` when none. */
export async function getLastCapture(): Promise<LastCaptureRecord | undefined> {
  const stored = await chrome.storage.session.get(LAST_CAPTURE_STORAGE_KEY);
  return stored[LAST_CAPTURE_STORAGE_KEY] as LastCaptureRecord | undefined;
}

/** Write the last-capture record. Replaces any prior slot. */
export async function setLastCapture(record: LastCaptureRecord): Promise<void> {
  await chrome.storage.session.set({ [LAST_CAPTURE_STORAGE_KEY]: record });
}

/** Drop the saved last-capture record, if any. No-op when absent. */
export async function clearLastCapture(): Promise<void> {
  await chrome.storage.session.remove(LAST_CAPTURE_STORAGE_KEY);
}

/**
 * Best-effort: if a saved last-capture exists, drop it and return
 * true so the caller can re-run its quota check. Returns false when
 * there was nothing to free. Used by the Capture-page open and the
 * Ask-send paths to recover from a quota rejection rather than
 * surfacing a "too large" error the user has no way to fix.
 */
export async function clearLastCaptureForQuota(): Promise<boolean> {
  const existing = await getLastCapture();
  if (!existing) return false;
  await clearLastCapture();
  return true;
}

/**
 * Read the per-tab `DetailsSession` at `tabId` and promote it to
 * the `lastCapture` slot. Called from every Capture-page close path
 * (`saveDetails` happy path, the Ask ctrl-click `closeCapturePage`
 * handler, and the `tabs.onRemoved` listener for manual closes).
 *
 * Last-closed wins, unconditionally: the captured screenshot + HTML
 * are the largest, least-reproducible part of the slot, and the
 * user's annotations (prompt, drawings) are recoverable in seconds
 * anyway. So we don't try to second-guess whether a close was
 * "accidental" — any close overwrites the prior slot. Total-capture-
 * failure tabs never get a stored session in the first place
 * (`openCapturePageWithSession` early-returns before `saveDetails`),
 * so the `!session` guard already filters them out.
 *
 * `chrome.storage.session.set` may reject for quota; on failure we
 * swallow rather than re-throwing. Restoring is a *bonus* — the
 * user's real save (when the close came from the Capture button)
 * already landed on disk. Letting a quota miss bubble would surface
 * a confusing "save failed" tooltip on a save that actually succeeded.
 */
export async function promoteSessionToLastCapture(tabId: number): Promise<void> {
  const key = detailsStorageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const session = stored[key] as DetailsSession | undefined;
  if (!session) return;
  const record: LastCaptureRecord = {
    capture: session.capture,
  };
  if (session.htmlEdited) record.htmlEdited = true;
  if (session.selectionEdited) record.selectionEdited = session.selectionEdited;
  if (session.saved) record.saved = session.saved;
  if (session.revisions) record.revisions = session.revisions;
  // Pin the original un-bumped artifact filenames forward: after a
  // save, `capture.<x>Filename` holds the most recent bumped name
  // (e.g. `…-3.png`), and rebuilding `bases` from it on restore
  // would treat that bumped name as the new base — producing
  // `…-3-4.png` on the next save. Carrying `bases` keeps the
  // bump chain rooted in the original session's stem.
  if (session.bases) record.bases = session.bases;
  if (session.uiState) record.uiState = session.uiState;
  try {
    await setLastCapture(record);
  } catch {
    // Quota race — expected best-effort failure; the real save
    // already landed on disk so there's nothing to surface.
  }
}
