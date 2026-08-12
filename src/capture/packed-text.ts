// Transparent gzip packing for the large text bodies we park in
// `chrome.storage.session` — the scraped page HTML and the three
// selection formats.
//
// Why: session storage is 10 MiB total, shared by every Capture-page
// session and every Ask-widget record, and page HTML is the artifact
// most likely to be huge (heavy SPAs inline megabytes of CSS, fonts
// and base64 assets into `documentElement.outerHTML`). HTML is also
// highly repetitive, so gzip typically wins 4:1 or better — which
// buys back most of the headroom the cap was spending.
//
// The packed form is a plain JSON object, because that's what
// `chrome.storage.session` accepts. Binary has to become a string,
// and base64 is the only encoding that survives JSON without the
// escaping blowing the saving back up. Base64 costs 33% on top of
// the gzip output, so the realistic end-to-end win is ~3:1 rather
// than the raw gzip ratio.
//
// Two rules keep this from ever being a pessimization:
//
//   - Bodies under `PACK_MIN_BYTES` are left alone. The saving is
//     irrelevant at that size and a plain string is far easier to
//     read in a storage dump while debugging.
//   - The packed form is kept only if its *stored* cost (what
//     `getBytesInUse` would charge, i.e. the JSON-stringified
//     length) actually beats the plain string's. Already-compressed
//     or high-entropy bodies fail this and ride through unpacked.
//
// So `MaybePackedText` really is "maybe": every consumer has to go
// through `unpackText` (or the length helpers) rather than assuming
// either representation.

/**
 * A gzipped, base64-encoded text body.
 *
 * Field names are deliberately short — this shape is stored once per
 * capture session and re-serialized on every session write, so the
 * key names are pure overhead. `z` doubles as the discriminator
 * against a plain string and as room for a future codec.
 */
export interface PackedText {
  z: 'gzip';
  /** base64 of the gzip byte stream. */
  d: string;
  /** UTF-8 byte length of the *original* text. Kept so size
   *  readouts and cap checks don't have to decompress. */
  n: number;
}

/** A text body that may or may not be gzip-packed. */
export type MaybePackedText = string | PackedText;

/**
 * Bodies at or below this stay plain. Chosen well above any
 * realistic "small page" so ordinary captures never pay the
 * compress/decompress round-trip, and well below the size at which
 * storage pressure starts to matter.
 */
const PACK_MIN_BYTES = 64 * 1024;

export function isPackedText(v: unknown): v is PackedText {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Partial<PackedText>;
  return p.z === 'gzip' && typeof p.d === 'string' && typeof p.n === 'number';
}

/** UTF-8 byte length of `s`. Not `.length` (which counts UTF-16
 *  code units and mis-sizes CJK / emoji pages by ~2×). */
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * UTF-8 byte length of the *original* text, whichever form it's in.
 * This is the number to show the user — it's what they'd see if they
 * viewed the source or looked at the saved file on disk.
 */
export function originalByteLength(v: MaybePackedText | undefined): number {
  if (v === undefined) return 0;
  return isPackedText(v) ? v.n : utf8ByteLength(v);
}

/**
 * What this body costs in `chrome.storage.session`, using the same
 * `JSON.stringify(value).length` accounting `getBytesInUse` does.
 * This is the number to check caps against.
 */
export function storedLength(v: MaybePackedText | undefined): number {
  // `undefined` accepted so the module is uniformly total, matching
  // `isEmptyText` / `isBlankText`. `JSON.stringify(undefined)` returns
  // `undefined`, not a string, so `.length` would throw here.
  return v === undefined ? 0 : JSON.stringify(v).length;
}

/** True when the body is empty in either representation. Replaces
 *  the bare `if (capture.html)` truthiness test, which a packed
 *  object would pass unconditionally. */
export function isEmptyText(v: MaybePackedText | undefined): boolean {
  return v === undefined || (isPackedText(v) ? v.n === 0 : v.length === 0);
}

/**
 * True when the body has no non-whitespace content — the
 * "is this artifact worth offering to save" test.
 *
 * Answers without decompressing: nothing under `PACK_MIN_BYTES`
 * gets packed, so a packed body is 64 KiB+ and treating it as
 * contentful is right in every case but a selection made entirely
 * of 64 KiB of whitespace. That one would be offered for save and
 * then correctly refused downstream, where the body is unpacked
 * before its own emptiness check.
 */
export function isBlankText(v: MaybePackedText | undefined): boolean {
  if (v === undefined) return true;
  return isPackedText(v) ? v.n === 0 : v.trim().length === 0;
}

/**
 * Pack `s` if it's big enough to be worth it and gzip actually wins.
 * Returns the original string otherwise, so the result is safe to
 * store either way.
 *
 * Never throws: a missing `CompressionStream` (or any encode
 * failure) falls back to the plain string. Compression is an
 * optimization, and losing it should cost storage headroom, not the
 * capture.
 */
export async function packText(
  s: string,
  /** UTF-8 byte length of `s`, when the caller already measured it.
   *  Saves re-encoding a multi-MB body just to count it. */
  knownByteLength?: number,
): Promise<MaybePackedText> {
  const bytes = knownByteLength ?? utf8ByteLength(s);
  if (bytes <= PACK_MIN_BYTES) return s;
  if (typeof CompressionStream === 'undefined') return s;
  let packed: PackedText;
  try {
    const gz = await gzip(s);
    packed = { z: 'gzip', d: bytesToBase64(gz), n: bytes };
  } catch (err) {
    // Handled: the caller stores the plain string instead.
    console.info('[SeeWhatISee] text pack failed:', err);
    return s;
  }
  // High-entropy bodies (already-compressed inline assets, random
  // data) can pack *larger* than the original once base64 is paid.
  return storedLength(packed) < storedLength(s) ? packed : s;
}

/**
 * Recover the original text. A plain string passes straight through,
 * so callers can hand this any `MaybePackedText` without checking.
 *
 * Unlike `packText` this *does* throw on a corrupt payload — by the
 * time we're unpacking, the plain body is gone and there's no
 * fallback to silently take. Callers surface it the same way they
 * already surface a missing artifact.
 */
export async function unpackText(v: MaybePackedText): Promise<string> {
  if (!isPackedText(v)) return v;
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Cannot read compressed content: DecompressionStream unavailable');
  }
  return gunzip(base64ToBytes(v.d));
}

async function gzip(s: string): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([s]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  // `Response.text()` decodes as UTF-8, which is what `gzip` encoded.
  return new Response(stream).text();
}

/** Chunked so a multi-MB body can't blow V8's argument-count limit
 *  on the spread into `String.fromCharCode`. */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
