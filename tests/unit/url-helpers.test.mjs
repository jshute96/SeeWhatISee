// Unit tests for `src/url-helpers.ts`. Today that's just the Ask
// menu's `firstUrlSegment` (path-segment extraction with 20-char
// truncation) and `excludedSuffix` wrapping it in the user-facing
// "(Wrong page: …)" form. The 20-char truncation in particular is
// hard to exercise from the e2e suite — fixture pages live at
// short paths — so we cover it here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  firstUrlSegment,
  excludedSuffix,
} from '../../dist/url-helpers.js';

test('firstUrlSegment: typical claude.ai paths', () => {
  assert.equal(firstUrlSegment('https://claude.ai/settings'), '/settings');
  assert.equal(firstUrlSegment('https://claude.ai/recents'), '/recents');
  assert.equal(
    firstUrlSegment('https://claude.ai/settings/profile'),
    '/settings',
  );
});

test('firstUrlSegment: trailing slash and empty path return empty', () => {
  // No segment to surface — caller falls back to a bare suffix.
  assert.equal(firstUrlSegment('https://claude.ai/'), '');
  assert.equal(firstUrlSegment('https://claude.ai'), '');
});

test('firstUrlSegment: query string / fragment do not affect segmentation', () => {
  assert.equal(
    firstUrlSegment('https://claude.ai/chat/abc?x=1#frag'),
    '/chat',
  );
  assert.equal(
    firstUrlSegment('https://claude.ai/settings?from=onboarding'),
    '/settings',
  );
});

test('firstUrlSegment: long segment truncates at 20 chars + ...', () => {
  // The fixture-page e2e test only exercises short segments.
  // Verify the truncation explicitly here.
  // 21 chars including the leading slash → trims to 20 + "...".
  const url = 'https://example.com/abcdefghijklmnopqrst';
  assert.equal(firstUrlSegment(url), '/abcdefghijklmnopqrs...');
  // Boundary: exactly 20 chars (leading slash + 19 chars) — no
  // truncation.
  assert.equal(
    firstUrlSegment('https://example.com/abcdefghijklmnopqrs'),
    '/abcdefghijklmnopqrs',
  );
});

test('firstUrlSegment: unparseable input returns empty string', () => {
  assert.equal(firstUrlSegment(''), '');
  assert.equal(firstUrlSegment('not a url'), '');
});

test('excludedSuffix: includes the segment when present', () => {
  assert.equal(
    excludedSuffix('https://claude.ai/settings/profile'),
    '(Wrong page: /settings)',
  );
  assert.equal(
    excludedSuffix('https://example.com/abcdefghijklmnopqrst'),
    '(Wrong page: /abcdefghijklmnopqrs...)',
  );
});

test('excludedSuffix: falls back to bare suffix when no segment', () => {
  // Trailing-slash and unparseable both yield a bare suffix so the
  // user still sees "this is excluded" without an empty parenthetical.
  assert.equal(excludedSuffix('https://claude.ai/'), '(Wrong page)');
  assert.equal(excludedSuffix(''), '(Wrong page)');
});
