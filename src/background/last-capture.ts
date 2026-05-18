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
 *   - `saved` / `revisions` ride along so a "Capture-button close
 *     → restore → Capture again" round-trip honours the original
 *     multi-capture filename bump (otherwise the restored session
 *     would write under the same base filename as the original
 *     save and overwrite the on-disk file).
 *   - `uiState` is the page-side state pushed via `pushUiState`.
 */
export interface LastCaptureRecord {
  capture: InMemoryCapture;
  htmlEdited?: boolean;
  selectionEdited?: Partial<Record<SelectionFormat, boolean>>;
  saved?: DetailsSession['saved'];
  revisions?: DetailsSession['revisions'];
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
 * Decide whether `session` carries anything worth promoting to
 * `lastCapture`. Returns false for a session whose user state is
 * indistinguishable from "fresh capture with stored defaults" — so
 * opening a Capture page by accident and closing it immediately
 * doesn't clobber a previously-useful slot.
 *
 * "Worth restoring" means at least one of:
 *   - A non-empty prompt.
 *   - At least one drawing edit committed (boxes / lines /
 *     redactions / crops).
 *   - A sticky Edit-dialog flag (`htmlEdited`, `selectionEdited`).
 *
 * Save-checkbox state alone doesn't qualify — the stored defaults
 * restore that on the next capture, and treating a default-checked
 * box as "worth saving" would erase a real prior slot every time
 * the user pops a Capture page open and shut.
 */
function isWorthPromoting(session: DetailsSession): boolean {
  if (session.htmlEdited) return true;
  if (session.selectionEdited) {
    for (const fmt of Object.keys(session.selectionEdited) as Array<keyof typeof session.selectionEdited>) {
      if (session.selectionEdited[fmt]) return true;
    }
  }
  const ui = session.uiState;
  if (!ui) return false;
  if (ui.prompt && ui.prompt.length > 0) return true;
  if (ui.edits && ui.edits.length > 0) return true;
  return false;
}

/**
 * Read the per-tab `DetailsSession` at `tabId` and, if it carries
 * anything restore-worthy, promote it to the `lastCapture` slot.
 * Called from every Capture-page close path (`saveDetails` happy
 * path, the Ask ctrl-click `closeCapturePage` handler, and the
 * `tabs.onRemoved` listener for manual closes).
 *
 * Skips silently when no session exists (closed a tab the SW never
 * seeded) or when the session has no user state worth restoring
 * (see `isWorthPromoting`) — in both cases an existing slot is
 * preserved rather than overwritten with empty content.
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
  if (!isWorthPromoting(session)) return;
  const record: LastCaptureRecord = {
    capture: session.capture,
  };
  if (session.htmlEdited) record.htmlEdited = true;
  if (session.selectionEdited) record.selectionEdited = session.selectionEdited;
  if (session.saved) record.saved = session.saved;
  if (session.revisions) record.revisions = session.revisions;
  if (session.uiState) record.uiState = session.uiState;
  try {
    await setLastCapture(record);
  } catch {
    // Quota race — expected best-effort failure; the real save
    // already landed on disk so there's nothing to surface.
  }
}
