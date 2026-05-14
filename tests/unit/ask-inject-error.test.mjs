import { test } from 'node:test';
import assert from 'node:assert/strict';

import { friendlyInjectError } from '../../dist/background/ask/index.js';

test('friendlyInjectError: returns generic message for unrecognized errors', () => {
  const err = new Error('Some random error');
  assert.equal(friendlyInjectError(err), 'Check if the tab is on a prompt screen.');
});

test('friendlyInjectError: returns raw message for ExtensionsSettings policy block', () => {
  const errMsg = 'This page cannot be scripted due to an ExtensionsSettings policy.';
  const err = new Error(errMsg);
  assert.equal(friendlyInjectError(err), errMsg);
});

test('friendlyInjectError: defensive — returns raw message for any "cannot be scripted" variant', () => {
  // The known Chrome string already contains "ExtensionsSettings", so the
  // /cannot be scripted/i branch is purely defensive: it catches hypothetical
  // future Chrome wording that drops the identifier but keeps the phrasing.
  // The string below is synthetic — not a real Chrome message.
  const errMsg = 'synthetic: page cannot be scripted by this extension';
  const err = new Error(errMsg);
  assert.equal(friendlyInjectError(err), errMsg);
});

test('friendlyInjectError: handles string errors', () => {
  assert.equal(friendlyInjectError('ExtensionsSettings policy block'), 'ExtensionsSettings policy block');
});
