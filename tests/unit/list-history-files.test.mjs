// Unit tests for `listHistoryFiles` — finding the `history-*.json`
// files by fetching the capture directory's `file://` URL and parsing
// Chrome's generated listing page.
//
// The listing markup is a browser internal, so the fixture below is a
// verbatim copy of what Chrome actually serves (captured from a real
// directory fetch), and the assertions pin the loose-parse contract:
// tokens collected anywhere in the page, deduplicated, sorted
// newest-first by the timestamp in the name — and `res.ok` ignored,
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
const { listHistoryFiles } = await import('../../dist/capture/downloads.js');

test('finds history files, ignores everything else, sorts newest first', async () => {
  stubFetch(listingHtml([
    row('history-20260101-120000-000.json'),
    row('history-20260302-080910-123.json'),
    row('log.json'),
    row('probe-1787669008.json'),
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

test('collapses each name appearing twice per row (text and href)', async () => {
  stubFetch(listingHtml([row('history-20260101-120000-000.json')]));
  assert.equal((await listHistoryFiles(DIR)).length, 1);
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
});
