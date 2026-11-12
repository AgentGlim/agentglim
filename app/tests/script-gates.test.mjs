// node --test app/tests/script-gates.test.mjs : the Status card's script gate fields (owner 2026-11-12). A temp _run with a
// stub bin/modes.mjs stands in for the harness: `show --json` returns a fixture with scriptGates, `request` writes the MODE
// request into the temp mode_queue (the same file shape the real modes.mjs writes). The real harness is never touched.
// The render check drives the page in Chromium when a Playwright install is found (gridwright's), else it is skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PW = [process.env.AGENTGLIM_TEST_PLAYWRIGHT, path.join(os.homedir(), 'dev/projects/gridwright/node_modules/playwright')].filter(Boolean).find((p) => fs.existsSync(p));
const SG = { def: 90, sub: 'claude', label: 'your sessions pause, 5h', script: '~/.claude/scripts/usage_gate.sh', tip: 'Your own Claude Code sessions pause when the 5-hour window reaches this %' };
const SHOW = { at: 1, harness: 'day', reaper: 'on', cloud: 'off', api: 'off', codexApi: 'off', projectCap: 4, declineAt: 85, pending: [], finalAudit: { claude: 'opus', codex: 'sol' },
  subs: { claude: { mode: 'normal', speed: 'normal', agentLimit: { haiku: 8 }, fiveHourGates: { haiku: 75 }, weeklyGates: { haiku: 85 }, windows: ['5h', '7d'] },
    codex: { mode: 'normal', speed: 'normal', agentLimit: { premium: 2 }, fiveHourGates: { premium: 90 }, weeklyGates: { premium: 100 }, windows: ['7d'] },
    go: { mode: 'normal', speed: 'normal', agentLimit: { worker: 8 }, fiveHourGates: { worker: 95 }, weeklyGates: { worker: 95 }, windows: ['5h', '7d'] } },
  canon: { agentLimit: { claude: { haiku: 8 }, codex: { premium: 2 }, go: { worker: 8 } }, usageLimit: { claude: { haiku: 75 }, codex: { premium: 90 }, go: { worker: 95 } }, overnightLimit: {}, weekly: { claude: 85, codex: 100 }, weeklyGate: { claude: { haiku: 85 }, codex: { premium: 100 }, go: { worker: 95 } } },
  scriptGates: { ownerPause5h: { value: 90, ...SG }, ownerPause7d: { ...SG, value: 98, def: 98, label: 'your sessions pause, week' },
    onboardCodexWeek: { value: 87, def: 87, sub: 'codex', label: 'onboard loop stops Codex', script: 'bin/onboard-loop.sh', tip: 'The onboard loop stops picking Codex once the Codex week reaches this %' },
    codexFullAt: { value: 99, def: 99, sub: 'codex', label: 'spend a reset at', script: 'bin/codex-full-wait.sh', tip: 'Spend a Codex reset credit at this weekly %' } } };
const STUB = `import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const [cmd, key, value] = process.argv.slice(2), Q = fileURLToPath(new URL('../mode_queue/', import.meta.url));
if (cmd === 'show') console.log(fs.readFileSync(new URL('./show.json', import.meta.url), 'utf8'));
else if (cmd === 'request') { if (!/^gates\\.[A-Za-z0-9]+$|^[a-z]/.test(key) || !/^\\d{1,3}$|^[a-z]+$/.test(value)) { console.log('invalid'); process.exit(2); }
  fs.mkdirSync(Q, { recursive: true }); const f = Q + Date.now() + '-' + key.replaceAll('.', '-') + '.json';
  fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), key, value, until: null, by: process.argv[process.argv.indexOf('--by') + 1] })); console.log(f); }
else process.exit(2);
`;

