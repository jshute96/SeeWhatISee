import { test as base, expect } from '@playwright/test';
import { spawn, execSync, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCH_SCRIPT = path.resolve(__dirname, '../../scripts/watch.sh');

// These tests are standalone — they create a temp directory with fake
// latest.json / log.json files and simulate captures by rewriting
// those files, then verify watch.sh reacts correctly. No extension or
// browser needed.
const test = base;

// ---- Helpers ---------------------------------------------------------------

/** Start watch.sh and collect its combined stdout+stderr. */
function startWatch(args: string[], opts?: { cwd?: string }): {
  proc: ChildProcess;
  output: () => string;
  kill: () => void;
} {
  const proc = spawn('bash', [WATCH_SCRIPT, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: opts?.cwd,
  });
  const chunks: Buffer[] = [];
  proc.stdout!.on('data', (d: Buffer) => chunks.push(d));
  proc.stderr!.on('data', (d: Buffer) => chunks.push(d));
  return {
    proc,
    output: () => Buffer.concat(chunks).toString('utf8'),
    kill: () => {
      try {
        // Kill the process group so inotifywait (child) also dies.
        process.kill(-proc.pid!, 'SIGTERM');
      } catch {
        try { proc.kill('SIGTERM'); } catch { /* already dead */ }
      }
    },
  };
}

/** Wait for the process to exit. Returns exit code, or null on timeout. */
function waitForExit(proc: ChildProcess, timeoutMs = 5_000): Promise<number | null> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) { resolve(proc.exitCode); return; }
    const timer = setTimeout(() => resolve(null), timeoutMs);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/**
 * Poll `getOutput()` until the output contains at least `count`
 * occurrences of `pattern`. Rejects on timeout.
 */
function waitForPattern(
  getOutput: () => string,
  pattern: string,
  count: number,
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(
        `timed out waiting for ${count}x "${pattern}" in output:\n${getOutput()}`,
      )),
      timeoutMs,
    );
    const interval = setInterval(() => {
      const n = getOutput().split(pattern).length - 1;
      if (n >= count) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve();
      }
    }, 100);
  });
}

/** Run a script synchronously. */
function runScript(
  script: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> },
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('bash', [script, ...args], {
    timeout: 5_000,
    encoding: 'utf8',
    cwd: opts?.cwd,
    env: { ...process.env, ...opts?.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    stdout: (result.stdout as string) ?? '',
    stderr: (result.stderr as string) ?? '',
    exitCode: result.status ?? 1,
  };
}

/** Run watch.sh synchronously (for short-lived invocations like --after / --stop). */
function runWatch(args: string[], opts?: { cwd?: string }): { stdout: string; stderr: string; exitCode: number } {
  return runScript(WATCH_SCRIPT, args, opts);
}

/** Build a fake capture record. */
function fakeRecord(index: number): { json: string; timestamp: string; screenshot: string } {
  const ms = String(index).padStart(3, '0');
  const screenshot = `screenshot-20260409-120000-${ms}.png`;
  const timestamp = `2026-04-09T12:00:00.${ms}Z`;
  const record = {
    timestamp,
    screenshot,
    url: `http://example.com/page${index}`,
  };
  return { json: JSON.stringify(record), timestamp, screenshot };
}

/**
 * Simulate a capture by rewriting latest.json (and appending to
 * log.json). Returns the synthetic record so callers can assert on
 * either `timestamp` (the `--after` key) or `screenshot` (the content
 * filename, useful for spotting the record in output).
 */
function simulateCapture(dir: string, index: number): {
  timestamp: string;
  screenshot: string;
} {
  const { json, timestamp, screenshot } = fakeRecord(index);
  fs.writeFileSync(path.join(dir, 'latest.json'), json + '\n');
  fs.appendFileSync(path.join(dir, 'log.json'), json + '\n');
  return { timestamp, screenshot };
}

// ---- Temp dir management ---------------------------------------------------

let tmpDir: string;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swis-watch-'));
  // Seed with an initial capture so the directory + files exist.
  const { json } = fakeRecord(0);
  fs.writeFileSync(path.join(tmpDir, 'latest.json'), json + '\n');
  fs.writeFileSync(path.join(tmpDir, 'log.json'), json + '\n');
});

