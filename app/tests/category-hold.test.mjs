import { waitForServerReady } from './helpers/server-ready.mjs';
// node --test app/tests/category-hold.test.mjs : the whole-category pause routes on temp plans dirs, never the real plans.
//   GET /api/category-holds -> status(), POST /api/category-hold {cat, pause} -> pause(cat) / resume(cat).
// The HOLD logic is the harness's _run/bin/category-hold.mjs, copied (read only) into the temp _run/bin; the test is
// skipped when this machine has no harness module. A second server checks the dev copy (writes off) and no module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUN } from '../paths.mjs';

const MOD = path.join(RUN, 'bin', 'category-hold.mjs');
const skip = !fs.existsSync(MOD) && 'harness _run/bin/category-hold.mjs not installed';
const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function fixture(withModule) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cathold-'));
  const w = (f, s) => { fs.mkdirSync(path.dirname(`${tmp}/${f}`), { recursive: true }); fs.writeFileSync(`${tmp}/${f}`, s); };
  for (const d of ['data', 'work', 'projects']) fs.mkdirSync(`${tmp}/${d}`);
  w('plans/categories.json', JSON.stringify({ colors: { Gaming: '#ff7a45', Ops: '#f2c14e' }, plans: { 56: 'Gaming', 57: 'Gaming', 58: 'Gaming', 15: 'Ops' } }));
  for (const d of ['56-game-one', '57-game-two', '58-game-three', '15-ops-one']) w(`plans/${d}/PLAN.md`, `# ${d}\n`);
  w('plans/57-game-two/HOLD', 'owner hold: waiting on art\n');
  if (withModule) w('plans/_run/bin/category-hold.mjs', fs.readFileSync(MOD, 'utf8'));
  else fs.mkdirSync(`${tmp}/plans/_run`, { recursive: true });
  return tmp;
}
async function start(t, tmp, env) {
  const srv = spawn(process.execPath, ['server.mjs', '0'], { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: tmp, USERPROFILE: tmp, AGENTGLIM_ENV_FILE: path.join(tmp, 'env'),
    AGENTGLIM_DEV: '1', AGENTGLIM_DATA: `${tmp}/data`, AGENTGLIM_WORK: `${tmp}/work`, AGENTGLIM_PROJECTS: `${tmp}/projects`, AGENTGLIM_PLANS: `${tmp}/plans`, AGENTGLIM_RUN: `${tmp}/plans/_run`, ...env } });
  t.after(async () => { if (srv.exitCode === null && srv.signalCode === null) { srv.kill(); await once(srv, 'exit'); } fs.rmSync(tmp, { recursive: true, force: true }); });
  const port = await waitForServerReady(srv);
  return `http://127.0.0.1:${port}`;
}

test('category pause routes: status, same-origin, validation, pause keeps owner HOLDs, resume lifts only its own; dev copy blocks', { skip }, async (t) => {
  const tmp = fixture(true), base = await start(t, tmp, { AGENTGLIM_DEV_WRITES: '1' }), P = `${tmp}/plans`;
  const get = async () => { const r = await fetch(`${base}/api/category-holds`); assert.equal(r.status, 200); return (await r.json()).find((x) => x.cat === 'Gaming'); };
  const post = (body, origin = base) => fetch(`${base}/api/category-hold`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
  const hold = (d) => { try { return fs.readFileSync(`${P}/${d}/HOLD`, 'utf8'); } catch { return null; } };

  let g = await get();
  assert.deepEqual(g.members, ['56-game-one', '57-game-two', '58-game-three']);
  assert.deepEqual(g.held, ['57-game-two']); assert.equal(g.paused, false);

  assert.equal((await post({ cat: 'Gaming', pause: true }, 'http://evil.test')).status, 403);
  assert.equal(hold('56-game-one'), null, 'a cross-origin POST writes nothing');
  assert.equal((await post({ cat: 'Gaming' })).status, 422, 'pause must be true or false');
  assert.equal((await post({ cat: '../x', pause: true })).status, 422);
  assert.equal((await post({ cat: 'Nope', pause: true })).status, 422, 'unknown category');

  let r = await post({ cat: 'Gaming', pause: true }); assert.equal(r.status, 200);
  let j = await r.json(); assert.deepEqual(j.wrote, ['56-game-one', '58-game-three']); assert.deepEqual(j.kept, ['57-game-two']);
  assert.match(hold('56-game-one'), /^category:Gaming /); assert.equal(hold('57-game-two'), 'owner hold: waiting on art\n');
  assert.equal(hold('15-ops-one'), null, 'other categories untouched');
  g = await get(); assert.equal(g.paused, true); assert.ok(!Number.isNaN(Date.parse(g.since)));
  assert.deepEqual(g.categoryHeld, ['56-game-one', '58-game-three']); assert.equal(g.held.length - g.categoryHeld.length, 1);
  const row = (await (await fetch(`${base}/api/snapshot`)).json()).projects.find((p) => p.dir === '56-game-one');
  assert.match(row?.held || '', /^category:Gaming /, 'the snapshot row carries the category HOLD right away');

  r = await post({ cat: 'Gaming', pause: false }); assert.equal(r.status, 200);
  j = await r.json(); assert.deepEqual(j.lifted, ['56-game-one', '58-game-three']); assert.deepEqual(j.kept, ['57-game-two']);
  assert.equal(hold('56-game-one'), null); assert.ok(fs.readdirSync(`${P}/56-game-one/_archive`).some((f) => f.startsWith('HOLD.category-Gaming-')), 'archived, not deleted');
  assert.equal(hold('57-game-two'), 'owner hold: waiting on art\n');
  g = await get(); assert.equal(g.paused, false); assert.deepEqual(g.categoryHeld, []);

  // the dev copy (writes off) refuses the POST; a harness without the module gets [] (no buttons) from GET
  const tmp2 = fixture(false), dev = await start(t, tmp2, {});
  assert.equal((await fetch(`${dev}/api/category-hold`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"cat":"Gaming","pause":true}' })).status, 403);
  assert.equal(fs.existsSync(`${tmp2}/plans/56-game-one/HOLD`), false);
  assert.deepEqual(await (await fetch(`${dev}/api/category-holds`)).json(), []);
});
