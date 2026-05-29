// Capture-time PNG → JPEG recompress for oversized screenshots.
//
// `chrome.tabs.captureVisibleTab` always returns a PNG. On photo-
// heavy pages that balloons to tens of MiB on disk and crowds the
// in-session `screenshotDataUrl` (which still carries a ~33% base64
// overhead on top of the binary). When the binary size crosses the
// configured threshold we try a JPEG re-encode and keep whichever
// is smaller, subject to a minimum-savings floor so we don't take
// the lossy hit for a marginal win. Plain UI / text captures stay
// well under the threshold and skip the work entirely.
//
// Format is *sticky* from here on: once we hand back a JPEG, the
// rest of the pipeline (in-memory capture, capture-page bake,
// downloaded file) carries the `.jpg` extension through.

/**
 * Default threshold above which we try a JPEG re-encode of the
 * freshly captured PNG. Compared against the *binary* PNG size
 * (`Blob.size` after decoding the data URL), not the base64-inflated
 * data-URL string length.
 *
 * The live value is held in `largeScreenshotThresholdBytes`, which
 * `_setLargeScreenshotThresholdForTest` can lower so e2e tests can
 * exercise the recompress path without producing an actual 2 MiB
 * capture.
 */
export const LARGE_SCREENSHOT_PNG_THRESHOLD_BYTES_DEFAULT = 2 * 1024 * 1024;
let largeScreenshotThresholdBytes = LARGE_SCREENSHOT_PNG_THRESHOLD_BYTES_DEFAULT;

/**
 * Test-only setter for `largeScreenshotThresholdBytes` (mirroring
 * the `_setAskProvidersForTest` pattern in background.ts). Pass
 * `null` to restore the production default. Re-exported on
 * `self.SeeWhatISee`.
 */
export function _setLargeScreenshotThresholdForTest(bytes: number | null): void {
  largeScreenshotThresholdBytes =
    bytes === null ? LARGE_SCREENSHOT_PNG_THRESHOLD_BYTES_DEFAULT : bytes;
}

/** JPEG quality used when re-encoding an oversized PNG screenshot.
 *  Matches `JPEG_BAKE_QUALITY` in capture-page/drawing.ts so the
 *  capture-time path and the user-edit bake path produce comparably
 *  faithful JPEGs. */
const LARGE_SCREENSHOT_JPG_QUALITY = 0.92;
/** The JPEG must be at least this fraction smaller than the PNG to
 *  win — otherwise the lossy encode buys too little to be worth it
 *  and we keep the PNG. */
const LARGE_SCREENSHOT_JPG_MIN_SAVINGS = 0.1;

/**
 * Re-encode an oversized PNG screenshot as JPEG if doing so would be
 * substantially smaller; otherwise return the PNG unchanged.
 *
 * Called right after `chrome.tabs.captureVisibleTab` for both the
 * quick-save and Capture-page flows.
 *
 * Decision flow:
 *   - Below the threshold → return PNG (no encode, no log).
 *   - Decode + JPEG re-encode via OffscreenCanvas (MV3 SW has both).
 *   - Compare sizes; pick the smaller subject to the savings floor.
 *   - Log both sizes regardless of which one we kept, so the
 *     threshold/quality constants can be tuned from real captures.
 *   - Any decode/encode failure falls back to the PNG.
 */
export async function maybeRecompressLargeScreenshot(
  pngDataUrl: string,
): Promise<{ dataUrl: string; ext: 'png' | 'jpg' }> {
  if (!pngDataUrl.startsWith('data:image/png')) {
    return { dataUrl: pngDataUrl, ext: 'png' };
  }
  let pngBlob: Blob;
  try {
    pngBlob = await (await fetch(pngDataUrl)).blob();
  } catch (err) {
    // Handled: fall back to the original PNG.
    console.info('[SeeWhatISee] large-screenshot fetch failed:', err);
    return { dataUrl: pngDataUrl, ext: 'png' };
  }
  if (pngBlob.size <= largeScreenshotThresholdBytes) {
    return { dataUrl: pngDataUrl, ext: 'png' };
  }
  let jpgBlob: Blob;
  try {
    const bitmap = await createImageBitmap(pngBlob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    jpgBlob = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: LARGE_SCREENSHOT_JPG_QUALITY,
    });
  } catch (err) {
    // Handled: keep the PNG.
    console.info('[SeeWhatISee] large-screenshot JPEG re-encode failed:', err);
    return { dataUrl: pngDataUrl, ext: 'png' };
  }
  const useJpg = jpgBlob.size <= pngBlob.size * (1 - LARGE_SCREENSHOT_JPG_MIN_SAVINGS);
  console.log(
    `[SeeWhatISee] large-screenshot recompress: PNG ${formatBytesShort(pngBlob.size)} → JPG ${formatBytesShort(jpgBlob.size)} — ${useJpg ? 'using JPG' : 'kept PNG'}`,
  );
  if (!useJpg) return { dataUrl: pngDataUrl, ext: 'png' };
  let jpgDataUrl: string;
  try {
    jpgDataUrl = await blobToDataUrl(jpgBlob);
  } catch (err) {
    // Handled: keep the PNG.
    console.info('[SeeWhatISee] large-screenshot JPEG data-URL build failed:', err);
    return { dataUrl: pngDataUrl, ext: 'png' };
  }
  return { dataUrl: jpgDataUrl, ext: 'jpg' };
}

function formatBytesShort(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** Chunked binary→base64 so we don't blow the call stack on
 *  multi-MB blobs. SW contexts don't have `FileReader.readAsDataURL`
 *  reliably, but `btoa` + `arrayBuffer()` is universal. CHUNK is well
 *  under V8's spread/apply argument-count limit. */
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
