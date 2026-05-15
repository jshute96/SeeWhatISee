import { test, expect } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../../scripts/SeeWhatISee.sh');

// SeeWhatISee.sh runs combinable actions in a fixed order: --stop,
// then --get-latest, then --watch. These tests pin both that order
// and the lenient "missing/empty log is OK when combined with --watch"
// behavior — when --get-latest is used standalone, missing/empty log
// is an error; when combined with --watch, it's just "nothing to
// emit yet, fall through to polling".

// ---- Helpers ---------------------------------------------------------------

function run(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('bash', [SCRIPT, ...args], {
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

function startProc(args: string[]): {
  proc: ChildProcess;
  output: () => string;
  kill: () => void;
} {
  const proc = spawn('bash', [SCRIPT, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks: Buffer[] = [];
  proc.stdout!.on('data', (d: Buffer) => chunks.push(d));
  proc.stderr!.on('data', (d: Buffer) => chunks.push(d));
  return {
    proc,
    output: () => Buffer.concat(chunks).toString('utf8'),
    kill: () => {
      try { process.kill(-proc.pid!, 'SIGTERM'); } catch {
        try { proc.kill('SIGTERM'); } catch { /* already dead */ }
      }
    },
  };
}

function waitForExit(proc: ChildProcess, timeoutMs = 5_000): Promise<number | null> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) { resolve(proc.exitCode); return; }
    const timer = setTimeout(() => resolve(null), timeoutMs);
    proc.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}

function waitForPattern(
  getOutput: () => string, pattern: string, timeoutMs = 5_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for "${pattern}"; output was:\n${getOutput()}`)),
      timeoutMs,
    );
    const interval = setInterval(() => {
      if (getOutput().includes(pattern)) {
        clearInterval(interval); clearTimeout(timer); resolve();
      }
    }, 50);
  });
}

let tmpDir: string;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swis-combined-'));
});

test.afterEach(() => {
  // Kill any watcher that might still be running.
  try {
    spawnSync('bash', [SCRIPT, '--stop', '--directory', tmpDir], { timeout: 3000 });
  } catch { /* ok */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---- Tests -----------------------------------------------------------------

test.describe('SeeWhatISee.sh combined actions', () => {
  test.setTimeout(15_000);

  test('--get-latest --watch emits current then waits for next', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'log.json'),
      JSON.stringify({
        timestamp: '2026-04-09T12:00:00.000Z',
        screenshot: { filename: 'first.png' },
      }) + '\n',
    );
    const w = startProc(['--get-latest', '--watch', '--directory', tmpDir]);
    // The current record should be emitted immediately.
    await waitForPattern(w.output, 'first.png');

    // Sleep past the 1s mtime granularity and append a new record.
    await new Promise((r) => setTimeout(r, 1100));
    fs.appendFileSync(
      path.join(tmpDir, 'log.json'),
      JSON.stringify({
        timestamp: '2026-04-09T12:00:01.000Z',
        screenshot: { filename: 'second.png' },
      }) + '\n',
    );
    // Without --loop, watch exits after the next emission.
    await waitForPattern(w.output, 'second.png');
    const code = await waitForExit(w.proc, 3_000);
    expect(code).toBe(0);
  });

  test('--get-latest --watch is lenient when log.json is missing', async () => {
    // Standalone --get-latest errors here; combined with --watch it
    // skips the get-latest emission and waits for the first capture.
    const w = startProc(['--get-latest', '--watch', '--directory', tmpDir]);

    // Give the script a moment to enter the poll loop, then create
    // the log to trigger an emission.
    await new Promise((r) => setTimeout(r, 600));
    fs.writeFileSync(
      path.join(tmpDir, 'log.json'),
      JSON.stringify({
        timestamp: '2026-04-09T12:00:00.000Z',
        screenshot: { filename: 'fresh.png' },
      }) + '\n',
    );
    await waitForPattern(w.output, 'fresh.png');
    const code = await waitForExit(w.proc, 3_000);
    expect(code).toBe(0);

    // No "Error:" should have been printed for the missing log.
    expect(w.output()).not.toContain('not found');
  });

  test('--get-latest --watch is lenient when log.json is empty', async () => {
    fs.writeFileSync(path.join(tmpDir, 'log.json'), '');
    const w = startProc(['--get-latest', '--watch', '--directory', tmpDir]);

    await new Promise((r) => setTimeout(r, 1100));
    fs.appendFileSync(
      path.join(tmpDir, 'log.json'),
      JSON.stringify({
        timestamp: '2026-04-09T12:00:00.000Z',
        screenshot: { filename: 'arrived.png' },
      }) + '\n',
    );
    await waitForPattern(w.output, 'arrived.png');
    const code = await waitForExit(w.proc, 3_000);
    expect(code).toBe(0);
    expect(w.output()).not.toContain('Error:');
  });

  test('--stop --get-latest runs --stop first then emits the latest', () => {
    // Pre-seed a stale pidfile so --stop has something to clean up.
    fs.writeFileSync(path.join(tmpDir, '.watch.pid'), '999999\n');
    fs.writeFileSync(
      path.join(tmpDir, 'log.json'),
      JSON.stringify({
        timestamp: '2026-04-09T12:00:00.000Z',
        screenshot: { filename: 'x.png' },
      }) + '\n',
    );
    const r = run(['--stop', '--get-latest', '--directory', tmpDir]);
    expect(r.exitCode).toBe(0);
    // Stop runs first → reports nothing-to-stop (pid 999999 isn't alive).
    expect(r.stdout).toContain('No existing watcher to stop');
    // …then get-latest emits the record.
    expect(r.stdout).toContain('x.png');
    // Order matters: the "No existing watcher" line should precede the JSON.
    const stopIdx = r.stdout.indexOf('No existing watcher to stop');
    const recordIdx = r.stdout.indexOf('x.png');
    expect(stopIdx).toBeLessThan(recordIdx);
  });

  test('--stop --get-latest --watch runs in --stop, --get-latest, --watch order', async () => {
    fs.writeFileSync(path.join(tmpDir, '.watch.pid'), '999999\n');
    fs.writeFileSync(
      path.join(tmpDir, 'log.json'),
      JSON.stringify({
        timestamp: '2026-04-09T12:00:00.000Z',
        screenshot: { filename: 'before-watch.png' },
      }) + '\n',
    );
    const w = startProc([
      '--stop', '--get-latest', '--watch', '--directory', tmpDir,
    ]);

    // The first thing in output is the stop message, then the
    // get-latest emission, then the script blocks in the poll loop
    // waiting for the next capture.
    await waitForPattern(w.output, 'before-watch.png');
    const before = w.output();
    expect(before).toContain('No existing watcher to stop');
    expect(before.indexOf('No existing watcher to stop'))
      .toBeLessThan(before.indexOf('before-watch.png'));

    // New capture wakes the poll loop; without --loop it then exits.
    await new Promise((r) => setTimeout(r, 1100));
    fs.appendFileSync(
      path.join(tmpDir, 'log.json'),
      JSON.stringify({
        timestamp: '2026-04-09T12:00:01.000Z',
        screenshot: { filename: 'after-watch.png' },
      }) + '\n',
    );
    await waitForPattern(w.output, 'after-watch.png');
    const code = await waitForExit(w.proc, 3_000);
    expect(code).toBe(0);
  });

  test('--stop --watch (no --get-latest) tears down then claims the pidfile', async () => {
    // Pre-seed a stale pidfile so --stop has something to clean up
    // and the subsequent --watch must claim a fresh slot.
    fs.writeFileSync(path.join(tmpDir, '.watch.pid'), '999999\n');
    fs.writeFileSync(
      path.join(tmpDir, 'log.json'),
      JSON.stringify({
        timestamp: '2026-04-09T12:00:00.000Z',
        screenshot: { filename: 'old.png' },
      }) + '\n',
    );
    const w = startProc([
      '--stop', '--watch', '--pid-lockfile', '--directory', tmpDir,
    ]);

    // --stop runs first and reports nothing-to-stop.
    await waitForPattern(w.output, 'No existing watcher to stop');

    // --watch then claims the pidfile under the live process. Wait
    // for the file to exist and contain *this* process's pid.
    await new Promise((r) => setTimeout(r, 300));
    const pidFile = path.join(tmpDir, '.watch.pid');
    expect(fs.existsSync(pidFile)).toBe(true);
    const pidStr = fs.readFileSync(pidFile, 'utf8').trim();
    expect(Number(pidStr)).toBe(w.proc.pid);

    // Without --get-latest, the existing record should NOT have been
    // emitted — only changes from this point on get printed.
    expect(w.output()).not.toContain('old.png');

    // Append a new capture; --watch (no --loop) emits it then exits.
    await new Promise((r) => setTimeout(r, 1100));
    fs.appendFileSync(
      path.join(tmpDir, 'log.json'),
      JSON.stringify({
        timestamp: '2026-04-09T12:00:01.000Z',
        screenshot: { filename: 'new.png' },
      }) + '\n',
    );
    await waitForPattern(w.output, 'new.png');
    const code = await waitForExit(w.proc, 3_000);
    expect(code).toBe(0);

    // Pidfile cleaned up via the EXIT trap.
    expect(fs.existsSync(pidFile)).toBe(false);
  });
});

// ---- --watch + --copy-to-dir (Gemini watch-and-copy flow) ------------------

test.describe('SeeWhatISee.sh --watch --catch-up-one --copy-to-dir', () => {
  test.setTimeout(15_000);

  test('emits one record on a fresh capture, copying files into the target dir', async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swis-copy-target-'));
    try {
      const w = startProc([
        '--watch', '--catch-up-one',
        '--directory', tmpDir,
        '--copy-to-dir', targetDir,
      ]);

      // Give the script a beat to enter the poll loop.
      await new Promise((r) => setTimeout(r, 300));

      // Drop a real screenshot file alongside the log entry so the
      // script has something to copy.
      const screenshotName = 'screenshot-fresh.png';
      fs.writeFileSync(path.join(tmpDir, screenshotName), 'fake-png-bytes');
      fs.writeFileSync(
        path.join(tmpDir, 'log.json'),
        JSON.stringify({
          timestamp: '2026-04-09T12:00:00.000Z',
          screenshot: { filename: screenshotName },
        }) + '\n',
      );

      await waitForPattern(w.output, screenshotName);
      const code = await waitForExit(w.proc, 3_000);
      expect(code).toBe(0);

      // The emitted JSON path points into targetDir, and the
      // referenced file was actually copied there.
      const out = w.output().trim();
      const jsonLine = out.split('\n').find((l) => l.startsWith('{'));
      expect(jsonLine).toBeTruthy();
      const parsed = JSON.parse(jsonLine!);
      expect(parsed.screenshot.filename).toBe(path.join(targetDir, screenshotName));
      expect(fs.existsSync(path.join(targetDir, screenshotName))).toBe(true);
    } finally {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  test('--after with one pending record emits exactly that record (no poll)', () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swis-copy-target-'));
    try {
      // Two records in the log; --after the first should emit just
      // the second (single-record / Gemini single-shot semantics).
      const firstName = 'first.png';
      const secondName = 'second.png';
      fs.writeFileSync(path.join(tmpDir, firstName), 'first-bytes');
      fs.writeFileSync(path.join(tmpDir, secondName), 'second-bytes');
      fs.writeFileSync(
        path.join(tmpDir, 'log.json'),
        JSON.stringify({
          timestamp: '2026-04-09T12:00:00.000Z',
          screenshot: { filename: firstName },
        }) + '\n' +
        JSON.stringify({
          timestamp: '2026-04-09T12:00:01.000Z',
          screenshot: { filename: secondName },
        }) + '\n',
      );

      const r = spawnSync(
        'bash',
        [
          SCRIPT, '--watch', '--catch-up-one',
          '--after', '2026-04-09T12:00:00.000Z',
          '--directory', tmpDir,
          '--copy-to-dir', targetDir,
        ],
        { timeout: 5_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      expect(r.status).toBe(0);

      const out = (r.stdout as string).trim();
      // Exactly one JSON line — the post-after record.
      const jsonLines = out.split('\n').filter((l) => l.startsWith('{'));
      expect(jsonLines).toHaveLength(1);
      const parsed = JSON.parse(jsonLines[0]);
      expect(parsed.screenshot.filename).toBe(path.join(targetDir, secondName));
      expect(parsed.timestamp).toBe('2026-04-09T12:00:01.000Z');

      // The post-after file was copied; the pre-after file was not.
      expect(fs.existsSync(path.join(targetDir, secondName))).toBe(true);
      expect(fs.existsSync(path.join(targetDir, firstName))).toBe(false);
    } finally {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });
});
