// Unit tests for the disk-vs-storage reconcile — one per row of the
// decision table in `docs/log-consistency.md`.
//
// Everything the reconcile consults is stubbed: the `log.json`
// download record (present / deleted / absent), whether `fetch` can
// read the file, and Chrome's existence re-check. The assertions are
// about *which branch* is taken, since that is what decides whether a
// user's file is read, replaced, or left alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const EXT_ID = 'our-extension-id';
const DIR = '/home/user/Downloads/SeeWhatISee';

/** Captured `chrome.downloads.download` calls, newest last. */
let writes = [];
/** Ids passed to removeFile / erase, so cleanup can be asserted. */
let removed = [];
let erased = [];

/**
 * Install a `chrome` + `fetch` stub describing one state of the world.
 *
 * - `record`: the `log.json` download record, or `null` for none.
 * - `fileText`: what a `file://` read returns, or `null` for a read
 *   that fails (denied or missing — indistinguishable to us).
 * - `fileAccess`: the "Allow access to file URLs" toggle. On by
 *   default — it's required, and the one test that turns it off
 *   checks the backstop.
 * - `otherRecord`: a non-log capture file, which is how the directory
 *   is normally known without probing.
 * - `probeFails`: whether the directory probe's throwaway write
 *   fails, i.e. no capture directory can be found or made.
 * - `inFlightText`: a `log.json` write that has started but not
 *   finished, holding this text once it lands. It shadows `record`,
 *   which stands for the write before it.
 * - `existsAfterRecheck`: what Chrome's existence re-check reports for
 *   the log record, delivered as a `downloads.onChanged` delta the way
 *   the real API does. `null` means no delta — the re-check agreed with
 *   the record, which is the healthy case. `false` is a file deleted
 *   this session, where `record.exists` is still a stale `true`.
 */
