import { waitForServerReady } from './helpers/server-ready.mjs';
// The status digest carries done plans that last moved 1-7 days ago (olderDone), so the page's day window can
// widen the plan table; plans moved in the last 24 h, live and held rows stay in `plans` as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { plansInWindow } from '../finished.mjs';

const pad = (n) => String(n).padStart(2, '0');
const stamp = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }; // driver.log is local time

for (const eol of ['\n', '\r\n']) test(`digest (${JSON.stringify(eol)}): done plans 1-7 days old go to olderDone and widen the table at 2 and 7 days`, async (t) => {
  const now = Date.now(), H = 3600e3;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-finished-window-'));
  const write = (file, content) => { const f = path.join(home, file); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content)); };
  write('env', ''); write('harness.json', '{}'); write('data/setup.json', {}); write('data/integrations.json', {});
  const plans = { '01-fresh': ['done', 2], '02-yesterday': ['done', 30], '03-three-days': ['done', 72], '04-old': ['done', 200], '05-held': ['v1-r1', 30] };
  const projects = {}, log = [];
  for (const [dir, [stage, hAgo]] of Object.entries(plans)) {
    write(`plans/${dir}/PLAN.md`, `# ${dir}\n`);
    projects[dir] = { stage, stages: [] };
    log.push([now - hAgo * H, stage === 'done' ? `advance ${dir} v1-verify -> done (ok)` : `launch ${dir} v1-r1 worker`]);
  }
  write('plans/05-held/HOLD', 'held for the test\n');
  write('plans/_run/state.json', { projects });
  write('plans/_run/driver.log', log.sort((a, b) => a[0] - b[0]).map(([t, x]) => `${stamp(t)} ${x}`).join(eol) + eol);
  // CIM process enumeration can exceed five seconds on a cold Windows runner.
  // Delay the LF fixture past the old deadline on every OS to keep this covered.
  const delay = eol === '\n' ? 6000 : 0;
  const script = `process.argv[2] = '0'; await new Promise(r => setTimeout(r, ${delay})); await import('./app/server.mjs');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: path.resolve(import.meta.dirname, '../..'), env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, AGENTGLIM_DATA: path.join(home, 'data'), AGENTGLIM_ENV_FILE: path.join(home, 'env'), AGENTGLIM_CONFIG: path.join(home, 'harness.json'), AGENTGLIM_PROJECTS: home, AGENTGLIM_PLANS: path.join(home, 'plans'), AGENTGLIM_DEV: '1',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', (s) => { errors += s; });
  t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, 'exit'); fs.rmSync(home, { recursive: true, force: true }); });
  const port = await waitForServerReady(child);
  const s = await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json();
  assert.ok(s?.statusDigest, `isolated server gave no digest: ${errors}`);
  const d = s.statusDigest;
  assert.deepEqual(d.plans.map((p) => p.dir), ['01-fresh'], 'plans: moved in the last 24 h (unchanged rule)');
  assert.deepEqual(d.olderDone.map((p) => p.dir), ['02-yesterday', '03-three-days'], 'olderDone: done, 1-7 days old, newest first; no held, nothing past 7 days');
  assert.ok(d.olderDone.every((p) => p.state === 'done' && p.last?.t && p.doneAt));
  assert.equal(d.tally.done24, 1, 'the server tally still counts 24 h');
  const rows = (n) => plansInWindow(d.plans, d.olderDone, d.at, n).map((p) => p.dir);
  assert.deepEqual(rows(1), ['01-fresh']);
  assert.deepEqual(rows(2), ['01-fresh', '02-yesterday']);
  assert.deepEqual(rows(7), ['01-fresh', '02-yesterday', '03-three-days']);
  assert.deepEqual(d.finished.map((f) => f.dir), ['01-fresh', '02-yesterday', '03-three-days'], 'the strip has the same 7-day set');
});
