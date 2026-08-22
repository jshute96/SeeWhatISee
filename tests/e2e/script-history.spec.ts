import { test, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../../scripts/SeeWhatISee.py');

function run(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(SCRIPT, [...args], {
    timeout: 5_000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    stdout: (result.stdout as string) ?? '',
    stderr: (result.stderr as string) ?? '',
    exitCode: result.status ?? 1,
  };
}

let tmpDir: string;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swis-history-'));
});

test.afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function ndjson(records: Record<string, unknown>[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

function writeFileOfRecords(name: string, records: Record<string, unknown>[]) {
  fs.writeFileSync(path.join(tmpDir, name), ndjson(records));
}

function rec(n: number, extra: Record<string, unknown> = {}) {
  return {
    timestamp: `2026-04-09T12:00:0${n}.000Z`,
    screenshot: { filename: `screenshot-2026040${n}.png` },
    url: `http://example.com/page${n}`,
    ...extra,
  };
}

/** Parse a JSONL stdout into records. */
function parseAll(stdout: string): Record<string, any>[] {
  return stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * Two archives plus log.json. Archive names carry the compact stamp of
 * the newest record they hold, so their byte-wise order is the capture
 * order — the seeding here relies on that just like the script does.
 */
function seedHistory() {
  writeFileOfRecords('history-20260409-120001-000.json', [
    rec(0, { title: 'GitHub pull request', url: 'https://github.com/o/r/pull/1' }),
    rec(1, { title: 'Docs', prompt: 'Review this page' }),
  ]);
  writeFileOfRecords('history-20260409-120003-000.json', [
    rec(2, { title: 'Local file', url: 'file:///tmp/page.html' }),
    rec(3, { title: 'GitHub issue', url: 'https://github.com/o/r/issues/7' }),
  ]);
  writeFileOfRecords('log.json', [
    rec(4, { title: 'News' }),
    rec(5, { title: 'Search', prompt: 'review the diff' }),
  ]);
}

test.describe('SeeWhatISee.py history listing', () => {
  test('--all emits every record, archives first, in capture order', () => {
    seedHistory();
    const r = run(['--all', '--directory', tmpDir]);
    expect(r.exitCode).toBe(0);

    const records = parseAll(r.stdout);
    expect(records.map((x) => x.timestamp)).toEqual([
      '2026-04-09T12:00:00.000Z',
      '2026-04-09T12:00:01.000Z',
      '2026-04-09T12:00:02.000Z',
      '2026-04-09T12:00:03.000Z',
      '2026-04-09T12:00:04.000Z',
      '2026-04-09T12:00:05.000Z',
    ]);
    // Archived records get the same path rewrite as live ones.
    expect(records[0].screenshot.filename).toBe(`${tmpDir}/screenshot-20260400.png`);
  });

  test('a disambiguated archive sorts after its base name', () => {
    // `history-<stamp>-1.json` is written after `history-<stamp>.json`
    // and holds the newer batch (see archiveFileName in
    // capture/log-store.ts). Sorting the names as-is puts it first,
    // because `-` (0x2D) sorts before `.` (0x2E).
    writeFileOfRecords('history-20260409-120001-000.json', [rec(0)]);
    writeFileOfRecords('history-20260409-120001-000-1.json', [rec(1)]);
    writeFileOfRecords('log.json', [rec(2)]);

    const order = ['2026-04-09T12:00:00.000Z', '2026-04-09T12:00:01.000Z',
      '2026-04-09T12:00:02.000Z'];
    expect(parseAll(run(['--all', '--directory', tmpDir]).stdout).map((x) => x.timestamp))
      .toEqual(order);
    // --limit takes the newest N off the same ordering.
    expect(parseAll(run(['--limit', '2', '--directory', tmpDir]).stdout).map((x) => x.timestamp))
      .toEqual(order.slice(1));
  });

  test('--limit stops reading once it has enough records', () => {
    // Proven by making the oldest archive unreadable: a --limit that
    // the newer files can satisfy must never open it, while --all and a
    // larger --limit must fail loudly rather than silently skip it.
    test.skip(process.getuid?.() === 0, 'root reads files regardless of mode');

    writeFileOfRecords('history-20260409-120001-000.json', [rec(0), rec(1)]);
    writeFileOfRecords('history-20260409-120003-000.json', [rec(2), rec(3)]);
    writeFileOfRecords('log.json', [rec(4), rec(5)]);
    const oldest = path.join(tmpDir, 'history-20260409-120001-000.json');
    fs.chmodSync(oldest, 0o000);

    try {
      const r = run(['--limit', '4', '--directory', tmpDir]);
      expect(r.exitCode).toBe(0);
      expect(parseAll(r.stdout)).toHaveLength(4);

      // Needing that file is an error, not a short answer.
      expect(run(['--limit', '5', '--directory', tmpDir]).exitCode).not.toBe(0);
      expect(run(['--all', '--directory', tmpDir]).exitCode).not.toBe(0);
    } finally {
      fs.chmodSync(oldest, 0o644);
    }
  });

  test('--all reads archives even with no log.json', () => {
    writeFileOfRecords('history-20260409-120001-000.json', [rec(0), rec(1)]);
    const r = run(['--all', '--directory', tmpDir]);
    expect(r.exitCode).toBe(0);
    expect(parseAll(r.stdout)).toHaveLength(2);
  });

  test('--limit N emits the N newest records, oldest first', () => {
    seedHistory();
    const r = run(['--limit', '3', '--directory', tmpDir]);
    expect(r.exitCode).toBe(0);

    expect(parseAll(r.stdout).map((x) => x.timestamp)).toEqual([
      '2026-04-09T12:00:03.000Z',
      '2026-04-09T12:00:04.000Z',
      '2026-04-09T12:00:05.000Z',
    ]);
  });

  test('--limit larger than the history emits everything', () => {
    seedHistory();
    const r = run(['--limit', '99', '--directory', tmpDir]);
    expect(r.exitCode).toBe(0);
    expect(parseAll(r.stdout)).toHaveLength(6);
  });

  test('--limit 1 matches --get-latest', () => {
    seedHistory();
    const limited = run(['--limit', '1', '--directory', tmpDir]);
    const latest = run(['--get-latest', '--directory', tmpDir]);
    expect(limited.exitCode).toBe(0);
    expect(limited.stdout).toBe(latest.stdout);
  });

  test('a bare filter defaults to the 10 most recent matches', () => {
    // 12 matching records, so the default cap is visible.
    writeFileOfRecords(
      'log.json',
      Array.from({ length: 12 }, (_, i) => ({
        timestamp: `2026-04-09T12:00:00.0${String(i).padStart(2, '0')}Z`,
        url: 'https://example.com/p',
        title: `Page ${i}`,
      })),
    );

    const r = run(['--search', 'page', '--directory', tmpDir]);
    expect(r.exitCode).toBe(0);
    const titles = parseAll(r.stdout).map((x) => x.title);
    expect(titles).toHaveLength(10);
    expect(titles[0]).toBe('Page 2');
    expect(titles[9]).toBe('Page 11');

    // --all opts back out of the cap; --limit overrides it.
    expect(parseAll(run(['--all', '--search', 'page', '--directory', tmpDir]).stdout))
      .toHaveLength(12);
    expect(parseAll(run(['--limit', '3', '--search', 'page', '--directory', tmpDir]).stdout))
      .toHaveLength(3);
  });

  test('--search requires every term, across url / title / prompt', () => {
    seedHistory();
    const r = run(['--search', 'review github', '--directory', tmpDir]);
    expect(r.exitCode).toBe(0);

    // "Review this page" (prompt) + github (url) is the Docs record's
    // neighbour, not the Docs record itself: only the pull-request row
    // has both, and only via two different fields.
    const records = parseAll(r.stdout);
    expect(records).toHaveLength(0);

    // Same words, but a record that really does carry both.
    writeFileOfRecords('log.json', [
      rec(6, { title: 'GitHub diff', prompt: 'Review this' }),
    ]);
    const r2 = run(['--search', 'review github', '--directory', tmpDir]);
    expect(parseAll(r2.stdout).map((x) => x.title)).toEqual(['GitHub diff']);
  });

  test('--search is case-insensitive and order-independent', () => {
    seedHistory();
    const r = run(['--search', 'ISSUE github', '--directory', tmpDir]);
    expect(parseAll(r.stdout).map((x) => x.title)).toEqual(['GitHub issue']);
  });

  test('--search with no matches exits 0 with no output', () => {
    seedHistory();
    const r = run(['--search', 'nothingmatchesthis', '--directory', tmpDir]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
  });

  test('--filter_site substring-matches the host of http urls only', () => {
    seedHistory();
    const r = run(['--filter_site', 'github', '--directory', tmpDir]);
    expect(parseAll(r.stdout).map((x) => x.title)).toEqual([
      'GitHub pull request',
      'GitHub issue',
    ]);

    // The path, not the host, holds "tmp" — and file:// urls have no
    // site to match at all.
    const r2 = run(['--filter_site', 'tmp', '--directory', tmpDir]);
    expect(r2.stdout).toBe('');
  });

  test('--filter_site skips records with no url and non-http schemes', () => {
    writeFileOfRecords('log.json', [
      { timestamp: '2026-04-09T12:00:00.000Z' },                       // no url at all
      { timestamp: '2026-04-09T12:00:01.000Z', url: 'chrome://extensions' },
      { timestamp: '2026-04-09T12:00:02.000Z', url: 'https://extensions.example.com/' },
    ]);
    const r = run(['--filter_site', 'extensions', '--directory', tmpDir]);
    expect(r.exitCode).toBe(0);
    expect(parseAll(r.stdout).map((x) => x.url)).toEqual(['https://extensions.example.com/']);
  });

  test('rejects an empty or whitespace-only filter', () => {
    seedHistory();
    for (const args of [
      ['--search', ''],
      ['--search', '   '],
      ['--filter_site', ''],
      ['--filter_site', ' '],
    ]) {
      const r = run([...args, '--directory', tmpDir]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('non-whitespace');
      expect(r.stdout).toBe('');
    }
  });

  test('--filter_site combines with --search and --limit', () => {
    seedHistory();
    const r = run([
      '--limit', '1', '--filter_site', 'github.com', '--search', 'r', '--directory', tmpDir,
    ]);
    expect(parseAll(r.stdout).map((x) => x.title)).toEqual(['GitHub issue']);
  });

  test('an empty history is not an error (unlike --get-latest)', () => {
    const r = run(['--all', '--directory', tmpDir]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
    expect(run(['--get-latest', '--directory', tmpDir]).exitCode).not.toBe(0);
  });

  test('a file with no trailing newline does not glue onto the next', () => {
    // These files sit in the user's Downloads folder and can be
    // hand-edited or truncated mid-write.
    fs.writeFileSync(
      path.join(tmpDir, 'history-20260409-120001-000.json'),
      ndjson([rec(0), rec(1)]).trimEnd(),
    );
    writeFileOfRecords('log.json', [rec(2)]);

    const r = run(['--all', '--directory', tmpDir]);
    expect(r.exitCode).toBe(0);
    expect(parseAll(r.stdout)).toHaveLength(3);
  });

  test('blank, non-record and truncated lines are skipped', () => {
    // A record cut off mid-write has no closing brace, so it must not
    // reach a caller parsing the output as JSONL.
    const truncated = JSON.stringify(rec(9)).slice(0, 40);
    fs.writeFileSync(
      path.join(tmpDir, 'log.json'),
      `\n${JSON.stringify(rec(0))}\nnot json at all\n${truncated}\n\n${JSON.stringify(rec(1))}\n`,
    );
    const r = run(['--all', '--directory', tmpDir]);
    expect(r.exitCode).toBe(0);
    expect(parseAll(r.stdout)).toHaveLength(2);
  });

  test('a record indented or CR-terminated still parses, trimmed', () => {
    // Downloads-folder files get hand-edited; a CR would otherwise both
    // fail the shape check and ride along into the emitted JSON.
    fs.writeFileSync(
      path.join(tmpDir, 'log.json'),
      `  ${JSON.stringify(rec(0))}\r\n${JSON.stringify(rec(1))}\n`,
    );
    const r = run(['--all', '--directory', tmpDir]);
    expect(r.exitCode).toBe(0);
    expect(parseAll(r.stdout)).toHaveLength(2);
    expect(r.stdout).not.toContain('\r');
  });

  test('archived records honor --copy-to-dir and --print_selection', () => {
    fs.writeFileSync(path.join(tmpDir, 'screenshot-20260400.png'), 'png');
    fs.writeFileSync(path.join(tmpDir, 'selection-0.txt'), 'selected words');
    writeFileOfRecords('history-20260409-120001-000.json', [
      rec(0, { selection: { filename: 'selection-0.txt' } }),
    ]);
    writeFileOfRecords('log.json', [rec(1)]);

    const outDir = path.join(tmpDir, 'out');
    const r = run([
      '--limit', '2', '--print_selection', '--copy-to-dir', outDir, '--directory', tmpDir,
    ]);
    expect(r.exitCode).toBe(0);

    const first = JSON.parse(r.stdout.split('\n')[0]);
    expect(first.screenshot.filename).toBe(`${outDir}/screenshot-20260400.png`);
    expect(first.selection.filename).toBe(`${outDir}/selection-0.txt`);
    expect(fs.existsSync(path.join(outDir, 'screenshot-20260400.png'))).toBe(true);
    expect(r.stdout).toContain('Selection:\nselected words');
  });

  test('rejects --all with --limit, and a non-positive --limit', () => {
    expect(run(['--all', '--limit', '3', '--directory', tmpDir]).exitCode).toBe(2);
    expect(run(['--limit', '0', '--directory', tmpDir]).exitCode).toBe(2);
    expect(run(['--limit', 'abc', '--directory', tmpDir]).exitCode).toBe(2);
  });

  test('rejects --get-latest combined with a history listing', () => {
    for (const args of [
      ['--get-latest', '--all'],
      ['--get-latest', '--limit', '2'],
      ['--get-latest', '--search', 'x'],
      ['--get-latest', '--filter_site', 'example.com'],
    ]) {
      const r = run([...args, '--directory', tmpDir]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('--get-latest cannot be combined');
    }
  });

  test('filters scope the listing only — --watch still emits everything',
    async () => {
      seedHistory();
      // A filter that matches nothing in the seeded history, so the
      // only output can come from the watch.
      const proc = spawn(SCRIPT, [
        '--search', 'nothingmatchesthis', '--watch', '--directory', tmpDir,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      proc.stdout!.on('data', (d: Buffer) => chunks.push(d));
      const output = () => Buffer.concat(chunks).toString('utf8');

      try {
        // Give the poll loop time to record log.json's mtime, and let
        // the clock tick past it — the poll compares whole-second
        // mtimes — before appending a record the filter would have
        // rejected.
        await new Promise((r) => setTimeout(r, 1200));
        fs.appendFileSync(
          path.join(tmpDir, 'log.json'),
          ndjson([rec(9, { title: 'Brand new capture' })]),
        );

        await expect.poll(() => output(), { timeout: 10_000 })
          .toContain('Brand new capture');
      } finally {
        try { proc.kill('SIGTERM'); } catch { /* already dead */ }
      }
    });
});
