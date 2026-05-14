// Image-source capture paths and MIME helpers.
//
// Three user-facing entry points all live here because they share
// the same `fetchImageBytes` core (SW-side `fetch` for `file://`
// URLs, page-side fetch + canvas fallback for everything else):
//
//   - `captureImageToMemory`     — image right-click flow into the
//     Capture page (returns `InMemoryCapture`).
//   - `captureImageAsScreenshot` — "Save screenshot" sibling for the
//     image context menu (writes the file + log entry directly).
//   - `captureImageTabToMemory`  — bare-image-tab branch of
//     `captureBothToMemory`. Same shape as the upload-image flow.
//
// Plus the MIME-to-extension table used by all three (and by
// background/capture-details.ts to pick the right extension when
// the Capture page uploads a file).

import {
  type CaptureResult,
  type InMemoryCapture,
  buildInMemoryCapture,
  saveCapture,
  scrapeTabState,
} from '../capture.js';
import { compactTimestamp } from './log-store.js';

/**
 * Image right-click flow — fetches the source image bytes from the
 * tab's page context (HTTPS / cookies / blob:) or the SW context
 * (file://) and builds an `InMemoryCapture` whose "screenshot" is
 * those bytes.
 *
 * The page HTML is *not* scraped (the user is acting on a specific
 * image, not the surrounding page), so the Capture page renders
 * with the Save HTML row quietly disabled (`htmlUnavailable: true`).
 * Selection scrape still runs in case the page has relevant
 * surrounding text selected — but its failure is non-fatal here.
 *
 * `imageUrl` is set so the saved record links back to the source
 * even if the user un-checks Save Screenshot before clicking
 * Capture; `useImageFlowDefaults` flips the Capture page to its
 * image-friendly default-check set.
 */
export async function captureImageToMemory(
  tab: chrome.tabs.Tab,
  srcUrl: string,
): Promise<InMemoryCapture> {
  if (tab.id === undefined) throw new Error('No tab id for image capture');
  const { dataUrl, ext } = await fetchImageBytes(tab.id, srcUrl);
  const scrape = await scrapeTabState(tab, { includeHtml: false });
  const now = new Date();
  const ts = compactTimestamp(now);
  const capture = buildInMemoryCapture({
    screenshotDataUrl: dataUrl,
    screenshotExt: ext,
    html: '',
    selectionRaw: scrape.selectionRaw,
    pageUrl: tab.url ?? '',
    pageTitle: tab.title ?? '',
    timestamp: now,
    ts,
  });
  capture.htmlUnavailable = true;
  capture.imageUrl = srcUrl;
  capture.useImageFlowDefaults = true;
  if (scrape.selectionError !== undefined) capture.selectionError = scrape.selectionError;
  return capture;
}

/**
 * "Save screenshot" sibling for the image context menu — saves the
 * right-clicked image bytes under the same `screenshot-<ts>.<ext>`
 * naming as a tab capture, and records it in `log.json` exactly like
 * `captureVisible` does. No Capture page round-trip; no HTML scrape.
 *
 * The record carries `imageUrl` (the right-clicked source URL)
 * alongside the saved screenshot artifact, so a downstream agent can
 * resolve the original image even if the saved bytes are gone.
 *
 * Uses the source image's MIME-derived extension so the on-disk file
 * is honest about its bytes (a JPEG image stays a `.jpg`, not a
 * `.png` with JPEG bytes). The downstream see-what-i-see skills key
 * off the `screenshot` artifact regardless of extension.
 */
export async function captureImageAsScreenshot(
  tab: chrome.tabs.Tab,
  srcUrl: string,
): Promise<CaptureResult> {
  if (tab.id === undefined) throw new Error('No tab id for image capture');
  const { dataUrl, ext } = await fetchImageBytes(tab.id, srcUrl);
  return saveCapture(dataUrl, tab.url ?? '', tab.title ?? '', ext, srcUrl);
}

/**
 * MIMEs that Chrome's built-in *raster* image viewer renders as a
 * bare image — the only set we want `probeActiveTabImage` to claim.
 *
 * Deliberately excludes `image/svg+xml`: SVG renders inline as its
 * own document (with DOM / CSS / `<script>` support) rather than
 * through the auto-generated image viewer, so a user capturing a
 * `.svg` tab probably wants the page-HTML scrape path, not the
 * image-source-bytes path.
 */
