import { waitForServerReady } from './helpers/server-ready.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('priority route validates, enforces origin and persists changes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentglim-priority-'));
  for (const d of ['data', 'work', 'plans', 'plans/01-test']) fs.mkdirSync(path.join(tmp, d));
  const f = path.join(tmp, 'data/priorities.json');
  fs.writeFileSync(f, JSON.stringify({ projects: { '01-test': { tier: 1, why: 'reason' } } }));
  const app = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const srv = spawn(process.execPath, ['server.mjs', '0'], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: tmp, USERPROFILE: tmp, AGENTGLIM_ENV_FILE: path.join(tmp, 'env'), AGENTGLIM_DEV: '1', AGENTGLIM_DEV_WRITES: '1', AGENTGLIM_DATA: `${tmp}/data`, AGENTGLIM_WORK: `${tmp}/work`, AGENTGLIM_PLANS: `${tmp}/plans`, AGENTGLIM_RUN: `${tmp}/plans/_run` } });
  try {
    const port = await waitForServerReady(srv);
    const base = `http://127.0.0.1:${port}`;
    const post = (body, origin = base) => fetch(`${base}/api/priority`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
    assert.equal((await post({ dir: '01-test', tier: 2 }, 'http://evil.test')).status, 403);
    assert.equal((await post({ dir: '../escape', tier: 2 })).status, 422);
    assert.equal((await post({ dir: '01-test', tier: 4 })).status, 422);
    assert.equal((await post({ dir: '01-test', tier: 2 })).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(f)).projects['01-test'], { tier: 2, why: 'reason' });
  } finally { srv.kill(); if (srv.exitCode === null) await once(srv, 'exit'); fs.rmSync(tmp, { recursive: true, force: true }); }
});
