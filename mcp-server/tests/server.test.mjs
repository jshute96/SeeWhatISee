// End-to-end tests for the MCP server. Uses InMemoryTransport so a Client
// and Server talk to each other inside the same Node process — no stdio,
// no spawning a binary.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { pathToFileURL } from 'node:url';

import { spawn } from 'node:child_process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

import { STREAM_URI, createServer } from '../dist/server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'swis-mcp-'));
}

/**
 * Build a single log.json record. Defaults give a screenshot-only record
 * with a bare PNG filename so the server has work to do rewriting it.
 */
function record(overrides = {}) {
  return {
    timestamp: overrides.timestamp ?? '2026-04-08T20:30:12.345Z',
    url: 'https://example.com/p',
    title: 'Example',
    screenshot: { filename: 'shot-1.png' },
    ...overrides,
  };
}

function writeLog(dir, records) {
  const logPath = path.join(dir, 'log.json');
  fs.writeFileSync(logPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return logPath;
}

function appendRecord(dir, rec) {
  const logPath = path.join(dir, 'log.json');
  fs.appendFileSync(logPath, JSON.stringify(rec) + '\n');
}

async function setup({ records = [], watchDefaultTimeoutMs = 150 } = {}) {
  const dir = tmpdir();
  if (records.length > 0) writeLog(dir, records);
  const server = createServer({
    sourceDir: dir,
    watchDefaultTimeoutMs,
    watchMaxTimeoutMs: 5_000,
  });
  const client = new Client({ name: 'test', version: '0' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return {
    dir,
    server,
    client,
    async cleanup() {
      await client.close();
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// The tools return a JSON metadata text block per record, followed by a
// resource_link (or inline content) per artifact file. These helpers pull the
// pieces apart.

/** Expected file:// URI for `name` under `dir`. */
function uriFor(dir, name) {
  return pathToFileURL(path.join(dir, name)).href;
}

/** The first (single-record) metadata record from a tool result. */
function metaRecord(res) {
  assert.ok(Array.isArray(res.content));
  const block = res.content.find((c) => c.type === 'text');
  assert.ok(block, 'expected a metadata text block');
  return JSON.parse(block.text);
}

/** All non-text content blocks (resource_link / image / embedded resource). */
function fileBlocks(res) {
  return res.content.filter((c) => c.type !== 'text');
}

/** All resource_link blocks. */
function links(res) {
  return res.content.filter((c) => c.type === 'resource_link');
}

/** The resource_link with the given role name. */
function linkFor(res, role) {
  return links(res).find((c) => c.name === role);
}

/** Inline blocks (image / embedded resource) — i.e. non-text, non-link. */
function inlineBlocks(res) {
  return res.content.filter((c) => c.type === 'image' || c.type === 'resource');
}

/**
 * Records carried by a `watch` result. An empty watch returns a single
 * `{ records: [] }` sentinel text block; otherwise each text block is a record.
 */
function watchRecords(res) {
  const texts = res.content.filter((c) => c.type === 'text').map((c) => JSON.parse(c.text));
  if (texts.length === 1 && Array.isArray(texts[0].records)) return texts[0].records;
  return texts;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

test('tools/list exposes the capture and watch tools', async () => {
  const ctx = await setup();
  try {
    const { tools } = await ctx.client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['get_latest', 'stop_watch', 'watch']);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// get_latest
// ---------------------------------------------------------------------------

test('get_latest returns a flags-only metadata block plus a resource_link', async () => {
  const ctx = await setup({
    records: [
      record({ timestamp: '2026-04-08T20:30:00.000Z', screenshot: { filename: 'a.png' } }),
      record({ timestamp: '2026-04-08T20:30:05.000Z', screenshot: { filename: 'b.png' } }),
    ],
  });
  try {
    const res = await ctx.client.callTool({ name: 'get_latest', arguments: {} });
    const rec = metaRecord(res);
    assert.equal(rec.timestamp, '2026-04-08T20:30:05.000Z');
    // The metadata block carries no locator — not the filename, and not a
    // duplicated uri/mimeType (those live on the resource_link).
    assert.equal(rec.screenshot.filename, undefined);
    assert.equal(rec.screenshot.uri, undefined);
    assert.equal(rec.screenshot.mimeType, undefined);
    // The file rides as a single resource_link.
    const all = fileBlocks(res);
    assert.equal(all.length, 1);
    const link = linkFor(res, 'screenshot');
    assert.equal(link.type, 'resource_link');
    assert.equal(link.uri, uriFor(ctx.dir, 'b.png'));
    assert.equal(link.mimeType, 'image/png');
  } finally {
    await ctx.cleanup();
  }
});

test('get_latest exposes all three artifacts as resource links, flags in metadata', async () => {
  const ctx = await setup({
    records: [
      record({
        screenshot: { filename: 'shot.png', hasHighlights: true },
        contents: { filename: 'page.html' },
        selection: { filename: 'sel.md', format: 'markdown' },
      }),
    ],
  });
  try {
    const res = await ctx.client.callTool({ name: 'get_latest', arguments: {} });
    // Flags live in the metadata block, keyed by role.
    const rec = metaRecord(res);
    assert.equal(rec.screenshot.hasHighlights, true);
    assert.equal(rec.selection.format, 'markdown');
    // Locators live on the resource_links.
    assert.equal(linkFor(res, 'screenshot').uri, uriFor(ctx.dir, 'shot.png'));
    assert.equal(linkFor(res, 'contents').uri, uriFor(ctx.dir, 'page.html'));
    assert.equal(linkFor(res, 'selection').uri, uriFor(ctx.dir, 'sel.md'));
    assert.deepEqual(
      links(res).map((l) => [l.name, l.mimeType]),
      [
        ['screenshot', 'image/png'],
        ['contents', 'text/html'],
        ['selection', 'text/markdown'],
      ],
    );
  } finally {
    await ctx.cleanup();
  }
});

test('get_latest resource_link carries a size when the file exists on disk', async () => {
  const ctx = await setup({
    records: [record({ screenshot: { filename: 'shot.png' } })],
  });
  try {
    fs.writeFileSync(path.join(ctx.dir, 'shot.png'), Buffer.alloc(42));
    const res = await ctx.client.callTool({ name: 'get_latest', arguments: {} });
    assert.equal(linkFor(res, 'screenshot').size, 42);
  } finally {
    await ctx.cleanup();
  }
});

test('get_latest return_inline adds inline content alongside the links', async () => {
  const ctx = await setup({
    records: [
      record({
        screenshot: { filename: 'shot.png' },
        contents: { filename: 'page.html' },
      }),
    ],
  });
  try {
    fs.writeFileSync(path.join(ctx.dir, 'shot.png'), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(ctx.dir, 'page.html'), '<h1>hi</h1>');
    const res = await ctx.client.callTool({
      name: 'get_latest',
      arguments: { return_inline: true },
    });
    // Both resource_links are still present...
    assert.equal(links(res).length, 2);
    // ...plus the inline bytes in addition. Image as image content.
    const img = inlineBlocks(res).find((b) => b.type === 'image');
    assert.ok(img, 'expected an image block');
    assert.equal(img.mimeType, 'image/png');
    assert.deepEqual(Array.from(Buffer.from(img.data, 'base64')), [1, 2, 3]);
    // HTML as an embedded resource (a file), not assistant text.
    const html = inlineBlocks(res).find((b) => b.type === 'resource');
    assert.ok(html, 'expected an embedded resource block');
    assert.equal(html.resource.mimeType, 'text/html');
    assert.equal(html.resource.text, '<h1>hi</h1>');
    assert.equal(html.resource.uri, uriFor(ctx.dir, 'page.html'));
  } finally {
    await ctx.cleanup();
  }
});

test('small selections are inlined by default; return_inline:false suppresses it', async () => {
  const ctx = await setup({
    records: [record({ screenshot: { filename: 'shot.png' }, selection: { filename: 'sel.md' } })],
  });
  try {
    fs.writeFileSync(path.join(ctx.dir, 'sel.md'), 'a short selection');
    // Default: the small selection comes inline (in addition to its link),
    // but the screenshot does not.
    const def = await ctx.client.callTool({ name: 'get_latest', arguments: {} });
    assert.equal(links(def).length, 2);
    const sel = inlineBlocks(def);
    assert.equal(sel.length, 1);
    assert.equal(sel[0].type, 'resource');
    assert.equal(sel[0].resource.text, 'a short selection');
    assert.equal(sel[0].resource.uri, uriFor(ctx.dir, 'sel.md'));
    // Explicit return_inline:false suppresses the default selection inlining.
    const off = await ctx.client.callTool({
      name: 'get_latest',
      arguments: { return_inline: false },
    });
    assert.equal(inlineBlocks(off).length, 0);
    assert.equal(links(off).length, 2);
  } finally {
    await ctx.cleanup();
  }
});

test('a large selection is not inlined by default', async () => {
  const ctx = await setup({
    records: [record({ screenshot: undefined, selection: { filename: 'big.md' } })],
  });
  try {
    fs.writeFileSync(path.join(ctx.dir, 'big.md'), 'x'.repeat(11 * 1024));
    const res = await ctx.client.callTool({ name: 'get_latest', arguments: {} });
    assert.equal(inlineBlocks(res).length, 0);
    assert.equal(linkFor(res, 'selection').uri, uriFor(ctx.dir, 'big.md'));
  } finally {
    await ctx.cleanup();
  }
});

test('get_latest return_inline falls back to a resource_link when a file is missing', async () => {
  // The screenshot file is never written to disk. Inline mode must not sink
  // the whole call — that artifact stays a resource_link with no inline block.
  const ctx = await setup({
    records: [record({ screenshot: { filename: 'gone.png' } })],
  });
  try {
    const res = await ctx.client.callTool({
      name: 'get_latest',
      arguments: { return_inline: true },
    });
    assert.equal(metaRecord(res).timestamp !== undefined, true);
    assert.equal(links(res).length, 1);
    assert.equal(inlineBlocks(res).length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('get_latest return_inline falls back to a link for paths outside the source dir', async () => {
  const ctx = await setup({
    records: [record({ screenshot: { filename: '/already/abs.png' } })],
  });
  try {
    const res = await ctx.client.callTool({
      name: 'get_latest',
      arguments: { return_inline: true },
    });
    assert.equal(links(res).length, 1);
    assert.equal(inlineBlocks(res).length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('get_latest leaves already-absolute paths alone', async () => {
  const ctx = await setup({
    records: [record({ screenshot: { filename: '/already/abs.png' } })],
  });
  try {
    const res = await ctx.client.callTool({ name: 'get_latest', arguments: {} });
    assert.equal(linkFor(res, 'screenshot').uri, pathToFileURL('/already/abs.png').href);
  } finally {
    await ctx.cleanup();
  }
});

test('get_latest errors when log.json is missing', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.client
      .callTool({ name: 'get_latest', arguments: {} })
      .catch((e) => e);
    assert.match(String(res), /not found/i);
  } finally {
    await ctx.cleanup();
  }
});

test('get_latest errors when log.json is empty', async () => {
  const ctx = await setup();
  try {
    fs.writeFileSync(path.join(ctx.dir, 'log.json'), '');
    const res = await ctx.client
      .callTool({ name: 'get_latest', arguments: {} })
      .catch((e) => e);
    assert.match(String(res), /empty/i);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// watch
// ---------------------------------------------------------------------------

test('watch with `after` drains pending records strictly newer', async () => {
  const ctx = await setup({
    records: [
      record({ timestamp: '2026-04-08T20:30:00.000Z', screenshot: { filename: 'a.png' } }),
      record({ timestamp: '2026-04-08T20:30:01.000Z', screenshot: { filename: 'b.png' } }),
      record({ timestamp: '2026-04-08T20:30:02.000Z', screenshot: { filename: 'c.png' } }),
    ],
  });
  try {
    const res = await ctx.client.callTool({
      name: 'watch',
      arguments: { after: '2026-04-08T20:30:00.000Z' },
    });
    const records = watchRecords(res);
    assert.equal(records.length, 2);
    assert.equal(records[0].timestamp, '2026-04-08T20:30:01.000Z');
    assert.equal(records[1].timestamp, '2026-04-08T20:30:02.000Z');
    // One resource_link per drained record, in order.
    assert.deepEqual(
      links(res).map((l) => l.uri),
      [uriFor(ctx.dir, 'b.png'), uriFor(ctx.dir, 'c.png')],
    );
  } finally {
    await ctx.cleanup();
  }
});

test('watch with no pending returns empty on timeout', async () => {
  const ctx = await setup({ watchDefaultTimeoutMs: 120 });
  try {
    const res = await ctx.client.callTool({ name: 'watch', arguments: {} });
    assert.deepEqual(watchRecords(res), []);
    assert.equal(fileBlocks(res).length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('watch with `after` matching the latest record falls through to blocking wait', async () => {
  const ctx = await setup({
    records: [record({ timestamp: '2026-04-08T20:30:00.000Z' })],
    watchDefaultTimeoutMs: 120,
  });
  try {
    const res = await ctx.client.callTool({
      name: 'watch',
      arguments: { after: '2026-04-08T20:30:00.000Z' },
    });
    assert.deepEqual(watchRecords(res), []);
  } finally {
    await ctx.cleanup();
  }
});

test('watch returns the next record when one is appended', async () => {
  const ctx = await setup({
    records: [record({ timestamp: '2026-04-08T20:30:00.000Z' })],
    watchDefaultTimeoutMs: 2_000,
  });
  try {
    const next = record({
      timestamp: '2026-04-08T20:30:05.000Z',
      screenshot: { filename: 'new.png' },
    });
    // Append shortly after kicking off the watch call so fs.watch is
    // already armed when the file changes.
    const watchPromise = ctx.client.callTool({
      name: 'watch',
      arguments: { after: '2026-04-08T20:30:00.000Z' },
    });
    setTimeout(() => appendRecord(ctx.dir, next), 80);
    const res = await watchPromise;
    const records = watchRecords(res);
    assert.equal(records.length, 1);
    assert.equal(records[0].timestamp, '2026-04-08T20:30:05.000Z');
    assert.equal(linkFor(res, 'screenshot').uri, uriFor(ctx.dir, 'new.png'));
  } finally {
    await ctx.cleanup();
  }
});

test('watch returns every record in a coalesced burst, not just the last', async () => {
  // Two captures landing within one fs.watch debounce window fan out as a
  // single wake. The wake must return BOTH — if it returned only the latest,
  // a client cursoring forward would skip the intermediate record.
  const ctx = await setup({
    records: [record({ timestamp: '2026-04-08T20:30:00.000Z' })],
    watchDefaultTimeoutMs: 2_000,
  });
  try {
    const watchPromise = ctx.client.callTool({
      name: 'watch',
      arguments: { after: '2026-04-08T20:30:00.000Z' },
    });
    // Append both back-to-back so they coalesce into one notification.
    setTimeout(() => {
      appendRecord(ctx.dir, record({ timestamp: '2026-04-08T20:30:05.000Z' }));
      appendRecord(ctx.dir, record({ timestamp: '2026-04-08T20:30:06.000Z' }));
    }, 80);
    const records = watchRecords(await watchPromise);
    assert.deepEqual(
      records.map((r) => r.timestamp),
      ['2026-04-08T20:30:05.000Z', '2026-04-08T20:30:06.000Z'],
    );
  } finally {
    await ctx.cleanup();
  }
});

test('watch resumes past the last record sharing the cursor timestamp', async () => {
  // A log that repeats a timestamp, which the extension doesn't write
  // (`uniqueTimestamp` in src/capture/log-store.ts). The drain resumes after
  // the last of them, so a client re-cursoring on that timestamp still
  // advances; matching the first would re-emit the rest on every call.
  const ctx = await setup({
    records: [
      record({ timestamp: '2026-04-08T20:30:00.000Z' }),
      record({ timestamp: '2026-04-08T20:30:05.000Z', screenshot: { filename: 'shot-a.png' } }),
      record({ timestamp: '2026-04-08T20:30:05.000Z', screenshot: { filename: 'shot-b.png' } }),
    ],
    watchDefaultTimeoutMs: 300,
  });
  try {
    const res = await ctx.client.callTool({
      name: 'watch',
      arguments: { after: '2026-04-08T20:30:05.000Z' },
    });
    assert.deepEqual(watchRecords(res), []);
  } finally {
    await ctx.cleanup();
  }
});

test('watch drains what follows a shared cursor timestamp, and neither copy', async () => {
  const ctx = await setup({
    records: [
      record({ timestamp: '2026-04-08T20:30:05.000Z', screenshot: { filename: 'shot-a.png' } }),
      record({ timestamp: '2026-04-08T20:30:05.000Z', screenshot: { filename: 'shot-b.png' } }),
      record({ timestamp: '2026-04-08T20:30:09.000Z', screenshot: { filename: 'shot-c.png' } }),
    ],
    watchDefaultTimeoutMs: 300,
  });
  try {
    const res = await ctx.client.callTool({
      name: 'watch',
      arguments: { after: '2026-04-08T20:30:05.000Z' },
    });
    assert.equal(watchRecords(res).length, 1);
    assert.equal(linkFor(res, 'screenshot').uri, uriFor(ctx.dir, 'shot-c.png'));
  } finally {
    await ctx.cleanup();
  }
});

test('watch with no cursor also wakes on an out-of-order arrival', async () => {
  // No `after`, so the baseline is the tail at the moment the wait starts —
  // still a position in the log, so the same positional rule applies.
  const ctx = await setup({
    records: [record({
      timestamp: '2026-04-08T20:30:05.000Z',
      screenshot: { filename: 'shot-a.png' },
    })],
    watchDefaultTimeoutMs: 2_000,
  });
  try {
    const watchPromise = ctx.client.callTool({ name: 'watch', arguments: {} });
    setTimeout(() => {
      appendRecord(ctx.dir, record({
        timestamp: '2026-04-08T20:29:00.000Z',
        screenshot: { filename: 'shot-b.png' },
      }));
    }, 80);
    const res = await watchPromise;
    assert.equal(watchRecords(res).length, 1);
    assert.equal(linkFor(res, 'screenshot').uri, uriFor(ctx.dir, 'shot-b.png'));
  } finally {
    await ctx.cleanup();
  }
});

test('watch wakes on a record whose timestamp precedes the cursor', async () => {
  // The log is in append order, and a record appended later can carry an
  // earlier timestamp: a Capture-page session pins its timestamp when the
  // capture is *taken*, so a slow save lands after captures taken later. A
  // chronological wake test never sees that record.
  const ctx = await setup({
    records: [record({
      timestamp: '2026-04-08T20:30:05.000Z',
      screenshot: { filename: 'shot-a.png' },
    })],
    watchDefaultTimeoutMs: 2_000,
  });
  try {
    const watchPromise = ctx.client.callTool({
      name: 'watch',
      arguments: { after: '2026-04-08T20:30:05.000Z' },
    });
    setTimeout(() => {
      appendRecord(ctx.dir, record({
        timestamp: '2026-04-08T20:29:00.000Z',
        screenshot: { filename: 'shot-b.png' },
      }));
    }, 80);
    const res = await watchPromise;
    assert.equal(watchRecords(res).length, 1);
    assert.equal(linkFor(res, 'screenshot').uri, uriFor(ctx.dir, 'shot-b.png'));
  } finally {
    await ctx.cleanup();
  }
});

test('the stream resource is positional too, so it returns an out-of-order arrival', async () => {
  const ctx = await setup({
    records: [
      record({ timestamp: '2026-04-08T20:30:05.000Z', screenshot: { filename: 'shot-a.png' } }),
      record({ timestamp: '2026-04-08T20:29:00.000Z', screenshot: { filename: 'shot-b.png' } }),
    ],
  });
  try {
    const res = await ctx.client.readResource({
      uri: 'seewhatisee://captures/stream?after=2026-04-08T20:30:05.000Z',
    });
    const payload = JSON.parse(res.contents[0].text);
    assert.deepEqual(payload.records.map((r) => r.timestamp),
      ['2026-04-08T20:29:00.000Z']);
  } finally {
    await ctx.cleanup();
  }
});

test('watch returns already-present newer records immediately, without blocking', async () => {
  // Records newer than the cursor already sit in the log when watch is called
  // (the cursor isn't an exact in-log timestamp, so the drain's exact-match
  // skips them). The post-attach catch-up read must still surface them at once
  // rather than blocking until the next fs change — closing the attach-gap
  // race. A short timeout means a regression returns [] quickly instead of
  // hanging.
  const ctx = await setup({
    records: [
      record({ timestamp: '2026-04-08T20:30:00.000Z' }),
      record({ timestamp: '2026-04-08T20:30:05.000Z' }),
    ],
    watchDefaultTimeoutMs: 300,
  });
  try {
    const res = await ctx.client.callTool({
      name: 'watch',
      arguments: { after: '2026-04-08T20:29:00.000Z' },
    });
    assert.deepEqual(
      watchRecords(res).map((r) => r.timestamp),
      ['2026-04-08T20:30:00.000Z', '2026-04-08T20:30:05.000Z'],
    );
  } finally {
    await ctx.cleanup();
  }
});

test('watch wakes up when log.json is created from scratch', async () => {
  // No log.json yet — exercises the parent-dir fs.watch path.
  const ctx = await setup({ watchDefaultTimeoutMs: 2_000 });
  try {
    const watchPromise = ctx.client.callTool({ name: 'watch', arguments: {} });
    setTimeout(() => {
      writeLog(ctx.dir, [record({ timestamp: '2026-04-08T20:31:00.000Z' })]);
    }, 80);
    const records = watchRecords(await watchPromise);
    assert.equal(records.length, 1);
    assert.equal(records[0].timestamp, '2026-04-08T20:31:00.000Z');
  } finally {
    await ctx.cleanup();
  }
});

test('watch caps timeout_ms at watchMaxTimeoutMs', async () => {
  const ctx = await setup({ watchDefaultTimeoutMs: 200 });
  try {
    // Caller asks for 10 minutes; max is 5s. Should not actually wait
    // that long — write a record and observe a quick return.
    const watchPromise = ctx.client.callTool({
      name: 'watch',
      arguments: { timeout_ms: 600_000 },
    });
    setTimeout(() => appendRecord(ctx.dir, record({ timestamp: '2026-04-08T20:31:00.000Z' })), 80);
    const records = watchRecords(await watchPromise);
    assert.equal(records.length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('watch return_inline inlines the new capture', async () => {
  const ctx = await setup({
    records: [record({ timestamp: '2026-04-08T20:30:00.000Z' })],
    watchDefaultTimeoutMs: 2_000,
  });
  try {
    fs.writeFileSync(path.join(ctx.dir, 'new.png'), Buffer.from([9, 8, 7]));
    const watchPromise = ctx.client.callTool({
      name: 'watch',
      arguments: { after: '2026-04-08T20:30:00.000Z', return_inline: true },
    });
    setTimeout(
      () =>
        appendRecord(ctx.dir, {
          timestamp: '2026-04-08T20:30:05.000Z',
          screenshot: { filename: 'new.png' },
        }),
      80,
    );
    const res = await watchPromise;
    const img = fileBlocks(res).find((b) => b.type === 'image');
    assert.ok(img, 'expected an inline image block');
    assert.deepEqual(Array.from(Buffer.from(img.data, 'base64')), [9, 8, 7]);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// resources/list
// ---------------------------------------------------------------------------

test('resources/list exposes only the captures/stream resource (files are not enumerated)', async () => {
  const ctx = await setup();
  try {
    // Even with captured files present, the list stays stream-only — files are
    // reached by URI via resources/read, not by listing.
    fs.writeFileSync(path.join(ctx.dir, 'shot.png'), Buffer.alloc(7));
    const { resources } = await ctx.client.listResources();
    assert.equal(resources.length, 1);
    assert.equal(resources[0].uri, STREAM_URI);
    assert.equal(resources[0].mimeType, 'application/json');
  } finally {
    await ctx.cleanup();
  }
});

test('resources/templates/list advertises the cursored stream and file templates', async () => {
  const ctx = await setup();
  try {
    const { resourceTemplates } = await ctx.client.listResourceTemplates();
    const byUri = Object.fromEntries(resourceTemplates.map((t) => [t.uriTemplate, t]));
    assert.equal(resourceTemplates.length, 2);
    assert.equal(byUri[STREAM_URI + '{?after}'].mimeType, 'application/json');
    // File template uses reserved expansion so path slashes aren't encoded.
    assert.ok(byUri['file://{+path}'], 'expected a file://{+path} template');
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// resources/read — captures/stream
// ---------------------------------------------------------------------------

test('resources/read returns { record: null } when log is empty', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.client.readResource({ uri: STREAM_URI });
    const payload = JSON.parse(res.contents[0].text);
    assert.deepEqual(payload, { record: null });
  } finally {
    await ctx.cleanup();
  }
});

test('resources/read returns the latest record referencing files by uri', async () => {
  const ctx = await setup({
    records: [
      record({ timestamp: '2026-04-08T20:30:00.000Z', screenshot: { filename: 'a.png' } }),
      record({ timestamp: '2026-04-08T20:30:05.000Z', screenshot: { filename: 'b.png' } }),
    ],
  });
  try {
    const res = await ctx.client.readResource({ uri: STREAM_URI });
    const payload = JSON.parse(res.contents[0].text);
    assert.equal(payload.timestamp, '2026-04-08T20:30:05.000Z');
    assert.equal(payload.screenshot.uri, uriFor(ctx.dir, 'b.png'));
  } finally {
    await ctx.cleanup();
  }
});

test('resources/read with ?after= drains every record strictly newer, in order', async () => {
  const ctx = await setup({
    records: [
      record({ timestamp: '2026-04-08T20:30:00.000Z', screenshot: { filename: 'a.png' } }),
      record({ timestamp: '2026-04-08T20:30:05.000Z', screenshot: { filename: 'b.png' } }),
      record({ timestamp: '2026-04-08T20:30:10.000Z', screenshot: { filename: 'c.png' } }),
    ],
  });
  try {
    const res = await ctx.client.readResource({
      uri: STREAM_URI + '?after=2026-04-08T20:30:00.000Z',
    });
    const payload = JSON.parse(res.contents[0].text);
    // Excludes the cursor record (strictly-greater), returns the rest in order.
    assert.deepEqual(
      payload.records.map((r) => r.timestamp),
      ['2026-04-08T20:30:05.000Z', '2026-04-08T20:30:10.000Z'],
    );
    assert.equal(payload.records[0].screenshot.uri, uriFor(ctx.dir, 'b.png'));
    assert.equal(payload.records[1].screenshot.uri, uriFor(ctx.dir, 'c.png'));
  } finally {
    await ctx.cleanup();
  }
});

test('resources/read with ?after= at/after the latest returns an empty records array', async () => {
  const ctx = await setup({
    records: [record({ timestamp: '2026-04-08T20:30:05.000Z' })],
  });
  try {
    const res = await ctx.client.readResource({
      uri: STREAM_URI + '?after=2026-04-08T20:30:05.000Z',
    });
    const payload = JSON.parse(res.contents[0].text);
    assert.deepEqual(payload, { records: [] });
  } finally {
    await ctx.cleanup();
  }
});

test('resources/read with an empty cursor (?after=) returns all records from the start', async () => {
  const ctx = await setup({
    records: [
      record({ timestamp: '2026-04-08T20:30:00.000Z' }),
      record({ timestamp: '2026-04-08T20:30:05.000Z' }),
    ],
  });
  try {
    // A client that bootstrapped on an empty log seeds an empty cursor; the
    // empty value must stay in the cursored ({ records }) shape, not fall back
    // to the bare latest-record shape.
    const res = await ctx.client.readResource({ uri: STREAM_URI + '?after=' });
    const payload = JSON.parse(res.contents[0].text);
    assert.deepEqual(
      payload.records.map((r) => r.timestamp),
      ['2026-04-08T20:30:00.000Z', '2026-04-08T20:30:05.000Z'],
    );
  } finally {
    await ctx.cleanup();
  }
});

test('resources/read trims a whitespace-only cursor to the empty "from the start" cursor', async () => {
  const ctx = await setup({
    records: [record({ timestamp: '2026-04-08T20:30:00.000Z' })],
  });
  try {
    // A space is a workaround for UIs that won't submit a truly blank value;
    // trimming makes it behave like `?after=`.
    const res = await ctx.client.readResource({ uri: STREAM_URI + '?after=%20' });
    const payload = JSON.parse(res.contents[0].text);
    assert.deepEqual(
      payload.records.map((r) => r.timestamp),
      ['2026-04-08T20:30:00.000Z'],
    );
  } finally {
    await ctx.cleanup();
  }
});

test('resources/read rejects a malformed after cursor', async () => {
  const ctx = await setup({
    records: [record({ timestamp: '2026-04-08T20:30:00.000Z' })],
  });
  try {
    await assert.rejects(
      ctx.client.readResource({ uri: STREAM_URI + '?after=not-a-timestamp' }),
      /Invalid `after` cursor/,
    );
    // A date without the full fixed-width time/zone is also rejected — the
    // lexical compare only works against the canonical format.
    await assert.rejects(
      ctx.client.readResource({ uri: STREAM_URI + '?after=2026-04-08' }),
      /Invalid `after` cursor/,
    );
  } finally {
    await ctx.cleanup();
  }
});

test('a burst of captures is fully recovered by one cursored read (loss-free)', async () => {
  const ctx = await setup();
  try {
    // Seed cursor from a bootstrap (bare) read of an empty log.
    let res = await ctx.client.readResource({ uri: STREAM_URI });
    assert.deepEqual(JSON.parse(res.contents[0].text), { record: null });
    // Several captures land back-to-back (would collapse to one notification).
    writeLog(ctx.dir, [
      record({ timestamp: '2026-04-08T20:31:00.000Z' }),
      record({ timestamp: '2026-04-08T20:31:00.500Z' }),
      record({ timestamp: '2026-04-08T20:31:01.000Z' }),
    ]);
    // A single cursored read from the seed cursor drains all three.
    res = await ctx.client.readResource({
      uri: STREAM_URI + '?after=2026-04-08T20:30:00.000Z',
    });
    const payload = JSON.parse(res.contents[0].text);
    assert.equal(payload.records.length, 3);
  } finally {
    await ctx.cleanup();
  }
});

test('resources/read rejects unknown non-file URIs', async () => {
  const ctx = await setup();
  try {
    const err = await ctx.client
      .readResource({ uri: 'seewhatisee://other' })
      .catch((e) => e);
    assert.match(String(err), /unknown resource/i);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// resources/read — file:// captured files
// ---------------------------------------------------------------------------

test('resources/read returns image bytes as a blob', async () => {
  const ctx = await setup();
  try {
    const filePath = path.join(ctx.dir, 'shot.png');
    fs.writeFileSync(filePath, Buffer.from([1, 2, 3, 4, 5]));
    const res = await ctx.client.readResource({ uri: pathToFileURL(filePath).href });
    assert.equal(res.contents[0].mimeType, 'image/png');
    assert.deepEqual(Array.from(Buffer.from(res.contents[0].blob, 'base64')), [1, 2, 3, 4, 5]);
    assert.equal(res.contents[0].text, undefined);
  } finally {
    await ctx.cleanup();
  }
});

test('resources/read returns HTML/text files as text', async () => {
  const ctx = await setup();
  try {
    const filePath = path.join(ctx.dir, 'page.html');
    fs.writeFileSync(filePath, '<h1>hi</h1>');
    const res = await ctx.client.readResource({ uri: pathToFileURL(filePath).href });
    assert.equal(res.contents[0].mimeType, 'text/html');
    assert.equal(res.contents[0].text, '<h1>hi</h1>');
  } finally {
    await ctx.cleanup();
  }
});

test('resources/read rejects file URIs outside the source dir', async () => {
  const ctx = await setup();
  try {
    const otherDir = tmpdir();
    const outside = path.join(otherDir, 'evil.png');
    fs.writeFileSync(outside, 'x');
    try {
      const err = await ctx.client
        .readResource({ uri: pathToFileURL(outside).href })
        .catch((e) => e);
      assert.match(String(err), /outside the source dir/i);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  } finally {
    await ctx.cleanup();
  }
});

test('resources/read rejects symlink escapes', async () => {
  const ctx = await setup();
  try {
    const otherDir = tmpdir();
    const realFile = path.join(otherDir, 'real.png');
    fs.writeFileSync(realFile, 'x');
    const link = path.join(ctx.dir, 'link.png');
    try {
      fs.symlinkSync(realFile, link);
    } catch (e) {
      if (e.code === 'EPERM') return; // platform doesn't allow symlinks; skip
      throw e;
    }
    try {
      const err = await ctx.client
        .readResource({ uri: pathToFileURL(link).href })
        .catch((e) => e);
      assert.match(String(err), /outside the source dir/i);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  } finally {
    await ctx.cleanup();
  }
});

test('resources/read reports not-found for missing files inside the source dir', async () => {
  const ctx = await setup();
  try {
    const err = await ctx.client
      .readResource({ uri: pathToFileURL(path.join(ctx.dir, 'nope.png')).href })
      .catch((e) => e);
    assert.match(String(err), /not found/i);
  } finally {
    await ctx.cleanup();
  }
});

test('resources/read rejects nonexistent paths outside the source dir without leaking existence', async () => {
  // The containment check must happen before any filesystem access, so a
  // path outside the source dir reports "outside", never "not found".
  const ctx = await setup();
  try {
    const err = await ctx.client
      .readResource({ uri: pathToFileURL('/definitely/not/here/file.png').href })
      .catch((e) => e);
    assert.match(String(err), /outside the source dir/i);
    assert.doesNotMatch(String(err), /not found/i);
  } finally {
    await ctx.cleanup();
  }
});

test('subscribe fires a notifications/resources/updated when log.json changes', async () => {
  const ctx = await setup();
  try {
    let resolveUpdate;
    const updated = new Promise((r) => (resolveUpdate = r));
    ctx.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      if (n.params.uri === STREAM_URI) resolveUpdate(n);
    });
    await ctx.client.subscribeResource({ uri: STREAM_URI });
    // Give fs.watch a tick to arm before we write.
    await sleep(50);
    writeLog(ctx.dir, [record({ timestamp: '2026-04-08T20:31:00.000Z' })]);
    const got = await Promise.race([
      updated,
      sleep(2_000).then(() => null),
    ]);
    assert.ok(got, 'expected a resources/updated notification within 2s');
    assert.equal(got.params.uri, STREAM_URI);
  } finally {
    await ctx.cleanup();
  }
});

test('unsubscribe stops further notifications', async () => {
  const ctx = await setup();
  try {
    let count = 0;
    ctx.client.setNotificationHandler(ResourceUpdatedNotificationSchema, () => {
      count += 1;
    });
    await ctx.client.subscribeResource({ uri: STREAM_URI });
    await sleep(50);
    writeLog(ctx.dir, [record({ timestamp: '2026-04-08T20:31:00.000Z' })]);
    // Wait for the first notification to land.
    await sleep(300);
    const afterFirst = count;
    assert.ok(afterFirst >= 1, `expected at least 1 notification, got ${afterFirst}`);

    await ctx.client.unsubscribeResource({ uri: STREAM_URI });
    await sleep(50);
    appendRecord(ctx.dir, record({ timestamp: '2026-04-08T20:32:00.000Z' }));
    await sleep(300);
    assert.equal(count, afterFirst, 'no further notifications after unsubscribe');
  } finally {
    await ctx.cleanup();
  }
});

test('a burst of fs events for one capture is debounced to a single notification', async () => {
  const ctx = await setup();
  try {
    let count = 0;
    ctx.client.setNotificationHandler(ResourceUpdatedNotificationSchema, () => {
      count += 1;
    });
    await ctx.client.subscribeResource({ uri: STREAM_URI });
    await sleep(50);
    // One logical capture, written several times in quick succession (mimics
    // the overlapping file+dir watchers and the browser's multi-write download).
    // All writes land well within WATCH_DEBOUNCE_MS, so they must coalesce.
    for (let i = 0; i < 5; i++) {
      writeLog(ctx.dir, [record({ timestamp: '2026-04-08T20:33:00.000Z' })]);
      await sleep(10);
    }
    // Wait out the debounce window plus margin.
    await sleep(300);
    assert.equal(count, 1, `expected exactly one coalesced notification, got ${count}`);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------

test('prompts/list exposes every prompt', async () => {
  const ctx = await setup();
  try {
    const { prompts } = await ctx.client.listPrompts();
    const names = prompts.map((p) => p.name).sort();
    assert.deepEqual(names, [
      'see-what-i-see', 'see-what-i-see-stop', 'see-what-i-see-watch',
    ]);
  } finally {
    await ctx.cleanup();
  }
});

test('prompts/get for see-what-i-see returns a user message that mentions get_latest', async () => {
  const ctx = await setup();
  try {
    const got = await ctx.client.getPrompt({ name: 'see-what-i-see' });
    assert.ok(got.messages?.length >= 1);
    const msg = got.messages[0];
    assert.equal(msg.role, 'user');
    assert.equal(msg.content.type, 'text');
    assert.match(msg.content.text, /get_latest/);
    assert.match(msg.content.text, /screenshot/);
  } finally {
    await ctx.cleanup();
  }
});

test('prompts/get for see-what-i-see-watch mentions both subscription and watch tool', async () => {
  const ctx = await setup();
  try {
    const got = await ctx.client.getPrompt({ name: 'see-what-i-see-watch' });
    const text = got.messages[0].content.text;
    assert.match(text, /captures\/stream/);
    assert.match(text, /watch/);
    assert.match(text, /after = /);
  } finally {
    await ctx.cleanup();
  }
});

test('prompts/get rejects unknown prompts', async () => {
  const ctx = await setup();
  try {
    const err = await ctx.client
      .getPrompt({ name: 'nope' })
      .catch((e) => e);
    assert.match(String(err), /unknown prompt/i);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Watch protocol — publishing a session so the extension (and the shell
// script) can see and stop this server's watch. See docs/watch-protocol.md.
// ---------------------------------------------------------------------------

const STATUS_FILE = '.watch-status.json';
const STOP_FILE = 'watch-stop.json';

function readStatus(dir) {
  const p = path.join(dir, STATUS_FILE);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Write the request the Capture page's Stop button downloads. */
function requestStop(dir, session) {
  fs.writeFileSync(
    path.join(dir, STOP_FILE),
    JSON.stringify({ sessionStarted: session, requestedAt: new Date().toISOString() }) + '\n',
  );
}

/** The `stopped` field a watch result carries when the watch was ended. */
function stoppedReason(res) {
  const blocks = res.content.filter((c) => c.type === 'text');
  for (const b of blocks) {
    const parsed = JSON.parse(b.text);
    if (parsed.stopped) return parsed.stopped;
  }
  return null;
}

test('a watch call publishes a session and hands it on', async () => {
  const ctx = await setup({ records: [record()] });
  try {
    // Nothing published until something watches.
    assert.equal(readStatus(ctx.dir), null);
    const res = await ctx.client.callTool({ name: 'watch', arguments: {} });
    assert.deepEqual(JSON.parse(res.content[0].text), { records: [] });

    // The call timed out with nothing new, so the session is handed on for
    // the next call rather than dropped: no run in flight, a gap lease, and
    // the cursor its successor is expected to carry.
    const gap = readStatus(ctx.dir);
    assert.equal(gap.kind, 'server');
    assert.equal(gap.pid, null);
    assert.ok(Date.parse(gap.expires) > Date.now());
    // No pidfile: an older --stop reads only that, and would signal a process
    // the watch is just one part of.
    assert.equal(fs.existsSync(path.join(ctx.dir, '.watch.pid')), false);
  } finally {
    await ctx.cleanup();
  }
});

test('successive watch calls are one session, whatever their cursor', async () => {
  const ctx = await setup({ records: [record()] });
  try {
    await ctx.client.callTool({ name: 'watch', arguments: {} });
    const first = readStatus(ctx.dir).sessionStarted;

    // The server is one process across calls, so it knows its own session —
    // a client moving its cursor around doesn't make it a different watch.
    await ctx.client.callTool({ name: 'watch', arguments: { after: '2020-01-01T00:00:00.000Z' } });
    assert.equal(readStatus(ctx.dir).sessionStarted, first);
  } finally {
    await ctx.cleanup();
  }
});

test('a restarted server resumes the session its cursor names', async () => {
  const ctx = await setup({ records: [record()] });
  try {
    // The record a previous server left between two calls: no run in flight,
    // and the cursor its successor is expected to carry.
    const handedOn = '2026-04-08T20:30:12.345Z';
    fs.writeFileSync(
      path.join(ctx.dir, STATUS_FILE),
      JSON.stringify({
        sessionStarted: '2026-04-08T20:00:00.000Z',
        pid: null,
        expires: new Date(Date.now() + 300_000).toISOString(),
        resumeAfter: handedOn,
        kind: 'server',
      }) + '\n',
    );
    await ctx.client.callTool({ name: 'watch', arguments: { after: handedOn } });
    assert.equal(readStatus(ctx.dir).sessionStarted, '2026-04-08T20:00:00.000Z');
  } finally {
    await ctx.cleanup();
  }
});

test('a stop request ends a watch call and says so', async () => {
  const ctx = await setup({ records: [record()], watchDefaultTimeoutMs: 5_000 });
  try {
    // Claim a session, then ask it to stop while the next call is blocking.
    await ctx.client.callTool({ name: 'watch', arguments: {} });
    const { sessionStarted, resumeAfter } = readStatus(ctx.dir);
    const pending = ctx.client.callTool({ name: 'watch', arguments: { after: resumeAfter } });
    await new Promise((r) => setTimeout(r, 200));
    requestStop(ctx.dir, sessionStarted);

    // It returns well inside the 5s timeout, marked stopped — the client's
    // equivalent of the script's exit 3.
    const res = await pending;
    assert.equal(stoppedReason(res), 'requested');
    // Everything the protocol wrote is gone, so nothing advertises a watch.
    assert.equal(readStatus(ctx.dir), null);
    assert.equal(fs.existsSync(path.join(ctx.dir, STOP_FILE)), false);
  } finally {
    await ctx.cleanup();
  }
});

test('a stop request left in the gap ends the next call on entry', async () => {
  const ctx = await setup({ records: [record()], watchDefaultTimeoutMs: 5_000 });
  try {
    await ctx.client.callTool({ name: 'watch', arguments: {} });
    const { sessionStarted, resumeAfter } = readStatus(ctx.dir);
    requestStop(ctx.dir, sessionStarted);

    // No capture is written: the call must not wait for one.
    const started = Date.now();
    const res = await ctx.client.callTool({ name: 'watch', arguments: { after: resumeAfter } });
    assert.ok(Date.now() - started < 2_000);
    assert.equal(stoppedReason(res), 'requested');
    assert.equal(readStatus(ctx.dir), null);
  } finally {
    await ctx.cleanup();
  }
});

test('a subscription holds the session until it ends', async () => {
  const ctx = await setup({ records: [record()] });
  try {
    await ctx.client.subscribeResource({ uri: STREAM_URI });
    const live = readStatus(ctx.dir);
    assert.equal(live.kind, 'server');
    assert.equal(live.pid, process.pid);
    // A subscription has no gaps, so nothing to resume from.
    assert.equal(live.resumeAfter, undefined);

    await ctx.client.unsubscribeResource({ uri: STREAM_URI });
    assert.equal(readStatus(ctx.dir), null);
  } finally {
    await ctx.cleanup();
  }
});

test('a stopped subscription is reported on the next stream read', async () => {
  const ctx = await setup({ records: [record()] });
  try {
    await ctx.client.subscribeResource({ uri: STREAM_URI });
    const { sessionStarted } = readStatus(ctx.dir);
    requestStop(ctx.dir, sessionStarted);
    await new Promise((r) => setTimeout(r, 300));

    // The doorbell carries no payload, so the answer rides on the read it
    // wakes — and is reported once.
    const first = await ctx.client.readResource({ uri: `${STREAM_URI}?after=` });
    assert.equal(JSON.parse(first.contents[0].text).stopped, true);
    const second = await ctx.client.readResource({ uri: `${STREAM_URI}?after=` });
    assert.equal(JSON.parse(second.contents[0].text).stopped, undefined);
  } finally {
    await ctx.cleanup();
  }
});

test('a watcher taking the slot displaces the server', async () => {
  const ctx = await setup({ records: [record()] });
  try {
    await ctx.client.subscribeResource({ uri: STREAM_URI });
    const mine = readStatus(ctx.dir).sessionStarted;

    // Somebody else claims the slot, the way a starting watch script does.
    fs.writeFileSync(
      path.join(ctx.dir, STATUS_FILE),
      JSON.stringify({
        sessionStarted: '2030-01-01T00:00:00.000Z',
        pid: 999999999,
        expires: new Date(Date.now() + 90_000).toISOString(),
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 300));

    // The server steps aside rather than fighting for the file, and leaves
    // the record naming its replacement alone.
    const res = await ctx.client.readResource({ uri: `${STREAM_URI}?after=` });
    assert.equal(JSON.parse(res.contents[0].text).stopped, true);
    assert.equal(readStatus(ctx.dir).sessionStarted, '2030-01-01T00:00:00.000Z');
    assert.notEqual(mine, '2030-01-01T00:00:00.000Z');
  } finally {
    await ctx.cleanup();
  }
});

test('stop_watch ends this server’s own watch', async () => {
  const ctx = await setup({ records: [record()] });
  try {
    await ctx.client.subscribeResource({ uri: STREAM_URI });
    const res = await ctx.client.callTool({ name: 'stop_watch', arguments: {} });
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.result, 'stopped');
    assert.equal(payload.kind, 'server');
    assert.match(payload.message, /Stopped the watch/);
    assert.equal(readStatus(ctx.dir), null);
  } finally {
    await ctx.cleanup();
  }
});

test('stop_watch reports nothing to stop', async () => {
  const ctx = await setup({ records: [record()] });
  try {
    const none = await ctx.client.callTool({ name: 'stop_watch', arguments: {} });
    assert.equal(JSON.parse(none.content[0].text).result, 'nothing');
  } finally {
    await ctx.cleanup();
  }
});

test('stop_watch ends this server’s own session between two watch calls', async () => {
  const ctx = await setup({ records: [record()] });
  try {
    // Handed back, not held — but still this server's, so it needs no request
    // and nobody to wait for.
    await ctx.client.callTool({ name: 'watch', arguments: {} });
    assert.notEqual(readStatus(ctx.dir), null);

    const res = await ctx.client.callTool({ name: 'stop_watch', arguments: {} });
    assert.equal(JSON.parse(res.content[0].text).result, 'stopped');
    assert.equal(readStatus(ctx.dir), null);
    assert.equal(fs.existsSync(path.join(ctx.dir, STOP_FILE)), false);
  } finally {
    await ctx.cleanup();
  }
});

test('stop_watch queues for someone else’s watch between runs', async () => {
  const ctx = await setup({ records: [record()] });
  try {
    // A watch script's session, handed back between two of its runs: nobody
    // is in flight to answer, so the request waits for its next run.
    fs.writeFileSync(
      path.join(ctx.dir, STATUS_FILE),
      JSON.stringify({
        sessionStarted: '2026-04-08T19:00:00.000000Z',
        pid: null,
        expires: new Date(Date.now() + 300_000).toISOString(),
        resumeAfter: '2026-04-08T20:30:12.345Z',
      }) + '\n',
    );
    const res = await ctx.client.callTool({ name: 'stop_watch', arguments: {} });
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.result, 'queued');
    assert.equal(payload.kind, 'script');
    // The request names it, and the record stays — it is what lets that run
    // know the request is its own — but its lease is spent, so the Capture
    // page stops showing a watch now.
    const request = JSON.parse(fs.readFileSync(path.join(ctx.dir, STOP_FILE), 'utf8'));
    assert.equal(request.sessionStarted, '2026-04-08T19:00:00.000000Z');
    assert.equal(readStatus(ctx.dir).sessionStarted, '2026-04-08T19:00:00.000000Z');
    assert.ok(Date.parse(readStatus(ctx.dir).expires) <= Date.now());
  } finally {
    await ctx.cleanup();
  }
});

test('a real watch script takes the slot without signalling the server', async () => {
  // The protocol's promise: a `kind: "server"` session is never signalled,
  // because the signal would land on a process the watch is only one part of.
  // A synthetic status file can't prove that — this runs the actual script.
  const ctx = await setup({ records: [record()] });
  const script = path.resolve(process.cwd(), '../skills/SeeWhatISee.py');
  let watcher;
  try {
    await ctx.client.subscribeResource({ uri: STREAM_URI });
    const mine = readStatus(ctx.dir).sessionStarted;
    assert.equal(readStatus(ctx.dir).pid, process.pid);

    watcher = spawn(script, ['--watch', '--loop', '--directory', ctx.dir], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 1_500));

    // This process is still here — the assertion is simply that the test
    // keeps running — and the slot is the script's now.
    const taken = readStatus(ctx.dir);
    assert.notEqual(taken.sessionStarted, mine);
    assert.equal(taken.pid, watcher.pid);
    assert.equal(taken.kind, undefined);

    // And the server noticed it was displaced rather than watching on.
    const read = await ctx.client.readResource({ uri: `${STREAM_URI}?after=` });
    assert.equal(JSON.parse(read.contents[0].text).stopped, true);
  } finally {
    watcher?.kill('SIGKILL');
    await ctx.cleanup();
  }
});

test('--no-lockfiles keeps the watch private', async () => {
  const dir = tmpdir();
  writeLog(dir, [record()]);
  const server = createServer({ sourceDir: dir, watchDefaultTimeoutMs: 150, publishWatch: false });
  const client = new Client({ name: 'test', version: '0' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    await client.subscribeResource({ uri: STREAM_URI });
    await client.callTool({ name: 'watch', arguments: {} });
    assert.equal(readStatus(dir), null);
  } finally {
    await client.close();
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
