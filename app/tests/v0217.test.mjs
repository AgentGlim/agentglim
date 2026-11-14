// v0.2.17 fixes: Windows ~\ paths, async/cheap worker tracking, missing-CLI wording, doctor hint and tool count,
// update wording, harness.json run override, Node listener, /api/setup 502 (v0215-arming test), Setup Save merge.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const tmp = (p = 'ag-v0217-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const py = ['python3', 'python'].find((p) => { try { return spawnSync(p, ['--version'], { stdio: 'ignore' }).status === 0; } catch { return false; } });
// run a snippet in a fresh node with its own HOME/data, so module-level paths are read from that env
const nodeEval = (code, env) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, ...env }, encoding: 'utf8', timeout: 30e3 });
const url = (f) => JSON.stringify(new URL(`file://${path.join(ROOT, f)}`).href);

test('expandHome accepts ~\\ (Windows Setup) and ~/', async () => {
  const { expandHome } = await import('../paths.mjs');
  assert.equal(expandHome('~\\.agentglim-up\\plans', 'C:\\Data\\me'), 'C:\\Data\\me\\.agentglim-up\\plans');
  assert.equal(expandHome('~/plans', '/h'), '/h/plans');
  assert.equal(expandHome('~', '/h'), '/h');
  assert.equal(expandHome('~other/x', '/h'), '~other/x');
});

test('a saved ~\\ plans path resolves under HOME, not a literal ~ folder; harness.json run override is honoured', () => {
  const home = tmp(), data = path.join(home, 'data'); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'setup.json'), JSON.stringify({ plans: { path: '~\\plansdir' } }));
  const env = { HOME: home, USERPROFILE: home, AGENTGLIM_DATA: data, XDG_CONFIG_HOME: path.join(home, 'cfg') };
  const code = `const p = await import(${url('app/paths.mjs')}); console.log(JSON.stringify({ plans: p.PLANS, run: p.RUN, info: p.pathsInfo() }));`;
  let r = nodeEval(code, env); assert.equal(r.status, 0, r.stderr);
  let j = JSON.parse(r.stdout);
  assert.ok(!j.plans.includes('~'), j.plans); assert.ok(j.plans.startsWith(home));
  fs.mkdirSync(path.join(home, 'cfg', 'agentglim'), { recursive: true });
  fs.writeFileSync(path.join(home, 'cfg', 'agentglim', 'harness.json'), JSON.stringify({ run: '{plans}/custom-run' }));
  r = nodeEval(code + `\nconst s = await import(${url('app/settings.mjs')}); console.log(s.harnessConfig().run);`, env); assert.equal(r.status, 0, r.stderr);
  const [line, cfgRun] = r.stdout.trim().split('\n'); j = JSON.parse(line);
  assert.equal(j.run, path.join(j.plans, 'custom-run')); assert.equal(cfgRun, j.run, 'paths.mjs and settings.mjs agree');
  assert.equal(j.info.configuredRun, j.run); assert.equal(j.info.restartNeeded, false);
});

test('Setup Save merges: unknown and omitted fields (projectIcons, skillPrefixes) survive', () => {
  const home = tmp(), data = path.join(home, 'data'); fs.mkdirSync(data);
  const before = { version: 2, plans: { path: '' }, projectIcons: { alpha: { path: '<circle cx="12" cy="12" r="4"/>', kind: 'devtools' } }, skillPrefixes: { acme: ['acme-'] }, futureField: { keep: 1 } };
  fs.writeFileSync(path.join(data, 'setup.json'), JSON.stringify(before));
  const r = nodeEval(`const s = await import(${url('app/setup.mjs')}); s.saveSetup({ budget: { apiDailyUsd: 3 }, harnesses: { codex: true } }); console.log('ok');`,
    { HOME: home, USERPROFILE: home, AGENTGLIM_DATA: data });
  assert.equal(r.status, 0, r.stderr);
  const after = JSON.parse(fs.readFileSync(path.join(data, 'setup.json'), 'utf8'));
  assert.equal(after.budget.apiDailyUsd, 3);
  assert.deepEqual(after.futureField, { keep: 1 });
  assert.deepEqual(after.skillPrefixes, before.skillPrefixes);
  assert.ok(after.projectIcons.alpha, JSON.stringify(after.projectIcons));
});

