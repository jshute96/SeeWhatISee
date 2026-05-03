// Storage layer for the in-page Ask status widget.
//
// See `docs/ask-widget.md` for the full design (per-item walking,
// cross-world bridge, retry/cancel-and-replace semantics).
//
// One record per destination tab. The SW writes the initial record
// (status: 'injecting' with all items 'pending'), mounts the widget,
// then steps back — the widget drives the per-item inject and patches
// the record per-item. The SW awaits the overall status to leave
// 'injecting' before resolving the capture-page request and writing
// the pin.
//
// Records live in `chrome.storage.session` so they're cleared on
// browser restart — `tabId` is only meaningful within a single Chrome
// session anyway. Keying by tabId means re-Asking into the same
// destination overwrites the previous record (the widget shows the
// most recent send only). Closing the destination tab leaves the
// record orphaned in storage; we clean those up on `tabs.onRemoved`.

const KEY_PREFIX = 'askWidget:';

export interface AskWidgetAttachment {
  /** `'image'` payloads are PNG data URLs; `'text'` payloads are raw text. */
  kind: 'image' | 'text';
  mimeType: string;
  filename: string;
  /** Same shape as `AskPayload.attachments[].data`. */
  data: string;
}

export type AskWidgetStatus = 'injecting' | 'success' | 'error';

export type AskWidgetItemStatus =
  | 'pending'
  | 'in_progress'
  | 'success'
  | 'error';

/**
 * One step in the widget's per-item orchestration. The widget walks
 * `items` in order, calling MAIN-world helpers via the postMessage
 * bridge. Each step's outcome is patched back into this record so
 * the UI updates live.
 */
export interface AskWidgetItem {
  /** Step kind. `attachment` rows reference `attachmentIndex`; the
   *  others are singletons per record. */
  kind: 'attachment' | 'prompt' | 'submit';
  /** Index into `attachments` when `kind === 'attachment'`. */
  attachmentIndex?: number;
  /** UI label: "Screenshot" / "HTML" / "Selection (markdown)" /
   *  "Prompt" / "Submit". */
  label: string;
  status: AskWidgetItemStatus;
  /** Filled when `status === 'error'`; surfaced in the row tooltip. */
  error?: string;
}

/**
 * One Ask attempt's worth of state, for the widget. Includes both
 * progress (`status` + per-item `items`) and the original payload so
 * the widget's Content section can offer copy-to-clipboard recovery
 * even after the Capture page closes.
 */
export interface AskWidgetRecord {
  /** Overall flow status. Computed from `items` by the widget after
   *  each per-item update. The SW polls this to know when to release
   *  the capture-page request. */
  status: AskWidgetStatus;
  /** Filled when `status === 'error'`; what to show in the Status section. */
  error?: string;
  /** What the SW called the destination — e.g. "Claude" or "Claude Code". */
  destinationLabel: string;
  /** URL of the page the user captured FROM (not the AI tab). */
  sourceUrl: string;
  /** Title of the source page; falls back to URL upstream when missing. */
  sourceTitle: string;
  attachments: AskWidgetAttachment[];
  promptText: string;
  /** Per-step orchestration state — see `AskWidgetItem`. */
  items: AskWidgetItem[];
  /** True when the user typed a prompt and wants the conversation
   *  to fire on completion. The widget skips the submit step when
   *  any prior item failed regardless. */
  autoSubmit: boolean;
  /** Provider selectors the widget hands to MAIN-world helpers.
   *  Plain data — selector strings only. */
  selectors: AskInjectSelectorsLike;
  /** Monotonic counter incremented on every fresh Ask into the same
   *  tab. Lets the widget orchestrator detect and bail if a re-Ask
   *  lands while a previous run is still walking the items. */
  runId: number;
  /** ms since epoch — last touch by SW or widget. */
  updatedAt: number;
}

/** Mirror of `AskInjectSelectors` from `src/ask-inject.ts`. We don't
 *  import the type here because this module is loaded by the SW and
 *  the inject runtime is a non-module classic script. */
export interface AskInjectSelectorsLike {
  preFileInputClicks?: string[];
  fileInput: string[];
  textInput: string[];
  submitButton: string[];
  attachmentPreview?: string[];
}

function key(tabId: number): string {
  return `${KEY_PREFIX}${tabId}`;
}

/**
 * Promise that resolves once `chrome.storage.session.setAccessLevel`
 * has granted ISOLATED-world content scripts (the in-page widget)
 * read access. Set in `installWidgetStoreCleanup` and awaited by
 * every write — without this, a cold-SW Ask could publish the
 * `injecting` record before the widget is allowed to read it,
 * leaving the user staring at an empty hidden widget until the next
 * `onChanged` event re-triggers a refresh. The cost is ~one promise
 * await on the first write per SW lifetime; subsequent writes hit
 * the already-resolved promise.
 */
let accessLevelReady: Promise<void> = Promise.resolve();

/**
 * Overwrite the entire record for `tabId`. Called once at the start
 * of every Ask send so a re-Ask into the same tab cleanly replaces
 * the prior attempt.
 *
 * Throws on storage failure (notably `QUOTA_BYTES` exceeded for
 * attachment-heavy Asks — `chrome.storage.session` defaults to a
 * 10 MB cap). The SW propagates this as a user-facing error so the
 * capture page reports it immediately, instead of waiting for the
 * widget-completion timeout to surface a generic failure.
 */
export async function writeWidgetRecord(
  tabId: number,
  record: AskWidgetRecord,
): Promise<void> {
  await accessLevelReady;
  await chrome.storage.session.set({ [key(tabId)]: record });
}

/**
 * Patch fields on an existing record (typically just `status` /
 * `error` / `updatedAt`). No-op if there's no record yet — the
 * caller should `writeWidgetRecord` first.
 */
export async function patchWidgetRecord(
  tabId: number,
  patch: Partial<AskWidgetRecord>,
): Promise<void> {
  try {
    await accessLevelReady;
    const got = await chrome.storage.session.get(key(tabId));
    const existing = got[key(tabId)] as AskWidgetRecord | undefined;
    if (!existing) return;
    await chrome.storage.session.set({
      [key(tabId)]: { ...existing, ...patch, updatedAt: Date.now() },
    });
  } catch {
    // See writeWidgetRecord comment.
  }
}

export async function clearWidgetRecord(tabId: number): Promise<void> {
  try {
    await chrome.storage.session.remove(key(tabId));
  } catch {
    // Same as above — best-effort cleanup.
  }
}

/**
 * Tab-removal cleanup. Wire from the SW so a closed destination tab
 * doesn't leave its record sitting in session storage forever (until
 * browser restart). Cheap — one `remove()` per close.
 *
 * Also opens up `chrome.storage.session` to ISOLATED-world content
 * scripts. By default `session` is restricted to "trusted" contexts
 * (the SW and extension pages); the in-page widget runs as a content
 * script and would silently get `{}` from `storage.session.get` and
 * never receive `storage.onChanged` events. Promoting the access
 * level once at SW startup is the supported way to fix that.
 */
export function installWidgetStoreCleanup(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    void clearWidgetRecord(tabId);
  });
  accessLevelReady = chrome.storage.session
    .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
    .catch(() => {
      // Older Chrome (or hardened MV3 profiles) may reject the call.
      // The widget tolerates a null record and just won't render —
      // the rest of Ask still works.
    });
}
