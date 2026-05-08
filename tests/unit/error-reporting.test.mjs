// Unit tests for the pure helper in
// `src/background/error-reporting.ts` — `friendlyErrorMessage`.
// The error-reporting module itself imports `chrome.tabs` for the
// page-opening helpers, but `friendlyErrorMessage` only touches its
// argument, so it tests cleanly without a chrome mock.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { friendlyErrorMessage } from '../../dist/background/error-reporting.js';

test('rewrites: "No active tab found to capture"', () => {
  const out = friendlyErrorMessage(new Error('No active tab found to capture'));
  assert.match(out, /Couldn't find a tab to capture/);
  // Names the common case (chrome:// pages) without enumerating
  // every speculative cause.
  assert.match(out, /Browser-internal and chrome:\/\/ pages cannot be captured/);
});

test('rewrites: "Failed to retrieve page contents"', () => {
  const out = friendlyErrorMessage(new Error('Failed to retrieve page contents'));
  assert.match(out, /Couldn't read this page's contents/);
  assert.match(out, /Browser-internal and chrome:\/\/ pages cannot be captured/);
});

test('rewrites: "No text selected"', () => {
  const out = friendlyErrorMessage(new Error('No text selected'));
  assert.match(out, /No text is selected/);
  assert.match(out, /Highlight some text/);
});

test('rewrites: per-format "No selection X content" family', () => {
  // All three formats hit the same rewrite — generated from
  // `noSelectionContentMessage` so the throw sites and the rewrite
  // can't drift.
  for (const format of ['html', 'text', 'markdown']) {
    const raw = `No selection ${format} content`;
    const out = friendlyErrorMessage(new Error(raw));
    assert.match(
      out,
      /didn't include anything in this format/,
      `format=${format}`,
    );
  }
});

test('rewrites: "No captures in the log to copy from"', () => {
  const out = friendlyErrorMessage(new Error('No captures in the log to copy from'));
  assert.match(out, /No captures yet/);
  assert.match(out, /Save a screenshot or HTML/);
});

test('passthrough: "Latest capture has no … to copy" family stays verbatim', () => {
  // These read fine on their own — the friendly layer should leave
  // them alone rather than dress them up with extra advice.
  for (const artifact of ['screenshot', 'HTML snapshot', 'selection']) {
    const raw = `Latest capture has no ${artifact} to copy`;
    assert.equal(friendlyErrorMessage(new Error(raw)), raw, `artifact=${artifact}`);
  }
});

test('rewrites: "Cannot access contents of the page" (substring match)', () => {
  // Chrome's full message often includes a tail like "Extension
  // manifest must request permission to access the respective host."
  // Substring match handles that and any locale-specific tails.
  const raw = 'Cannot access contents of the page. Extension manifest must request permission to access the respective host.';
  const out = friendlyErrorMessage(new Error(raw));
  assert.match(out, /Couldn't access this page/);
  assert.match(out, /Browser-internal and chrome:\/\/ pages cannot be captured/);
});

test('rewrites: tab-drag-in-progress', () => {
  const raw = 'Tabs cannot be edited right now (user may be dragging a tab).';
  const out = friendlyErrorMessage(new Error(raw));
  assert.match(out, /Browser is busy/);
  assert.match(out, /Try again in a moment/);
});

test('passes unrecognized messages through verbatim', () => {
  const raw = 'something the friendly map has never seen';
  assert.equal(friendlyErrorMessage(new Error(raw)), raw);
});

test('handles non-Error values by stringifying them', () => {
  // Real throw sites are Error instances, but `runWithErrorReporting`
  // funnels through unknown rejection values — Strings, plain
  // objects, etc. The helper should at least not throw.
  assert.equal(friendlyErrorMessage('plain string'), 'plain string');
  assert.equal(friendlyErrorMessage(42), '42');
  assert.equal(friendlyErrorMessage(undefined), 'undefined');
});
