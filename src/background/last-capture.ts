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

import type { SelectionFormat } from '../capture/types.js';
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
 *   - `prompt` is the literal textarea value (untrimmed — the user
 *     may want to keep trailing whitespace they were about to edit).
 *   - `saveCheckboxes` snapshot the three toggles + the chosen
 *     selection format radio.
 *
 * Zoom mode is deliberately NOT carried — viewport size, scroll
 * position, and DPR are page-local and not snapshotted, so a
 * restored page that picked an explicit zoom is just as likely to
 * land at "wrong" sizing as a fresh Fit. Defaulting to Fit on
 * restore matches the rest of the unsaved page-local state.
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
}

/**
 * `DetailsSession` keys that must NOT survive into `lastCapture` —
 * the denylist that drives both the on-disk record type and the
 * runtime promote/restore plumbing. Add a key here when a new
 * `DetailsSession` field shouldn't carry across a Restore; leave it
 * off the list and the field flows through automatically.
 *
 *   - `openerTabId` — the originating tab id. The restored capture
 *     finds a fresh opener from the currently active tab; carrying
 *     the old one would re-focus a tab that may be long gone.
 *   - `downloads` — per-artifact download-cache entries
 *     (`{ downloadId, path, editVersion }`). Those `downloadId`s
 *     belong to the original SW lifetime and the cached on-disk
 *     paths may have been moved or deleted; the new session has to
 *     re-materialize files itself.
 */
export const LAST_CAPTURE_EXCLUDED_KEYS = [
  'openerTabId',
  'downloads',
] as const satisfies readonly (keyof DetailsSession)[];

type LastCaptureExcludedKey = typeof LAST_CAPTURE_EXCLUDED_KEYS[number];

/**
 * On-disk shape of the `lastCapture` session-storage record:
 * everything on a `DetailsSession` except `LAST_CAPTURE_EXCLUDED_KEYS`.
 *
 * Derived rather than hand-written so new `DetailsSession` fields
 * default to carrying across a Restore — the failure mode before
 * the denylist refactor was that adding a field to one of three
 * parallel hand-curated lists (`DetailsSession`, `LastCaptureRecord`,
 * `openCapturePageWithSession`'s `restored` arg, `promoteSession…`'s
 * copy loop, `buildSession`'s read) but forgetting another silently
 * dropped the field from the round-trip. The poster child was
 * `bases`: present everywhere except `LastCaptureRecord`, which made
 * post-save Restores write to `…-3-4.png` instead of `…-4.png`
 * because the new session rebuilt `bases` from the already-bumped
 * `capture.<x>Filename`.
 */
export type LastCaptureRecord = Omit<DetailsSession, LastCaptureExcludedKey>;

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
  // Spread the whole session, drop the denylisted keys. Anything
  // not on `LAST_CAPTURE_EXCLUDED_KEYS` flows through automatically,
  // so a new `DetailsSession` field gets carried across Restore by
  // default — you only need to touch this file again if the new
  // field shouldn't be carried.
  const record = { ...session } as Record<string, unknown>;
  for (const k of LAST_CAPTURE_EXCLUDED_KEYS) delete record[k];
  try {
    await setLastCapture(record as unknown as LastCaptureRecord);
  } catch {
    // Quota race — expected best-effort failure; the real save
    // already landed on disk so there's nothing to surface.
  }
}
