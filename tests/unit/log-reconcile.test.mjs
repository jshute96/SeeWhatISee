// Unit tests for the `log.json` reconcile — one per row of the
// decision table in `docs/log-consistency.md`.
//
// Everything the reconcile consults is stubbed: the download records
// that say where the capture directory is, whether `fetch` can read
// the file, and what the directory listing holds. The assertions are
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
 * - `known`: whether a download record of ours exists, which is how
 *   the capture directory is normally known. `false` is a profile with
 *   no download history and no cached directory.
 * - `fileText`: what a `file://` read of `log.json` returns, or `null`
 *   for a read that fails.
 * - `listed`: whether `log.json` appears in the directory listing.
 *   Defaults to "there is text to read", the consistent state; set
 *   explicitly to describe a file that is listed but won't read.
 * - `directoryGone`: the directory itself can't be listed.
 * - `fileAccess`: the "Allow access to file URLs" toggle. On by
 *   default — it's required, and the one test that turns it off
 *   checks the backstop.
 * - `claimFails`: whether the first `log.json` write on an unknown
 *   directory (`claimNewLog`'s uniquify write) fails.
 * - `deflect`: force that write to land as `log (1).json` even with
 *   no readable `fileText` — a log that is there but can't be read.
 */
function stubChrome({
  known = true,
  fileText = null,
  listed = fileText !== null,
  directoryGone = false,
  fileAccess = true,
  claimFails = false,
  deflect = false,
} = {}) {
  writes = [];
  removed = [];
  erased = [];
  const store = {};
  const session = {};
  let nextId = 1;
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
          const filename = created.get(query.id);
          return filename ? [{ id: query.id, state: 'complete', filename }] : [];
        }
        // The directory search behind `peekCaptureDirectory`: any
        // file we wrote says where the directory is.
        return known
          ? [{ id: 0, state: 'complete', filename: `${DIR}/shot-0.png`, byExtensionId: EXT_ID }]
          : [];
      },
      removeFile: async (id) => { removed.push(id); },
      erase: async ({ id }) => { erased.push(id); },
    },
  };
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/log.json')) {
      if (fileText === null) throw new TypeError('Failed to fetch');
      return { ok: true, text: async () => fileText };
    }
    // The directory listing, in the shape Chrome generates it.
    if (directoryGone) throw new TypeError('Failed to fetch');
    const rows = ['shot-0.png', ...(listed ? ['log.json'] : [])]
      .map((n) => `<script>addRow(${JSON.stringify(n)},${JSON.stringify(n)},0,0,"0 B",0,"");</script>`);
    return { ok: false, status: 0, text: async () => rows.join('\n') };
  };
  // The session note `recordCapture` leaves, for the tests to check.
  Object.defineProperty(store, 'lastCaptureFiles', { get: () => session.lastCaptureFiles });
  return store;
}

stubChrome();
const { inspectLogFile, LogWriteFailedError } =
  await import('../../dist/capture/log-reconcile.js');
const { FileAccessRequiredError } = await import('../../dist/capture/file-access.js');
const { recordCapture, serializeLog, parseLogText, appendLogLine } =
  await import('../../dist/capture/log-store.js');

/** A record whose timestamp encodes `n`, so order is checkable. */
function rec(n) {
  const t = new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  return { timestamp: t, screenshot: { filename: `shot-${n}.png` } };
}

// ── the file itself decides ──────────────────────────────────────────

test('a readable file is the log, as it is', async () => {
  const text = serializeLog([rec(1)]);
  stubChrome({ fileText: text });
  const state = await inspectLogFile();
  assert.equal(state.kind, 'contents');
  assert.equal(state.text, text);
  assert.equal(state.directory, DIR);
});

test('a file missing from the directory listing starts fresh', async () => {
  // The user deleted `log.json` — however they did it. The listing is
  // the filesystem's answer, so nothing else has to agree.
  stubChrome({ fileText: null, listed: false });
  assert.equal((await inspectLogFile()).kind, 'fresh');
});

test('a directory that cannot be listed starts fresh too', async () => {
  // The whole `SeeWhatISee/` folder is gone — the other supported way
  // to start over.
  stubChrome({ fileText: null, directoryGone: true });
  assert.equal((await inspectLogFile()).kind, 'fresh');
});

test('an unreadable file that is listed fails the capture', async () => {
  stubChrome({ fileText: null, listed: true });
  await assert.rejects(inspectLogFile(), (err) => {
    assert.ok(err instanceof LogWriteFailedError);
    assert.match(err.message, /couldn't read \/home\/user\/Downloads\/SeeWhatISee\/log\.json\. Fix or delete the file, then capture again\.$/);
    return true;
  });
});

test('with nothing to locate the file, the reconcile says so rather than guessing', async () => {
  stubChrome({ known: false, fileText: serializeLog([rec(1)]) });
  assert.equal((await inspectLogFile()).kind, 'unknown-directory');
  assert.equal(writes.length, 0);
});

test('an unknown directory: the first write is deflected, then the file is read and appended to', async () => {
  // Download history cleared but the log still there. Writing
  // `log.json` without overwriting lands as `log (1).json`, which says
  // a log exists and where; that copy is discarded and the real one
  // appended to.
  const text = serializeLog([rec(1)]);
  stubChrome({ known: false, fileText: text });
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
  // "the user deleted it". Writing over it would lose the log the
  // write was deflected by.
  const store = stubChrome({ known: false, fileText: null, deflect: true });
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
  const store = stubChrome({ known: false, fileText: null });
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
  const store = stubChrome({ known: false, fileText: null, claimFails: true });
  await assert.rejects(recordCapture(rec(3)), (err) => {
    assert.equal(err.name, 'LogWriteFailedError');
    assert.match(err.message, /couldn't write Downloads\/SeeWhatISee\/log\.json: download failed\.$/);
    return true;
  });
  assert.equal(store.lastCaptureFiles, undefined);
});

test('without the file-access toggle the reconcile refuses to guess', async () => {
  // Every entry point checks first, so this is the backstop: a fetch
  // refused for lack of the toggle looks exactly like a deleted log,
  // and starting a new one over the user's history is the wrong guess.
  stubChrome({ fileAccess: false, fileText: serializeLog([rec(1)]) });
  await assert.rejects(inspectLogFile(), FileAccessRequiredError);
});

// ── what recordCapture does with those decisions ─────────────────────

test('a deleted log.json makes the next capture start over, not resurrect', async () => {
  const store = stubChrome({ fileText: null, listed: false });
  await recordCapture(rec(3));
  const log = writes.filter((w) => w.filename.endsWith('log.json')).pop();
  assert.equal(log.body, serializeLog([rec(3)]));
  // And the note says which files the capture wrote.
  assert.deepEqual(store.lastCaptureFiles, { timestamp: rec(3).timestamp, screenshot: 'shot-3.png' });
});

test('a failed capture leaves everything untouched', async () => {
  const store = stubChrome({ fileText: null, listed: true });
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
  stubChrome({ fileText: text });
  await recordCapture(rec(3));
  assert.equal(writes.at(-1).body, `${text}${serializeLog([rec(3)])}`);
});

test('a file missing its trailing newline gets one before the new record', async () => {
  const text = serializeLog([rec(1)]).trimEnd();
  stubChrome({ fileText: text });
  await recordCapture(rec(2));
  assert.equal(writes.at(-1).body, serializeLog([rec(1), rec(2)]));
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
