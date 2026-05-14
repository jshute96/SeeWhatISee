// Unit tests for `src/background/text-compression.ts`. Exercises the
// plain / gzip-base64 branches, the round-trip via `readStoredText`,
// and the too-large rejection at the 2 MiB compressed cap.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STORED_TEXT_COMPRESS_THRESHOLD_BYTES,
  STORED_TEXT_HARD_CAP_BYTES_DEFAULT,
  prepareStoredText,
  readStoredText,
  storedTextBytes,
  isCompressed,
} from '../../dist/background/text-compression.js';

// Tests authored against the production default cap — alias so the
// existing assertions read the same.
const STORED_TEXT_HARD_CAP_BYTES = STORED_TEXT_HARD_CAP_BYTES_DEFAULT;

test('prepareStoredText: tiny input stays `plain`', async () => {
  const r = await prepareStoredText('hello world');
  assert.equal(r.ok, true);
  assert.equal(r.stored.kind, 'plain');
  assert.equal(r.stored.text, 'hello world');
  assert.equal(r.stored.uncompressedBytes, 11);
  assert.equal(isCompressed(r.stored), false);
  assert.equal(storedTextBytes(r.stored), 11);
});

test('prepareStoredText: exactly-threshold input stays `plain`', async () => {
  const text = 'x'.repeat(STORED_TEXT_COMPRESS_THRESHOLD_BYTES);
  const r = await prepareStoredText(text);
  assert.equal(r.ok, true);
  assert.equal(r.stored.kind, 'plain');
});

test('prepareStoredText: input over threshold compresses', async () => {
  // 'x' repeated compresses extremely well, so it lands far below
  // the 2 MiB hard cap. Useful as the canonical "did we take the
  // compress branch" assertion.
  const text = 'x'.repeat(STORED_TEXT_COMPRESS_THRESHOLD_BYTES + 1);
  const r = await prepareStoredText(text);
  assert.equal(r.ok, true);
  assert.equal(r.stored.kind, 'gzip-base64');
  assert.ok(r.stored.compressedBytes < text.length);
  assert.equal(r.stored.uncompressedBytes, text.length);
  assert.equal(isCompressed(r.stored), true);
});

test('prepareStoredText: UTF-8 multibyte chars are counted in bytes, not code units', async () => {
  // 'é' is 2 bytes in UTF-8, 1 code unit in UTF-16. The threshold
  // contract is bytes-based; verify counting tracks that.
  const text = 'é'.repeat(60_000); // 120 000 bytes — over the 100 KiB threshold.
  const r = await prepareStoredText(text);
  assert.equal(r.ok, true);
  assert.equal(r.stored.kind, 'gzip-base64');
  assert.equal(r.stored.uncompressedBytes, 120_000);
});

test('readStoredText: round-trip on plain', async () => {
  const original = 'short text';
  const prepared = await prepareStoredText(original);
  assert.equal(prepared.ok, true);
  const restored = await readStoredText(prepared.stored);
  assert.equal(restored, original);
});

test('prepareStoredText / readStoredText: empty string round-trip', async () => {
  // `captureBothToMemory` emits empty strings for selection bodies
  // on pages with no selection, so the empty path matters.
  const prepared = await prepareStoredText('');
  assert.equal(prepared.ok, true);
  assert.equal(prepared.stored.kind, 'plain');
  assert.equal(prepared.stored.text, '');
  assert.equal(prepared.stored.uncompressedBytes, 0);
  const restored = await readStoredText(prepared.stored);
  assert.equal(restored, '');
});

test('readStoredText: round-trip on gzip-base64', async () => {
  // A repeating-but-not-trivial payload exercises both the gzip
  // encoder and the multi-chunk base64 path.
  const block = 'The quick brown fox jumps over the lazy dog.\n';
  const original = block.repeat(5000); // 225 000 bytes, plenty over threshold.
  const prepared = await prepareStoredText(original);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.stored.kind, 'gzip-base64');
  const restored = await readStoredText(prepared.stored);
  assert.equal(restored, original);
});

test('prepareStoredText: refuses content whose compressed form exceeds the cap', async () => {
  // True random bytes don't compress, so we use crypto-quality
  // randomness to guarantee the gzip output stays above 2 MiB. A
  // pseudo-random arithmetic sequence (e.g. `i * prime % 94`) has
  // enough structure for gzip to shrink it; only real randomness
  // is reliably incompressible.
  const { webcrypto } = await import('node:crypto');
  const buf = new Uint8Array(3 * 1024 * 1024);
  // `getRandomValues` caps at 65 536 bytes per call, so fill in
  // chunks.
  for (let i = 0; i < buf.length; i += 65_536) {
    webcrypto.getRandomValues(buf.subarray(i, Math.min(i + 65_536, buf.length)));
  }
  // Coerce to printable ASCII so it's a valid string but stays
  // high-entropy.
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    const slice = buf.subarray(i, i + CHUNK);
    let bin = '';
    for (let j = 0; j < slice.length; j++) {
      bin += String.fromCharCode(33 + (slice[j] % 94));
    }
    s += bin;
  }
  const r = await prepareStoredText(s);
  assert.equal(r.ok, false);
  assert.ok(r.compressedBytes > STORED_TEXT_HARD_CAP_BYTES);
  assert.match(r.message, /^Content too large:/);
  assert.match(r.message, /compressed/);
  assert.match(r.message, /limit 2 MB/);
});

test('storedTextBytes: reports the base64 length for gzipped, byte length for plain', async () => {
  const small = await prepareStoredText('abc');
  assert.equal(small.ok, true);
  assert.equal(storedTextBytes(small.stored), 3);

  const big = await prepareStoredText('y'.repeat(STORED_TEXT_COMPRESS_THRESHOLD_BYTES + 1));
  assert.equal(big.ok, true);
  assert.equal(big.stored.kind, 'gzip-base64');
  // base64 inflates raw bytes by ~33%, so the reported stored size
  // is between the gzip raw size and ⌈gzipRaw * 4 / 3⌉.
  const expectedFloor = big.stored.compressedBytes;
  const expectedCeil = Math.ceil(big.stored.compressedBytes * 4 / 3) + 4;
  assert.ok(storedTextBytes(big.stored) >= expectedFloor);
  assert.ok(storedTextBytes(big.stored) <= expectedCeil);
});
