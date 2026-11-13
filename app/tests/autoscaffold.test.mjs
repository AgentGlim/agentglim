import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { waitForServerReady } from './helpers/server-ready.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');

// Issue #1: tools were only linked after a manual `npm run scaffold-harness`. First-run setup now links
// them, the Harness page has a Link tools button (POST /api/harness-scaffold) and the stale hint is gone.
test('first-run setup links the tools; the Link tools endpoint works; no stale hint once linked', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-autoscaffold-'));
  const data = path.join(home, 'data'), plans = path.join(home, 'plans'), run = path.join(plans, '_run');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'env'), '');
  fs.writeFileSync(path.join(home, 'harness.json'), JSON.stringify({ status: { appUrl: 'http://127.0.0.1:9' } }));
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    AGENTGLIM_DATA: data, AGENTGLIM_ENV_FILE: path.join(home, 'env'), AGENTGLIM_CONFIG: path.join(home, 'harness.json'),
    AGENTGLIM_PLANS: plans, AGENTGLIM_DEV: '1',
  };
  const srv = spawn(process.execPath, ['app/server.mjs', '0'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { srv.kill(); if (srv.exitCode === null) await once(srv, 'exit'); fs.rmSync(home, { recursive: true, force: true }); });
  const port = await waitForServerReady(srv), base = `http://127.0.0.1:${port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body ?? {}) });

  assert.equal((await (await fetch(base + '/api/harness')).json()).harness.found, false);
  assert.equal((await post('/api/harness-scaffold')).status, 200);
  assert.equal((await fetch(base + '/api/harness-scaffold', { method: 'POST', headers: { origin: 'http://evil.example' } })).status, 403);
  const linked = await (await fetch(base + '/api/harness')).json();
  assert.equal(linked.harness.found, true);
  assert.equal(linked.harness.missing, 0);
  assert.ok(fs.existsSync(path.join(run, 'bin', 'auditq-wait.sh')));

  // first-run setup does it by itself on a clean run folder
  fs.renameSync(run, run + '.old');
  const r = await post('/api/setup', {});
  assert.equal(r.status, 200);
  assert.equal((await r.json()).scaffold.ok, true);
  assert.equal((await (await fetch(base + '/api/harness')).json()).harness.missing, 0);
  assert.ok(fs.existsSync(path.join(run, 'bin', 'status-write.mjs')));

  // the page: button present, per-row "Next:" hint only for tools that are not linked
  const html = await (await fetch(base + '/harness')).text();
  assert.match(html, /id="linkTools"/);
  assert.match(html, /p\.next&&!\(p\.live&&p\.live\.exists\)/);
});