const IMAGE_VIEWER_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/avif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

/**
 * Detect whether the active tab is showing a bare image file (e.g. a
 * `file://` or `http(s)://` URL pointing directly at a PNG / JPG /
 * WEBP / etc., rendered by Chrome's built-in image viewer). Returns
 * the image URL + title when so, `null` otherwise.
 *
 * Implementation note: Chrome reports the document's actual MIME via
 * `document.contentType` for these auto-generated viewer pages, so a
 * one-shot `executeScript` probe is enough. URL-extension sniffing
 * alone isn't reliable (an HTML page can still end in `.png`), and
 * `data:image/...` tabs may have no extension at all.
 *
 * Failures fall through to `null`:
 *   - `executeScript` rejection (restricted URL, no file-URL access
 *     toggle for `file://` tabs, etc.) means we couldn't tell — the
 *     caller takes a normal screenshot, which still works for many
 *     of these cases via `activeTab`.
 *   - Probe returns nothing — same fallback.
 *   - Content-Type isn't one of `IMAGE_VIEWER_MIMES` (e.g. SVG).
 */
export async function probeActiveTabImage(
  tab: chrome.tabs.Tab,
): Promise<{ url: string; title: string } | null> {
  if (tab.id === undefined) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        contentType: document.contentType,
        href: location.href,
        title: document.title,
      }),
    });
    const info = results[0]?.result as
      | { contentType?: unknown; href?: unknown; title?: unknown }
      | undefined;
    const rawContentType = typeof info?.contentType === 'string' ? info.contentType : '';
    // Strip params (`;charset=...`) before the set lookup so a server
    // that decorates the MIME still matches.
    const contentType = rawContentType.toLowerCase().split(';')[0]!.trim();
    if (!IMAGE_VIEWER_MIMES.has(contentType)) return null;
    const url = typeof info?.href === 'string' ? info.href : (tab.url ?? '');
    const title = typeof info?.title === 'string' ? info.title : (tab.title ?? '');
    return { url, title };
  } catch {
    return null;
  }
}

/**
 * Build an `InMemoryCapture` for a tab that's displaying a bare image
 * file. The "screenshot" is the image bytes themselves (fetched from
 * the page context the same way as the image-right-click flow), the
 * page URL is the image URL, HTML is unavailable, and any text
 * selection is ignored — same shape as the upload-image flow, so the
 * Capture page renders identically.
 *
 * Unlike the image-right-click flow we do *not* set `imageUrl`: the
 * tab URL already *is* the image URL, mirroring the upload path
 * (where the file is the source, already named in `url`).
 */
export async function captureImageTabToMemory(
  tab: chrome.tabs.Tab,
  imageUrl: string,
  title: string,
): Promise<InMemoryCapture> {
  if (tab.id === undefined) throw new Error('No tab id for image-tab capture');
  const { dataUrl, ext } = await fetchImageBytes(tab.id, imageUrl);
  const now = new Date();
  const ts = compactTimestamp(now);
  const capture = buildInMemoryCapture({
    screenshotDataUrl: dataUrl,
    screenshotExt: ext,
    html: '',
    selectionRaw: null,
    pageUrl: imageUrl,
    pageTitle: title,
    timestamp: now,
    ts,
  });
  capture.htmlUnavailable = true;
  capture.useImageFlowDefaults = true;
  return capture;
}

/**
 * Filename-extension lookup table for the image-context save path.
 * Mirrors the canonical short names browsers and downstream tools
 * key off (`jpg`, not `jpeg`; `svg` not `svg+xml`). Used only for
 * MIMEs we want to normalize away from their full subtype string.
 */
const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

/**
 * Reverse of `IMAGE_MIME_EXTENSIONS` — the canonical MIME for a
 * given extension. Lets `fetchImageInPage` rebuild the data URL's
 * MIME prefix to match the extension `imageExtensionFor` picked,
 * so downstream consumers that key off the data URL's MIME (the
 * Capture-page bake's sticky-format check is the load-bearing one:
 * `bakeMime()` only outputs JPEG when `sourceMime() === 'image/jpeg'`)
 * stay aligned with what the on-disk file will actually be.
 *
 * Returns `undefined` when the extension has no canonical mapping
 * (`unknown`, or any ext we don't recognize). Callers then leave the
 * data URL's original MIME prefix alone.
 */
