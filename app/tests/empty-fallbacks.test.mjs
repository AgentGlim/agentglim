// node --test app/tests/empty-fallbacks.test.mjs : with empty data and no harness, /api/modes and /api/agy-bench answer 200
// with empty fallbacks (they used to 500). Starts a dev-copy server on a spare port against fresh temp dirs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyModes, emptyAgyBench, has } from '../empty-fallbacks.mjs';

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 19374;
let srv, tmp;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-empty-'));
  for (const d of ['data', 'work', 'plans']) fs.mkdirSync(`${tmp}/${d}`);
  srv = spawn(process.execPath, ['server.mjs', String(PORT)], { cwd: APP, stdio: 'ignore',
    env: { ...process.env, HOME: tmp, USERPROFILE: tmp, AGENTGLIM_ENV_FILE: path.join(tmp, 'env'), AGENTGLIM_DEV: '1', AGENTGLIM_DATA: `${tmp}/data`, AGENTGLIM_WORK: `${tmp}/work`, AGENTGLIM_PLANS: `${tmp}/plans` } });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/modes`)).status) return; } catch {} await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('server did not start');
});
after(() => { srv?.kill(); });

test('fallback shapes are empty and safe to render', () => {
  assert.equal(has('/nonexistent/x.mjs'), false);
  const m = emptyModes(); assert.equal(m.empty, true); assert.deepEqual(m.pending, []);
  const b = emptyAgyBench(); assert.equal(b.empty, true); assert.deepEqual(b.models, []); assert.ok(!Number.isNaN(Date.parse(b.start))); assert.ok(b.days > 0);
});

for (const [route, key] of [['/api/modes', 'pending'], ['/api/agy-bench', 'models']]) {
  test(`${route} returns 200 with an empty fallback when the harness is absent`, async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}${route}`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.empty, true); assert.equal(j.error, undefined); assert.deepEqual(j[key], []);
  });
}
