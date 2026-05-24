// End-to-end tests for the MCP server. Uses InMemoryTransport so a Client
// and Server talk to each other inside the same Node process — no stdio,
// no spawning a binary.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

function parseToolResult(res) {
  assert.ok(Array.isArray(res.content));
  const text = res.content.map((c) => c.text ?? '').join('');
  return JSON.parse(text);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

test('tools/list exposes the four tools', async () => {
  const ctx = await setup();
  try {
    const { tools } = await ctx.client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['get_file_info', 'get_latest', 'read_file', 'watch']);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// get_latest
// ---------------------------------------------------------------------------

test('get_latest returns the last record with paths rewritten', async () => {
  const ctx = await setup({
    records: [
      record({ timestamp: '2026-04-08T20:30:00.000Z', screenshot: { filename: 'a.png' } }),
      record({ timestamp: '2026-04-08T20:30:05.000Z', screenshot: { filename: 'b.png' } }),
    ],
  });
  try {
    const res = await ctx.client.callTool({ name: 'get_latest', arguments: {} });
    const rec = parseToolResult(res);
    assert.equal(rec.timestamp, '2026-04-08T20:30:05.000Z');
    assert.equal(rec.screenshot.filename, path.join(ctx.dir, 'b.png'));
  } finally {
    await ctx.cleanup();
  }
});

test('get_latest rewrites all three artifact filenames', async () => {
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
    const rec = parseToolResult(
      await ctx.client.callTool({ name: 'get_latest', arguments: {} }),
    );
    assert.equal(rec.screenshot.filename, path.join(ctx.dir, 'shot.png'));
    assert.equal(rec.screenshot.hasHighlights, true);
    assert.equal(rec.contents.filename, path.join(ctx.dir, 'page.html'));
    assert.equal(rec.selection.filename, path.join(ctx.dir, 'sel.md'));
    assert.equal(rec.selection.format, 'markdown');
  } finally {
    await ctx.cleanup();
  }
});

test('get_latest leaves already-absolute paths alone', async () => {
  const ctx = await setup({
    records: [record({ screenshot: { filename: '/already/abs.png' } })],
  });
  try {
    const rec = parseToolResult(
      await ctx.client.callTool({ name: 'get_latest', arguments: {} }),
    );
    assert.equal(rec.screenshot.filename, '/already/abs.png');
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
    const { records } = parseToolResult(res);
    assert.equal(records.length, 2);
    assert.equal(records[0].timestamp, '2026-04-08T20:30:01.000Z');
    assert.equal(records[1].timestamp, '2026-04-08T20:30:02.000Z');
    assert.equal(records[1].screenshot.filename, path.join(ctx.dir, 'c.png'));
  } finally {
    await ctx.cleanup();
  }
});

test('watch with no pending returns empty on timeout', async () => {
  const ctx = await setup({ watchDefaultTimeoutMs: 120 });
  try {
    const res = await ctx.client.callTool({ name: 'watch', arguments: {} });
    const { records } = parseToolResult(res);
    assert.deepEqual(records, []);
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
    const { records } = parseToolResult(res);
    assert.deepEqual(records, []);
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
    const { records } = parseToolResult(await watchPromise);
    assert.equal(records.length, 1);
    assert.equal(records[0].timestamp, '2026-04-08T20:30:05.000Z');
    assert.equal(records[0].screenshot.filename, path.join(ctx.dir, 'new.png'));
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
    const { records } = parseToolResult(await watchPromise);
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
    const { records } = parseToolResult(await watchPromise);
    assert.equal(records.length, 1);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

test('read_file returns full bytes when no range given', async () => {
  const ctx = await setup();
  try {
    const filePath = path.join(ctx.dir, 'shot.png');
    fs.writeFileSync(filePath, Buffer.from([1, 2, 3, 4, 5]));
    const res = parseToolResult(
      await ctx.client.callTool({
        name: 'read_file',
        arguments: { filename: filePath },
      }),
    );
    assert.equal(res.totalSize, 5);
    assert.equal(res.eof, true);
    assert.deepEqual(
      Array.from(Buffer.from(res.bytes, 'base64')),
      [1, 2, 3, 4, 5],
    );
  } finally {
    await ctx.cleanup();
  }
});

test('read_file honors offset + length and reports eof=false mid-file', async () => {
  const ctx = await setup();
  try {
    const filePath = path.join(ctx.dir, 'page.html');
    fs.writeFileSync(filePath, Buffer.from([10, 20, 30, 40, 50, 60]));
    const res = parseToolResult(
      await ctx.client.callTool({
        name: 'read_file',
        arguments: { filename: filePath, offset: 2, length: 2 },
      }),
    );
    assert.equal(res.totalSize, 6);
    assert.equal(res.eof, false);
    assert.deepEqual(Array.from(Buffer.from(res.bytes, 'base64')), [30, 40]);
  } finally {
    await ctx.cleanup();
  }
});

test('read_file at end-of-file returns eof=true with empty bytes', async () => {
  const ctx = await setup();
  try {
    const filePath = path.join(ctx.dir, 'small.txt');
    fs.writeFileSync(filePath, 'hi');
    const res = parseToolResult(
      await ctx.client.callTool({
        name: 'read_file',
        arguments: { filename: filePath, offset: 100, length: 10 },
      }),
    );
    assert.equal(res.totalSize, 2);
    assert.equal(res.eof, true);
    assert.equal(Buffer.from(res.bytes, 'base64').length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('read_file rejects relative paths', async () => {
  const ctx = await setup();
  try {
    const err = await ctx.client
      .callTool({ name: 'read_file', arguments: { filename: 'relative.png' } })
      .catch((e) => e);
    assert.match(String(err), /absolute path/i);
  } finally {
    await ctx.cleanup();
  }
});

test('read_file rejects paths outside the source dir', async () => {
  const ctx = await setup();
  try {
    // Create a file outside the source dir.
    const otherDir = tmpdir();
    const outside = path.join(otherDir, 'evil.png');
    fs.writeFileSync(outside, 'x');
    try {
      const err = await ctx.client
        .callTool({ name: 'read_file', arguments: { filename: outside } })
        .catch((e) => e);
      assert.match(String(err), /outside the source dir/i);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  } finally {
    await ctx.cleanup();
  }
});

test('read_file rejects symlink escapes', async () => {
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
        .callTool({ name: 'read_file', arguments: { filename: link } })
        .catch((e) => e);
      assert.match(String(err), /outside the source dir/i);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  } finally {
    await ctx.cleanup();
  }
});

test('read_file errors when the file is missing', async () => {
  const ctx = await setup();
  try {
    const err = await ctx.client
      .callTool({
        name: 'read_file',
        arguments: { filename: path.join(ctx.dir, 'nope.png') },
      })
      .catch((e) => e);
    assert.match(String(err), /not found/i);
  } finally {
    await ctx.cleanup();
  }
});

test('read_file rejects nonexistent paths outside the source dir without leaking existence', async () => {
  // Regression: previously the server reported "file not found" for paths
  // outside the source dir, which both gives the wrong error and leaks
  // whether arbitrary paths exist on disk. The containment check must
  // happen before any filesystem access.
  const ctx = await setup();
  try {
    const err = await ctx.client
      .callTool({
        name: 'read_file',
        arguments: { filename: '/definitely/not/here/file.png' },
      })
      .catch((e) => e);
    assert.match(String(err), /outside the source dir/i);
    assert.doesNotMatch(String(err), /not found/i);
  } finally {
    await ctx.cleanup();
  }
});

test('read_file rejects `..` traversal that lexically escapes the source dir', async () => {
  const ctx = await setup();
  try {
    const escape = path.join(ctx.dir, '..', 'sibling.png');
    const err = await ctx.client
      .callTool({ name: 'read_file', arguments: { filename: escape } })
      .catch((e) => e);
    assert.match(String(err), /outside the source dir/i);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// get_file_info
// ---------------------------------------------------------------------------

test('get_file_info returns size, mimeType, capturedAt', async () => {
  const ctx = await setup();
  try {
    const filePath = path.join(ctx.dir, 'shot.png');
    fs.writeFileSync(filePath, Buffer.alloc(128));
    const info = parseToolResult(
      await ctx.client.callTool({
        name: 'get_file_info',
        arguments: { filename: filePath },
      }),
    );
    assert.equal(info.size, 128);
    assert.equal(info.mimeType, 'image/png');
    assert.match(info.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await ctx.cleanup();
  }
});

test('get_file_info maps common extensions to expected mimeTypes', async () => {
  const ctx = await setup();
  try {
    const cases = [
      ['x.jpg', 'image/jpeg'],
      ['x.html', 'text/html'],
      ['x.md', 'text/markdown'],
      ['x.unknown', 'application/octet-stream'],
    ];
    for (const [name, expected] of cases) {
      const filePath = path.join(ctx.dir, name);
      fs.writeFileSync(filePath, '');
      const info = parseToolResult(
        await ctx.client.callTool({
          name: 'get_file_info',
          arguments: { filename: filePath },
        }),
      );
      assert.equal(info.mimeType, expected, `mime for ${name}`);
    }
  } finally {
    await ctx.cleanup();
  }
});

test('get_file_info applies the same containment check as read_file', async () => {
  const ctx = await setup();
  try {
    const otherDir = tmpdir();
    const outside = path.join(otherDir, 'evil.png');
    fs.writeFileSync(outside, 'x');
    try {
      const err = await ctx.client
        .callTool({ name: 'get_file_info', arguments: { filename: outside } })
        .catch((e) => e);
      assert.match(String(err), /outside the source dir/i);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  } finally {
    await ctx.cleanup();
  }
});

test('get_file_info rejects nonexistent paths outside the source dir without leaking existence', async () => {
  const ctx = await setup();
  try {
    const err = await ctx.client
      .callTool({
        name: 'get_file_info',
        arguments: { filename: '/definitely/not/here/file.png' },
      })
      .catch((e) => e);
    assert.match(String(err), /outside the source dir/i);
    assert.doesNotMatch(String(err), /not found/i);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// resources
// ---------------------------------------------------------------------------

test('resources/list exposes the captures/stream resource', async () => {
  const ctx = await setup();
  try {
    const { resources } = await ctx.client.listResources();
    assert.equal(resources.length, 1);
    assert.equal(resources[0].uri, STREAM_URI);
    assert.equal(resources[0].mimeType, 'application/json');
  } finally {
    await ctx.cleanup();
  }
});

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

test('resources/read returns the latest record with paths rewritten', async () => {
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
    assert.equal(payload.screenshot.filename, path.join(ctx.dir, 'b.png'));
  } finally {
    await ctx.cleanup();
  }
});

test('resources/read rejects unknown URIs', async () => {
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

// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------

test('prompts/list exposes both prompts', async () => {
  const ctx = await setup();
  try {
    const { prompts } = await ctx.client.listPrompts();
    const names = prompts.map((p) => p.name).sort();
    assert.deepEqual(names, ['see-what-i-see', 'see-what-i-see-watch']);
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
