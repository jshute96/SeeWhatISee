// Unit tests for the transparent gzip packing used on large text
// bodies bound for `chrome.storage.session` (today: page HTML).
//
// The contract worth pinning down is that packing is *optional and
// invisible*: small bodies and bodies that don't compress ride
// through as plain strings, every consumer can call `unpackText` on
// whatever it's holding, and the size helpers answer correctly for
// both forms.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isBlankText,
  isEmptyText,
  isPackedText,
  originalByteLength,
  packText,
  storedLength,
  unpackText,
  utf8ByteLength,
} from '../../dist/capture/packed-text.js';

/** Repetitive HTML-ish filler, in the spirit of what a real page
 *  looks like to gzip: lots of repeated tag and class names. */
function bloatedHtml(approxBytes) {
  const chunk =
    '<div class="row item"><span class="label">Name</span>'
    + '<span class="value">Value</span></div>\n';
  return `<!doctype html><html><body>${chunk.repeat(
    Math.ceil(approxBytes / chunk.length),
  )}</body></html>`;
}

/** High-entropy filler that gzip can't shrink — base64 then makes
 *  the packed form strictly bigger, which is the case `packText` has
 *  to detect and decline. */
function incompressible(bytes) {
  let s = '';
  for (let i = 0; i < bytes; i++) {
    s += String.fromCharCode(33 + Math.floor(Math.random() * 94));
  }
  return s;
}

test('packText: small bodies stay plain strings', async () => {
  const small = bloatedHtml(1000);
  const packed = await packText(small);
  assert.equal(packed, small);
  assert.equal(isPackedText(packed), false);
});

test('packText: large compressible bodies pack, and round-trip exactly', async () => {
  const html = bloatedHtml(400_000);
  const packed = await packText(html);
  assert.equal(isPackedText(packed), true);
  assert.equal(await unpackText(packed), html);
});

test('packText: packing a large HTML body is a big storage win', async () => {
  const html = bloatedHtml(400_000);
  const packed = await packText(html);
  // Repetitive markup should beat 4:1 even after base64's 33%.
  assert.ok(
    storedLength(packed) < storedLength(html) / 4,
    `expected >4x saving, got ${storedLength(html)} -> ${storedLength(packed)}`,
  );
});

test('packText: declines when gzip + base64 would be bigger', async () => {
  const noise = incompressible(200_000);
  const packed = await packText(noise);
  assert.equal(isPackedText(packed), false);
  assert.equal(packed, noise);
});

test('unpackText: a plain string passes straight through', async () => {
  assert.equal(await unpackText('<p>hi</p>'), '<p>hi</p>');
  assert.equal(await unpackText(''), '');
});

test('round-trip preserves non-ASCII exactly', async () => {
  // UTF-8 matters twice over: the gzip input encoding and the byte
  // count reported to the caller.
  const html = `<p>${'héllo — 世界 🌍 '.repeat(30_000)}</p>`;
  const packed = await packText(html);
  assert.equal(isPackedText(packed), true);
  assert.equal(await unpackText(packed), html);
  assert.equal(originalByteLength(packed), utf8ByteLength(html));
  // The point of the test: byte length is well above code-unit length.
  assert.ok(utf8ByteLength(html) > html.length);
});

test('originalByteLength reports source bytes for both forms', async () => {
  const html = bloatedHtml(200_000);
  const raw = utf8ByteLength(html);
  assert.equal(originalByteLength(html), raw);
  assert.equal(originalByteLength(await packText(html)), raw);
});

test('storedLength reports what storage would charge, not source bytes', async () => {
  const html = bloatedHtml(200_000);
  const packed = await packText(html);
  assert.ok(storedLength(packed) < originalByteLength(packed));
  // A plain string is charged its JSON form — bytes plus the quotes
  // and any escaping.
  assert.equal(storedLength('a"b'), JSON.stringify('a"b').length);
});

test('isEmptyText covers both forms and undefined', async () => {
  assert.equal(isEmptyText(''), true);
  assert.equal(isEmptyText(undefined), true);
  assert.equal(isEmptyText('<p>x</p>'), false);
  assert.equal(isEmptyText(await packText(bloatedHtml(200_000))), false);
  // The regression this helper exists for: a bare truthiness test
  // passes for any packed object, so an empty one would read as
  // present.
  assert.equal(isEmptyText({ z: 'gzip', d: '', n: 0 }), true);
});

test('isBlankText: whitespace counts as blank for plain bodies', async () => {
  assert.equal(isBlankText(''), true);
  assert.equal(isBlankText('   \n\t '), true);
  assert.equal(isBlankText(undefined), true);
  assert.equal(isBlankText('<p>x</p>'), false);
  assert.equal(isBlankText(await packText(bloatedHtml(200_000))), false);
});

test('isBlankText: a packed body is never blank unless its length is 0', () => {
  // Documented quirk: the whole point is to answer without
  // decompressing, so a packed body is judged by its recorded byte
  // count. 64 KiB of pure whitespace would therefore read as
  // contentful — absurd enough to accept, and the unpacked check
  // downstream still refuses it.
  assert.equal(isBlankText({ z: 'gzip', d: 'x', n: 100 }), false);
  assert.equal(isBlankText({ z: 'gzip', d: '', n: 0 }), true);
});

test('storedLength / originalByteLength are total over undefined', () => {
  assert.equal(storedLength(undefined), 0);
  assert.equal(originalByteLength(undefined), 0);
});

test('isPackedText rejects look-alikes', () => {
  assert.equal(isPackedText(null), false);
  assert.equal(isPackedText('gzip'), false);
  assert.equal(isPackedText({ z: 'brotli', d: 'x', n: 1 }), false);
  assert.equal(isPackedText({ z: 'gzip', d: 'x' }), false);
  assert.equal(isPackedText({ z: 'gzip', d: 'x', n: 1 }), true);
});
