import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../../scripts/SeeWhatISee.sh');

// SeeWhatISee.sh refuses nonsense flag combinations rather than
// silently no-op'ing them. These tests pin that behavior so a
// regression doesn't leak past the type system into a confused user
// session ("I passed --after but nothing came out!").

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

test.describe('SeeWhatISee.sh flag-combo validation', () => {
  test('--get-latest --after errors out', () => {
    const r = run(['--get-latest', '--after', '2026-01-01T00:00:00.000Z']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--after only applies with --watch');
  });

  test('--get-latest --loop errors out', () => {
    const r = run(['--get-latest', '--loop']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--loop only applies with --watch');
  });

  test('--get-latest --catch-up-one errors out', () => {
    const r = run(['--get-latest', '--catch-up-one']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--catch-up-one only applies with --watch');
  });

  // No explicit action defaults to --get-latest; the same error must fire
  // when watch-only flags are passed without selecting an action.
  test('bare --after (no action) errors out', () => {
    const r = run(['--after', '2026-01-01T00:00:00.000Z']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--after only applies with --watch');
  });

  test('--stop --after errors out (--stop is not a watch action)', () => {
    const r = run(['--stop', '--after', '2026-01-01T00:00:00.000Z']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--after only applies with --watch');
  });

  test('--stop --loop errors out (--stop is not a watch action)', () => {
    const r = run(['--stop', '--loop']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--loop only applies with --watch');
  });

  test('--stop --catch-up-one errors out (--stop is not a watch action)', () => {
    const r = run(['--stop', '--catch-up-one']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--catch-up-one only applies with --watch');
  });

  test('--watch --catch-up-one --loop errors as mutually exclusive', () => {
    const r = run(['--watch', '--catch-up-one', '--loop']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain(
      '--catch-up-one and --loop are mutually exclusive',
    );
  });

  // Unknown flags exit 2 and print the usage block.
  test('unknown option errors with usage', () => {
    const r = run(['--bogus']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('Unknown option: --bogus');
    expect(r.stderr).toContain('Usage:');
  });

  // --help wins over any action / option, even contradictory ones.
  test('--help short-circuits past validation', () => {
    const r = run(['--get-latest', '--after', 'X', '--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Usage:');
    // The help layout has a dedicated `Options for --watch:` section.
    expect(r.stdout).toContain('Options for --watch:');
  });
});
