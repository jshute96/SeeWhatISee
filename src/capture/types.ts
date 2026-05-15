// Wire-format types and constants shared across the capture
// pipeline. Lives in a leaf module (no runtime imports) so the
// sibling submodules under `src/capture/` and consumers in
// `src/background/` can pull types without going through the
// `capture.ts` hub — avoids cycles in the runtime import graph and
// keeps the type contract in one obvious place.

/**
 * A saved file the capture flow wants to surface in `log.json`.
 * Wraps the bare basename (no directory; the downloads root sits
 * elsewhere) with optional metadata flags. Omitted flags carry the
 * "default / not-set" meaning — e.g. `isEdited` absent ≡ unedited
 * — so downstream consumers can ignore fields they don't care
 * about and presence is itself the signal.
 *
 * Used uniformly for artifacts that may be produced either as a
 * raw scrape or as a user-edited body: currently `contents` and
 * `selection`. Future editable artifact kinds should adopt the
 * same shape so the record is symmetrical across kinds.
 */
export interface Artifact {
  /** Bare basename of the file on disk (no directory segment). */
  filename: string;
  /**
   * `true` iff the user replaced the body via the corresponding
   * Edit dialog before the save that produced this record. Omitted
   * when the artifact is the raw scrape.
   */
  isEdited?: true;
}

/**
 * Which serialization format a saved selection file uses. A single
 * capture only ever writes one format (we can't tell which the user
 * wants without asking, and the More menu / Capture page make that
 * choice explicit), so the record carries exactly one of these.
 *
 *   - `'html'`     — raw `innerHTML` of the range, wrapped in `<div>`.
 *   - `'text'`     — `window.getSelection().toString()` — what the
 *                    user sees visually, with line breaks preserved.
 *   - `'markdown'` — HTML fed through `htmlToMarkdown` so nested
 *                    structure (headings, lists, links, tables)
 *                    survives in a reader-friendly form.
 */
export type SelectionFormat = 'html' | 'text' | 'markdown';

/**
 * Record-side selection artifact. Extends `Artifact` with a
 * `format` field so downstream consumers can tell at a glance which
 * bytes the file carries without inferring from the extension.
 */
export interface SelectionArtifact extends Artifact {
  format: SelectionFormat;
}

/**
 * File-extension suffix used for each selection format on disk.
 * Centralized so the filename computation and any downstream
 * validation (e.g. shell scripts) stay in one place.
 */
export const SELECTION_EXTENSIONS: Record<SelectionFormat, string> = {
  html: 'html',
  text: 'txt',
  markdown: 'md',
};

/**
 * Canonical error message for a per-format empty selection body.
 * Every site that throws (`captureSelection`, `downloadSelection`,
 * `ensureSelectionDownloaded`) and the SW's `SUPPRESSED_UNHANDLED`
 * list both go through this helper so wording stays in lock-step —
 * rewording the message at one site without updating the suppress
 * list would otherwise silently leak the failure into the
 * chrome://extensions Errors console.
 */
export function noSelectionContentMessage(format: SelectionFormat): string {
  return `No selection ${format} content`;
}

/**
 * Screenshot record in `log.json`. Same filename-plus-optional-flags
 * shape as `Artifact`, but the flags describe different "things the
 * user did to this PNG" rather than a single "edited" bit —
 * distinct types let new kind-specific flags land without a loose
 * `{ [k: string]: unknown }` fallback.
 *
 * The three edit flags are independent (any combination can appear)
 * and only the ones that apply are emitted — presence is the signal.
 */
export interface ScreenshotArtifact {
  /** Bare basename of the PNG on disk (no directory segment). */
  filename: string;
  /**
   * `true` iff the saved PNG bytes carry red highlights (Box-tool
   * boxes / Line-tool lines) baked in. Redactions and crops are
   * separate kinds and get their own flags below. Downstream
   * consumers treat `hasHighlights: true` as "the user marked
   * specific regions on this image; focus your description on those."
   */
  hasHighlights?: true;
  /**
   * `true` iff the saved PNG bytes carry at least one opaque black
   * redaction rectangle baked in. Downstream consumers should treat
   * these regions as deliberately hidden by the user.
   */
  hasRedactions?: true;
  /**
   * `true` iff the saved PNG was cropped to a user-selected region
   * (the saved bytes cover only that region, not the full capture).
   */
  isCropped?: true;
}

