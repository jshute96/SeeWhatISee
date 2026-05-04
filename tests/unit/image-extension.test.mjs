// Unit tests for `imageExtensionFor` in `src/capture.ts` — the
// fallback table + URL-pathname + `.unknown` ladder used by the
// image right-click capture path. End-to-end tests cover the
// known-MIME case (PNG and JPEG); the off-table and unknown paths
// only get exercised here, since they require synthetic MIME /
// URL combinations the fixture server can't produce on its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { imageExtensionFor } from '../../dist/capture.js';

test('imageExtensionFor: known MIMEs use the canonical short table form', () => {
  assert.equal(imageExtensionFor('image/png', 'https://example.com/p'), 'png');
  // jpeg → jpg, not "jpeg" — matches what the rest of the system
  // and downstream tools key off.
  assert.equal(imageExtensionFor('image/jpeg', 'https://example.com/p'), 'jpg');
  assert.equal(imageExtensionFor('image/jpg', 'https://example.com/p'), 'jpg');
  assert.equal(imageExtensionFor('image/webp', 'https://example.com/p'), 'webp');
  assert.equal(imageExtensionFor('image/gif', 'https://example.com/p'), 'gif');
  // svg+xml → svg (strip the structured-suffix).
  assert.equal(imageExtensionFor('image/svg+xml', 'https://example.com/p'), 'svg');
  assert.equal(imageExtensionFor('image/avif', 'https://example.com/p'), 'avif');
  assert.equal(imageExtensionFor('image/bmp', 'https://example.com/p'), 'bmp');
  // x-icon and the IANA-registered alias both map to ico.
  assert.equal(imageExtensionFor('image/x-icon', 'https://example.com/p'), 'ico');
  assert.equal(
    imageExtensionFor('image/vnd.microsoft.icon', 'https://example.com/p'),
    'ico',
  );
});

test('imageExtensionFor: trims charset / parameters from the MIME', () => {
  assert.equal(
    imageExtensionFor('image/png; charset=utf-8', 'https://example.com/p'),
    'png',
  );
  assert.equal(
    imageExtensionFor('IMAGE/JPEG', 'https://example.com/p'),
    'jpg',
  );
});

test('imageExtensionFor: off-table MIME falls back to URL pathname extension', () => {
  // image/heic isn't in the table; pathname ends in `.heic` → ext = heic.
  assert.equal(
    imageExtensionFor('image/heic', 'https://example.com/photo.heic'),
    'heic',
  );
  // application/octet-stream is what some servers send for binary
  // data — entirely useless for ext picking, so URL fallback wins.
  assert.equal(
    imageExtensionFor('application/octet-stream', 'https://example.com/photo.jp2'),
    'jp2',
  );
});

test('imageExtensionFor: query string and fragment do not bleed into the ext', () => {
  // `.png?token=...` — the URL parser strips the query before our
  // pathname regex sees it, so `png` is what comes back.
  assert.equal(
    imageExtensionFor('application/octet-stream', 'https://example.com/photo.png?token=abc&v=2'),
    'png',
  );
  assert.equal(
    imageExtensionFor('application/octet-stream', 'https://example.com/photo.gif#section'),
    'gif',
  );
});

test('imageExtensionFor: data: URL with off-table MIME and no pathname ext returns unknown', () => {
  // `image/heic` not in the table; data: URL has no useful pathname.
  // The fallback is `unknown` — never `.png`, because misnaming
  // bytes by guessing is what the fallback was added to avoid.
  assert.equal(
    imageExtensionFor('image/heic', 'data:image/heic;base64,xxxx'),
    'unknown',
  );
});

test('imageExtensionFor: blob: URL with off-table MIME returns unknown', () => {
  assert.equal(
    imageExtensionFor('image/x-some-format', 'blob:https://example.com/uuid'),
    'unknown',
  );
});

test('imageExtensionFor: completely empty MIME and unparseable URL returns unknown', () => {
  assert.equal(imageExtensionFor('', 'not-a-valid-url'), 'unknown');
});

test('imageExtensionFor: pathname extension only used when 1-5 chars and alphanumeric', () => {
  // Longer-than-5 segment is rejected (avoids pulling weird trailing
  // strings out of clean URLs).
  assert.equal(
    imageExtensionFor('application/octet-stream', 'https://example.com/foo.verylongextension'),
    'unknown',
  );
  // Punctuation in the segment is rejected.
  assert.equal(
    imageExtensionFor('application/octet-stream', 'https://example.com/foo.png+bar'),
    'unknown',
  );
});
