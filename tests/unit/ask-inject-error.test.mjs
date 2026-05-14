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

test('friendlyInjectError: returns raw message for cannot be scripted error', () => {
  const errMsg = 'Cannot access contents of the page. Extension cannot be scripted here.';
  const err = new Error(errMsg);
  assert.equal(friendlyInjectError(err), errMsg);
});

test('friendlyInjectError: handles string errors', () => {
  assert.equal(friendlyInjectError('ExtensionsSettings policy block'), 'ExtensionsSettings policy block');
});