/**
 * Kinds of captured body that the Capture page's Edit dialogs can
 * replace. Imported by both the SW (`background.ts`) for its
 * `updateArtifact` dispatch table and the Capture page
 * (`capture-page.ts`) for the `EDIT_KINDS` catalog — both sides
 * share this single definition so a new kind added in one file
 * can't silently go unhandled on the other.
 *
 * The three `selection*` kinds are independent editable mirrors:
 * the user can edit each selection format separately on the Capture
 * page, but only the format chosen for save ends up in `log.json`.
 */
export type EditableArtifactKind =
  | 'html'
  | 'selectionHtml'
  | 'selectionText'
  | 'selectionMarkdown';

export interface CaptureRecord {
  /** ISO 8601 UTC timestamp, e.g. "2026-04-08T20:30:12.345Z". */
  timestamp: string;
  /**
   * Captured screenshot artifact. Set on the immediate / delayed
   * screenshot paths, and on the "Capture page" path when
   * the user keeps the screenshot. Carries the bare PNG filename
   * plus optional `hasHighlights` / `hasRedactions` / `isCropped`
   * flags (see `ScreenshotArtifact`).
   *
   * The embedded compact timestamp in `filename` is in *local* time
   * (chosen so filenames sort the way the user expects when browsing
   * the directory) — note this differs from `timestamp` above, which
   * is UTC. The two refer to the same instant but will display
   * different dates near local midnight.
   */
  screenshot?: ScreenshotArtifact;
  /**
   * Captured HTML artifact. Set on HTML captures — the "Save HTML
   * contents" menu entry, and the "Capture page" path when
   * the user keeps the HTML. Carries the bare filename (no
   * directory) plus an optional `isEdited: true` flag that appears
   * iff the user saved an edit via the Edit HTML dialog before
   * capture; the flag is omitted on an unedited scrape.
   */
  contents?: Artifact;
  /**
   * Captured selection artifact. Set by either `captureSelection()`
   * (the More → Save selection shortcuts — one per format) or
   * the Capture page flow when the user picked a selection format to
   * save. Carries the bare filename, the chosen `format` (so
   * downstream consumers can dispatch without parsing the
   * extension), and an optional `isEdited: true` flag set when the
   * user edited that format's body via the Edit selection dialog
   * before capture. A single capture only ever writes one selection
   * file — selecting "Save as markdown" excludes the text / HTML
   * versions from the log, even though all three were scraped into
   * memory.
   */
  selection?: SelectionArtifact;
  /**
   * User-entered prompt text from the "Capture page" flow,
   * trimmed. Omitted entirely when empty so the field's presence
   * implies there is something to act on.
   */
  prompt?: string;
  /**
   * URL of the captured tab. Empty string is treated as "unavailable"
   * — `serializeRecord` omits the field from `log.json` rather than
   * writing `"url": ""`. Write paths always assign a string (possibly
   * empty); presence in the JSON output therefore implies a known URL.
   */
  url: string;
  /**
   * URL of the source image when the capture came from the
   * image-context right-click flow (Save screenshot / Capture... on
   * a right-clicked `<img>`). Carried independently from the
   * `screenshot` artifact so downstream consumers can resolve the
   * original image even if the user unchecked Save Screenshot in
   * the Capture page (or the bytes are no longer on disk). Omitted
   * for tab-screenshot captures — `serializeRecord` only emits the
   * field when present.
   */
  imageUrl?: string;
  /**
   * Title of the captured tab (`chrome.tabs.Tab.title`). Same omit-
   * when-empty contract as `url` — `serializeRecord` skips the field
   * when the value is empty so an absent title doesn't appear as
   * `"title": ""` in `log.json`.
   */
  title: string;
}

export interface CaptureResult extends CaptureRecord {
  /**
   * Bare filename of the content file (PNG or HTML) written by this
   * specific capture. Denormalized copy of whichever of `screenshot`
   * / `contents` the underlying save path set — callers that don't
   * need to care which kind of capture ran can read this directly.
   * The detailed-capture path (which may write both files) doesn't
   * return a CaptureResult, so there's never ambiguity here.
   */
  filename: string;
  /** Download id of the content file (PNG or HTML). */
  downloadId: number;
  /**
   * Download id of the JSON sidecar (log.json) written alongside the
   * content file. Production callers (toolbar / context menu) ignore
   * this; it's primarily there so e2e tests can resolve the sidecar
   * to its on-disk path via chrome.downloads.search.
   */
  sidecarDownloadIds: {
    log: number;
  };
}