const CANONICAL_MIME_FOR_EXT: Record<string, string> = {
  png: 'image/png',
  // `imageExtensionFor`'s MIME-table lookup canonicalizes `image/jpeg`
  // to `jpg`, but its URL-pathname fallback preserves whatever the
  // path used — `/photo.jpeg` produces `jpeg`. Map both spellings so
  // a `.jpeg`-URL capture with a missing / mislabeled Content-Type
  // still gets its data-URL MIME normalized (the canvas-fallback path
  // already treats `.jpg`/`.jpeg` equivalently). On-disk filename
  // preserves whichever spelling came in; OSes recognize both.
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

function canonicalMimeForExt(ext: string): string | undefined {
  return CANONICAL_MIME_FOR_EXT[ext];
}

/**
 * Replace the MIME prefix on a `data:` URL — bytes untouched, only
 * the `data:<mime>;...` header rewritten. Used by `fetchImageInPage`
 * to align the data URL's declared MIME with the canonical MIME for
 * its filename extension; see `CANONICAL_MIME_FOR_EXT` for the why.
 *
 * Returns the input verbatim if the URL doesn't match the `data:`
 * shape we know how to rewrite — same defensive default as
 * `sourceMime` on the Capture page.
 */
function rewriteDataUrlMime(dataUrl: string, mime: string): string {
  const m = /^data:[^;,]*([;,])/.exec(dataUrl);
  if (!m) return dataUrl;
  return `data:${mime}${dataUrl.slice(m[0]!.length - 1)}`;
}

/**
 * Pick the right filename extension for the bytes we're about to
 * save. Order:
 *
 *   1. Known MIME → table lookup (canonical short names).
 *   2. URL pathname extension (`/photo.heic` → `heic`) when the
 *      MIME didn't help. Useful when servers send
 *      `application/octet-stream` or otherwise lie about the type.
 *   3. `unknown` — never `.png`, because misnaming JPEG bytes as
 *      `.png` (or vice-versa) is the bug we're trying to avoid.
 *      An honest `.unknown` lets the user open the file with
 *      whatever their OS chooses based on the magic header.
 *
 * Pathname-extension parsing is conservative: only accepts 1-5
 * lowercase letters/digits to avoid pulling weird strings out of
 * query parameters or fragments.
 */
export function imageExtensionFor(mime: string, srcUrl: string): string {
  const m = mime.toLowerCase().split(';')[0]!.trim();
  const fromTable = IMAGE_MIME_EXTENSIONS[m];
  if (fromTable) return fromTable;
  const fromUrl = imageExtensionFromUrl(srcUrl);
  if (fromUrl) return fromUrl;
  return 'unknown';
}

function imageExtensionFromUrl(srcUrl: string): string | undefined {
  // Only http(s) / file URLs carry a meaningful pathname; data: /
  // blob: have nothing to extract.
  let pathname: string;
  try {
    pathname = new URL(srcUrl).pathname;
  } catch {
    return undefined;
  }
  const match = /\.([a-z0-9]{1,5})$/i.exec(pathname);
  return match ? match[1]!.toLowerCase() : undefined;
}

/**
 * Resolve an image URL into image bytes — wrapper that picks the
 * right fetch strategy for the URL scheme.
 *
 * `file://` URLs go through the SW context. Chromium's file://
 * origin model rejects same-origin `fetch()` from inside the
 * file:// page even when the extension has "Allow access to file
 * URLs" enabled, so the page-side strategy in `fetchImageInPage`
 * falls all the way through to the canvas-snapshot re-encode (lossy
 * — 0.92 quality JPEG that differs in bytes and size from the
 * original). The SW context runs in the extension's own
 * `chrome-extension://` origin, so its `fetch()` is bound by
 * `<all_urls>` host permission + the file-URL toggle and succeeds
 * losslessly.
 *
 * Other URL schemes (http(s), data:, blob:) route to the page-side
 * helper. Page context is the right place for them because (a) it
 * sends the user's cookies on cross-origin authenticated images,
 * (b) `blob:` URLs are scoped to the page that created them and
 * aren't visible to the SW, and (c) the painted-`<img>` canvas
 * fallback is only reachable from there.
 */
export async function fetchImageBytes(
  tabId: number,
  srcUrl: string,
): Promise<{ dataUrl: string; ext: string }> {
  if (srcUrl.startsWith('file://')) {
    const swResult = await fetchImageInSW(srcUrl);
    if (swResult) return swResult;
    // SW path failed (file-URL toggle off, file moved, etc.). Fall
    // through — the page-side flow may still recover via the canvas
    // fallback, even if lossy.
  }
  return fetchImageInPage(tabId, srcUrl);
}

/**
 * SW-side image fetch — used for `file://` URLs and only for
 * those (see `fetchImageBytes`'s comment for why). Returns `null`
 * on any failure so the caller can fall through to other
 * strategies. Applies the same MIME normalization as the page-side
 * path so the `data:` URL's prefix matches the chosen extension.
 */
async function fetchImageInSW(
  srcUrl: string,
): Promise<{ dataUrl: string; ext: string } | null> {
  let blob: Blob;
  try {
    const res = await fetch(srcUrl);
    if (!res.ok) return null;
    blob = await res.blob();
  } catch {
    return null;
  }
  let rawDataUrl: string;
  try {
    rawDataUrl = await blobToDataUrl(blob);
  } catch {
    return null;
  }
  const ext = imageExtensionFor(blob.type, srcUrl);
  const canonical = canonicalMimeForExt(ext);
  const dataUrl = canonical ? rewriteDataUrlMime(rawDataUrl, canonical) : rawDataUrl;
  return { dataUrl, ext };
}

/** Chunked binary→base64 so we don't blow the call stack on
 *  multi-MB blobs. SW contexts don't have `FileReader.readAsDataURL`
 *  reliably, but `btoa` + `arrayBuffer()` is universal. CHUNK is well
 *  under V8's spread/apply argument-count limit.
 *
 *  Duplicated from `./recompress.ts` deliberately — both modules want
 *  to stay self-contained and the helper is small enough that an
 *  inter-module dep would be more friction than it's worth. */
async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type};base64,${btoa(bin)}`;
}

/**
 * Resolve an image URL into PNG/JPEG/etc. bytes from the source tab's
 * page context. Two strategies, tried in order:
 *
 *   1. **Fetch.** A normal `fetch(url)` from the page's isolated
 *      world. Sends cookies for the URL's origin (default
 *      credentials), respects CORS the way a page-side fetch would,
 *      and works for `data:` / `blob:` URLs that have no network
 *      round-trip at all. This is the right answer when it works —
 *      the response body is the original encoded bytes (lossless),
 *      so JPEG photos stay JPEG, animated GIFs stay animated, etc.
 *   2. **Canvas snapshot of the already-painted `<img>`.** When
 *      fetch fails (403 because the server's auth doesn't accept
 *      anonymous CORS, hot-link protection rejecting our
 *      `Sec-Fetch-Site`, expired signed-URL params, etc.) we fall
 *      back to whatever's already on the page. Find an `<img>` whose
 *      `currentSrc` or `src` matches the right-clicked URL, draw it
 *      onto a canvas, and read bytes back. Output MIME follows the
 *      source URL's extension: `.jpg` / `.jpeg` re-encodes as JPEG
 *      (lossy but format-preserving), everything else writes PNG.
 *      Tainted-canvas sources (cross-origin without
 *      `crossorigin="anonymous"`) throw a SecurityError on
 *      `toDataURL`; that's surfaced as a clear
 *      error so the user knows why.
 *
 * Returns `mime` in addition to `dataUrl` so the caller can pick the
 * right filename extension via `imageExtensionFor`. The canvas
 * fallback picks its output MIME from the source URL's extension so
 * a JPEG source survives as JPEG (re-encoded, since the original
 * bytes are out of reach) rather than silently being PNG-ified —
 * everything else collapses to PNG, which is what the bake canvas
 * also writes for non-JPEG sources.
 *
 * The injected function catches its own errors and returns them in
 * the result envelope — `executeScript` discards page-side
 * rejections, so we can't rely on the promise rejecting back through
 * the IPC.
 */
async function fetchImageInPage(
  tabId: number,
  srcUrl: string,
): Promise<{ dataUrl: string; ext: string }> {
  // Pre-compute the URL-derived format hint so the page-side function
  // can pick the canvas fallback's output MIME without re-implementing
  // `imageExtensionFromUrl`. JPEG sources get `image/jpeg`; everything
  // else uses PNG, matching the Capture-page bake's sticky rule.
  const urlExt = imageExtensionFromUrl(srcUrl);
  const canvasFallbackMime: 'image/jpeg' | 'image/png' =
    urlExt === 'jpg' || urlExt === 'jpeg' ? 'image/jpeg' : 'image/png';
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (url: string, fallbackMime: 'image/jpeg' | 'image/png') => {
      // Helper: read a Blob into a data URL via FileReader. Same
      // shape both branches use, so define it once.
      const blobToDataUrl = (blob: Blob) =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
          reader.onload = () => resolve(String(reader.result));
          reader.readAsDataURL(blob);
        });

      // Strategy 1: fetch().
      let fetchError: string | undefined;
      try {
        const res = await fetch(url);
        if (res.ok) {
          const blob = await res.blob();
          const dataUrl = await blobToDataUrl(blob);
          return { dataUrl, mime: blob.type };
        }
        fetchError = `HTTP ${res.status} fetching image`;
      } catch (err) {
        fetchError = err instanceof Error ? err.message : String(err);
      }

      // Strategy 2: snapshot the already-painted <img>. Looks for an
      // image whose `currentSrc` or `src` matches the right-clicked
      // URL. `currentSrc` matches first because <picture>/srcset can
      // make `src` lie about which URL actually painted.
      const candidates = Array.from(document.querySelectorAll('img'));
      const img =
        candidates.find((el) => el.currentSrc === url) ??
        candidates.find((el) => el.src === url);
      if (!img || !img.complete || img.naturalWidth === 0) {
        return {
          error:
            `Image fetch failed (${fetchError ?? 'unknown error'}) and no painted <img>`
            + ` matches the URL. The image may not be visible on the page, may`
            + ` use a CSS background-image (not supported), or finished loading`
            + ` after we looked.`,
        };
      }
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) return { error: 'Failed to get 2D canvas context' };
        ctx.drawImage(img, 0, 0);
        // toDataURL throws SecurityError on a tainted canvas (cross-
        // origin image loaded without crossorigin="anonymous"). Output
        // MIME follows the URL-extension hint so JPEG sources stay
        // JPEG (re-encoded — original bytes are inaccessible here);
        // 0.92 mirrors the Capture-page bake's default JPEG quality.
        const dataUrl =
          fallbackMime === 'image/jpeg'
            ? canvas.toDataURL('image/jpeg', 0.92)
            : canvas.toDataURL('image/png');
        return { dataUrl, mime: fallbackMime };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          error:
            `Image fetch failed (${fetchError ?? 'unknown error'}) and canvas`
            + ` fallback was blocked: ${msg}. This usually means the image is`
            + ` cross-origin and the server doesn't send permissive CORS headers.`,
        };
      }
    },
    args: [srcUrl, canvasFallbackMime],
  });
  const out = results[0]?.result as
    | { dataUrl: string; mime: string }
    | { error: string }
    | undefined;
  if (!out) throw new Error('Failed to fetch image (no result from page)');
  if ('error' in out) throw new Error(out.error);
  const ext = imageExtensionFor(out.mime, srcUrl);
  // Normalize the data URL's MIME prefix to the canonical MIME for
  // the chosen extension. Bytes are untouched; only the `data:<mime>`
  // header is rewritten. The load-bearing consumer is the Capture
  // page's `bakeMime()` — it keeps a JPEG source JPEG only when
  // `sourceMime() === 'image/jpeg'` exactly, so a server that sends
  // `application/octet-stream` (or omits Content-Type entirely) would
  // otherwise silently flip a JPG bake to PNG. We trust the chosen
  // `ext` here: it already prefers the MIME table over the URL fallback,
  // so we're not papering over a real MIME-vs-bytes mismatch.
  const canonical = canonicalMimeForExt(ext);
  const dataUrl = canonical ? rewriteDataUrlMime(out.dataUrl, canonical) : out.dataUrl;
  return { dataUrl, ext };
}
