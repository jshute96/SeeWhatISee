// Annotation transfer clipboard: a private, single-slot side channel
// that carries a Capture page's annotations (drawn edits + applied
// crop) to a *different* Capture page. Backs the More menu's
// "Copy annotations" / "Paste annotations" pair, whose whole point is
// lining up identical crops and highlights across a before/after pair
// of screenshots.
//
// Why a private slot instead of the system clipboard:
//   - Paste has to be disabled (with a reason in its tooltip) *before*
//     the user clicks, and reading the system clipboard needs a user
//     gesture — there's no way to poll it to drive a disabled state.
//   - It doesn't clobber whatever the user actually had copied.
//   - No `clipboardRead` permission, no custom MIME-type negotiation.
//
// There are two slots, written by different gestures and read by
// different menu items:
//
//   - `annotationClipboard` — an explicit "Copy annotations" click.
//   - `lastCaptureAnnotations` — written automatically from every
//     Capture-page close, feeding "Import annotations from last
//     capture". It has to be its own slot rather than a read of
//     `lastCapture.uiState`: opening a Capture page *clears*
//     `lastCapture` for quota relief, so by the time the new page
//     could import from it, it's gone. These payloads are geometry
//     only, so nothing has to be reclaimed to make room for them.
//
// Both live in `chrome.storage.session` alongside `lastCapture`, so
// they share that lifetime (gone on browser restart). Unlike
// `lastCapture` the payloads are a few hundred bytes and never
// participate in quota relief.

export const ANNOTATION_CLIPBOARD_STORAGE_KEY = 'annotationClipboard';
export const LAST_CAPTURE_ANNOTATIONS_STORAGE_KEY = 'lastCaptureAnnotations';

/**
 * Wire format for a set of transferable annotations.
 *
 * Readers must check `v` and reject anything they don't know: the
 * slot outlives an extension update within a browser session, so a
 * page from the new build can find a record written by the old one.
 *
 *   - `edits` — the drawing module's edit stack verbatim. Typed
 *     `unknown[]` here for the same reason `CapturePageUiState` does
 *     it: the `Edit` union lives on the page side and the SW only
 *     ferries the values. Geometry is in *percentages*, and edits
 *     hidden under an unapplied crop are carried too — invisible
 *     now, visible again if that crop is undone on the target. (Edits
 *     outside an *applied* crop are already gone: `remapEditsIntoRegion`
 *     dropped them when the crop was applied on the source page.)
 *   - `viewCropPct` — the applied ("Replace with cropped image")
 *     region in percentages of the *original* capture, or null.
 *   - `source` — pixel size of the original capture these were drawn
 *     against. The target refuses a paste unless its own original
 *     matches exactly; see `annotationTransferBlockReason` on the
 *     page side.
 *   - `label` — capture title / URL, shown in the menu tooltip so the
 *     user can tell what they're about to paste.
 */
export interface AnnotationTransfer {
  v: 1;
  edits: unknown[];
  viewCropPct: { x: number; y: number; w: number; h: number } | null;
  source: { w: number; h: number };
  label?: string;
}

// Mirrored page-side in `src/capture-page/drawing.ts` (with real
// `Edit` types). Bump both together — see the note there.
export const ANNOTATION_TRANSFER_VERSION = 1;

/** Which slot a `getTransferableAnnotations` request reads. */
export type AnnotationTransferSource = 'clipboard' | 'lastCapture';

/**
 * True for a value that's shaped like a transfer payload *and*
 * carries something worth pasting. An empty payload (no edits, no
 * crop) is treated as absent everywhere: pasting it would be a
 * destructive no-op — it would wipe the target's annotations and put
 * nothing in their place.
 */
export function isUsableAnnotationTransfer(
  value: unknown,
): value is AnnotationTransfer {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<AnnotationTransfer>;
  if (p.v !== ANNOTATION_TRANSFER_VERSION) return false;
  if (!Array.isArray(p.edits)) return false;
  if (!isFiniteSize(p.source)) return false;
  if (p.viewCropPct !== null && p.viewCropPct !== undefined
      && !isFiniteRect(p.viewCropPct)) {
    return false;
  }
  return p.edits.length > 0 || !!p.viewCropPct;
}

