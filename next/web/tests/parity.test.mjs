import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const checker = join(here, '../check-parity.mjs');
const baseline = join(here, '../fixtures/baseline-index.html');

function run(args) {
  try {
    const stdout = execFileSync('node', [checker, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('parity: passes on frozen baseline', () => {
  const r = run([]);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout + r.stderr, /required producer missing/);
});

test('parity: empty baseline fails and names required producer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-parity-'));
  try {
    const p = join(dir, 'empty.html');
    writeFileSync(p, '');
    const r = run([p]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /required producer missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parity: symlink baseline fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-parity-'));
  try {
    const target = join(dir, 'target.html');
    writeFileSync(target, '<html><body></body></html>');
    const link = join(dir, 'link.html');
    symlinkSync(target, link);
    const r = run([link]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /symlink/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parity: unrecognized markup baseline fails and names required producer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-parity-'));
  try {
    const p = join(dir, 'junk.html');
    writeFileSync(p, '<!doctype html><html><body><p>nothing here</p></body></html>');
    const r = run([p]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /required producer missing/);
    assert.match(r.stderr, /Active agents/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parity: missing producer baseline fails and names the bad row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-parity-'));
  try {
    const src = readFileSync(baseline, 'utf8');
    const p = join(dir, 'partial.html');
    writeFileSync(p, src.replace('Active agents', 'Gone agents'));
    const r = run([p]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /required producer missing/);
    assert.match(r.stderr, /Active agents/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parity: missing baseline file fails', () => {
  const r = run([join(tmpdir(), 'ag-parity-nope', 'missing.html')]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /required baseline not found/);
});