test.afterEach(() => {
  // Kill any watcher left behind.
  try { execSync(`bash ${WATCH_SCRIPT} --stop --directory ${tmpDir}`, { timeout: 3000 }); } catch { /* ok */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---- Functional tests ------------------------------------------------------

test.describe('watch.sh', () => {
  // These tests have >1s waits between simulated captures (filesystem
  // mtime granularity), so total time can add up.
  test.setTimeout(30_000);
  test('--help prints usage and exits 0', () => {
    const r = runWatch(['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Usage:');
    expect(r.stdout).toContain('--directory');
    expect(r.stdout).toContain('--loop');
    expect(r.stdout).toContain('--after');
    expect(r.stdout).toContain('--stop');
  });

  test('errors when directory does not exist', () => {
    const r = runWatch(['--directory', '/nonexistent/path']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('does not exist');
  });

  test('once mode: emits on the next latest.json rewrite and exits', async () => {
    const watch = startWatch(['--directory', tmpDir]);
    // Wait >1s so the simulated capture's mtime is strictly greater
    // than the seed file's (filesystem mtime granularity is 1 second).
    await new Promise((r) => setTimeout(r, 1200));

    // Simulate a capture — rewrite latest.json.
    const { screenshot } = simulateCapture(tmpDir, 1);

    const exitCode = await waitForExit(watch.proc, 5_000);
    expect(exitCode).toBe(0);

    const out = watch.output();
    expect(out).toContain(`${tmpDir}/${screenshot}`);
  });

  test('once mode: output contains absolute paths', async () => {
    const watch = startWatch(['--directory', tmpDir]);
    await new Promise((r) => setTimeout(r, 1200));

    simulateCapture(tmpDir, 1);
    const exitCode = await waitForExit(watch.proc, 5_000);
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(watch.output().trim());
    expect(parsed.screenshot).toBe(`${tmpDir}/${fakeRecord(1).screenshot}`);
  });

  test('loop mode: emits on 3 captures', async () => {
    const watch = startWatch(['--loop', '--directory', tmpDir]);
    // Wait >1s so the first simulated capture has a strictly newer mtime.
    await new Promise((r) => setTimeout(r, 1200));

    const screenshots: string[] = [];
    for (let i = 1; i <= 3; i++) {
      screenshots.push(simulateCapture(tmpDir, i).screenshot);
      // Small gap so the mtime definitely advances (filesystem mtime
      // granularity is typically 1s; we write each capture to a temp
      // file then rename, and our emit() deduplicates on mtime).
      await new Promise((r) => setTimeout(r, 1100));
    }

    // Wait for all 3 screenshots to appear in the output.
    await waitForPattern(watch.output, screenshots[2], 1, 10_000);

    watch.kill();
    const out = watch.output();

    for (const fn of screenshots) {
      expect(out).toContain(`${tmpDir}/${fn}`);
    }
  });

  test('--after with pending captures emits them immediately', async () => {
    // log.json already has record 0 (from beforeEach). Add 2 more.
    simulateCapture(tmpDir, 1);
    simulateCapture(tmpDir, 2);

    const r0 = fakeRecord(0);
    const r1 = fakeRecord(1);
    const r2 = fakeRecord(2);

    // --after record 0: should show 2 pending (records 1 and 2).
    const after0 = runWatch(['--after', r0.timestamp, '--directory', tmpDir]);
    expect(after0.exitCode).toBe(0);
    expect(after0.stderr).toContain('2 pending captures');
    expect(after0.stdout).toContain(`${tmpDir}/${r1.screenshot}`);
    expect(after0.stdout).toContain(`${tmpDir}/${r2.screenshot}`);
    expect(after0.stdout).not.toContain(r0.screenshot);

    // --after record 1: should show 1 pending (record 2).
    const after1 = runWatch(['--after', r1.timestamp, '--directory', tmpDir]);
    expect(after1.exitCode).toBe(0);
    expect(after1.stderr).toContain('1 pending capture:');
    expect(after1.stdout).toContain(`${tmpDir}/${r2.screenshot}`);

    // --after record 2: nothing pending — script would block, so verify
    // it doesn't exit immediately.
    const after2 = startWatch(['--after', r2.timestamp, '--directory', tmpDir]);
    const code2 = await waitForExit(after2.proc, 1_500);
    // Should still be running (null = didn't exit within timeout).
    expect(code2).toBeNull();
    after2.kill();
  });

  test('--after + --loop emits pending then continues watching', async () => {
    // log.json has record 0 from beforeEach. Add record 1.
    simulateCapture(tmpDir, 1);

    const r0 = fakeRecord(0);
    const r1 = fakeRecord(1);

    // Start with --after r0.timestamp --loop. Should immediately emit
    // the pending capture (record 1), then keep watching.
    const watch = startWatch(['--after', r0.timestamp, '--loop', '--directory', tmpDir]);

    // Wait for the pending capture to appear in the output.
    await waitForPattern(watch.output, `${tmpDir}/${r1.screenshot}`, 1, 5_000);

    // Verify it emitted the pending capture.
    const out1 = watch.output();
    expect(out1).toContain('1 pending capture:');
    expect(out1).toContain(`${tmpDir}/${r1.screenshot}`);

    // The process should still be running (loop mode).
    expect(watch.proc.exitCode).toBeNull();

    // Now simulate another capture and verify the watcher picks it up.
    await new Promise((r) => setTimeout(r, 1200));
    const { screenshot: fn2 } = simulateCapture(tmpDir, 2);
    await waitForPattern(watch.output, `${tmpDir}/${fn2}`, 1, 5_000);

    watch.kill();
    const out2 = watch.output();
    expect(out2).toContain(`${tmpDir}/${fn2}`);
  });

  test('--after with nonexistent timestamp warns and watches', async () => {
    const watch = startWatch([
      '--after', '2099-01-01T00:00:00.000Z', '--directory', tmpDir,
    ]);
    // Give it a moment to print the warning and enter the watch loop.
    await new Promise((r) => setTimeout(r, 1_000));

    const out = watch.output();
    expect(out).toContain('not found');
    expect(out).toContain('watching');

    // It should still be running (in watch mode after the warning).
    expect(watch.proc.exitCode).toBeNull();
    watch.kill();
  });
});

// ---- Concurrency tests -----------------------------------------------------

test.describe('watch.sh concurrency', () => {
  test.setTimeout(30_000);
  test('pidfile is created and cleaned up on exit', async () => {
    const pidfile = path.join(tmpDir, '.watch.pid');

    const watch = startWatch(['--directory', tmpDir]);
    await new Promise((r) => setTimeout(r, 500));

    expect(fs.existsSync(pidfile)).toBe(true);
    const pid = parseInt(fs.readFileSync(pidfile, 'utf8').trim(), 10);
    expect(pid).toBe(watch.proc.pid);

    watch.kill();
    await waitForExit(watch.proc, 3_000);

    // Give the EXIT trap a moment to run.
    await new Promise((r) => setTimeout(r, 200));
    expect(fs.existsSync(pidfile)).toBe(false);
  });

  test('starting a second watcher kills the first', async () => {
    const pidfile = path.join(tmpDir, '.watch.pid');

    const watch1 = startWatch(['--directory', tmpDir]);
    await new Promise((r) => setTimeout(r, 500));
    expect(fs.existsSync(pidfile)).toBe(true);

    const watch2 = startWatch(['--directory', tmpDir]);
    const code1 = await waitForExit(watch1.proc, 5_000);
    // watch1 was terminated.
    expect(code1).not.toBeNull();

    // pidfile should now hold watch2's PID.
    await new Promise((r) => setTimeout(r, 500));
    expect(fs.existsSync(pidfile)).toBe(true);
    const pid2 = parseInt(fs.readFileSync(pidfile, 'utf8').trim(), 10);
    expect(pid2).toBe(watch2.proc.pid);

    watch2.kill();
    await waitForExit(watch2.proc, 3_000);
  });

  test('--stop kills the running watcher', async () => {
    const watch = startWatch(['--directory', tmpDir]);
    await new Promise((r) => setTimeout(r, 500));

    const stop = runWatch(['--stop', '--directory', tmpDir]);
    expect(stop.stdout).toContain('Stopping existing watcher');

    const code = await waitForExit(watch.proc, 5_000);
    expect(code).not.toBeNull();
  });

  test('--stop with no watcher reports nothing to stop', () => {
    const stop = runWatch(['--stop', '--directory', tmpDir]);
    expect(stop.stdout).toContain('No existing watcher to stop');
  });
});

// ---- Config file (.SeeWhatISee) tests ---------------------------------------

test.describe('watch.sh config file', () => {
  test.setTimeout(30_000);

  // These tests run watch.sh from a temp directory that contains a
  // .SeeWhatISee config file pointing at the tmpDir created by the
  // outer beforeEach. This tests the "look in current directory" path
  // without touching $HOME (which we can't safely modify in tests).
  let cfgDir: string;

  test.beforeEach(() => {
    cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swis-cfg-'));
  });

  test.afterEach(() => {
    fs.rmSync(cfgDir, { recursive: true, force: true });
  });

  test('reads directory from .SeeWhatISee in the current directory', async () => {
    fs.writeFileSync(path.join(cfgDir, '.SeeWhatISee'), `directory=${tmpDir}\n`);

    // Start watch.sh without --directory; it should find .SeeWhatISee.
    const watch = startWatch([], { cwd: cfgDir });
    await new Promise((r) => setTimeout(r, 1200));

    simulateCapture(tmpDir, 1);
    const exitCode = await waitForExit(watch.proc, 5_000);
    expect(exitCode).toBe(0);

    const out = watch.output();
    const { screenshot } = fakeRecord(1);
    expect(out).toContain(screenshot);
  });

  test('--directory flag overrides .SeeWhatISee config', async () => {
    // Config points to a nonexistent dir; --directory should override it.
    fs.writeFileSync(path.join(cfgDir, '.SeeWhatISee'), 'directory=/nonexistent/path\n');

    const watch = startWatch(['--directory', tmpDir], { cwd: cfgDir });
    await new Promise((r) => setTimeout(r, 1200));

    simulateCapture(tmpDir, 1);
    const exitCode = await waitForExit(watch.proc, 5_000);
    expect(exitCode).toBe(0);

    const out = watch.output();
    const { screenshot } = fakeRecord(1);
    expect(out).toContain(screenshot);
  });

  test('errors on unrecognized option in config file', () => {
    fs.writeFileSync(
      path.join(cfgDir, '.SeeWhatISee'),
      `directory=${tmpDir}\nbadoption=foo\n`,
    );

    const r = runWatch([], { cwd: cfgDir });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('unrecognized option');
    expect(r.stderr).toContain('line 2');
  });

  test('skips comments and blank lines in config file', async () => {
    fs.writeFileSync(
      path.join(cfgDir, '.SeeWhatISee'),
      `# This is a comment\n\n  # Indented comment\ndirectory=${tmpDir}\n`,
    );

    const watch = startWatch([], { cwd: cfgDir });
    await new Promise((r) => setTimeout(r, 1200));

    simulateCapture(tmpDir, 1);
    const exitCode = await waitForExit(watch.proc, 5_000);
    expect(exitCode).toBe(0);

    const out = watch.output();
    const { screenshot } = fakeRecord(1);
    expect(out).toContain(screenshot);
  });

  test('handles quoted directory values in config', async () => {
    fs.writeFileSync(path.join(cfgDir, '.SeeWhatISee'), `directory="${tmpDir}"\n`);

    const watch = startWatch([], { cwd: cfgDir });
    await new Promise((r) => setTimeout(r, 1200));

    simulateCapture(tmpDir, 1);
    const exitCode = await waitForExit(watch.proc, 5_000);
    expect(exitCode).toBe(0);

    const out = watch.output();
    const { screenshot } = fakeRecord(1);
    expect(out).toContain(screenshot);
  });
});
