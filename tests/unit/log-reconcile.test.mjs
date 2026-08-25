// Unit tests for the disk-vs-storage reconcile — one per row of the
// decision tables in `docs/log-consistency.md`.
//
// Everything the reconcile consults is stubbed: the `log.json`
// download record (present / deleted / emptied / a different size /
// absent), whether `fetch` can read the file, and what a uniquify
// probe write comes back named. The assertions are about *which
// branch* is taken, since that is what decides whether a user's file
// is read, replaced, or left alone.

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
 * - `fileAccess`: the "Allow access to file URLs" toggle.
 * - `otherRecord`: a non-log capture file, which is how the directory
 *   is normally known without probing.
 * - `probeCollides`: whether a uniquify write of `log.json` comes back
 *   renamed, i.e. a file was already there.
 * - `inFlightText`: a `log.json` write that has started but not
 *   finished, holding this text once it lands. It shadows `record`,
 *   which stands for the write before it.
 */
function stubChrome({
  record = null,
  fileText = null,
  fileAccess = false,
  otherRecord = null,
  probeCollides = false,
  inFlightText = null,
} = {}) {
  writes = [];
  removed = [];
  erased = [];
  const store = {};
  let nextId = 1;
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
      download: async ({ filename, url, conflictAction }) => {
        const id = nextId++;
        const body = decodeURIComponent(url.slice(url.indexOf(',') + 1));
        const base = filename.replace(/^.*\//, '');
        // Only a uniquify write can be renamed, and only when
        // something is already sitting at the name.
        const landed = conflictAction === 'uniquify' && probeCollides
          ? base.replace('.json', ' (1).json')
          : base;
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
        // `getLogFileRecord` pins its regex to log.json;
        // `getCaptureDirectory` matches any file we wrote.
        const forLog = String(query.filenameRegex).endsWith('log\\.json$');
        // Newest first, so an in-flight write shadows the record of the
        // write before it.
        if (forLog) return [inFlight, record].filter(Boolean);
        return [record, otherRecord].filter(Boolean);
      },
      removeFile: async (id) => { removed.push(id); },
      erase: async ({ id }) => { erased.push(id); },
    },
  };
  globalThis.fetch = async () => {
    if (fileText === null) throw new TypeError('Failed to fetch');
    return { ok: true, text: async () => fileText };
  };
  return store;
}

/** A complete, present `log.json` record whose file holds `text`. */
function logRecord(text, state = 'complete') {
  const size = new TextEncoder().encode(text).length;
  return {
    id: 0,
    state,
    filename: `${DIR}/log.json`,
    byExtensionId: EXT_ID,
    exists: true,
    fileSize: size,
    bytesReceived: size,
  };
}

stubChrome();
const { inspectLogFile, LogWriteBlockedError } =
  await import('../../dist/capture/log-reconcile.js');
const { recordCapture, serializeLog, LOG_STORAGE_KEY } =
  await import('../../dist/capture/log-store.js');

/** A record whose timestamp encodes `n`, so order is checkable. */
function rec(n) {
  const t = new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  return { timestamp: t, screenshot: { filename: `shot-${n}.png` } };
}

/** `inspectLogFile` for a storage log of `stored`, appending `next`. */
function inspect(stored, next = rec(9)) {
  return inspectLogFile({
    expectedText: serializeLog(stored),
    freshPayload: serializeLog([next]),
  });
}

// ── with file access: the file itself decides ────────────────────────

test('a readable file replaces the buffer, dropped rows included', async () => {
  const onDisk = serializeLog([rec(1)]);
  stubChrome({ fileAccess: true, record: logRecord(onDisk), fileText: onDisk });
  // Storage still remembers rec(2); the file says the user removed it.
  const state = await inspect([rec(1), rec(2)]);
  assert.equal(state.kind, 'contents');
  assert.equal(state.text, onDisk);
});

