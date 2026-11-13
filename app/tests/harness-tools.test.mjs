import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { waitForServerReady } from './helpers/server-ready.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');

// A fresh user has no plans harness. The Harness page must say so instead of showing the optional run
// folder as a fault, the shipped SuperAgent tools must be listed, and `npm run scaffold-harness` must
// make the Status and Watcher tools work. Before 2026-11-13 the public tree shipped neither the manifest
// nor the tools, so the page had no pieces and every queue control was dead.
test('fresh install: the harness is optional, the shipped tools are listed, and the scaffold makes them work', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-harness-'));
  const data = path.join(home, 'data'), plans = path.join(home, 'plans'), run = path.join(plans, '_run');
  const write = (rel, text) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  write('env', '');
  write('harness.json', JSON.stringify({ status: { appUrl: 'http://127.0.0.1:9' } }));
  write('data/setup-complete', '');
  write('data/setup.json', JSON.stringify({ setupComplete: true }));
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    AGENTGLIM_DATA: data, AGENTGLIM_ENV_FILE: path.join(home, 'env'), AGENTGLIM_CONFIG: path.join(home, 'harness.json'),
    AGENTGLIM_PLANS: plans, AGENTGLIM_DEV: '1',
  };
  const srv = spawn(process.execPath, ['app/server.mjs', '0'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { srv.kill(); if (srv.exitCode === null) await once(srv, 'exit'); fs.rmSync(home, { recursive: true, force: true }); });
  const port = await waitForServerReady(srv), base = `http://127.0.0.1:${port}`;
  const get = async (p) => { const r = await fetch(base + p); assert.equal(r.status, 200); return r; };

  const before = await (await get('/api/harness')).json();
  assert.equal(before.harness.found, false);
  assert.equal(before.harness.run, path.join('~', 'plans', '_run'));
  assert.ok(before.pieces.length >= 7, `shipped tools listed, got ${before.pieces.length}`);
  assert.ok(before.pieces.some((p) => p.id === 'status-write'));
  assert.ok(before.pieces.every((p) => p.packagedFound === true)); // every packaged path exists in a clean clone
  assert.ok(before.pieces.every((p) => p.live?.exists === false)); // not linked yet
  assert.match(await (await get('/harness')).text(), /npm run scaffold-harness/);

  const dry = spawnSync(process.execPath, [path.join(REPO, 'tools', 'scaffold-harness.mjs'), '--dry-run'], { cwd: REPO, env, encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(fs.existsSync(run), false, 'a dry run writes nothing');

  const sc = spawnSync(process.execPath, [path.join(REPO, 'tools', 'scaffold-harness.mjs')], { cwd: REPO, env, encoding: 'utf8' });
  assert.equal(sc.status, 0, sc.stderr);
  for (const f of ['status-write.mjs', 'chat-write.mjs', 'owner-check.mjs', 'harness-set.mjs', 'auditq-wait.sh', 'io-guard.sh', 'jev-route.mjs'])
    assert.ok(fs.existsSync(path.join(run, 'bin', f)), `${f} linked`);
  assert.match(fs.readFileSync(path.join(run, 'AGENTGLIM-HARNESS.md'), 'utf8'), /does \*\*not\*\* include a plans driver/);

  const after = await (await get('/api/harness')).json();
  assert.equal(after.harness.found, true);
  assert.equal(after.harness.missing, 0);
  assert.ok(after.pieces.every((p) => p.live?.exists === true));

  // The linked Status writer answers a refresh request with the SuperAgent's words.
  write('plans/_run/status_ask/1700000000000.json', JSON.stringify({ at: 1700000000000, source: 'status-refresh' }));
  const st = spawnSync(process.execPath, [path.join(run, 'bin', 'status-write.mjs'), '--done', 'no blockers', '--running', 'watching plans', '--blocked', 'none', '--next', 'keep watching'], { cwd: REPO, env, encoding: 'utf8' });
  assert.equal(st.status, 0, st.stderr);
  const status = JSON.parse(fs.readFileSync(path.join(data, 'status.json'), 'utf8'));
  assert.deepEqual(status.lines, { done: 'no blockers', running: 'watching plans', blocked: 'none', next: 'keep watching', optimize: '' });
  assert.equal(status.source, 'asked');
  assert.ok(fs.existsSync(path.join(run, 'status_ask', '1700000000000.json.answered')), 'the status ask is answered');

  // The linked chat writer answers the Control Watcher thread.
  write('plans/_run/chat_inbox/1700000000001.json', JSON.stringify({ at: '2023-11-14T22:13:20.000Z', from: 'control', text: 'hi' }));
  const cw = spawnSync(process.execPath, [path.join(run, 'bin', 'chat-write.mjs'), '--reply', 'hello from the SuperAgent', '--to', '1700000000001'], { cwd: REPO, env, encoding: 'utf8' });
  assert.equal(cw.status, 0, cw.stderr);
  assert.match(fs.readFileSync(path.join(data, 'control', 'watcher-in.ndjson'), 'utf8'), /hello from the SuperAgent/);
  assert.ok(fs.existsSync(path.join(run, 'chat_inbox', '1700000000001.json.answered')));

  // A second scaffold preserves anything already there, including a file the user added.
  write('plans/_run/bin/my-own-tool.sh', '#!/bin/sh\n');
  const again = spawnSync(process.execPath, [path.join(REPO, 'tools', 'scaffold-harness.mjs')], { cwd: REPO, env, encoding: 'utf8' });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(fs.readFileSync(path.join(run, 'bin', 'my-own-tool.sh'), 'utf8'), '#!/bin/sh\n');
});
