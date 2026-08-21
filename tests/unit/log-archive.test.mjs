// Unit tests for the capture log's archive rotation — `recordCapture`
// flushing the oldest entries into `history-<timestamp>.json` once the
// in-storage buffer goes over its cap, plus the `parseLogText` reader
// the History page uses to read those files back.
//
// `chrome.storage.local` and `chrome.downloads` are stubbed. The
// download stub records the `filename` / decoded body of every write,
// which is what the assertions inspect: the point of these tests is
// *which* records land in *which* file, not the plumbing that gets
// them there.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const EXT_ID = 'our-extension-id';

/** Captured `chrome.downloads.download` calls, newest last. */
let writes = [];

/**
 * Stub the two APIs the log store touches, starting from a stored log
 * of `existing` records. Returns a handle for reading back what the
 * store did.
 */
function stubChrome(existing = []) {
  writes = [];
  const store = { captureLog: existing };
  let nextId = 1;
  globalThis.chrome = {
    runtime: { id: EXT_ID },
    storage: {
      local: {
        // Cloned on the way out, like the real API: `recordCapture`
        // splices the array it gets back, and sharing the stored one
        // would hide a failed write's rollback.
        get: async (key) => (key in store ? { [key]: structuredClone(store[key]) } : {}),
        set: async (obj) => Object.assign(store, obj),
        remove: async (key) => { delete store[key]; },
      },
    },
    downloads: {
      download: async ({ filename, url }) => {
        // Undo the `data:` wrapper `writeJsonFile` puts around the text.
        const body = decodeURIComponent(url.slice(url.indexOf(',') + 1));
        writes.push({ filename, body });
        return nextId++;
      },
    },
  };
  return store;
}

stubChrome();
const { recordCapture, parseLogText, serializeLog, dedupeRecords } =
  await import('../../dist/capture/log-store.js');

/** A record whose timestamp encodes `n`, so order is checkable. */
function rec(n) {
  // 2026-01-01T00:00:00Z + n seconds, and a filename carrying `n`.
  const t = new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  return { timestamp: t, screenshot: { filename: `shot-${n}.png` } };
}

/** The bodies of the `history-*.json` writes, in write order. */
function archiveWrites() {
  return writes.filter((w) => w.filename.includes('/history-'));
}

/** The most recent `log.json` write. */
function lastLogWrite() {
  return writes.filter((w) => w.filename.endsWith('/log.json')).pop();
}

test('under the cap, nothing is archived', async () => {
  const store = stubChrome([rec(1), rec(2)]);
  await recordCapture(rec(3));
  assert.equal(archiveWrites().length, 0);
  assert.equal(store.captureLog.length, 3);
  assert.equal(parseLogText(lastLogWrite().body).length, 3);
});

test('crossing the cap flushes the oldest half to an archive file', async () => {
  // 100 stored + 1 new = 101, one over the cap, so the oldest 50 go.
  const store = stubChrome(Array.from({ length: 100 }, (_, i) => rec(i)));
  await recordCapture(rec(100));

  const archives = archiveWrites();
  assert.equal(archives.length, 1);
  const archived = parseLogText(archives[0].body);
  assert.equal(archived.length, 50);
  assert.equal(archived[0].screenshot.filename, 'shot-0.png');
  assert.equal(archived[49].screenshot.filename, 'shot-49.png');

  // Storage keeps the rest, oldest-first, with the new record last.
  assert.equal(store.captureLog.length, 51);
  assert.equal(store.captureLog[0].screenshot.filename, 'shot-50.png');
  assert.equal(store.captureLog[50].screenshot.filename, 'shot-100.png');
  // ...and `log.json` matches storage exactly.
  assert.deepEqual(parseLogText(lastLogWrite().body), store.captureLog);
});