function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag sgates-'));
  for (const d of ['data', 'work', 'projects', 'plans/_run/bin']) fs.mkdirSync(`${tmp}/${d}`, { recursive: true });
  fs.writeFileSync(`${tmp}/plans/_run/bin/modes.mjs`, STUB);
  fs.writeFileSync(`${tmp}/plans/_run/bin/show.json`, JSON.stringify(SHOW));
  fs.writeFileSync(`${tmp}/plans/_run/modes.json`, '{}');
  return tmp;
}
async function start(t, tmp) {
  const port = 19372;
  const srv = spawn(process.execPath, ['server.mjs', String(port)], { cwd: APP, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, HOME: tmp, USERPROFILE: tmp, AGENTGLIM_ENV_FILE: path.join(tmp, 'env'),
    AGENTGLIM_DEV: '1', AGENTGLIM_DEV_WRITES: '1', AGENTGLIM_DATA: `${tmp}/data`, AGENTGLIM_WORK: `${tmp}/work`, AGENTGLIM_PROJECTS: `${tmp}/projects`, AGENTGLIM_PLANS: `${tmp}/plans`, AGENTGLIM_RUN: `${tmp}/plans/_run` } });
  let errors = ''; srv.stderr.on('data', (s) => { errors += s; });
  t.after(async () => { srv.kill(); if (srv.exitCode === null) await once(srv, 'exit'); fs.rmSync(tmp, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/api/modes`)).status) return base; } catch {} if (srv.exitCode !== null) break; await new Promise((r) => setTimeout(r, 100)); }
  assert.fail(`server did not start: ${errors}`);
}
const queued = (tmp) => { const d = `${tmp}/plans/_run/mode_queue`; return fs.existsSync(d) ? fs.readdirSync(d).map((f) => JSON.parse(fs.readFileSync(`${d}/${f}`, 'utf8'))) : []; };

test('POST /api/mode accepts gates.* keys and writes a MODE request; bad keys are refused', async (t) => {
  const tmp = fixture(), base = await start(t, tmp);
  const post = (body) => fetch(`${base}/api/mode`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) });
  assert.equal((await (await fetch(`${base}/api/modes`)).json()).scriptGates.ownerPause5h.value, 90, '/api/modes passes scriptGates through');
  let r = await post({ key: 'gates.ownerPause5h', value: '91' }); assert.equal(r.status, 200); assert.equal((await r.json()).queued, true);
  assert.deepEqual(queued(tmp).map((q) => [q.key, q.value, q.by]), [['gates.ownerPause5h', '91', 'status card']]);
  for (const key of ['gates.', 'gates.a/b', 'gates.x;rm', 'scripts.ownerPause5h']) assert.equal((await post({ key, value: '50' })).status, 422, key);
  assert.equal(queued(tmp).length, 1);
});

test('Status card renders the script gate fields per provider and a save queues a request', { skip: !PW && 'no Playwright install found' }, async (t) => {
  const tmp = fixture(), base = await start(t, tmp);
  const { chromium } = createRequire(import.meta.url)(PW);
  let exe; try { exe = chromium.executablePath(); if (!fs.existsSync(exe)) exe = undefined; } catch {}
  if (!exe) { const c = path.join(os.homedir(), '.cache/ms-playwright'); const d = fs.existsSync(c) && fs.readdirSync(c).filter((x) => /^chromium-\d+/.test(x)).sort().pop(); if (d) exe = `${c}/${d}/chrome-linux64/chrome`; }
  const browser = await chromium.launch({ executablePath: exe }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(base); await page.waitForSelector('#stModes input[data-nkey="gates.ownerPause5h"]', { state: 'attached', timeout: 20000 });
  const rows = await page.$$eval('#stModes .mdsub', (subs) => subs.map((s) => [...s.querySelectorAll('input[data-nkey^="gates."]')].map((i) => [i.dataset.nkey, i.value])));
  assert.deepEqual(rows, [[['gates.ownerPause5h', '90'], ['gates.ownerPause7d', '98']], [['gates.onboardCodexWeek', '87'], ['gates.codexFullAt', '99']], []], 'Claude and Codex rows, none for Go');
  assert.equal(await page.$$eval('#stModes [data-gate-follow]', (e) => e.length), 0, 'no supporting text lines (owner 2026-11-12)');
  assert.match(await page.$eval('#stModes .mdsg', (e) => e.dataset.tip), /5-hour window/);
  // the card itself stays hidden without a status digest, so fire the same focusout the save handler listens for
  await page.$eval('#stModes input[data-nkey="gates.codexFullAt"]', (i) => { i.value = '97'; i.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
  for (let i = 0; i < 50 && !queued(tmp).length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(queued(tmp).map((q) => [q.key, q.value]), [['gates.codexFullAt', '97']]);
});
