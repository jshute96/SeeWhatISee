// Unit tests for the Ask provider settings normalizer. Covers the
// two invariants we expect on every read AND write:
//   1. `enabled` always has a boolean entry per registered provider id.
//   2. `default` is either null or the id of an enabled provider; if
//      the stored default points at a now-disabled provider, normalize
//      auto-shifts it to the next enabled provider in label-order
//      (wrapping); if no provider is enabled, default becomes null.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ASK_PROVIDER_SETTINGS,
  normalizeAskProviderSettings,
  pickNextEnabledDefault,
} from '../../dist/background/ask/settings.js';

test('normalize: undefined → factory defaults', () => {
  assert.deepEqual(
    normalizeAskProviderSettings(undefined),
    DEFAULT_ASK_PROVIDER_SETTINGS,
  );
});

test('normalize: empty object → factory defaults', () => {
  assert.deepEqual(
    normalizeAskProviderSettings({}),
    DEFAULT_ASK_PROVIDER_SETTINGS,
  );
});

test('normalize: missing per-provider enabled → factory true defaults', () => {
  const out = normalizeAskProviderSettings({ enabled: {}, default: 'claude' });
  assert.equal(out.enabled.claude, true);
  assert.equal(out.enabled.gemini, true);
  assert.equal(out.enabled.chatgpt, true);
  assert.equal(out.default, 'claude');
});

test('normalize: stored default disabled → shifts to next enabled (label order)', () => {
  // Disable Claude (the stored default). Next enabled in label order
  // (ChatGPT, Claude, Gemini) is Gemini.
  const out = normalizeAskProviderSettings({
    enabled: { claude: false, chatgpt: true, gemini: true },
    default: 'claude',
  });
  assert.equal(out.default, 'gemini');
});

test('normalize: stored default disabled, only ChatGPT enabled → shifts to ChatGPT (wraparound)', () => {
  // Pin disabled, Gemini disabled, only ChatGPT enabled — wrapping
  // around past Gemini lands on ChatGPT.
  const out = normalizeAskProviderSettings({
    enabled: { claude: false, gemini: false, chatgpt: true },
    default: 'claude',
  });
  assert.equal(out.default, 'chatgpt');
});

test('normalize: all disabled → default becomes null', () => {
  const out = normalizeAskProviderSettings({
    enabled: { claude: false, gemini: false, chatgpt: false },
    default: 'claude',
  });
  assert.equal(out.default, null);
});

test('normalize: missing default but providers enabled → factory default (Claude) wins', () => {
  const out = normalizeAskProviderSettings({
    enabled: { claude: true, gemini: true, chatgpt: true },
    // default omitted entirely
  });
  // We seed with the factory default before validation so a partial
  // settings object lands on Claude, not the alphabetical-first entry.
  assert.equal(out.default, 'claude');
});

test('normalize: bogus default string → factory default seeded, shifts if disabled', () => {
  const out = normalizeAskProviderSettings({
    enabled: { claude: true, gemini: false, chatgpt: false },
    default: 'not-a-provider',
  });
  assert.equal(out.default, 'claude');
});

test('pickNextEnabledDefault: rotation order is ChatGPT → Claude → Gemini', () => {
  const all = { claude: true, gemini: true, chatgpt: true };
  assert.equal(pickNextEnabledDefault('chatgpt', all), 'claude');
  assert.equal(pickNextEnabledDefault('claude', all), 'gemini');
  assert.equal(pickNextEnabledDefault('gemini', all), 'chatgpt');
});

test('pickNextEnabledDefault: skips disabled providers', () => {
  // From Claude with Gemini disabled → wraps to ChatGPT.
  assert.equal(
    pickNextEnabledDefault('claude', { claude: true, gemini: false, chatgpt: true }),
    'chatgpt',
  );
});

test('pickNextEnabledDefault: from null starts at top of rotation', () => {
  const all = { claude: true, gemini: true, chatgpt: true };
  assert.equal(pickNextEnabledDefault(null, all), 'chatgpt');
});

test('pickNextEnabledDefault: returns null when nothing is enabled', () => {
  assert.equal(
    pickNextEnabledDefault('claude', { claude: false, gemini: false, chatgpt: false }),
    null,
  );
});