test('an unreadable file whose record says it is gone starts fresh', async () => {
  const gone = { ...logRecord('x'), exists: false };
  stubChrome({ fileAccess: true, record: gone, fileText: null });
  assert.equal((await inspect([rec(1)])).kind, 'fresh');
});

test('an unreadable file the record says is there blocks', async () => {
  const text = serializeLog([rec(1)]);
  stubChrome({ fileAccess: true, record: logRecord(text), fileText: null });
  const state = await inspect([rec(1)]);
  assert.equal(state.kind, 'blocked');
  assert.equal(state.reason, 'unreadable');
  assert.equal(state.directory, DIR);
});

test('with no record to locate it, the directory is probed and the file read', async () => {
  const onDisk = serializeLog([rec(1)]);
  stubChrome({ fileAccess: true, record: null, fileText: onDisk });
  const state = await inspect([]);
  assert.equal(state.kind, 'contents');
  // The throwaway probe went out under a name nothing else reads, and
  // was cleaned up both on disk and in the download history.
  assert.match(writes[0].filename, /\/probe-\d+\.json$/);
  assert.equal(removed.length, 1);
  assert.equal(erased.length, 1);
});

// ── without file access: the record is all we have ───────────────────

test('a matching size appends to the buffer', async () => {
  const stored = [rec(1), rec(2)];
  stubChrome({ record: logRecord(serializeLog(stored)) });
  assert.equal((await inspect(stored)).kind, 'insync');
});

test('a log.json write still in flight is waited out, not read around', async () => {
  // Two captures in quick succession: the first one's write hasn't
  // landed when the second reconciles. Answering from the *previous*
  // record would report a size that no longer matches the buffer and
  // block a perfectly healthy log.
  const stored = [rec(1), rec(2)];
  stubChrome({
    record: logRecord(serializeLog([rec(1)])),
    inFlightText: serializeLog(stored),
  });
  assert.equal((await inspect(stored)).kind, 'insync');
});

test('a deleted file starts fresh', async () => {
  stubChrome({ record: { ...logRecord('x'), exists: false } });
  assert.equal((await inspect([rec(1)])).kind, 'fresh');
});

test('a log we ourselves left empty starts fresh', async () => {
  // A zero-byte record is only ever *our* write — the old "Clear log
  // history" entry, or a flush with nothing to write. There's nothing
  // in the file to preserve.
  stubChrome({ record: logRecord('') });
  assert.equal((await inspect([rec(1)])).kind, 'fresh');
});

test('without read access, an edit to the file is invisible', async () => {
  // Pinning the known limit rather than a behavior we want: both sides
  // of the size check are ours (what we wrote vs. what the browser
  // copy says), so *any* change to the file — a deleted row, an edited
  // one, even emptying it — leaves the check reading "unchanged", and
  // the next capture rewrites over it. Granting the file-read
  // permission is the only thing that closes this; see
  // `docs/log-consistency.md`.
  stubChrome({ record: logRecord(serializeLog([rec(1), rec(2)])) });
  assert.equal((await inspect([rec(1), rec(2)])).kind, 'insync');
});

test('a browser copy that lost records blocks rather than truncating the file', async () => {
  // What the size check *does* catch: the browser copy drifting from
  // what we last wrote — a reinstall, cleared site data, an
  // interrupted write.
  stubChrome({ record: logRecord(serializeLog([rec(1), rec(2)])) });
  assert.equal((await inspect([rec(1)])).reason, 'size-mismatch');
});

test('a size that disagrees with the buffer blocks', async () => {
  // The shape of a storage wipe: the file holds two records, storage
  // holds none.
  stubChrome({ record: logRecord(serializeLog([rec(1), rec(2)])) });
  const state = await inspect([]);
  assert.equal(state.kind, 'blocked');
  assert.equal(state.reason, 'size-mismatch');
});

test('no record and no file: the probe write is the write', async () => {
  stubChrome({ record: null, probeCollides: false });
  const state = await inspect([], rec(9));
  assert.equal(state.kind, 'written');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].landed, 'log.json');
  assert.equal(writes[0].body, serializeLog([rec(9)]));
  assert.equal(removed.length, 0);
});

