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

  test('archives a millisecond apart still read in order', () => {
    // Two flushes in one drain land a millisecond apart (`archiveFileName`
    // advances the stamp rather than suffixing the name), so the names differ
    // only in their last digit. A plain sort has to get that right.
    writeFileOfRecords('history-20260409-120001-000.json', [rec(0)]);
    writeFileOfRecords('history-20260409-120001-001.json', [rec(1)]);
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
      ['--get-latest', '--filter_time', '2026-04-08'],
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

/**
 * --filter_time.
 *
 * $TZ is pinned per-run so the local-time cases are deterministic
 * wherever the suite runs. America/New_York is UTC-4 in April, which
 * puts the boundary between records 20:00Z and 02:00Z the next day —
 * the whole point of distinguishing local from UTC.
 */
test.describe('SeeWhatISee.py --filter_time', () => {
  /** Records an hour apart around a day boundary, titled by UTC time. */
  const TIMED = [
    { timestamp: '2026-04-07T22:30:00.000Z', title: 'apr7-2230z' },
    { timestamp: '2026-04-08T02:15:00.000Z', title: 'apr8-0215z' },
    { timestamp: '2026-04-08T20:30:12.345Z', title: 'apr8-2030z' },
    { timestamp: '2026-04-09T06:00:00.000Z', title: 'apr9-0600z' },
    { timestamp: '2026-05-02T10:00:00.000Z', title: 'may2-1000z' },
  ];

  function runTz(tz: string, args: string[]) {
    const result = spawnSync(SCRIPT, [...args], {
      timeout: 5_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TZ: tz },
    });
    return {
      stdout: (result.stdout as string) ?? '',
      stderr: (result.stderr as string) ?? '',
      exitCode: result.status ?? 1,
    };
  }

  /** Titles of the records a span selects, in emitted order. */
  function titles(span: string, tz = 'UTC'): string[] {
    const result = runTz(tz, ['--all', '--filter_time', span,
                             '--directory', tmpDir]);
    expect(result.exitCode).toBe(0);
    return parseAll(result.stdout).map((r) => r.title);
  }

  test.beforeEach(() => {
    writeFileOfRecords('log.json', TIMED);
  });

  test('a date matches that whole local day', () => {
    expect(titles('2026-04-08')).toEqual(['apr8-0215z', 'apr8-2030z']);
  });

  test('a trailing z reads the same date as UTC', () => {
    // In New York, UTC 02:15 on the 8th is still the evening of the
    // 7th, so only the z form includes it.
    expect(titles('2026-04-08', 'America/New_York')).toEqual(['apr8-2030z']);
    expect(titles('2026-04-08z', 'America/New_York'))
      .toEqual(['apr8-0215z', 'apr8-2030z']);
  });

  test('a month, a year, and an hour each span their own unit', () => {
    expect(titles('2026-04')).toEqual([
      'apr7-2230z', 'apr8-0215z', 'apr8-2030z', 'apr9-0600z',
    ]);
    expect(titles('2026')).toHaveLength(5);
    expect(titles('2026-04-08 20')).toEqual(['apr8-2030z']);
  });

  test('a timestamp copied from log.json matches its own record', () => {
    expect(titles('2026-04-08T20:30:12.345Z')).toEqual(['apr8-2030z']);
  });

  test('t or a space separates date and time, and case is ignored', () => {
    expect(titles('2026-04-08t20:30')).toEqual(['apr8-2030z']);
    expect(titles('2026-04-08 20:30')).toEqual(['apr8-2030z']);
    expect(titles('2026-04-08T20:30:12.345z')).toEqual(['apr8-2030z']);
  });

  test('leading zeros are optional', () => {
    expect(titles('2026-4-8')).toEqual(['apr8-0215z', 'apr8-2030z']);
  });

  test('a range covers both endpoints entirely', () => {
    expect(titles('2026-04-08..2026-04-09'))
      .toEqual(['apr8-0215z', 'apr8-2030z', 'apr9-0600z']);
    // Month endpoints span the whole months, not their first instants.
    expect(titles('2026-04..2026-05')).toHaveLength(5);
  });

  test('either end of a range may be left open', () => {
    expect(titles('..2026-04-07')).toEqual(['apr7-2230z']);
    expect(titles('2026-05..')).toEqual(['may2-1000z']);
  });

  test('a bare time and today/yesterday resolve against the clock', () => {
    // Seeded at `now` rather than a few minutes back: a record minutes
    // old belongs to *yesterday* when the suite runs just after UTC
    // midnight, which would fail this roughly five minutes a day.
    const now = new Date();
    const iso = (d: Date) => d.toISOString();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    writeFileOfRecords('log.json', [
      { timestamp: iso(now), title: 'just-now' },
      { timestamp: iso(dayAgo), title: 'a-day-ago' },
      { timestamp: '2020-01-01T00:00:00.000Z', title: 'ancient' },
    ]);
    // Run in UTC so "today" and the record clock agree regardless of
    // where the suite runs.
    expect(titles('today')).toEqual(['just-now']);
    expect(titles('YESTERDAY')).toEqual(['a-day-ago']);
    expect(titles('yesterday..today')).toEqual(['just-now', 'a-day-ago']);
    // The hour the record landed in, as an open range from its start.
    expect(titles(`${now.getUTCHours()}:..`)).toEqual(['just-now']);
  });

  /**
   * Daylight saving. Wall-clock spans are compared against wall-clock
   * readings, so a transition day is simply every instant that reads as
   * that date — no bound arithmetic to get wrong. 2026-03-08 skips
   * 02:00-03:00 in New York; 2026-11-01 runs 01:00-02:00 twice.
   */
  test.describe('across a daylight-saving transition', () => {
    const NY = 'America/New_York';
    const DST = [
      { timestamp: '2026-03-08T05:30:00.000Z', title: '0030-est' },
      { timestamp: '2026-03-08T06:30:00.000Z', title: '0130-est' },
      { timestamp: '2026-03-08T07:30:00.000Z', title: '0330-edt' },
      { timestamp: '2026-11-01T05:30:00.000Z', title: '0130-edt-first' },
      { timestamp: '2026-11-01T06:30:00.000Z', title: '0130-est-second' },
    ];

    test.beforeEach(() => {
      writeFileOfRecords('log.json', DST);
    });

    test('the hour before a spring-forward gap is a real hour', () => {
      expect(titles('2026-03-08 01', NY)).toEqual(['0130-est']);
      // The whole short day, all 23 hours of it.
      expect(titles('2026-03-08', NY))
        .toEqual(['0030-est', '0130-est', '0330-edt']);
    });

    test('an hour that never happened matches nothing', () => {
      // 02:00-03:00 does not exist locally that day. It must not
      // silently resolve to a neighboring hour.
      expect(titles('2026-03-08 02', NY)).toEqual([]);
      expect(titles('2026-03-08 02:30', NY)).toEqual([]);
    });

    test('an hour that happened twice matches both times', () => {
      expect(titles('2026-11-01 01', NY))
        .toEqual(['0130-edt-first', '0130-est-second']);
      expect(titles('2026-11-01 01:30', NY))
        .toEqual(['0130-edt-first', '0130-est-second']);
    });
  });

  test('spaces are allowed around the range separator', () => {
    expect(titles('2026-04-07 .. 2026-04-08'))
      .toEqual(['apr7-2230z', 'apr8-0215z', 'apr8-2030z']);
    expect(titles('2026-05 ..')).toEqual(['may2-1000z']);
    expect(titles('.. 2026-04-07')).toEqual(['apr7-2230z']);
  });

  test('runs of spaces, and leading or trailing ones, are tolerated', () => {
    expect(titles('  2026-04-08  ')).toEqual(['apr8-0215z', 'apr8-2030z']);
    expect(titles('2026-04-08   20')).toEqual(['apr8-2030z']);
    expect(titles('  2026-04-07  ..   2026-04-08  '))
      .toEqual(['apr7-2230z', 'apr8-0215z', 'apr8-2030z']);
  });

  test('the compact stamp from a capture filename is accepted', () => {
    // Capture filenames embed local time, e.g.
    // screenshot-20260822-132959-259.png. Records here are seeded from
    // local wall times, and this test deliberately uses run() rather
    // than runTz() so Node and the script share one zone — whatever it
    // is, the round-trip is exact. Don't "fix" it to pin a zone.
    const local = (y: number, mo: number, d: number, h: number, mi: number,
                   s: number, ms = 0) =>
      new Date(y, mo - 1, d, h, mi, s, ms).toISOString();
    writeFileOfRecords('log.json', [
      { timestamp: local(2026, 8, 22, 13, 29, 59, 259), title: 'stamped' },
      { timestamp: local(2026, 8, 22, 13, 45, 0), title: 'same-hour' },
      { timestamp: local(2026, 8, 22, 17, 0, 0), title: 'later' },
      { timestamp: local(2026, 8, 23, 9, 0, 0), title: 'next-day' },
    ]);
    const spanTitles = (span: string) => {
      const r = run(['--all', '--filter_time', span, '--directory', tmpDir]);
      expect(r.exitCode).toBe(0);
      return parseAll(r.stdout).map((rec) => rec.title);
    };
    expect(spanTitles('20260822-132959-259')).toEqual(['stamped']);
    expect(spanTitles('20260822-1329')).toEqual(['stamped']);
    expect(spanTitles('20260822-13')).toEqual(['stamped', 'same-hour']);
    expect(spanTitles('20260822')).toEqual(['stamped', 'same-hour', 'later']);
    expect(spanTitles('202608'))
      .toEqual(['stamped', 'same-hour', 'later', 'next-day']);
    expect(spanTitles('20260822-13..20260822-17'))
      .toEqual(['stamped', 'same-hour', 'later']);
    expect(spanTitles('20260822-17..')).toEqual(['later', 'next-day']);
    expect(spanTitles('..20260822-13')).toEqual(['stamped', 'same-hour']);
    // Four digits stay a year — the compact pattern is tried last, and
    // a reorder of POINT_PATTERNS must not change that.
    expect(spanTitles('2026')).toHaveLength(4);
  });

  test('a trailing z reads a compact stamp as UTC', () => {
    // Filenames stamp local time, but the zone rule is uniform across
    // every form, so `z` still overrides.
    writeFileOfRecords('log.json', [
      { timestamp: '2026-08-22T13:30:00.000Z', title: 'utc-1330' },
      { timestamp: '2026-08-22T20:30:00.000Z', title: 'utc-2030' },
    ]);
    expect(titles('20260822-13z', 'America/New_York')).toEqual(['utc-1330']);
    // Same stamp read locally is a different hour entirely.
    expect(titles('20260822-13', 'America/New_York')).toEqual([]);
    expect(titles('20260822-16', 'America/New_York')).toEqual(['utc-2030']);
  });

  test('a fractional second is padded on the right', () => {
    writeFileOfRecords('log.json', [
      { timestamp: '2026-04-08T20:30:12.300Z', title: 'at-300ms' },
      { timestamp: '2026-04-08T20:30:12.030Z', title: 'at-030ms' },
    ]);
    // `.3` is 300ms, as in the ISO form — not 3ms.
    expect(titles('2026-04-08 20:30:12.3')).toEqual(['at-300ms']);
    expect(titles('2026-04-08 20:30:12.03')).toEqual(['at-030ms']);
  });

  test('a bare hour spans the hour, not the minute', () => {
    writeFileOfRecords('log.json', [
      { timestamp: '2026-04-08T14:00:30.000Z', title: 'top-of-hour' },
      { timestamp: '2026-04-08T14:45:00.000Z', title: 'late-in-hour' },
      { timestamp: '2026-04-08T15:00:00.000Z', title: 'next-hour' },
    ]);
    expect(titles('14:', 'UTC')).toEqual([]);   // that hour, but today
    expect(titles('2026-04-08 14:'))
      .toEqual(['top-of-hour', 'late-in-hour']);
    expect(titles('2026-04-08 14:00')).toEqual(['top-of-hour']);
  });

  test('combines with --filter_site', () => {
    writeFileOfRecords('log.json', [
      { timestamp: '2026-04-08T01:00:00.000Z', url: 'https://github.com/a',
        title: 'gh-in-span' },
      { timestamp: '2026-04-08T02:00:00.000Z', url: 'https://other.test/b',
        title: 'other-in-span' },
      { timestamp: '2026-04-09T03:00:00.000Z', url: 'https://github.com/c',
        title: 'gh-out-of-span' },
    ]);
    const result = runTz('UTC', ['--all', '--filter_time', '2026-04-08',
                                 '--filter_site', 'github.com',
                                 '--directory', tmpDir]);
    expect(parseAll(result.stdout).map((r) => r.title)).toEqual(['gh-in-span']);
  });

  test('--limit stops reading once it has enough matches', () => {
    // The oldest archive is unreadable, so opening it would fail the
    // run — the span and limit must be satisfied before reaching it.
    seedHistory();
    const oldest = fs.readdirSync(tmpDir)
      .filter((n) => n.startsWith('history-')).sort()[0];
    fs.chmodSync(path.join(tmpDir, oldest), 0o000);
    try {
      const result = runTz('UTC', ['--limit', '1', '--filter_time', '2026',
                                   '--directory', tmpDir]);
      expect(result.exitCode).toBe(0);
      expect(parseAll(result.stdout)).toHaveLength(1);
    } finally {
      fs.chmodSync(path.join(tmpDir, oldest), 0o600);
    }
  });

  test('filters combine with --search and --limit', () => {
    writeFileOfRecords('log.json', [
      { timestamp: '2026-04-08T01:00:00.000Z', title: 'keep me' },
      { timestamp: '2026-04-08T02:00:00.000Z', title: 'skip me' },
      { timestamp: '2026-04-09T03:00:00.000Z', title: 'keep me' },
    ]);
    const result = runTz('UTC', ['--all', '--filter_time', '2026-04-08',
                                 '--search', 'keep', '--directory', tmpDir]);
    expect(parseAll(result.stdout).map((r) => r.timestamp))
      .toEqual(['2026-04-08T01:00:00.000Z']);
  });

  test('a bare --filter_time lists the 10 most recent matches', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({
      timestamp: `2026-04-08T0${Math.floor(i / 10)}:${String(i % 10).padStart(2, '0')}:00.000Z`,
      title: `t${i}`,
    }));
    writeFileOfRecords('log.json', many);
    const result = runTz('UTC', ['--filter_time', '2026-04-08',
                                 '--directory', tmpDir]);
    expect(result.exitCode).toBe(0);
    expect(parseAll(result.stdout)).toHaveLength(10);
  });

  test('records with an unparseable timestamp never match a span', () => {
    writeFileOfRecords('log.json', [
      { timestamp: 'not a timestamp', title: 'broken' },
      { timestamp: '2026-04-08T05:00:00.000Z', title: 'fine' },
    ]);
    expect(titles('2026')).toEqual(['fine']);
  });

  test.describe('rejected values', () => {
    const bad: [string, string][] = [
      ['3', 'cannot parse'],
      ['2026-13-01', 'not a real date'],
      ['garbage', 'cannot parse'],
      ['2026-04..2026-03', 'ends before it starts'],
      ['2026-01..2026-02z', 'mixes local and UTC'],
      ['1..2..3', "more than one '..'"],
      ['..', 'needs a date or time'],
      ['2026-04-08z 20', 'cannot parse'],   // z has to come last
      ['20:30:', 'cannot parse'],           // trailing separator
      ['20:30:12.', 'cannot parse'],
      ['2026082', 'cannot parse'],          // half a compact field
      ['20268', 'cannot parse'],            // shorter than YYYYMM
      ['20260822-13-259', 'cannot parse'],  // ms without minutes
      ['20260822-1329-259', 'cannot parse'],  // ms without seconds
      ['202608-13', 'cannot parse'],        // an hour with no day
      ['20260822 13', 'cannot parse'],      // compact takes no separator
      ['20260822t13', 'cannot parse'],
      ['   ', 'non-whitespace'],
    ];
    for (const [value, message] of bad) {
      test(`rejects '${value}'`, () => {
        const result = runTz('UTC', ['--all', '--filter_time', value,
                                     '--directory', tmpDir]);
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain(message);
        expect(result.stdout).toBe('');
      });
    }
  });

  test('the span does not filter records --watch emits later', async () => {
    const proc = spawn(SCRIPT, [
      '--filter_time', '2020-01-01', '--watch', '--directory', tmpDir,
    ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TZ: 'UTC' } });
    const chunks: Buffer[] = [];
    proc.stdout!.on('data', (d: Buffer) => chunks.push(d));
    const output = () => Buffer.concat(chunks).toString('utf8');

    try {
      await new Promise((r) => setTimeout(r, 1200));
      fs.appendFileSync(
        path.join(tmpDir, 'log.json'),
        ndjson([{ timestamp: '2026-06-01T00:00:00.000Z', title: 'Brand new' }]),
      );
      await expect.poll(() => output(), { timeout: 10_000 })
        .toContain('Brand new');
    } finally {
      try { proc.kill('SIGTERM'); } catch { /* already dead */ }
    }
  });
});

