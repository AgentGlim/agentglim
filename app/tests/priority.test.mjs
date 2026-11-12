import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('priority route validates, enforces origin and persists changes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentglim-priority-'));
  for (const d of ['data', 'work', 'plans', 'plans/01-test']) fs.mkdirSync(path.join(tmp, d));
  const f = path.join(tmp, 'data/priorities.json');
  fs.writeFileSync(f, JSON.stringify({ projects: { '01-test': { tier: 1, why: 'reason' } } }));
  const port = 19000 + Math.floor(Math.random() * 500), base = `http://127.0.0.1:${port}`;
  const app = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const srv = spawn(process.execPath, ['server.mjs', String(port)], { cwd: app, stdio: 'ignore', env: { ...process.env, AGENTGLIM_DEV: '1', AGENTGLIM_DEV_WRITES: '1', AGENTGLIM_DATA: `${tmp}/data`, AGENTGLIM_WORK: `${tmp}/work`, AGENTGLIM_PLANS: `${tmp}/plans`, AGENTGLIM_RUN: `${tmp}/plans/_run` } });
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) { try { await fetch(`${base}/api/modes`); ready = true; break; } catch {} await new Promise(r => setTimeout(r, 150)); }
    assert.ok(ready, 'server started');
    const post = (body, origin = base) => fetch(`${base}/api/priority`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
    assert.equal((await post({ dir: '01-test', tier: 2 }, 'http://evil.test')).status, 403);
    assert.equal((await post({ dir: '../escape', tier: 2 })).status, 422);
    assert.equal((await post({ dir: '01-test', tier: 4 })).status, 422);
    assert.equal((await post({ dir: '01-test', tier: 2 })).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(f)).projects['01-test'], { tier: 2, why: 'reason' });
  } finally { srv.kill(); }
});
