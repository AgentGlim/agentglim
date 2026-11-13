import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const SCAN = fileURLToPath(new URL('../../dev/leak-scan.mjs', import.meta.url));

// Symlinked folders (e.g. .claude/skills/*) made the scan crash with EISDIR; it must read the link text instead.
test('leak scan reads symlink targets instead of following them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-leak-'));
  fs.mkdirSync(path.join(dir, 'real'));
  fs.writeFileSync(path.join(dir, 'real', 'a.txt'), 'hi\n');
  fs.symlinkSync('real', path.join(dir, 'link'));
  fs.symlinkSync(['', 'home', 'someone', 'x'].join('/'), path.join(dir, 'leak'));
  const list = path.join(dir, '..', path.basename(dir) + '.list');
  fs.writeFileSync(list, 'real/a.txt\nlink\nleak\n');
  const r = spawnSync(process.execPath, [SCAN, dir, '--public', list, '--env', path.join(dir, 'none.env')], { encoding: 'utf8' });
  assert.doesNotMatch(r.stderr, /EISDIR/);
  assert.match(r.stdout, /^home\tleak:1\t/m);
  assert.doesNotMatch(r.stdout, /^home\tlink/m);
  assert.match(r.stdout, /leak scan: 3 files/);
});
