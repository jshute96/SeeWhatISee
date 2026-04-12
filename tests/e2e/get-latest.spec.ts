import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../../scripts/get-latest.sh');

function run(
  args: string[], opts?: { cwd?: string },
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    timeout: 5_000,
    encoding: 'utf8',
    cwd: opts?.cwd,
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swis-getlatest-'));
});

test.afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeLatest(dir: string, record: Record<string, unknown>) {
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(record) + '\n');
}

test.describe('get-latest.sh', () => {
  test('prints JSON with absolute screenshot path', () => {
    writeLatest(tmpDir, {
      timestamp: '2026-04-09T12:00:00.001Z',
      screenshot: 'screenshot-20260409-120000-001.png',
      url: 'http://example.com/page1',
    });

    const r = run(['--directory', tmpDir]);
    expect(r.exitCode).toBe(0);

    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.screenshot).toBe(`${tmpDir}/screenshot-20260409-120000-001.png`);
    expect(parsed.timestamp).toBe('2026-04-09T12:00:00.001Z');
    expect(parsed.url).toBe('http://example.com/page1');
  });

  test('prints JSON with absolute contents path', () => {
    writeLatest(tmpDir, {
      timestamp: '2026-04-09T12:00:00.000Z',
      contents: 'contents-20260409-120000-000.html',
      url: 'http://example.com/page0',
    });

    const r = run(['--directory', tmpDir]);
    expect(r.exitCode).toBe(0);

    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.contents).toBe(`${tmpDir}/contents-20260409-120000-000.html`);
  });

  test('absolutizes both screenshot and contents', () => {
    writeLatest(tmpDir, {
      timestamp: '2026-04-09T12:00:00.000Z',
      screenshot: 'screenshot-20260409-120000-000.png',
      contents: 'contents-20260409-120000-000.html',
      url: 'http://example.com/page0',
    });

    const r = run(['--directory', tmpDir]);
    expect(r.exitCode).toBe(0);

    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.screenshot).toBe(`${tmpDir}/screenshot-20260409-120000-000.png`);
    expect(parsed.contents).toBe(`${tmpDir}/contents-20260409-120000-000.html`);
  });

  test('does not double-absolutize already-absolute paths', () => {
    writeLatest(tmpDir, {
      timestamp: '2026-04-09T12:00:00.000Z',
      screenshot: '/already/absolute/screenshot.png',
      url: 'http://example.com/page0',
    });

    const r = run(['--directory', tmpDir]);
    expect(r.exitCode).toBe(0);

    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.screenshot).toBe('/already/absolute/screenshot.png');
  });

  test('errors when latest.json does not exist', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swis-empty-'));
    const r = run(['--directory', emptyDir]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('not found');
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  test('resolves directory from .SeeWhatISee config', () => {
    writeLatest(tmpDir, {
      timestamp: '2026-04-09T12:00:00.001Z',
      screenshot: 'screenshot-20260409-120000-001.png',
      url: 'http://example.com/page1',
    });

    const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swis-cfg-'));
    fs.writeFileSync(path.join(cfgDir, '.SeeWhatISee'), `directory=${tmpDir}\n`);

    const r = run([], { cwd: cfgDir });
    expect(r.exitCode).toBe(0);

    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.screenshot).toBe(`${tmpDir}/screenshot-20260409-120000-001.png`);
    fs.rmSync(cfgDir, { recursive: true, force: true });
  });
});