function stubChrome({
  record = null,
  fileText = null,
  fileAccess = true,
  otherRecord = null,
  probeFails = false,
  inFlightText = null,
  existsAfterRecheck = null,
} = {}) {
  writes = [];
  removed = [];
  erased = [];
  const store = {};
  let nextId = 1;
  const changeListeners = [];
  // Flipped by the first `search({id})`, i.e. by the poll inside
  // `waitForDownloadComplete` — so the wait resolves on its first tick
  // rather than the test paying real time for it.
  let inFlight = inFlightText === null
    ? null
    : { ...logRecord(inFlightText, 'in_progress'), id: 99 };
  /** Downloads created during the test, so `search({id})` can resolve them. */
  const created = new Map();
  globalThis.chrome = {
    runtime: { id: EXT_ID },
    storage: {
      local: {
        get: async (key) => (key in store ? { [key]: structuredClone(store[key]) } : {}),
        set: async (obj) => Object.assign(store, obj),
        remove: async (key) => { delete store[key]; },
      },
    },
    extension: { isAllowedFileSchemeAccess: async () => fileAccess },
    downloads: {
      download: async ({ filename, url }) => {
        if (probeFails && /\/probe-\d+\.json$/.test(filename)) {
          throw new Error('download failed');
        }
        const id = nextId++;
        const body = decodeURIComponent(url.slice(url.indexOf(',') + 1));
        const landed = filename.replace(/^.*\//, '');
        writes.push({ filename, body, landed });
        created.set(id, `${DIR}/${landed}`);
        return id;
      },
      search: async (query) => {
        if (query.id !== undefined) {
          if (inFlight && query.id === inFlight.id) {
            inFlight = { ...inFlight, state: 'complete' };
            return [inFlight];
          }
          const filename = created.get(query.id);
          return filename ? [{ id: query.id, state: 'complete', filename }] : [];
        }
        // `getLogFileRecord` pins its regex to log.json; the
        // directory search behind `peekCaptureDirectory` matches any
        // file we wrote.
        const forLog = String(query.filenameRegex).endsWith('log\\.json$');
        if (forLog && record && existsAfterRecheck !== null) {
          // The real API behaves exactly this way: `search()` triggers
          // the existence re-check and returns the *old* value, and the
          // refreshed one arrives afterwards as an event.
          queueMicrotask(() => {
            for (const fn of changeListeners) {
              fn({ id: record.id, exists: { current: existsAfterRecheck } });
            }
          });
        }
        // Newest first, so an in-flight write shadows the record of the
        // write before it.
        if (forLog) return [inFlight, record].filter(Boolean);
        return [record, otherRecord].filter(Boolean);
      },
      removeFile: async (id) => { removed.push(id); },
      erase: async ({ id }) => { erased.push(id); },
      onChanged: {
        addListener: (fn) => { changeListeners.push(fn); },
        removeListener: (fn) => {
          const i = changeListeners.indexOf(fn);
          if (i >= 0) changeListeners.splice(i, 1);
        },
      },
    },
  };
  globalThis.fetch = async () => {
    if (fileText === null) throw new TypeError('Failed to fetch');
    return { ok: true, text: async () => fileText };
  };
  return store;
}

/**
 * A complete, present `log.json` record. `text` is only for the
 * caller's readability — pairing the record with the file it names —
 * since nothing reads a record's size any more.
 */
function logRecord(_text, state = 'complete') {
  return {
    id: 0,
    state,
    filename: `${DIR}/log.json`,
    byExtensionId: EXT_ID,
    exists: true,
  };
}

stubChrome();
const { inspectLogFile, LogWriteFailedError } =
  await import('../../dist/capture/log-reconcile.js');
const { FileAccessRequiredError } = await import('../../dist/capture/file-access.js');
const { recordCapture, serializeLog, parseLogLines, LOG_STORAGE_KEY } =
  await import('../../dist/capture/log-store.js');
const { _setExistsRecheckTimeoutForTest } =
  await import('../../dist/capture/downloads.js');
// A failed read with the file still there never fires a delta, so
// those tests pay this timeout in full. Keep it short.
_setExistsRecheckTimeoutForTest(5);

/** A record whose timestamp encodes `n`, so order is checkable. */
function rec(n) {
  const t = new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  return { timestamp: t, screenshot: { filename: `shot-${n}.png` } };
}

/** A `log.json` on disk holding `records`, with a matching record. */
function onDisk(records) {
  const text = serializeLog(records);
  return { record: logRecord(text), fileText: text };
}

// ── the file itself decides ──────────────────────────────────────────

test('a readable file replaces the buffer, dropped rows included', async () => {
  const text = serializeLog([rec(1)]);
  stubChrome({ record: logRecord(text), fileText: text });
  // Storage still remembers rec(2); the file says the user removed it.
  const state = await inspectLogFile();
  assert.equal(state.kind, 'contents');
  assert.equal(state.text, text);
  assert.equal(state.directory, DIR);
});

test('an unreadable file whose record says it is gone starts fresh', async () => {
  const gone = { ...logRecord('x'), exists: false };
  stubChrome({ record: gone, fileText: null });
  assert.equal((await inspectLogFile()).kind, 'fresh');
});

test('an unreadable file the record says is there fails the capture', async () => {
  stubChrome({ record: logRecord(serializeLog([rec(1)])), fileText: null });
  await assert.rejects(inspectLogFile(), (err) => {
    assert.ok(err instanceof LogWriteFailedError);
    assert.match(err.message, /couldn't read log\.json\. Fix or delete the file/);
    return true;
  });
});

test('with no record to locate it, the directory is probed and the file read', async () => {
  const text = serializeLog([rec(1)]);
  stubChrome({ record: null, fileText: text });
  const state = await inspectLogFile();
  assert.equal(state.kind, 'contents');
  // The throwaway probe went out under a name nothing else reads, and
  // was cleaned up both on disk and in the download history.
  assert.match(writes[0].filename, /\/probe-\d+\.json$/);
  assert.equal(removed.length, 1);
  assert.equal(erased.length, 1);
});

test('no record and no readable file: fresh, with nothing to ask', async () => {
  // Download history cleared and the file gone (or never written): the
  // probe finds the directory, the read fails, and with no record
  // there is nothing to consult about whether a file is there.
  stubChrome({ record: null, fileText: null });
  assert.equal((await inspectLogFile()).kind, 'fresh');
});

test('no directory at all fails the capture rather than guessing', async () => {
  // Nothing knows where captures go and the probe can't find out. A
  // probe that timed out says nothing about whether a log is there,
  // so this can't be "fresh" — that would overwrite one.
  stubChrome({ record: null, fileText: null, probeFails: true });
  await assert.rejects(inspectLogFile(), (err) => {
    assert.equal(err.name, 'LogWriteFailedError');
    assert.match(err.message, /capture directory/);
    return true;
  });
});

test('a log.json write still in flight is waited out, not read around', async () => {
  // Two captures in quick succession: the first one's write hasn't
  // landed when the second reconciles. Reading the file at that moment
  // could catch it half-written and adopt the truncation as the log.
  const stored = [rec(1), rec(2)];
  stubChrome({
    ...onDisk(stored),
    record: logRecord(serializeLog([rec(1)])),
    inFlightText: serializeLog(stored),
  });
  const state = await inspectLogFile();
  assert.equal(state.kind, 'contents');
  assert.equal(state.text, serializeLog(stored));
});

test('without the file-access toggle the reconcile refuses to guess', async () => {
  // Every entry point checks first, so this is the backstop: a fetch
  // refused for lack of the toggle looks exactly like a deleted log,
  // and starting a new one over the user's history is the wrong guess.
  stubChrome({ fileAccess: false, ...onDisk([rec(1)]) });
  await assert.rejects(inspectLogFile(), FileAccessRequiredError);
});

// ── what recordCapture does with those decisions ─────────────────────

test('a deleted log.json makes the next capture start over, not resurrect', async () => {
  const store = stubChrome({ record: { ...logRecord('x'), exists: false } });
  store[LOG_STORAGE_KEY] = [rec(1), rec(2)];
  await recordCapture(rec(3));
  assert.deepEqual(store[LOG_STORAGE_KEY].map((r) => r.screenshot.filename), ['shot-3.png']);
  const log = writes.filter((w) => w.filename.endsWith('log.json')).pop();
  assert.equal(log.body, serializeLog([rec(3)]));
});

test('a failed capture leaves everything untouched', async () => {
  const store = stubChrome({ record: logRecord(serializeLog([rec(1), rec(2)])), fileText: null });
  store[LOG_STORAGE_KEY] = [];
  await assert.rejects(recordCapture(rec(3)), LogWriteFailedError);
  // Point-in-time failure: no file written, no storage change, no
  // state left behind for anything to clean up later.
  assert.equal(writes.length, 0, 'log.json must not be overwritten');
  assert.deepEqual(store[LOG_STORAGE_KEY], []);
});

test('the file decides, not the buffer', async () => {
  // A buffer row the file doesn't have (rec(2)) stays gone: the user
  // deleted it from the file, and the file is the log.
  const store = stubChrome(onDisk([rec(1)]));
  store[LOG_STORAGE_KEY] = [rec(1), rec(2)];

  await recordCapture(rec(3));
  assert.equal(writes.at(-1).body, serializeLog([rec(1), rec(3)]));
  assert.deepEqual(
    store[LOG_STORAGE_KEY].map((r) => r.screenshot.filename),
    ['shot-1.png', 'shot-3.png'],
  );
});

test('capturing again after deleting log.json starts a fresh log', async () => {
  // The "delete the file" remedy: with it gone there is nothing left
  // to preserve, so the next capture becomes the new log.
  const store = stubChrome({ record: { ...logRecord('x'), exists: false } });
  store[LOG_STORAGE_KEY] = [rec(1), rec(2)];
  await recordCapture(rec(3));
  assert.equal(writes.at(-1).body, serializeLog([rec(3)]));
  assert.deepEqual(store[LOG_STORAGE_KEY], [rec(3)]);
});

// ── stale `DownloadItem.exists` ──────────────────────────────────────
//
// Chrome doesn't watch the filesystem: `search()` *triggers* the
// existence re-check and returns the value from before it, with the
// refreshed one arriving as a `downloads.onChanged` delta. A failed
// read is the one place the reconcile consults `exists`, to tell a
// deleted log from an unreadable one — and taking the search result
// at face value there would fail a capture for a user who simply
// deleted their log.

test('a log.json deleted this session starts fresh, not a failure', async () => {
  // The record still says `exists: true`; only the re-check knows the
  // file is gone.
  const stored = [rec(1), rec(2)];
  const store = stubChrome({
    record: logRecord(serializeLog(stored)),
    fileText: null,
    existsAfterRecheck: false,
  });
  store[LOG_STORAGE_KEY] = stored;

  await recordCapture(rec(3));
  // Fresh, not append: the deleted log stays deleted and the new one
  // holds only the capture that just happened.
  assert.equal(writes.at(-1).body, serializeLog([rec(3)]));
  assert.deepEqual(store[LOG_STORAGE_KEY], [rec(3)]);
});

test('no re-check delta leaves the record trusted', async () => {
  // A failed read with the record standing: fail, since the file is
  // there and we can't see into it.
  const store = stubChrome({ record: logRecord(serializeLog([rec(1)])), fileText: null });
  store[LOG_STORAGE_KEY] = [rec(1)];
  await assert.rejects(recordCapture(rec(2)), /couldn't read log\.json/);
});

test('a re-check confirming the file fails the same way', async () => {
  const store = stubChrome({
    record: logRecord(serializeLog([rec(1)])),
    fileText: null,
    existsAfterRecheck: true,
  });
  store[LOG_STORAGE_KEY] = [rec(1)];
  await assert.rejects(recordCapture(rec(2)), /couldn't read log\.json/);
});

// ── a file we can read but can't rewrite ─────────────────────────────

test('parseLogLines counts what it had to drop, and names the first', () => {
  const good = serializeLog([rec(1)]);
  assert.deepEqual(parseLogLines(good).skipped, 0);
  assert.equal(parseLogLines(good).firstBadLine, null);
  assert.equal(parseLogLines(good).records.length, 1);
  // Unparseable, and valid-JSON-but-not-a-record. Both are lines a
  // rewrite would destroy.
  assert.equal(parseLogLines(`${good}{"broken"\n`).skipped, 1);
  assert.equal(parseLogLines(`${good}"a string"\n`).skipped, 1);
  assert.equal(parseLogLines(`${good}[1,2]\n`).skipped, 1);
  // 1-based, counting blank lines, so it matches an editor's gutter.
  assert.equal(parseLogLines(`${good}\n{"broken"\n`).firstBadLine, 3);
});

test('a log.json with unparseable lines fails instead of dropping them', async () => {
  // Reading works, so the file would normally be adopted wholesale —
  // but adopting it means re-serializing it back over itself, which
  // would delete the line we couldn't parse.
  const onDisk = `${serializeLog([rec(1)])}{"truncated"\n`;
  const store = stubChrome({ record: logRecord(onDisk), fileText: onDisk });
  store[LOG_STORAGE_KEY] = [rec(1)];

  await assert.rejects(recordCapture(rec(2)), (err) => {
    assert.ok(err instanceof LogWriteFailedError);
    assert.match(err.message, /isn't a capture record \(line 2\)\. Fix or delete the file/);
    return true;
  });
  // Nothing written and nothing stored — the bad line is still there.
  assert.equal(writes.length, 0);
  assert.deepEqual(store[LOG_STORAGE_KEY], [rec(1)]);
});