test('no record but a file already there blocks, and the probe is cleaned up', async () => {
  stubChrome({ record: null, probeCollides: true });
  const state = await inspect([], rec(9));
  assert.equal(state.kind, 'blocked');
  assert.equal(state.reason, 'unknown-file');
  assert.equal(state.directory, DIR);
  // The renamed probe file must not survive — it would sit in the
  // capture directory forever otherwise.
  assert.equal(writes[0].landed, 'log (1).json');
  assert.deepEqual(removed, [1]);
  assert.deepEqual(erased, [1]);
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

test('a blocked capture throws and leaves everything untouched', async () => {
  const store = stubChrome({ record: logRecord(serializeLog([rec(1), rec(2)])) });
  store[LOG_STORAGE_KEY] = [];
  const err = await recordCapture(rec(3)).then(
    () => assert.fail('expected a LogWriteBlockedError'),
    (e) => e,
  );
  // The error carries everything the prompt needs — reason, directory,
  // and the record itself, which lives nowhere else.
  assert.ok(err instanceof LogWriteBlockedError);
  assert.equal(err.reason, 'size-mismatch');
  assert.equal(err.directory, DIR);
  assert.deepEqual(err.record, rec(3));
  // Point-in-time failure: no file written, no storage change, no
  // state left behind for anything to clean up later.
  assert.equal(writes.length, 0, 'log.json must not be overwritten');
  assert.deepEqual(store[LOG_STORAGE_KEY], []);
});

// ── the prompt's two buttons (both are recordCapture again) ─────────

test('Overwrite appends to the buffer without consulting the file', async () => {
  // A file we can neither read nor account for — the state Overwrite
  // exists to end.
  const store = stubChrome({ record: logRecord('something else entirely') });
  store[LOG_STORAGE_KEY] = [rec(1), rec(2)];

  await recordCapture(rec(3), { force: true });
  assert.equal(writes.at(-1).body, serializeLog([rec(1), rec(2), rec(3)]));
  assert.deepEqual(
    store[LOG_STORAGE_KEY].map((r) => r.screenshot.filename),
    ['shot-1.png', 'shot-2.png', 'shot-3.png'],
  );
});

test('Retry after gaining read access appends to the file, not the buffer', async () => {
  // The record blocked earlier and rode along on the error; the user
  // turned on file reads and clicked Retry. The file decides — a
  // buffer row the file doesn't have (rec(2)) stays gone.
  const onDisk = serializeLog([rec(1)]);
  const store = stubChrome({
    fileAccess: true,
    record: logRecord(onDisk),
    fileText: onDisk,
  });
  store[LOG_STORAGE_KEY] = [rec(1), rec(2)];

  await recordCapture(rec(3));
  assert.equal(writes.at(-1).body, serializeLog([rec(1), rec(3)]));
  assert.deepEqual(
    store[LOG_STORAGE_KEY].map((r) => r.screenshot.filename),
    ['shot-1.png', 'shot-3.png'],
  );
});

test('Retry with nothing changed blocks again, file untouched', async () => {
  const store = stubChrome({ record: logRecord(serializeLog([rec(1), rec(2)])) });
  store[LOG_STORAGE_KEY] = [rec(3)];
  await assert.rejects(recordCapture(rec(4)), LogWriteBlockedError);
  assert.equal(writes.length, 0);
});

test('Retry after the user deletes log.json starts a fresh log', async () => {
  // The "delete it yourself, then Retry" remedy: with the file gone
  // there is nothing left to preserve, so the retried record becomes
  // the new log.
  const store = stubChrome({ record: { ...logRecord('x'), exists: false } });
  store[LOG_STORAGE_KEY] = [rec(1), rec(2)];
  await recordCapture(rec(3));
  assert.equal(writes.at(-1).body, serializeLog([rec(3)]));
  assert.deepEqual(store[LOG_STORAGE_KEY], [rec(3)]);
});
