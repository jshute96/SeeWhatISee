// Unit tests for resolveSourceDir — the source-dir resolution that
// mirrors SeeWhatISee.sh.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { resolveSourceDir } from '../dist/server.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'swis-mcp-resolve-'));
}

test('explicit --directory beats everything', () => {
  const home = tmpdir();
  const cwd = tmpdir();
  fs.writeFileSync(path.join(home, '.SeeWhatISee'), 'directory=/from/home\n');
  fs.writeFileSync(path.join(cwd, '.SeeWhatISee'), 'directory=/from/cwd\n');
  assert.equal(
    resolveSourceDir({ explicitDir: '/explicit', homeDir: home, cwd }),
    '/explicit',
  );
});

test('cwd .SeeWhatISee beats home .SeeWhatISee', () => {
  const home = tmpdir();
  const cwd = tmpdir();
  fs.writeFileSync(path.join(home, '.SeeWhatISee'), 'directory=/from/home\n');
  fs.writeFileSync(path.join(cwd, '.SeeWhatISee'), 'directory=/from/cwd\n');
  assert.equal(resolveSourceDir({ homeDir: home, cwd }), '/from/cwd');
});

test('home .SeeWhatISee used when cwd has none', () => {
  const home = tmpdir();
  const cwd = tmpdir();
  fs.writeFileSync(path.join(home, '.SeeWhatISee'), 'directory=/from/home\n');
  assert.equal(resolveSourceDir({ homeDir: home, cwd }), '/from/home');
});

test('default falls back to $HOME/Downloads/SeeWhatISee', () => {
  const home = tmpdir();
  const cwd = tmpdir();
  assert.equal(
    resolveSourceDir({ homeDir: home, cwd }),
    path.join(home, 'Downloads', 'SeeWhatISee'),
  );
});

test('comments and blank lines are skipped', () => {
  const home = tmpdir();
  const cwd = tmpdir();
  fs.writeFileSync(
    path.join(cwd, '.SeeWhatISee'),
    '# a comment\n\n  # indented comment\ndirectory=/configured\n',
  );
  assert.equal(resolveSourceDir({ homeDir: home, cwd }), '/configured');
});

test('quoted directory values are unquoted', () => {
  const home = tmpdir();
  const cwd = tmpdir();
  fs.writeFileSync(path.join(cwd, '.SeeWhatISee'), 'directory="/with spaces"\n');
  assert.equal(resolveSourceDir({ homeDir: home, cwd }), '/with spaces');
});

test('unknown config key throws', () => {
  const home = tmpdir();
  const cwd = tmpdir();
  fs.writeFileSync(path.join(cwd, '.SeeWhatISee'), 'frobnicate=yes\n');
  assert.throws(() => resolveSourceDir({ homeDir: home, cwd }), /Unrecognized option/);
});
