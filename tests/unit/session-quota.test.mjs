// Unit tests for `src/background/session-quota.ts`. The pure helpers
// (`estimateRecordBytes`, `formatBytes`, `formatQuotaError`) need no
// chrome mock; `checkSessionStorageRoom` is exercised behind a small
// `chrome.storage.session` stub installed on `globalThis` for the
// duration of those tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateRecordBytes,
  formatBytes,
  formatQuotaError,
  checkSessionStorageRoom,
} from '../../dist/background/session-quota.js';

test('estimateRecordBytes counts key + JSON.stringify(value)', () => {
  // Empty value still costs the key length.
  assert.equal(estimateRecordBytes('a', null), 1 + 'null'.length);
  // Plain object: JSON.stringify gives the literal serialized form.
  const v = { hi: 'x' };
  assert.equal(estimateRecordBytes('k', v), 'k'.length + JSON.stringify(v).length);
});

test('formatBytes: B / KB / MB ladder with whole-MB collapse', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(2048), '2 KB');
  // Just under 1 MiB stays in KB.
  assert.equal(formatBytes(1024 * 1024 - 1), '1024 KB');
  // Exact 10 MiB drops the trailing `.0`.
  assert.equal(formatBytes(10 * 1024 * 1024), '10 MB');
  // Non-round MB keeps the decimal.
  assert.equal(formatBytes(7.2 * 1024 * 1024), '7.2 MB');
  // 4.8 MB is the "free" example we use in the user-facing
  // message; verify it formats as expected.
  assert.equal(formatBytes(Math.round(4.8 * 1024 * 1024)), '4.8 MB');
});

test('formatQuotaError: capture variant with no breakdown falls back to "needs X"', () => {
  const result = {
    ok: false,
    needBytes: 7.2 * 1024 * 1024,
    freeBytes: 4.8 * 1024 * 1024,
    quotaBytes: 10 * 1024 * 1024,
  };
  const msg = formatQuotaError('capture', result);
  assert.match(msg, /Capture is too large/);
  assert.match(msg, /needs 7\.2 MB/);
  assert.match(msg, /4\.8 MB of 10 MB extension storage free/);
});

