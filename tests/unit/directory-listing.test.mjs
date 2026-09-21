// Unit tests for reading the capture directory over `file://`:
// `listCaptureDirectory` (the names in it — the filesystem's answer
// to "is this file there?") and `listHistoryFiles` (the
// `history-*.json` files among them, newest first).
//
// The listing markup is a browser internal, so the fixture below is a
// verbatim copy of what Chrome actually serves (captured from a real
// directory fetch), and the assertions pin the parse contract: one
// name per `addRow(` call, JSON-unescaped, sorted newest-first by the
// timestamp in the name for the history files — and `res.ok` ignored,
// because Chrome hands the listing back with `status: 0`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const DIR = '/home/user/Downloads/SeeWhatISee';

/** A directory listing the way Chrome generates it. */
function listingHtml(rows) {
  return `<!DOCTYPE html><html dir="ltr" lang="en"><head><meta charset="utf-8">
<script>function addRow(name, url, isdir, size, size_string, date_modified, date_modified_string) {
  if (name == "." || name == "..") return; }</script>
<script>start("${DIR}/");</script>
<script>onHasParentDirectory();</script>
${rows.map((r) => `<script>addRow(${r});</script>`).join('\n')}
</head><body></body></html>`;
}

/** One addRow argument list for a plain file named `name`. */
function row(name) {
  return `"${name}","${encodeURIComponent(name)}",0,0,"0 B",1787669008,"8/25/26, 7:43:28 AM"`;
}

/** URL passed to the last stubbed `fetch` call. */
let fetchedUrl = null;

/** Stub `fetch` with the listing response Chrome produces. */
function stubFetch(html) {
  globalThis.fetch = async (url) => {
    fetchedUrl = url;
    return { ok: false, status: 0, text: async () => html };
  };
}

globalThis.chrome = { runtime: { id: 'test' } };
const { listCaptureDirectory, listHistoryFiles } = await import('../../dist/capture/downloads.js');

test('finds history files, ignores everything else, sorts newest first', async () => {
  stubFetch(listingHtml([
    row('history-20260101-120000-000.json'),
    row('history-20260302-080910-123.json'),
    row('log.json'),
    row('log (1).json'),
    row('shot with space.png'),
    row('screenshot-20260101-120000-000.png'),
  ]));
  assert.deepEqual(await listHistoryFiles(DIR), [
    `${DIR}/history-20260302-080910-123.json`,
    `${DIR}/history-20260101-120000-000.json`,
  ]);
  assert.equal(fetchedUrl, `file://${DIR}`);
});

test('ignores names that merely contain a history-file name', async () => {
  stubFetch(listingHtml([
    // An interrupted download Chrome left behind: listing the .json
    // it embeds would report a phantom file that never reads.
    row('history-20260101-120000-000.json.crdownload'),
    row('history-20260201-000000-000.json.bak'),
    // A user's stray rename — same phantom-file problem from the
    // front.
    row('old-history-20260215-000000-000.json'),
    // Right prefix but not a machine-generated stamp: someone else's
    // file. The Python backend skips all of these by the same rule.
    row('history-notes.json'),
    row('history-20260302-080910-123.json'),
  ]));
  assert.deepEqual(await listHistoryFiles(DIR), [
    `${DIR}/history-20260302-080910-123.json`,
  ]);
});

test('percent-encodes awkward directory paths in the fetch URL', async () => {
  stubFetch(listingHtml([]));
  await listHistoryFiles('C:\\Users\\First Last\\Downloads\\SeeWhatISee');
  assert.equal(fetchedUrl, 'file:///C:/Users/First%20Last/Downloads/SeeWhatISee');
});

test('listCaptureDirectory returns every entry by its exact name', async () => {
  stubFetch(listingHtml([
    row('log.json'),
    row('log (1).json'),
    row('shot with space.png'),
    row('history-20260101-120000-000.json.crdownload'),
  ]));
  const names = await listCaptureDirectory(DIR);
  assert.deepEqual([...names].sort(), [
    'history-20260101-120000-000.json.crdownload',
    'log (1).json',
    'log.json',
    'shot with space.png',
  ]);
  // Exact names, so a sibling or a partial write can't pass for the
  // file itself — the question the reconcile asks after a failed read.
  assert.ok(names.has('log.json'));
  assert.ok(!names.has('history-20260101-120000-000.json'));
});

test('listCaptureDirectory undoes the JSON escaping Chrome applies', async () => {
  // Chrome writes each name as a JSON string literal: a quote or a
  // non-ASCII character in a filename arrives escaped.
  stubFetch(listingHtml([
    `"say \\"hi\\".png","say%20%22hi%22.png",0,0,"0 B",0,""`,
    `"caf\\u00e9.png","caf%C3%A9.png",0,0,"0 B",0,""`,
  ]));
  const names = await listCaptureDirectory(DIR);
  assert.ok(names.has('say "hi".png'));
  assert.ok(names.has('café.png'));
});

test('listCaptureDirectory is empty for a page with no rows', async () => {
  stubFetch(listingHtml([]));
  assert.equal((await listCaptureDirectory(DIR)).size, 0);
});

test('reuses the directory separator for Windows paths', async () => {
  stubFetch(listingHtml([row('history-20260101-120000-000.json')]));
  const paths = await listHistoryFiles('C:\\Users\\u\\Downloads\\SeeWhatISee');
  assert.deepEqual(paths, ['C:\\Users\\u\\Downloads\\SeeWhatISee\\history-20260101-120000-000.json']);
});

test('an empty or unrecognizable page yields an empty list', async () => {
  stubFetch('');
  assert.deepEqual(await listHistoryFiles(DIR), []);
  stubFetch('<html><body>some totally different markup</body></html>');
  assert.deepEqual(await listHistoryFiles(DIR), []);
});

test('a refused read (missing dir, toggle off) rejects for the caller to catch', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(listHistoryFiles(DIR), TypeError);
  await assert.rejects(listCaptureDirectory(DIR), TypeError);
});

test('the directory is fetched uncached', async () => {
  // Re-read after every capture, so it has to see the file that just
  // landed.
  let init = null;
  globalThis.fetch = async (_url, opts) => {
    init = opts;
    return { ok: false, status: 0, text: async () => listingHtml([]) };
  };
  await listCaptureDirectory(DIR);
  assert.equal(init?.cache, 'no-store');
});