function isFiniteSize(v: unknown): v is { w: number; h: number } {
  if (!v || typeof v !== 'object') return false;
  const s = v as { w?: unknown; h?: unknown };
  return typeof s.w === 'number' && Number.isFinite(s.w) && s.w > 0
    && typeof s.h === 'number' && Number.isFinite(s.h) && s.h > 0;
}

// A non-finite crop rectangle is worse than a missing one: the paste
// path's `px.w <= 0` bail is false for NaN, so it would sail through
// and hand the canvas a `NaN` width — which coerces to 0 and yields a
// blank "data:," image *after* the page state has been replaced.
// Rejecting the record up front keeps the "nothing mutates unless the
// whole paste can succeed" guarantee intact.
function isFiniteRect(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (['x', 'y', 'w', 'h'] as const).every(
    (k) => typeof r[k] === 'number' && Number.isFinite(r[k]),
  );
}

/** Read the copied annotations, or `undefined` when the slot is
 *  empty or holds something this build can't use. */
export async function getAnnotationClipboard(): Promise<AnnotationTransfer | undefined> {
  const stored = await chrome.storage.session.get(ANNOTATION_CLIPBOARD_STORAGE_KEY);
  const value = stored[ANNOTATION_CLIPBOARD_STORAGE_KEY];
  return isUsableAnnotationTransfer(value) ? value : undefined;
}

/** Write the copied annotations, replacing any prior slot. */
export async function setAnnotationClipboard(
  payload: AnnotationTransfer,
): Promise<void> {
  await chrome.storage.session.set({ [ANNOTATION_CLIPBOARD_STORAGE_KEY]: payload });
}

/** Annotations of the last Capture page that closed, or undefined
 *  when it had none (or predates this field). */
export async function getLastCaptureAnnotations(): Promise<AnnotationTransfer | undefined> {
  const stored = await chrome.storage.session.get(LAST_CAPTURE_ANNOTATIONS_STORAGE_KEY);
  const value = stored[LAST_CAPTURE_ANNOTATIONS_STORAGE_KEY];
  return isUsableAnnotationTransfer(value) ? value : undefined;
}

/**
 * Record (or clear) the last-closed Capture page's annotations from
 * the UI state it pushed. Called on every close path, right where the
 * session is promoted to `lastCapture`.
 *
 * Write-or-clear rather than write-if-present: the menu item says
 * "from last capture", so a last capture that carried no annotations
 * has to leave the item disabled — quietly offering the one before it
 * would paste something the user never saw on the page they're
 * thinking of.
 */
export async function recordLastCaptureAnnotations(
  ui: { edits?: unknown[]; viewCropPct?: unknown; sourceSize?: unknown } | undefined,
  label: string | undefined,
): Promise<void> {
  const payload = {
    v: ANNOTATION_TRANSFER_VERSION,
    edits: ui?.edits ?? [],
    viewCropPct: ui?.viewCropPct ?? null,
    source: ui?.sourceSize,
    label,
  };
  // Never throws. This runs inside the Capture-page close paths,
  // where a rejection would skip the session cleanup and the tab
  // close that follow it — the page would stay open, claiming a save
  // that already landed. Same reasoning (and the same swallow) as
  // `setLastCapture`'s call site in `promoteSessionToLastCapture`.
  try {
    if (isUsableAnnotationTransfer(payload)) {
      await chrome.storage.session.set({
        [LAST_CAPTURE_ANNOTATIONS_STORAGE_KEY]: payload,
      });
    } else {
      await chrome.storage.session.remove(LAST_CAPTURE_ANNOTATIONS_STORAGE_KEY);
    }
  } catch {
    // Quota race — Import just won't offer this capture.
  }
}

/** Resolve whichever slot a page asked for. Both paths return the
 *  same shape, so the page has one applier for the two menu items. */
export async function getTransferableAnnotations(
  source: AnnotationTransferSource,
): Promise<AnnotationTransfer | undefined> {
  return source === 'clipboard'
    ? getAnnotationClipboard()
    : getLastCaptureAnnotations();
}