/**
 * Shape returned from the page-side selection scrape. All three
 * formats are computed in one `executeScript` round-trip so the
 * More-menu selection-format shortcuts and the Capture page flow share
 * the same scraped view of the page.
 *
 *   - `html`     — `innerHTML` of the selected range fragment, used
 *                  as the source of truth for the other two formats
 *                  and as the "Save selection as HTML" payload.
 *   - `text`     — `window.getSelection().toString()`, which matches
 *                  what the user visually sees selected (respects
 *                  line breaks in block elements).
 *   - `markdown` — produced by `selectionMarkdownBody(html, text,
 *                  pageUrl)` in the SW after the scrape returns
 *                  (keeps the converter a pure function,
 *                  unit-testable without a DOM). Either short-
 *                  circuits to the verbatim text (when the
 *                  selection is itself markdown source) or runs
 *                  `htmlToMarkdown(html, pageUrl)`. See
 *                  `looksLikeMarkdownSource` in `src/markdown.ts`
 *                  for the detection rule.
 */
export interface SelectionBodies {
  html: string;
  text: string;
  markdown: string;
}

export interface InMemoryCapture {
  screenshotDataUrl: string;
  /**
   * Full HTML of the captured tab. Empty string when scraping failed
   * — `htmlError` is then set with the reason. The Capture page uses
   * the error field (not the empty string) to decide whether to
   * grey out the Save HTML checkbox.
   */
  html: string;
  url: string;
  /**
   * Title of the captured tab (`chrome.tabs.Tab.title`) at capture
   * time, or empty string if unavailable. Pinned with the rest of
   * the snapshot so the Capture page shows the title that was live
   * when the user clicked, even if the tab navigates afterwards.
   */
  title: string;
  /**
   * ISO 8601 UTC timestamp of the moment the capture was taken
   * (right after `chrome.tabs.captureVisibleTab` returned). Pinning
   * this here — rather than re-stamping at save time — means the
   * record's `timestamp` and the filename's embedded local time both
   * describe the *capture moment*, not whenever the user got around
   * to clicking Save in the Capture page flow.
   */
  timestamp: string;
  /**
   * Filename the screenshot will be written under if the user saves
   * it. Computed from `timestamp` so the Capture page can show /
   * copy the exact name before the file lands on disk.
   *
   * Mutable across the session: when the Capture-page user bakes
   * highlights / redactions / a crop into the screenshot, the bake
   * step emits image bytes in the sticky output format (JPEG for a
   * JPEG source, PNG otherwise — see `bakeMime` on the page side),
   * and the SW rewrites this filename's extension to match (via
   * `extFromDataUrl`). Reverting all edits (no bake) flips it back
   * to the original extension. See `screenshotOriginalExt` for the
   * immutable record of the pre-bake extension.
   */
  screenshotFilename: string;
  /**
   * Original filename extension the screenshot would use without any
   * bake-in — `png` for the toolbar tab-capture path, MIME-derived
   * for the image right-click flow (e.g. `jpg`, `webp`, `unknown`).
   * Stable across the session; the SW reads it to swap
   * `screenshotFilename` back to the pre-bake extension when the
   * user undoes all edits between Copy / Capture clicks.
   */
  screenshotOriginalExt: string;
  /**
   * Filename the HTML snapshot will be written under if the user
   * saves it. Same reason as `screenshotFilename`.
   */
  contentsFilename: string;
  /**
   * The user's page selection at capture time, rendered in all
   * three storage formats (HTML fragment, plain text, and
   * markdown). Undefined when no selection existed — the Capture
   * page uses that to grey out / uncheck every "Save selection as
   * …" row and disable their Copy / Edit buttons. A given format's
   * entry may be an empty string even when `selections` is set
   * (e.g. an image-only selection has non-empty `html` but empty
   * `text`); each format row on the Capture page is gated
   * independently on its per-format emptiness.
   */
  selections?: SelectionBodies;
  /**
   * Filenames each selection format will be written under if the
   * user saves it. All three share the same compact timestamp
   * suffix as `screenshotFilename` / `contentsFilename` so files
   * written from the same capture sort together regardless of
   * which format ended up on disk. Populated together with
   * `selections`.
   */
  selectionFilenames?: Record<SelectionFormat, string>;
  /**
   * Reason HTML could not be captured (e.g. restricted URL where
   * `chrome.scripting.executeScript` can't inject). Set only when
   * scraping failed — the Capture page reads this to disable + flag
   * the Save HTML row with an error icon while still opening the
   * Capture page flow so the user can add a URL-only / screenshot-only
   * record with any prompt or highlights they want.
   */
  htmlError?: string;
  /**
   * Reason the page selection could not be captured. In practice
   * this fires together with `htmlError` (selection is scraped in
   * the same `executeScript` call) but is kept as a separate field
   * so the UI can distinguish "no selection existed" from
   * "couldn't even check for a selection". Only "no selection
   * existed" leaves both `selection` and `selectionError` unset.
   */
  selectionError?: string;
  /**
   * Reason screenshot could not be captured (e.g. restricted URL
   * like the Web Store where extensions aren't allowed to capture).
   * Set only when captureVisibleTab failed — the Capture page reads
   * this to flag the screenshot row/preview with an error icon.
   */
  screenshotError?: string;
  /**
   * Image-context right-click flow: the URL of the right-clicked
   * `<img>`. Mirrors the eventual `CaptureRecord.imageUrl` and is
   * carried on the in-memory capture so the Capture page can echo
   * it (e.g. as a hover hint) and so `recordDetailedCapture` can
   * include it in the saved record regardless of whether the user
   * keeps the screenshot checkbox checked.
   */
  imageUrl?: string;
  /**
   * Image-context flow flag: HTML was deliberately not scraped
   * because the user came in via right-clicking an image, not the
   * whole-tab capture path. Distinct from `htmlError` — there's no
   * failure to surface, the Capture page should just disable the
   * Save HTML row quietly without an error icon. Selection is
   * still scraped in this mode (the right-click might happen on a
   * page with a relevant caption selected).
   */
  htmlUnavailable?: boolean;
  /**
   * Use `imageFlowDefaults` instead of the user's stored
   * `capturePageDefaults` when seeding the Capture page checkboxes.
   * Set by flows where "save the screenshot" is the natural intent
   * regardless of the user's whole-page preferences — currently the
   * right-click image flow and the upload-image flow.
   *
   * Lives separately from `imageUrl` (the *recorded* source URL of a
   * right-clicked `<img>`) because the upload flow has no source URL
   * to record but still wants the same defaults; conversely, a future
   * flow could record an `imageUrl` without wanting image-flow
   * defaults.
   */
  useImageFlowDefaults?: true;
}

