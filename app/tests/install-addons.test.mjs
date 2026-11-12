import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
test('add-on installer preserves user commands and installs only portable command links',()=>{
  const prefix=fs.mkdtempSync(path.join(os.tmpdir(),'ag-install-'));fs.mkdirSync(path.join(prefix,'bin'));fs.writeFileSync(path.join(prefix,'bin','jev-gate'),'existing command');const script=path.resolve(import.meta.dirname,'../../tools/install-addons.mjs');execFileSync(process.execPath,[script,'--prefix',prefix,'--commands-only'],{stdio:'pipe'});assert.equal(fs.readFileSync(path.join(prefix,'bin','jev-gate'),'utf8'),'existing command');assert.ok(fs.existsSync(path.join(prefix,'bin','jobs-track')));assert.ok(fs.existsSync(path.join(prefix,'bin','agent-notify')));
});

test('portable command links resolve through a symlinked prefix ancestor', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-install-alias-'));
  t.after(() => fs.rmSync(base, {recursive:true, force:true}));
  const target = path.join(base, 'physical', 'nested');
  fs.mkdirSync(target, {recursive:true});
  const alias = path.join(base, 'alias');
  fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const prefix = path.join(alias, 'prefix');
  execFileSync(process.execPath, [path.resolve(import.meta.dirname, '../../tools/install-addons.mjs'), '--prefix', prefix, '--commands-only']);
  for (const [name, file] of [['jobs-track', 'jobs-track.py'], ['jev-gate', 'jev-gate'], ['agent-notify', 'agent-notify']]) {
    assert.equal(fs.readFileSync(path.join(prefix, 'bin', name), 'utf8'), fs.readFileSync(path.resolve(import.meta.dirname, '../../tools/addons', file), 'utf8'));
  }
});