test('doctor checks the same tool list scaffold links, and SETUP.md names every one', async () => {
  const { HARNESS_TOOLS } = await import('../harness-tools.mjs');
  const scaffold = fs.readFileSync(path.join(ROOT, 'tools', 'scaffold-harness.mjs'), 'utf8');
  const doctor = fs.readFileSync(path.join(ROOT, 'tools', 'first-run.mjs'), 'utf8');
  assert.match(scaffold, /const tools = HARNESS_TOOLS;/); assert.match(doctor, /const DOCTOR_TOOLS = HARNESS_TOOLS;/);
  const setup = fs.readFileSync(path.join(ROOT, 'SETUP.md'), 'utf8');
  for (const t of HARNESS_TOOLS) { assert.ok(setup.includes(`\`${t}\``), `SETUP.md lists ${t}`); assert.ok(fs.existsSync(path.join(ROOT, 'harness', 'bin', t)), t); }
  assert.match(setup, new RegExp(`${HARNESS_TOOLS.length} tools`));
});

test('doctor tracking hint names the Python that was found', async () => {
  const { trackingFix } = await import('../../tools/first-run.mjs');
  assert.match(trackingFix('python'), /^run `python tools/);
  assert.match(trackingFix('py -3'), /`py -3 tools/);
  assert.match(trackingFix(), /`python3 tools/);
});

test('track() is async, never throws, and names a missing jobs-track command', async () => {
  const { track } = await import('../../harness/bin/worker-launch.mjs');
  const p = track([path.join(tmp(), 'no-such-tracker')], ['start']);
  assert.ok(p instanceof Promise);
  const r = await p; assert.equal(r.id, ''); assert.match(r.error, /not found/);
  const ok = await track([process.execPath, '-e', 'console.log("job-1")'], []); assert.deepEqual(ok, { id: 'job-1', error: '' });
  const slow = await track([process.execPath, '-e', 'setTimeout(()=>{}, 5000)'], [], process.env, 200); assert.match(slow.error, /longer than/);
});

test('worker-launch: a missing CLI is not reported as "jobs-track start failed"', () => {
  const dir = tmp(), pf = path.join(dir, 'p.md'); fs.writeFileSync(pf, 'x');
  const env = { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, TMPDIR: process.env.TMPDIR, JOBS_TRACK_DIR: path.join(dir, 'jobs'),
    AGENTGLIM_JOBS_TRACK: process.execPath, AGENTGLIM_PI_BIN: path.join(dir, 'no-such-pi') };
  const r = spawnSync(process.execPath, [path.join(ROOT, 'harness', 'bin', 'worker-launch.mjs'), 'pi', dir, pf, path.join(dir, 'o'), '5', 'low'], { env, encoding: 'utf8', timeout: 30e3 });
  assert.equal(r.status, 127, r.stderr);
  assert.doesNotMatch(r.stderr, /jobs-track start failed/);
  assert.doesNotMatch(r.stderr, /tracking degraded/);
});

test('jobs-track windows_parent uses one process snapshot, not PowerShell per lookup', { skip: !py && 'no python' }, () => {
  const script = path.join(ROOT, 'tools', 'addons', 'jobs-track.py');
  const code = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location('j', sys.argv[1]); j = importlib.util.module_from_spec(spec); spec.loader.exec_module(j)
calls = {'snap': 0, 'ps': 0}
def snap():
    calls['snap'] += 1
    return {43: 42, 42: 7}
j.windows_parent_table = snap
def no_ps(*a, **k):
    calls['ps'] += 1
    raise AssertionError('powershell called')
j.subprocess.check_output = no_ps
assert j.windows_parent(43) == 42 and j.windows_parent(42) == 7
assert j.windows_parent(99) == 0
assert calls['ps'] == 0, calls
assert calls['snap'] == 2, calls  # one snapshot, one refresh for the unknown pid
print('ok')`;
  const r = spawnSync(py, ['-c', code, script], { encoding: 'utf8', env: { ...process.env, JOBS_TRACK_DIR: tmp() } });
  assert.equal(r.status, 0, r.stderr + r.stdout); assert.match(r.stdout, /ok/);
});

test('auditq-wait.mjs (native Windows listener) prints the same wake-ups as auditq-wait.sh', () => {
  const plans = tmp(), run = path.join(plans, '_run');
  for (const d of ['audit_queue', 'chat_inbox', 'status_ask', 'owner_check', 'watchdog_queue', 'heartbeats', 'bin']) fs.mkdirSync(path.join(run, d), { recursive: true });
  const L = path.join(ROOT, 'harness', 'bin', 'auditq-wait.mjs');
  const go = () => spawnSync(process.execPath, [L], { env: { ...process.env, AGENTGLIM_RUN: run, AGENTGLIM_WAIT_ROUNDS: '1', AGENTGLIM_WAIT_POLL: '0' }, encoding: 'utf8', timeout: 20e3 });
  let r = go(); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), 'NONE (re-arm)');
  assert.ok(fs.existsSync(path.join(run, 'heartbeats', 'auditq-wait'))); assert.ok(fs.existsSync(path.join(run, 'audit_queue', '.alive')));
  fs.writeFileSync(path.join(run, 'chat_inbox', '123.json'), '{}');
  r = go(); assert.match(r.stdout, /^CHAT: 123\.json \(read them/m); assert.match(r.stdout, /chat-write\.mjs/);
  fs.renameSync(path.join(run, 'chat_inbox', '123.json'), path.join(run, 'chat_inbox', '123.done'));
  fs.mkdirSync(path.join(plans, '07-x')); fs.writeFileSync(path.join(plans, '07-x', 'HOLD'), '');
  fs.writeFileSync(path.join(run, 'audit_queue', '07-x__p1.req'), 'role=build\n');
  fs.writeFileSync(path.join(run, 'audit_queue', '08-y__p1.req'), 'role=verify\n');
  r = go(); assert.match(r.stdout, /^PENDING: 08-y__p1 \(verify first: 08-y__p1\)/m);
  assert.ok(fs.existsSync(path.join(run, 'audit_queue', '07-x__p1.decline')), 'HOLD plan declined');
  const noq = spawnSync(process.execPath, [L], { env: { ...process.env, AGENTGLIM_RUN: path.join(plans, 'nope') }, encoding: 'utf8' });
  assert.equal(noq.status, 2); assert.match(noq.stdout, /no audit_queue folder/);
});

test('update wording: no "data folder was not changed" before the chat archive step', () => {
  for (const f of ['tools/update.mjs', 'tools/refresh-integrations.mjs']) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /data folder was not changed/);
  assert.match(fs.readFileSync(path.join(ROOT, 'tools', 'update.mjs'), 'utf8'), /AGENTGLIM_UPDATE_STEP: '1'/);
});

test('waitCommand: node listener on Windows, bash elsewhere', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'paths.mjs'), 'utf8');
  assert.match(src, /win \? 'auditq-wait\.mjs' : 'auditq-wait\.sh'/);
  // the Node listener ships: it is in this checkout (a published export holds only what it ships), and the private
  // release allowlist lists it. public.txt is machine-local and gitignored, so a clone or an export has none.
  assert.ok(fs.existsSync(path.join(ROOT, 'harness', 'bin', 'auditq-wait.mjs')), 'harness/bin/auditq-wait.mjs is shipped');
  const allow = path.join(ROOT, 'public.txt');
  if (fs.existsSync(allow)) assert.match(fs.readFileSync(allow, 'utf8'), /^harness\/bin\/auditq-wait\.mjs\r?$/m);
});
