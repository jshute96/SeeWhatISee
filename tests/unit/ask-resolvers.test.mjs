// Unit tests for the pure URL-aware resolvers used by the Ask flow:
//
//   - `resolveAcceptedKinds(provider, url)` — walks the provider's
//     `urlVariants` in declaration order; falls back to the provider-
//     level `acceptedAttachmentKinds`; finally returns `null` ("no
//     restriction").
//   - `resolveMaxAttachmentCount(provider, url)` — provider-level
//     today; returns `null` when no cap is declared.
//   - `resolveDestinationLabel(provider, url)` — same walk, returns
//     the matching variant's `label` if set, otherwise the provider's
//     own `label`.
//   - `formatKindList(kinds)` — friendly join used in the SW's
//     pre-send refusal error message.
//
// All pure functions — no chrome.* APIs touched — so they exercise
// cleanly under `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatKindList,
  resolveAcceptedKinds,
  resolveDestinationLabel,
  resolveMaxAttachmentCount,
} from '../../dist/ask/index.js';

const baseProvider = {
  id: 'claude',
  label: 'Claude',
  urlPatterns: ['https://claude.ai/*'],
  newTabUrl: 'https://claude.ai/new',
  enabled: true,
  selectors: {
    fileInput: ['input[type="file"]'],
    textInput: ['div[contenteditable="true"]'],
    submitButton: ['button[aria-label="Send"]'],
  },
};

test('resolveAcceptedKinds: no variants, no provider-level → null', () => {
  assert.equal(
    resolveAcceptedKinds(baseProvider, 'https://claude.ai/new'),
    null,
  );
});

test('resolveAcceptedKinds: variant matches → variant kinds', () => {
  const provider = {
    ...baseProvider,
    urlVariants: [
      { pattern: 'https://claude.ai/code*', acceptedAttachmentKinds: ['image'] },
    ],
  };
  assert.deepEqual(
    resolveAcceptedKinds(provider, 'https://claude.ai/code'),
    ['image'],
  );
  assert.deepEqual(
    resolveAcceptedKinds(provider, 'https://claude.ai/code/sess_abc'),
    ['image'],
  );
});

test('resolveAcceptedKinds: variant does not match → falls back to provider-level', () => {
  const provider = {
    ...baseProvider,
    acceptedAttachmentKinds: ['image', 'text'],
    urlVariants: [
      { pattern: 'https://claude.ai/code*', acceptedAttachmentKinds: ['image'] },
    ],
  };
  assert.deepEqual(
    resolveAcceptedKinds(provider, 'https://claude.ai/new'),
    ['image', 'text'],
  );
});

test('resolveAcceptedKinds: first matching variant wins (declaration order)', () => {
  const provider = {
    ...baseProvider,
    urlVariants: [
      { pattern: 'https://claude.ai/code*', acceptedAttachmentKinds: ['image'] },
      // Broader pattern declared later — would match too, but the
      // first match must win.
      { pattern: 'https://claude.ai/*', acceptedAttachmentKinds: ['text'] },
    ],
  };
  assert.deepEqual(
    resolveAcceptedKinds(provider, 'https://claude.ai/code'),
    ['image'],
  );
  assert.deepEqual(
    resolveAcceptedKinds(provider, 'https://claude.ai/new'),
    ['text'],
  );
});

test('resolveDestinationLabel: variant with label → variant label', () => {
  const provider = {
    ...baseProvider,
    urlVariants: [
      {
        pattern: 'https://claude.ai/code*',
        label: 'Claude Code',
        acceptedAttachmentKinds: ['image'],
      },
    ],
  };
  assert.equal(
    resolveDestinationLabel(provider, 'https://claude.ai/code'),
    'Claude Code',
  );
});

test('resolveDestinationLabel: variant matches but no label → provider label', () => {
  const provider = {
    ...baseProvider,
    urlVariants: [
      { pattern: 'https://claude.ai/code*', acceptedAttachmentKinds: ['image'] },
    ],
  };
  assert.equal(
    resolveDestinationLabel(provider, 'https://claude.ai/code'),
    'Claude',
  );
});

test('resolveDestinationLabel: no variant matches → provider label', () => {
  const provider = {
    ...baseProvider,
    urlVariants: [
      {
        pattern: 'https://claude.ai/code*',
        label: 'Claude Code',
        acceptedAttachmentKinds: ['image'],
      },
    ],
  };
  assert.equal(
    resolveDestinationLabel(provider, 'https://claude.ai/new'),
    'Claude',
  );
});

test('formatKindList: empty → empty string', () => {
  assert.equal(formatKindList([]), '');
  assert.equal(formatKindList(null), '');
});

test('formatKindList: single kind', () => {
  assert.equal(formatKindList(['image']), 'image');
});

test('formatKindList: two kinds use "and"', () => {
  assert.equal(formatKindList(['image', 'text']), 'image and text');
});

test('formatKindList: three+ kinds use Oxford comma', () => {
  // No third kind exists today, but the helper should be future-proof.
  assert.equal(
    formatKindList(['image', 'text', 'audio']),
    'image, text, and audio',
  );
});

test('resolveMaxAttachmentCount: no cap declared → null', () => {
  assert.equal(
    resolveMaxAttachmentCount(baseProvider, 'https://claude.ai/new'),
    null,
  );
});

test('resolveMaxAttachmentCount: provider-level cap returned', () => {
  const provider = { ...baseProvider, maxAttachmentCount: 2 };
  assert.equal(
    resolveMaxAttachmentCount(provider, 'https://claude.ai/new'),
    2,
  );
});

test('resolveMaxAttachmentCount: URL does not influence the result today', () => {
  // Cap is currently provider-level only — variants don't override.
  // Pin the contract so a future per-URL cap addition can't silently
  // drop the provider-level fallback.
  const provider = { ...baseProvider, maxAttachmentCount: 3 };
  assert.equal(
    resolveMaxAttachmentCount(provider, 'https://claude.ai/code/sess_abc'),
    3,
  );
});
