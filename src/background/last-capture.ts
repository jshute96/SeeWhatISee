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
 * `DetailsSession` on restore (minus download caches and multi-
 * capture bump state, which don't carry over).
 *
 *   - `htmlEdited` / `selectionEdited` ride along because they're
 *     sticky flags the user set via the Edit dialogs; they belong
 *     to the *body* state, not the download cache.
 *   - `uiState` is the page-side state pushed via `pushUiState`.
 *     Absent on the very first close, before the page has had a
 *     chance to push anything.
 */
export interface LastCaptureRecord {
  capture: InMemoryCapture;
  htmlEdited?: boolean;
  selectionEdited?: Partial<Record<SelectionFormat, boolean>>;
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
 * the `lastCapture` slot, preserving the page-side UI state pushed
 * via `pushUiState`. Called from every Capture-page close path
 * (`saveDetails` happy path, the Ask ctrl-click `closeCapturePage`
 * handler, and the `tabs.onRemoved` listener for manual closes).
 *
 * No-op when no session exists at `tabId` — the user closed a tab
 * the SW never seeded (bookmark / direct load) or the storage was
 * already dropped by a previous close path.
 *
 * `chrome.storage.session.set` may reject for quota; on failure we
 * swallow the error rather than re-throwing. Restoring the last
 * capture is a *bonus* — the user's real save (when the close came
 * from the Capture button) already landed on disk. Letting a quota
 * miss bubble would surface a confusing "save failed" tooltip on a
 * save that actually succeeded.
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
  if (session.uiState) record.uiState = session.uiState;
  try {
    await setLastCapture(record);
  } catch (err) {
    console.warn('[SeeWhatISee] failed to save last capture:', err);
  }
}