test('the archive is named for the newest record it holds', async () => {
  const store = stubChrome(Array.from({ length: 100 }, (_, i) => rec(i)));
  await recordCapture(rec(100));
  // rec(49) is the last record in the batch. `compactTimestamp` is
  // local-time, so derive the expected stamp the same way rather than
  // hardcoding a timezone-dependent string.
  const d = new Date(store.captureLog[0].timestamp); // shot-50, one after
  const prev = new Date(d.getTime() - 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${prev.getFullYear()}${pad(prev.getMonth() + 1)}${pad(prev.getDate())}`
    + `-${pad(prev.getHours())}${pad(prev.getMinutes())}${pad(prev.getSeconds())}`
    + `-${pad(prev.getMilliseconds(), 3)}`;
  assert.equal(archiveWrites()[0].filename, `SeeWhatISee/history-${stamp}.json`);
});

test('a log far over the cap drains in batches, oldest file first', async () => {
  // 200 stored + 1: 201 → 151 → 101 → 51, i.e. three flushes.
  const store = stubChrome(Array.from({ length: 200 }, (_, i) => rec(i)));
  await recordCapture(rec(200));
  const archives = archiveWrites();
  assert.equal(archives.length, 3);
  assert.equal(parseLogText(archives[0].body)[0].screenshot.filename, 'shot-0.png');
  assert.equal(parseLogText(archives[1].body)[0].screenshot.filename, 'shot-50.png');
  assert.equal(parseLogText(archives[2].body)[0].screenshot.filename, 'shot-100.png');
  assert.equal(store.captureLog.length, 51);
});

test('a failed archive write keeps every entry, including the new one', async () => {
  const store = stubChrome(Array.from({ length: 100 }, (_, i) => rec(i)));
  const realDownload = chrome.downloads.download;
  chrome.downloads.download = async (opts) => {
    if (opts.filename.includes('/history-')) throw new Error('disk full');
    return realDownload(opts);
  };
  // The capture itself must still succeed: its screenshot is already
  // on disk, so rejecting here would orphan that file and drop the
  // record on the floor.
  const logId = await recordCapture(rec(100));
  assert.ok(logId > 0);
  assert.equal(archiveWrites().length, 0);
  // Nothing archived means nothing trimmed — the log simply sits one
  // over its cap until the next capture retries the flush.
  assert.equal(store.captureLog.length, 101);
  assert.equal(store.captureLog[100].screenshot.filename, 'shot-100.png');
  assert.deepEqual(parseLogText(lastLogWrite().body), store.captureLog);
});

test('a mid-drain failure keeps what it could not archive, and no more', async () => {
  // Three batches due; the second write fails. Batch 1 is on disk, so
  // its entries are gone from storage; batches 2-3 stay put. Nothing
  // may end up in both places.
  const store = stubChrome(Array.from({ length: 200 }, (_, i) => rec(i)));
  const realDownload = chrome.downloads.download;
  let archiveCalls = 0;
  chrome.downloads.download = async (opts) => {
    if (opts.filename.includes('/history-')) {
      archiveCalls += 1;
      if (archiveCalls === 2) throw new Error('disk full');
    }
    return realDownload(opts);
  };
  await recordCapture(rec(200));

  const archived = parseLogText(archiveWrites()[0].body);
  assert.equal(archiveWrites().length, 1);
  assert.equal(archived[0].screenshot.filename, 'shot-0.png');
  // 201 total - the 50 that reached disk.
  assert.equal(store.captureLog.length, 151);
  assert.equal(store.captureLog[0].screenshot.filename, 'shot-50.png');
  // No overlap between the archive file and what's still in storage.
  const inStorage = new Set(store.captureLog.map((r) => serializeLog([r])));
  assert.ok(archived.every((r) => !inStorage.has(serializeLog([r]))));
});

// A Capture-page session pins ONE timestamp and writes a record per
// save, so several records legitimately share a `timestamp` and differ
// only in their screenshot filename. Nothing may treat the timestamp
// as a record's identity — doing so silently drops real captures.

/**
 * `n` records sharing one timestamp, as one Capture session writes.
 * A `session` filename prefix keeps them apart from `rec`'s `shot-N`.
 */
function sameStampRecords(n) {
  const t = new Date(Date.UTC(2026, 0, 1, 12, 0, 0)).toISOString();
  return Array.from({ length: n }, (_, i) => ({
    timestamp: t,
    screenshot: { filename: i === 0 ? 'session.png' : `session-${i}.png` },
  }));
}

test('records sharing a timestamp all survive the archive round-trip', async () => {
  // 6 saves from one session, sitting at the head of an over-cap log.
  const session = sameStampRecords(6);
  stubChrome([...session, ...Array.from({ length: 94 }, (_, i) => rec(i))]);
  await recordCapture(rec(500));

  const archived = parseLogText(archiveWrites()[0].body);
  assert.equal(archived.length, 50);
  const sessionRows = archived.filter((r) => r.screenshot.filename.startsWith('session'));
  assert.equal(sessionRows.length, 6);
  // In file order, so the page can show them the way they were taken.
  assert.deepEqual(sessionRows.map((r) => r.screenshot.filename),
    ['session.png', 'session-1.png', 'session-2.png',
      'session-3.png', 'session-4.png', 'session-5.png']);
  // And they stay distinguishable once serialized — this is the key
  // the History page dedupes on.
  assert.equal(new Set(sessionRows.map((r) => serializeLog([r]))).size, 6);
});

test('two batches ending on one timestamp get distinct archive names', async () => {
  // Contrived: 50 saves in one session so both batches end inside it.
  // `conflictAction: 'overwrite'` means a shared name would destroy
  // the first batch outright.
  const session = sameStampRecords(60);
  stubChrome([...session, ...Array.from({ length: 141 }, (_, i) => rec(i))]);
  await recordCapture(rec(500));

  const names = archiveWrites().map((w) => w.filename);
  assert.equal(names.length, 3);
  assert.equal(new Set(names).size, 3);
});

// `dedupeRecords` is display-side: the log files keep every save, the
// History page shows a re-sent capture once. The line it has to walk
// is between "byte-identical repeat" (drop) and "same timestamp,
// different record" (keep) — getting that wrong loses real captures.

test('dedupeRecords drops a byte-identical repeat, keeping the first', async () => {
  // What Restore last capture writes when nothing was changed: the
  // timestamp and filenames are pinned, so the record repeats exactly.
  const a = rec(1);
  const resent = JSON.parse(JSON.stringify(a));
  const out = dedupeRecords([a, rec(2), resent]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => r.screenshot.filename), ['shot-1.png', 'shot-2.png']);
  assert.equal(out[0], a); // the first occurrence is the one kept
});

test('dedupeRecords keeps same-timestamp records that differ at all', async () => {
  // One Capture session's successive saves: same timestamp, different
  // filename. These are distinct captures and must all survive.
  const out = dedupeRecords(sameStampRecords(6));
  assert.equal(out.length, 6);
});

test('dedupeRecords ignores key order from the storage round-trip', async () => {
  // `chrome.storage.local` doesn't promise key order, so the same
  // record can come back shaped differently than the copy in a file.
  // `serializeRecord`'s canonical order is what makes them compare
  // equal; raw JSON.stringify would not.
  const a = { timestamp: '2026-01-01T00:00:00.000Z', prompt: 'hi', url: 'https://e.com' };
  const reordered = { url: 'https://e.com', timestamp: '2026-01-01T00:00:00.000Z', prompt: 'hi' };
  assert.notEqual(JSON.stringify(a), JSON.stringify(reordered));
  assert.equal(dedupeRecords([a, reordered]).length, 1);
});

test('dedupeRecords spans the storage/archive boundary', async () => {
  // The two copies need not be adjacent — a restore can be separated
  // from the original by any number of captures, and by a flush.
  const dup = rec(7);
  const out = dedupeRecords([dup, rec(8), rec(9), JSON.parse(JSON.stringify(dup))]);
  assert.equal(out.length, 3);
});

test('parseLogText skips blank and unparseable lines', async () => {
  stubChrome();
  const text = serializeLog([rec(1), rec(2)]);
  const damaged = `${text}\n{ not json\n[1,2,3]\n${serializeLog([rec(3)])}`;
  const parsed = parseLogText(damaged);
  // The array line is dropped along with the truncated object: a
  // record is an object.
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed.map((r) => r.screenshot.filename),
    ['shot-1.png', 'shot-2.png', 'shot-3.png']);
});