test('formatQuotaError: capture variant with one breakdown part drops the `+` / `=`', () => {
  const result = {
    ok: false,
    needBytes: 5 * 1024 * 1024,
    freeBytes: 4 * 1024 * 1024,
    quotaBytes: 10 * 1024 * 1024,
  };
  const msg = formatQuotaError('capture', result, [
    { label: 'image', bytes: 5 * 1024 * 1024 },
    { label: 'HTML', bytes: 0 }, // filtered out
  ]);
  assert.match(msg, /^Capture is too large \(5 MB image; /);
  assert.doesNotMatch(msg, /\+/);
  assert.doesNotMatch(msg, /= /);
});

test('formatQuotaError: capture variant joins multiple breakdown parts with `+` and totals with `=`', () => {
  const result = {
    ok: false,
    needBytes: 11 * 1024 * 1024,
    freeBytes: -1 * 1024 * 1024, // already over the cap; clamp to 0 B
    quotaBytes: 10 * 1024 * 1024,
  };
  const msg = formatQuotaError('capture', result, [
    { label: 'image', bytes: 3 * 1024 * 1024 },
    { label: 'HTML', bytes: 7 * 1024 * 1024 },
    { label: 'selection', bytes: 1 * 1024 * 1024 },
  ]);
  assert.match(
    msg,
    /^Capture is too large \(3 MB image \+ 7 MB HTML \+ 1 MB selection = 11 MB; only 0 B of 10 MB extension storage free\)\.$/,
  );
});

test('formatQuotaError: ask variant uses Ask-specific phrasing', () => {
  const result = {
    ok: false,
    needBytes: 6 * 1024 * 1024,
    freeBytes: 3 * 1024 * 1024,
    quotaBytes: 10 * 1024 * 1024,
  };
  const msg = formatQuotaError('ask', result);
  assert.match(msg, /Not enough extension storage to send this Ask/);
  assert.match(msg, /needs 6 MB/);
  assert.match(msg, /3 MB of 10 MB free/);
});

test('formatQuotaError: clamps a negative `freeBytes` to zero in the user-facing string', () => {
  // `freeBytes` can plausibly be negative if `inUse > QUOTA_BYTES`
  // (e.g. a quota change shrunk the cap mid-session). The raw
  // result still carries the negative number; the formatter masks
  // it so the user doesn't read "-1.2 MB free".
  const result = {
    ok: false,
    needBytes: 1024,
    freeBytes: -1.2 * 1024 * 1024,
    quotaBytes: 10 * 1024 * 1024,
  };
  const msg = formatQuotaError('capture', result);
  assert.match(msg, /only 0 B of 10 MB extension storage free/);
});

// --- checkSessionStorageRoom — needs a chrome.storage.session stub ---

/**
 * Install a minimal `chrome.storage.session` stub on `globalThis`
 * for the duration of the test. Lets us drive `getBytesInUse`
 * deterministically and inspect the resulting `QuotaCheckResult`.
 *
 * `inUse` is the number returned for `getBytesInUse(null)`.
 * `existingForKey` is the per-key map used by `getBytesInUse(key)`.
 * `quota` overrides the area's `QUOTA_BYTES`; omit to default.
 */
function installSessionStub({
  inUse,
  existingForKey = {},
  quota,
  rejectAll = false,
}) {
  const stub = {
    QUOTA_BYTES: quota,
    getBytesInUse: async (key) => {
      if (rejectAll) throw new Error('stubbed failure');
      if (key === null || key === undefined) return inUse;
      return existingForKey[key] ?? 0;
    },
  };
  globalThis.chrome = { storage: { session: stub } };
  return () => {
    delete globalThis.chrome;
  };
}

test('checkSessionStorageRoom: ok when room remains', async () => {
  const restore = installSessionStub({
    inUse: 1024,
    quota: 10 * 1024,
  });
  try {
    const result = await checkSessionStorageRoom('k', { tiny: true });
    assert.equal(result.ok, true);
    assert.equal(result.quotaBytes, 10 * 1024);
    // freeBytes after the proposed write should be the remaining
    // headroom under the cap.
    assert.ok(result.freeBytes > 0);
  } finally {
    restore();
  }
});

test('checkSessionStorageRoom: fails when proposed write would overflow', async () => {
  // 100-byte cap, 90 bytes already in use. A 50-byte payload won't
  // fit even though the existing key isn't in the way.
  const restore = installSessionStub({
    inUse: 90,
    quota: 100,
  });
  try {
    const big = 'x'.repeat(50);
    const result = await checkSessionStorageRoom('k', big);
    assert.equal(result.ok, false);
    assert.equal(result.quotaBytes, 100);
    assert.ok(result.needBytes > result.freeBytes);
  } finally {
    restore();
  }
});

test('checkSessionStorageRoom: counts existing-key bytes as freeable', async () => {
  // Same 100-byte cap, 90 in use — but 60 of those are at our key.
  // Replacing it should free those 60, leaving 70 free.
  const restore = installSessionStub({
    inUse: 90,
    existingForKey: { k: 60 },
    quota: 100,
  });
  try {
    const result = await checkSessionStorageRoom('k', 'x'.repeat(40));
    // Need ≈ 'k'.length + JSON.stringify('xxx…').length = 1 + 42 = 43.
    // Free ≈ 100 - (90 - 60) = 70.
    assert.equal(result.ok, true);
  } finally {
    restore();
  }
});

test('checkSessionStorageRoom: returns ok:false when getBytesInUse rejects', async () => {
  const restore = installSessionStub({
    inUse: 0,
    quota: 100,
    rejectAll: true,
  });
  try {
    const result = await checkSessionStorageRoom('k', 'x');
    assert.equal(result.ok, false);
    assert.equal(result.freeBytes, 0);
    assert.equal(result.quotaBytes, 100);
  } finally {
    restore();
  }
});

test('checkSessionStorageRoom: falls back to documented 10 MiB when QUOTA_BYTES is missing', async () => {
  const restore = installSessionStub({
    inUse: 0,
    // No `quota` field — exercises the fallback branch.
  });
  try {
    const result = await checkSessionStorageRoom('k', 'x');
    assert.equal(result.quotaBytes, 10 * 1024 * 1024);
  } finally {
    restore();
  }
});
