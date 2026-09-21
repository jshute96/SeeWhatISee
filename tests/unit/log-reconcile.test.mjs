// Unit tests for the `log.json` reconcile — one per row of the
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
 *   is normally known before the log is written.
 * - `claimFails`: whether the first `log.json` write on an unknown
 *   directory (`claimNewLog`'s uniquify write) fails.
 * - `deflect`: force that write to land as `log (1).json` even with
 *   no readable `fileText` — a log that is there but can't be read.
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
  claimFails = false,
  deflect = false,
  inFlightText = null,
  existsAfterRecheck = null,
} = {}) {
  writes = [];
  removed = [];
  erased = [];
  const store = {};
  const session = {};
  let nextId = 1;
  const changeListeners = [];
  // Flipped by the first `search({id})`, i.e. by the poll inside
  // `waitForDownloadComplete` — so the wait resolves on its first tick
  // rather than the test paying real time for it.
  let inFlight = inFlightText === null
    ? null
    : { ...logRecord('in_progress'), id: 99 };
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
      session: {
        get: async (key) => (key in session ? { [key]: structuredClone(session[key]) } : {}),
        set: async (obj) => Object.assign(session, obj),
      },
    },
    extension: { isAllowedFileSchemeAccess: async () => fileAccess },
    downloads: {
      download: async ({ filename, url, conflictAction }) => {
        if (claimFails && conflictAction === 'uniquify') {
          throw new Error('download failed');
        }
        const id = nextId++;
        const body = decodeURIComponent(url.slice(url.indexOf(',') + 1));
        let landed = filename.replace(/^.*\//, '');
        // What Chrome does for `'uniquify'` when the file is there:
        // picks a sibling name instead. `fileText` stands in for "a
        // file is there".
        if (conflictAction === 'uniquify' && (deflect || fileText !== null)) {
          landed = landed.replace(/\.json$/, ' (1).json');
        }
        writes.push({ filename, body, landed, conflictAction });
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
  // The session note `recordCapture` leaves, for the tests to check.
  Object.defineProperty(store, 'lastCaptureFiles', { get: () => session.lastCaptureFiles });
  return store;
}

/** A present `log.json` record — complete unless told otherwise. */
function logRecord(state = 'complete') {
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
const { recordCapture, serializeLog, parseLogText, appendLogLine } =
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
  return { record: logRecord(), fileText: text };
}

// ── the file itself decides ──────────────────────────────────────────

test('a readable file is the log, as it is', async () => {
  const text = serializeLog([rec(1)]);
  stubChrome({ record: logRecord(), fileText: text });
  const state = await inspectLogFile();
  assert.equal(state.kind, 'contents');
  assert.equal(state.text, text);
  assert.equal(state.directory, DIR);
});

test('an unreadable file whose record says it is gone starts fresh', async () => {
  const gone = { ...logRecord(), exists: false };
  stubChrome({ record: gone, fileText: null });
  assert.equal((await inspectLogFile()).kind, 'fresh');
});

test('an unreadable file the record says is there fails the capture', async () => {
  stubChrome({ record: logRecord(), fileText: null });
  await assert.rejects(inspectLogFile(), (err) => {
    assert.ok(err instanceof LogWriteFailedError);
    assert.match(err.message, /couldn't read \/home\/user\/Downloads\/SeeWhatISee\/log\.json\. Fix or delete the file, then capture again\.$/);
    return true;
  });
});

test('with nothing to locate the file, the reconcile says so rather than guessing', async () => {
  stubChrome({ record: null, fileText: serializeLog([rec(1)]) });
  assert.equal((await inspectLogFile()).kind, 'unknown-directory');
  assert.equal(writes.length, 0);
});

test('an unknown directory: the first write is deflected, then the file is read and appended to', async () => {
  // Download history cleared but the log still there. Writing
  // `log.json` without overwriting lands as `log (1).json`, which says
  // a log exists and where; that copy is discarded and the real one
  // appended to.
  const text = serializeLog([rec(1)]);
  stubChrome({ record: null, fileText: text });
  await recordCapture(rec(3));
  assert.equal(writes.length, 2);
  assert.equal(writes[0].conflictAction, 'uniquify');
  assert.equal(writes[0].landed, 'log (1).json');
  assert.equal(removed.length, 1, 'the deflected copy is deleted');
  assert.equal(erased.length, 1, '…and its download record dropped');
  assert.equal(writes[1].conflictAction, 'overwrite');
  assert.equal(writes[1].body, `${text}${serializeLog([rec(3)])}`);
});

test('a deflected first write whose log then cannot be read fails, not overwrites', async () => {
  // The deflection proves a file is there, so a failed read can't be
  // "the user deleted it" — and there is no record to ask. Writing
  // over it would lose the log the write was deflected by.
  const store = stubChrome({ record: null, fileText: null, deflect: true });
  await assert.rejects(recordCapture(rec(3)), (err) => {
    assert.equal(err.name, 'LogWriteFailedError');
    assert.match(err.message, /couldn't read \/home\/user\/Downloads\/SeeWhatISee\/log\.json\. Fix or delete the file, then capture again\.$/);
    return true;
  });
  assert.equal(writes.length, 1, 'only the deflected write');
  assert.equal(removed.length, 1, 'the deflected copy is still cleaned up');
  assert.equal(store.lastCaptureFiles, undefined);
});

test('an unknown directory with no log: the first write is the log', async () => {
  // A profile that has never captured. One write, no cleanup, and the
  // capture is recorded by it.
  const store = stubChrome({ record: null, fileText: null });
  await recordCapture(rec(3));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].conflictAction, 'uniquify');
  assert.equal(writes[0].landed, 'log.json');
  assert.equal(writes[0].body, serializeLog([rec(3)]));
  assert.equal(removed.length, 0);
  assert.deepEqual(store.lastCaptureFiles, { timestamp: rec(3).timestamp, screenshot: 'shot-3.png' });
});

test('an unknown directory whose first write fails is a failed capture', async () => {
  // Nothing knows where captures go and the write to find out fails.
  // That says nothing about whether a log is there, so this can't be
  // "fresh" — and there is nothing to overwrite it with anyway.
  const store = stubChrome({ record: null, fileText: null, claimFails: true });
  await assert.rejects(recordCapture(rec(3)), (err) => {
    assert.equal(err.name, 'LogWriteFailedError');
    assert.match(err.message, /couldn't write Downloads\/SeeWhatISee\/log\.json: download failed\.$/);
    return true;
  });
  assert.equal(store.lastCaptureFiles, undefined);
});

test('a log.json write still in flight is waited out, not read around', async () => {
  // Two captures in quick succession: the first one's write hasn't
  // landed when the second reconciles. Reading the file at that moment
  // could catch it half-written and adopt the truncation as the log.
  const stored = [rec(1), rec(2)];
  stubChrome({ ...onDisk(stored), inFlightText: serializeLog(stored) });
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
  const store = stubChrome({ record: { ...logRecord(), exists: false } });
  await recordCapture(rec(3));
  const log = writes.filter((w) => w.filename.endsWith('log.json')).pop();
  assert.equal(log.body, serializeLog([rec(3)]));
  // And the note says which files the capture wrote.
  assert.deepEqual(store.lastCaptureFiles, { timestamp: rec(3).timestamp, screenshot: 'shot-3.png' });
});

test('a failed capture leaves everything untouched', async () => {
  const store = stubChrome({ record: logRecord(), fileText: null });
  await assert.rejects(recordCapture(rec(3)), LogWriteFailedError);
  // Point-in-time failure: no file written, no note left, no state
  // left behind for anything to clean up later.
  assert.equal(writes.length, 0, 'log.json must not be overwritten');
  assert.equal(store.lastCaptureFiles, undefined);
});

test('the append keeps the file as it was, plus one line', async () => {
  // Hand-edited formatting and a line that isn't a record at all both
  // survive byte for byte: the file is the log, and the append only
  // adds to it. The bad line is skipped for the timestamp check, as
  // every reader skips it.
  const text = `{ "timestamp": "2026-01-01T00:00:01.000Z" , "title": "edited" }\nnot a record\n`;
  stubChrome({ record: logRecord(), fileText: text });
  await recordCapture(rec(3));
  assert.equal(writes.at(-1).body, `${text}${serializeLog([rec(3)])}`);
});

test('a file missing its trailing newline gets one before the new record', async () => {
  const text = serializeLog([rec(1)]).trimEnd();
  stubChrome({ record: logRecord(), fileText: text });
  await recordCapture(rec(2));
  assert.equal(writes.at(-1).body, serializeLog([rec(1), rec(2)]));
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
  stubChrome({
    record: logRecord(),
    fileText: null,
    existsAfterRecheck: false,
  });

  await recordCapture(rec(3));
  // Fresh, not append: the deleted log stays deleted and the new one
  // holds only the capture that just happened.
  assert.equal(writes.at(-1).body, serializeLog([rec(3)]));
});

test('no re-check delta leaves the record trusted', async () => {
  // A failed read with the record standing: fail, since the file is
  // there and we can't see into it.
  stubChrome({ record: logRecord(), fileText: null });
  await assert.rejects(recordCapture(rec(2)), /couldn't read \/home\/user\/Downloads\/SeeWhatISee\/log\.json/);
});

test('a re-check confirming the file fails the same way', async () => {
  stubChrome({
    record: logRecord(),
    fileText: null,
    existsAfterRecheck: true,
  });
  await assert.rejects(recordCapture(rec(2)), /couldn't read \/home\/user\/Downloads\/SeeWhatISee\/log\.json/);
});

// ── lines that aren't records ────────────────────────────────────────

test('parseLogText skips what it cannot read', () => {
  const good = serializeLog([rec(1)]);
  assert.equal(parseLogText(good).length, 1);
  // Unparseable, and valid-JSON-but-not-a-record. Both are skipped,
  // by every reader and by the writer's timestamp check alike.
  assert.equal(parseLogText(`${good}{"broken"\n`).length, 1);
  assert.equal(parseLogText(`${good}"a string"\n`).length, 1);
  assert.equal(parseLogText(`${good}[1,2]\n`).length, 1);
});

test('appendLogLine adds one terminated line and nothing else', () => {
  assert.equal(appendLogLine('', 'x'), 'x\n');
  assert.equal(appendLogLine('a\n', 'x'), 'a\nx\n');
  assert.equal(appendLogLine('a', 'x'), 'a\nx\n');
});
