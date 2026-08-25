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
//
// The `downloads.search` stub reports a `log.json` whose size always
// matches what we last wrote, which is what puts `recordCapture` on
// its ordinary append path. The reconcile's other branches — deleted,
// emptied, mismatched, unreadable — are covered in
// `log-reconcile.test.mjs`.

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
    // File reads off: these tests are about archiving, and the
    // record-only path is the one that appends without needing a
    // `fetch` stub as well.
    extension: { isAllowedFileSchemeAccess: async () => false },
    downloads: {
      download: async ({ filename, url }) => {
        // Undo the `data:` wrapper `writeJsonFile` puts around the text.
        const body = decodeURIComponent(url.slice(url.indexOf(',') + 1));
        writes.push({ filename, body });
        return nextId++;
      },
      search: async () => {
        // Whatever we last wrote *is* what's on disk, so the log and
        // the file agree and the append proceeds. Before the first
        // write, the seeded storage is what the file would hold.
        const last = lastLogWrite();
        const body = last ? last.body : serializeLog(store.captureLog ?? []);
        const size = new TextEncoder().encode(body).length;
        return [{
          id: 0,
          filename: `SeeWhatISee/log.json`,
          byExtensionId: EXT_ID,
          state: 'complete',
          exists: true,
          fileSize: size,
          bytesReceived: size,
        }];
      },
      // The reconcile waits briefly for Chrome's existence re-check
      // before trusting `exists` (see `startExistsWatch`). These tests
      // never delete anything, so no delta is ever fired — the listener
      // just has to exist to be registered and removed.
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  };
  return store;
}

stubChrome();
const { recordCapture, parseLogText, serializeLog, dedupeRecords } =
  await import('../../dist/capture/log-store.js');
const { _setExistsRecheckTimeoutForTest } =
  await import('../../dist/capture/downloads.js');
// No delta is ever fired here, so each reconcile would otherwise wait
// out the full existence-recheck timeout.
_setExistsRecheckTimeoutForTest(5);

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

// Records that share a `timestamp` and differ only in their screenshot
// filename. `recordCapture` no longer produces these — `uniqueTimestamp`
// pulls them apart — so these fixtures are seeded straight into storage.
// They pin the readers: nothing may treat the timestamp as a record's
// identity, since doing so silently drops real captures.

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
  // Disambiguated by advancing the stamp, not by a suffix, so every
  // archive name still matches the one pattern a reader can parse.
  for (const name of names) {
    assert.match(name, /\/history-\d{8}-\d{6}-\d{3}\.json$/);
  }
});

// `dedupeRecords` is display-side: it collapses one record that
// reached the History page from both of the sources the page merges.
// The line it has to walk is between "the same record twice" (drop)
// and "same timestamp, different record" (keep) — getting that wrong
// loses real captures.

test('dedupeRecords drops an exact repeat, keeping the first', async () => {
  // A record the page loaded from an archive and from storage both.
  const a = rec(1);
  const resent = JSON.parse(JSON.stringify(a));
  const out = dedupeRecords([a, rec(2), resent]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => r.screenshot.filename), ['shot-1.png', 'shot-2.png']);
  assert.equal(out[0], a); // the first occurrence is the one kept
});

