import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../../scripts/copy-last-snapshot.sh');

// copy-last-snapshot.sh reads from $HOME/Downloads/SeeWhatISee and copies
// files into $TARGET_DIR/SeeWhatISee. We fake both via env vars.

function run(
  env: { HOME: string; TARGET_DIR: string },
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('bash', [SCRIPT], {
    timeout: 5_000,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    stdout: (result.stdout as string) ?? '',
    stderr: (result.stderr as string) ?? '',
    exitCode: result.status ?? 1,
  };
}

function makeFakeHome(): { fakeHome: string; srcDir: string } {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swis-home-'));
  const srcDir = path.join(fakeHome, 'Downloads', 'SeeWhatISee');
  fs.mkdirSync(srcDir, { recursive: true });
  return { fakeHome, srcDir };
}

function writeLog(dir: string, records: Record<string, unknown>[]) {
  const ndjson = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'log.json'), ndjson);
}

let targetDir: string;

test.beforeEach(() => {
  targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swis-target-'));
});

test.afterEach(() => {
  fs.rmSync(targetDir, { recursive: true, force: true });
});

test.describe('copy-last-snapshot.sh', () => {
  test('copies files and rewrites paths to TARGET_DIR', () => {
    const { fakeHome, srcDir } = makeFakeHome();

    const screenshotFile = 'screenshot-20260409-120000-000.png';
    const contentsFile = 'contents-20260409-120000-000.html';
    const record = {
      timestamp: '2026-04-09T12:00:00.000Z',
      screenshot: screenshotFile,
      contents: contentsFile,
      url: 'http://example.com/page0',
    };
    writeLog(srcDir, [record]);
    fs.writeFileSync(path.join(srcDir, screenshotFile), 'fake-png-data');
    fs.writeFileSync(path.join(srcDir, contentsFile), '<html>test</html>');

    const r = run({ HOME: fakeHome, TARGET_DIR: targetDir });
    expect(r.exitCode).toBe(0);

    const parsed = JSON.parse(r.stdout.trim());
    const outDir = `${targetDir}/SeeWhatISee`;
    expect(parsed.screenshot).toBe(`${outDir}/${screenshotFile}`);
    expect(parsed.contents).toBe(`${outDir}/${contentsFile}`);

    expect(fs.existsSync(path.join(outDir, screenshotFile))).toBe(true);
    expect(fs.existsSync(path.join(outDir, contentsFile))).toBe(true);

    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  test('handles screenshot-only records', () => {
    const { fakeHome, srcDir } = makeFakeHome();

    const screenshotFile = 'screenshot-20260409-120000-000.png';
    const record = {
      timestamp: '2026-04-09T12:00:00.000Z',
      screenshot: screenshotFile,
      url: 'http://example.com/page0',
    };
    writeLog(srcDir, [record]);
    fs.writeFileSync(path.join(srcDir, screenshotFile), 'fake-png-data');

    const r = run({ HOME: fakeHome, TARGET_DIR: targetDir });
    expect(r.exitCode).toBe(0);

    const parsed = JSON.parse(r.stdout.trim());
    const outDir = `${targetDir}/SeeWhatISee`;
    expect(parsed.screenshot).toBe(`${outDir}/${screenshotFile}`);
    expect(parsed.contents).toBeUndefined();

    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  test('handles contents-only records', () => {
    const { fakeHome, srcDir } = makeFakeHome();

    const contentsFile = 'contents-20260409-120000-000.html';
    const record = {
      timestamp: '2026-04-09T12:00:00.000Z',
      contents: contentsFile,
      url: 'http://example.com/page0',
    };
    writeLog(srcDir, [record]);
    fs.writeFileSync(path.join(srcDir, contentsFile), '<html>test</html>');

    const r = run({ HOME: fakeHome, TARGET_DIR: targetDir });
    expect(r.exitCode).toBe(0);

    const parsed = JSON.parse(r.stdout.trim());
    const outDir = `${targetDir}/SeeWhatISee`;
    expect(parsed.contents).toBe(`${outDir}/${contentsFile}`);
    expect(parsed.screenshot).toBeUndefined();

    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  test('returns the last record when log has multiple entries', () => {
    const { fakeHome, srcDir } = makeFakeHome();

    const screenshotFile = 'screenshot-20260409-120000-001.png';
    writeLog(srcDir, [
      {
        timestamp: '2026-04-09T12:00:00.000Z',
        screenshot: 'screenshot-20260409-120000-000.png',
        url: 'http://example.com/page0',
      },
      {
        timestamp: '2026-04-09T12:00:00.001Z',
        screenshot: screenshotFile,
        url: 'http://example.com/page1',
      },
    ]);
    fs.writeFileSync(path.join(srcDir, screenshotFile), 'fake-png-data');

    const r = run({ HOME: fakeHome, TARGET_DIR: targetDir });
    expect(r.exitCode).toBe(0);

    const parsed = JSON.parse(r.stdout.trim());
    const outDir = `${targetDir}/SeeWhatISee`;
    expect(parsed.screenshot).toBe(`${outDir}/${screenshotFile}`);
    expect(parsed.timestamp).toBe('2026-04-09T12:00:00.001Z');

    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  test('errors when log.json does not exist', () => {
    const { fakeHome } = makeFakeHome();
    const r = run({ HOME: fakeHome, TARGET_DIR: targetDir });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('not found');
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  test('errors when log.json is empty (cleared history)', () => {
    // "Clear log history" overwrites log.json with a zero-byte file.
    // Match the missing-file behavior so callers don't try to parse
    // empty output.
    const { fakeHome, srcDir } = makeFakeHome();
    fs.writeFileSync(path.join(srcDir, 'log.json'), '');
    const r = run({ HOME: fakeHome, TARGET_DIR: targetDir });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('empty');
    expect(r.stdout).toBe('');
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });
});
