// Unit tests for the URL-glob matcher used by Ask AI's
// `excludeUrlPatterns`. The matcher converts a glob (`*` wildcard +
// literal text) into an anchored case-insensitive regex; tests cover
// the basic semantics plus the regression that motivated the test —
// catastrophic backtracking when a pattern has multiple `*`s.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { globMatch, matchesAny } from '../../dist/background/ask/index.js';

test('globMatch: literal prefix with trailing wildcard', () => {
  assert.equal(globMatch('https://claude.ai/settings', 'https://claude.ai/settings*'), true);
  assert.equal(globMatch('https://claude.ai/settings/profile', 'https://claude.ai/settings*'), true);
  assert.equal(globMatch('https://claude.ai/chat/abc', 'https://claude.ai/settings*'), false);
});

test('globMatch: matches query strings and fragments via trailing *', () => {
  assert.equal(globMatch('https://claude.ai/settings?x=1', 'https://claude.ai/settings*'), true);
  assert.equal(globMatch('https://claude.ai/settings#frag', 'https://claude.ai/settings*'), true);
});

test('globMatch: anchored — partial-pattern matches do not pass', () => {
  // The pattern is anchored ^…$, so a URL that *contains* the pattern
  // somewhere doesn't match unless wildcards bracket it.
  assert.equal(globMatch('https://claude.ai/settings', 'claude.ai/settings'), false);
  assert.equal(globMatch('https://claude.ai/settings', '*claude.ai/settings*'), true);
});

test('globMatch: regex specials in pattern are escaped', () => {
  assert.equal(globMatch('https://example.com/a.b', 'https://example.com/a.b'), true);
  // `.` is a literal dot, not "any char": `aXb` should not match.
  assert.equal(globMatch('https://example.com/aXb', 'https://example.com/a.b'), false);
  // Other specials: + ? ^ $ { } ( ) | [ ] \
  assert.equal(globMatch('a+b', 'a+b'), true);
  assert.equal(globMatch('aab', 'a+b'), false);
  assert.equal(globMatch('a(b)c', 'a(b)c'), true);
});

test('globMatch: case-insensitive', () => {
  assert.equal(globMatch('https://Claude.AI/settings', 'https://claude.ai/settings'), true);
  assert.equal(globMatch('HTTPS://CLAUDE.AI/SETTINGS', 'https://claude.ai/settings'), true);
});

test('globMatch: multiple consecutive wildcards do not backtrack', () => {
  // Regression: a naive `.replace(/\*/g, '.*')` would turn `**foo`
  // into `.*.*foo`, which on a non-matching URL produces exponential
  // backtracking. With the `*+` collapse we should resolve in micros.
  const start = Date.now();
  assert.equal(
    globMatch(
      'https://claude.ai/this-is-a-tab-that-does-not-end-in-bar',
      'https://*.*.*.*.*.*.*.*.*.*.*.*.*.*.*.*.*.*.*.*.*bar',
    ),
    false,
  );
  // Ten seconds is generous; the actual time is sub-millisecond.
  // The pre-fix version did not finish in minutes.
  assert.ok(Date.now() - start < 10_000, 'globMatch took too long — backtracking?');
});

test('globMatch: bare `*` matches any non-empty URL', () => {
  // Documented quirk — used as a "watch out for this" in providers.ts.
  assert.equal(globMatch('https://anywhere.example.com/x', '*'), true);
  // Empty URLs are guarded at the matchesAny() layer below.
  assert.equal(globMatch('', '*'), true);
});

test('matchesAny: empty URL is never matched', () => {
  // Defends against a stray `*` exclusion silently dropping tabs
  // whose URL is missing or empty.
  assert.equal(matchesAny('', ['*']), false);
  assert.equal(matchesAny('', ['https://claude.ai/settings*']), false);
});

test('matchesAny: returns true on first matching pattern', () => {
  const url = 'https://claude.ai/projects/abc';
  const patterns = [
    'https://claude.ai/settings*',
    'https://claude.ai/projects*',
    'https://claude.ai/customize*',
  ];
  assert.equal(matchesAny(url, patterns), true);
});

test('matchesAny: returns false when no pattern matches', () => {
  const url = 'https://claude.ai/chat/abc-def';
  const patterns = [
    'https://claude.ai/settings*',
    'https://claude.ai/projects*',
  ];
  assert.equal(matchesAny(url, patterns), false);
});
