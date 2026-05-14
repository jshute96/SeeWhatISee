// Text-artifact compression for `chrome.storage.session` payloads.
//
// Heavy SPAs frequently inline CSS, fonts, and base64 assets, so the
// page HTML (and occasionally a long selection) can dominate the
// 10 MiB session-storage cap before the screenshot even gets to add
// its share. Gzipping these text fields before storage keeps them
// well under the cap; consumers see plain strings on the read side,
// since this module decompresses at the boundary.
//
// `chrome.storage.session` is JSON-serialized, so a raw `Uint8Array`
// would inflate to `{0: …, 1: …}` form and lose the win entirely;
// we base64-encode the gzipped bytes (~33% inflation) which still
// lands far below the raw text size on anything compressible.
//
// Two thresholds matter:
//   - `COMPRESS_THRESHOLD_BYTES` (≈100 KiB) — below this, compression
//     buys less than the per-call CompressionStream overhead is
//     worth, so we store the text verbatim and skip the round-trip.
//   - `HARD_CAP_BYTES` (2 MiB compressed) — above this, the artifact
//     is rejected outright at capture / edit-save time. The error
//     surfaces on the corresponding Save row in the Capture page.

import { formatBytes } from './session-quota.js';

const COMPRESS_THRESHOLD_BYTES = 100 * 1024;
const HARD_CAP_BYTES_DEFAULT = 2 * 1024 * 1024;

/** Exported so the Capture page / docs can quote the actual limit. */
export const STORED_TEXT_COMPRESS_THRESHOLD_BYTES = COMPRESS_THRESHOLD_BYTES;
export const STORED_TEXT_HARD_CAP_BYTES_DEFAULT = HARD_CAP_BYTES_DEFAULT;

let hardCapBytes = HARD_CAP_BYTES_DEFAULT;
/** Live cap used by `prepareStoredText`. Read-only via this
 *  accessor so the StoredCapture serializer can format error
 *  messages with the *current* cap rather than the compile-time
 *  default. */
export function storedTextHardCapBytes(): number {
  return hardCapBytes;
}

/**
 * Test-only setter for the per-artifact compressed cap (mirroring
 * the `_setLargeScreenshotThresholdForTest` pattern in capture.ts).
 * Pass `null` to restore the production default. Re-exported on
 * `self.SeeWhatISee`.
 */
export function _setStoredTextHardCapForTest(bytes: number | null): void {
  hardCapBytes = bytes === null ? HARD_CAP_BYTES_DEFAULT : bytes;
}

/**
 * Discriminated union for one text artifact as it sits in
 * `chrome.storage.session`. Small fields stay as `plain`; larger
 * fields become `gzip-base64`.
 *
 * `uncompressedBytes` is the UTF-8 byte length of the original
 * string (not its UTF-16 `.length`, which would mis-size CJK / emoji
 * pages). For `plain` it's redundant but kept for breakdown
 * reporting symmetry. For `gzip-base64`, `compressedBytes` is the
 * raw gzip byte length pre-base64; reporting that — rather than the
 * inflated base64 string length — matches what the user sees
 * elsewhere ("6 MB compressed" reads cleaner than "8 MB stored").
 */
export type StoredText =
  | { kind: 'plain'; text: string; uncompressedBytes: number }
  | {
      kind: 'gzip-base64';
      base64: string;
      uncompressedBytes: number;
      compressedBytes: number;
    };

export interface PreparedOk {
  ok: true;
  stored: StoredText;
}

export interface PreparedTooLarge {
  ok: false;
  uncompressedBytes: number;
  compressedBytes: number;
  /** User-facing message — matches what we surface on the Save
   *  HTML / Save selection row when the artifact is dropped. */
  message: string;
}

export type PreparedText = PreparedOk | PreparedTooLarge;

/**
 * Pack a text artifact into a `StoredText`, or refuse with the
 * caller-friendly "too large" payload. Empty strings short-circuit
 * to a `plain` zero-byte entry; the caller decides whether to even
 * emit the field (currently both call sites drop empty text from
 * the breakdown / session record entirely).
 */
export async function prepareStoredText(text: string): Promise<PreparedText> {
  const uncompressedBytes = new TextEncoder().encode(text).length;
  if (uncompressedBytes <= COMPRESS_THRESHOLD_BYTES) {
    return {
      ok: true,
      stored: { kind: 'plain', text, uncompressedBytes },
    };
  }
  const gz = await gzip(text);
  const compressedBytes = gz.byteLength;
  if (compressedBytes > hardCapBytes) {
    return {
      ok: false,
      uncompressedBytes,
      compressedBytes,
      message: `Content too large: ${formatBytes(uncompressedBytes)}, ${formatBytes(compressedBytes)} compressed (limit ${formatBytes(hardCapBytes)}).`,
    };
  }
  return {
    ok: true,
    stored: {
      kind: 'gzip-base64',
      base64: bytesToBase64(gz),
      uncompressedBytes,
      compressedBytes,
    },
  };
}

/**
 * Inverse of `prepareStoredText`. Decompresses `gzip-base64`,
 * returns the literal text for `plain`. Used at the storage-read
 * boundary so the rest of the codebase sees plain strings.
 */
export async function readStoredText(stored: StoredText): Promise<string> {
  if (stored.kind === 'plain') return stored.text;
  return await gunzip(base64ToBytes(stored.base64));
}

/** Byte cost of a `StoredText` in `chrome.storage.session` — the
 *  base64 string in the gzipped case (what JSON-stringify will
 *  actually charge), the UTF-8 length of the text in the plain
 *  case. Used by the quota-breakdown formatter so the "needs N MB"
 *  total matches the stored form rather than the user's text. */
export function storedTextBytes(stored: StoredText): number {
  return stored.kind === 'plain' ? stored.uncompressedBytes : stored.base64.length;
}

/** True iff `stored` was actually compressed (i.e. we'd label the
 *  breakdown part "compressed HTML" rather than "HTML"). */
export function isCompressed(stored: StoredText): boolean {
  return stored.kind === 'gzip-base64';
}

// --- gzip / base64 plumbing -------------------------------------

async function gzip(text: string): Promise<Uint8Array> {
  // `CompressionStream` accepts a Blob source; piping through it
  // and consuming via Response gives us the gzipped bytes without
  // hand-rolling chunk plumbing.
  const stream = new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  // `new Blob([Uint8Array])` types `bytes.buffer` as
  // ArrayBufferLike, which TS won't widen to ArrayBuffer; copy into
  // a fresh buffer to keep the constructor happy.
  const blob = new Blob([new Uint8Array(bytes)]);
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

/** Chunked binary→base64. Mirrors the helper in `capture.ts` —
 *  CHUNK well under V8's spread/apply argument-count limit so we
 *  don't blow the stack on multi-MB inputs. */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