export interface BuildInMemoryCaptureInput {
  screenshotDataUrl: string;
  /** Filename extension for the screenshot artifact — `png` for the
   * tab-screenshot path, the source image's MIME-derived extension
   * for the right-clicked-image path. */
  screenshotExt: string;
  html: string;
  selectionRaw: { html: string; text: string } | null;
  pageUrl: string;
  pageTitle: string;
  timestamp: Date;
  ts: string;
}

export interface SaveDetailedOptions {
  capture: InMemoryCapture;
  /** Save the screenshot PNG as part of this capture. */
  includeScreenshot: boolean;
  /** Save the captured HTML as part of this capture. */
  includeHtml: boolean;
  /**
   * Save one of the captured selection formats as
   * `selection-<timestamp>.{html,txt,md}`. `undefined` means "don't
   * save a selection." Only one format is ever written per capture;
   * the Capture page's three Save-selection-as-… rows are mutually
   * exclusive. Ignored when `capture.selections` is unset (no
   * selection existed at capture time) or the chosen format's body
   * is empty.
   */
  selectionFormat?: SelectionFormat;
  /**
   * Optional user-entered prompt. Trimmed by the caller; an empty
   * string is treated the same as omitting the field. Stored on the
   * sidecar record under `prompt` when non-empty.
   */
  prompt?: string;
  /**
   * True when `capture.screenshotDataUrl` has at least one red
   * rectangle / line (from the Box / Line tools) baked into the PNG
   * bytes. Causes the saved record's `screenshot` artifact object to
   * carry `hasHighlights: true`. Ignored unless `includeScreenshot`
   * is also true — there's no point flagging highlights on a record
   * that didn't save the image they're on.
   */
  hasHighlights?: boolean;
  /**
   * True when the baked PNG contains at least one redaction
   * rectangle. Causes the saved record's `screenshot` artifact to
   * carry `hasRedactions: true`. Same `includeScreenshot` gating as
   * `hasHighlights`.
   */
  hasRedactions?: boolean;
  /**
   * True when the baked PNG was cropped to a user-selected region.
   * Causes the saved record's `screenshot` artifact to carry
   * `isCropped: true`. Same `includeScreenshot` gating as above.
   */
  isCropped?: boolean;
  /**
   * True when the user replaced the captured HTML via the Edit HTML
   * dialog before saving. Causes the record's `contents` artifact
   * object to carry `isEdited: true`. Ignored unless `includeHtml`
   * is also true — the flag only makes sense on a record that
   * actually saved the HTML file.
   */
  htmlEdited?: boolean;
  /**
   * True when the user replaced the captured selection body for the
   * format named in `selectionFormat` via the Edit selection dialog
   * before saving. Causes the record's `selection` artifact object
   * to carry `isEdited: true`. Ignored unless `selectionFormat` is
   * also set.
   */
  selectionEdited?: boolean;
}