/**
 * The per-bundle `history.sh` wrappers.
 *
 * They force no action — the skill supplies the history flags — and
 * they own the skill-level `--copy` flag, which each bundle resolves
 * differently: dropped where the agent reads the capture dir in
 * place, turned into `--copy-to-dir <tmp>` for Gemini. `SeeWhatISee.py`
 * itself rejects `--copy`, so a wrapper that failed to consume it
 * would fail loudly; one that passed the wrong dir would not.
 */
test.describe('history.sh wrappers', () => {
  const ROOT = path.resolve(__dirname, '../..');
  const CLAUDE = `${ROOT}/skills/claude-plugin/skills/see-what-i-see-history/scripts/history.sh`;
  const GENERIC = `${ROOT}/skills/generic-skills/see-what-i-see-history/scripts/history.sh`;
  const GEMINI = `${ROOT}/skills/dot-gemini/skills/see-what-i-see-history/scripts/history.sh`;

  function runWrapper(script: string, args: string[], env: NodeJS.ProcessEnv = {}) {
    const result = spawnSync(script, args, {
      timeout: 5_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return {
      stdout: (result.stdout as string) ?? '',
      stderr: (result.stderr as string) ?? '',
      exitCode: result.status ?? 1,
    };
  }

  test.beforeEach(() => {
    writeFileOfRecords('log.json', [rec(1), rec(2), rec(3)]);
    for (const n of [1, 2, 3]) {
      fs.writeFileSync(path.join(tmpDir, `screenshot-2026040${n}.png`), 'png');
    }
  });

  for (const [name, script] of [['claude', CLAUDE], ['generic', GENERIC]] as const) {
    test(`${name}: forwards history flags, reading files in place`, () => {
      const result = runWrapper(script, ['--limit', '2', '--directory', tmpDir]);
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
      const records = parseAll(result.stdout);
      expect(records.map((r) => r.url)).toEqual([
        'http://example.com/page2', 'http://example.com/page3',
      ]);
      // Paths point at the source dir: these bundles never copy.
      expect(records[0].screenshot.filename).toBe(
        path.join(tmpDir, 'screenshot-20260402.png'));
    });
  }

  test('gemini: --copy copies into $TARGET_DIR/SeeWhatISee', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'swis-target-'));
    try {
      const result = runWrapper(
        GEMINI, ['--limit', '1', '--copy', '--directory', tmpDir],
        { TARGET_DIR: target });
      expect(result.exitCode).toBe(0);
      const [record] = parseAll(result.stdout);
      const copied = path.join(target, 'SeeWhatISee', 'screenshot-20260403.png');
      expect(record.screenshot.filename).toBe(copied);
      expect(fs.existsSync(copied)).toBe(true);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  test('gemini: without --copy, nothing is copied', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'swis-target-'));
    try {
      const result = runWrapper(
        GEMINI, ['--limit', '1', '--directory', tmpDir], { TARGET_DIR: target });
      expect(result.exitCode).toBe(0);
      const [record] = parseAll(result.stdout);
      expect(record.screenshot.filename).toBe(
        path.join(tmpDir, 'screenshot-20260403.png'));
      expect(fs.existsSync(path.join(target, 'SeeWhatISee'))).toBe(false);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  test('a run with no count or filter is refused', () => {
    // The backend falls back to --get-latest when no action flag is
    // given, so a history run that lost its flags would silently
    // describe the newest capture. The wrappers stop that.
    for (const script of [CLAUDE, GENERIC, GEMINI]) {
      for (const args of [[], ['--directory', tmpDir]]) {
        const result = runWrapper(script, args);
        expect(result.exitCode).toBe(2);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('pass a count');
      }
    }
    // --copy alone is no more of a history action than no flags at all.
    const copyOnly = runWrapper(GEMINI, ['--copy', '--directory', tmpDir]);
    expect(copyOnly.exitCode).toBe(2);
    expect(copyOnly.stdout).toBe('');
  });

  test('gemini: --copy is only consumed in flag position', () => {
    // A search term that happens to read like the flag is a value,
    // not the flag — stripping it blindly would shift the arguments.
    writeFileOfRecords('log.json', [rec(1, { title: 'about --copy semantics' }), rec(2)]);
    const result = runWrapper(GEMINI, ['--search', '--copy', '--directory', tmpDir]);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(parseAll(result.stdout).map((r) => r.title)).toEqual(['about --copy semantics']);
  });

  test('--help reaches the backend through the wrapper', () => {
    const result = runWrapper(CLAUDE, ['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--filter_time SPAN');
  });
});