test('dedupeRecords keeps same-timestamp records that differ at all', async () => {
  // Same timestamp, different filename — distinct captures, so they must
  // all survive however they got into the log.
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

// --- timestamp uniquification ---------------------------------------------
//
// A Capture-page session pins one timestamp and writes a record per
// save, so the same one arrives repeatedly. The log pulls them apart by
// a millisecond so a timestamp can serve as a cursor into `log.json`
// (`--after` in `skills/SeeWhatISee.py`, the MCP `watch` tool).

/** A record carrying `timestamp` verbatim, plus a distinguishing name. */
function recAt(timestamp, name) {
  return { timestamp, screenshot: { filename: `${name}.png` } };
}

test('a record repeating a stored timestamp is bumped a millisecond', async () => {
  const t = '2026-01-01T00:00:05.000Z';
  const store = stubChrome([recAt(t, 'save-1')]);
  await recordCapture(recAt(t, 'save-2'));
  assert.deepEqual(store.captureLog.map((r) => r.timestamp),
    [t, '2026-01-01T00:00:05.001Z']);
  // Only the timestamp moves — the files keep the stamp they were
  // written with.
  assert.equal(store.captureLog[1].screenshot.filename, 'save-2.png');
});

test('a run of repeats keeps stepping past every one already taken', async () => {
  const t = '2026-01-01T00:00:05.000Z';
  const store = stubChrome();
  for (const name of ['save-1', 'save-2', 'save-3']) {
    await recordCapture(recAt(t, name));
  }
  assert.deepEqual(store.captureLog.map((r) => r.timestamp), [
    t, '2026-01-01T00:00:05.001Z', '2026-01-01T00:00:05.002Z',
  ]);
});

test('a bump skips a timestamp another record already holds', async () => {
  // The millisecond after the collision is itself taken, so the new
  // record has to land past it rather than colliding again.
  const store = stubChrome([
    recAt('2026-01-01T00:00:05.000Z', 'a'),
    recAt('2026-01-01T00:00:05.001Z', 'b'),
  ]);
  await recordCapture(recAt('2026-01-01T00:00:05.000Z', 'c'));
  assert.deepEqual(store.captureLog.map((r) => r.timestamp), [
    '2026-01-01T00:00:05.000Z',
    '2026-01-01T00:00:05.001Z',
    '2026-01-01T00:00:05.002Z',
  ]);
});

test('a fresh timestamp is left exactly as it is', async () => {
  const store = stubChrome([rec(1)]);
  await recordCapture(rec(2));
  assert.deepEqual(store.captureLog.map((r) => r.timestamp),
    [rec(1).timestamp, rec(2).timestamp]);
});

test('an unparseable repeated timestamp is left alone', async () => {
  // A hand-edited log: there is nothing meaningful to advance, and
  // inventing a time would be worse than leaving the duplicate.
  const store = stubChrome([recAt('not-a-date', 'a')]);
  await recordCapture(recAt('not-a-date', 'b'));
  assert.deepEqual(store.captureLog.map((r) => r.timestamp),
    ['not-a-date', 'not-a-date']);
});

test('the bump is visible on the record the caller passed in', async () => {
  // `recordDetailedCapture` returns the record it handed to
  // `recordCapture`, and the save path stores `serializeRecord` of it
  // as the key the History page matches a Restore row by. A key built
  // from the pre-bump timestamp would describe no record in the log.
  const t = '2026-01-01T00:00:05.000Z';
  stubChrome([recAt(t, 'save-1')]);
  const mine = recAt(t, 'save-2');
  await recordCapture(mine);
  assert.equal(mine.timestamp, '2026-01-01T00:00:05.001Z');
});

test('a re-save that changed nothing still gets its own timestamp', async () => {
  // *Restore last capture* re-saved unchanged writes a record matching an
  // earlier one in every field. It's still its own save, and the cursor
  // consumers need every record in the log to be nameable.
  const t = '2026-01-01T00:00:05.000Z';
  const store = stubChrome([recAt(t, 'save-1')]);
  await recordCapture(recAt(t, 'save-1'));
  assert.deepEqual(store.captureLog.map((r) => r.timestamp),
    [t, '2026-01-01T00:00:05.001Z']);
});

test('every save in a session lands on its own timestamp', async () => {
  // The session pins one stamp and saves three times — a re-crop, then a
  // restore re-saved unchanged. All three arrive carrying the pinned stamp.
  const t = '2026-01-01T00:00:05.000Z';
  const store = stubChrome();
  await recordCapture(recAt(t, 'save-1'));
  await recordCapture(recAt(t, 'save-2'));
  await recordCapture(recAt(t, 'save-2'));
  assert.equal(new Set(store.captureLog.map((r) => r.timestamp)).size, 3);
});

test('a collision resolves against a record the same call is about to archive', async () => {
  // `uniqueTimestamp` reads the stored log *before* the flush trims it, so a
  // predecessor on its way into an archive still forces the bump. Reading the
  // trimmed list would hand out a timestamp the archive already holds.
  const t = '2026-01-01T00:00:05.000Z';
  const store = stubChrome([
    recAt(t, 'oldest'),
    ...Array.from({ length: 100 }, (_, i) => rec(i)),
  ]);
  await recordCapture(recAt(t, 'newest'));
  // The colliding predecessor went to the archive; the new record kept the
  // bump it forced, so the two never share a timestamp.
  const archived = parseLogText(archiveWrites()[0].body);
  assert.equal(archived[0].timestamp, t);
  assert.equal(store.captureLog[store.captureLog.length - 1].timestamp,
    '2026-01-01T00:00:05.001Z');
});
