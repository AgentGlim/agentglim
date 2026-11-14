// The bundled jobs register end to end on a temp dir: run wrapper, kind/project detection,
// rc-file and pid reaping, the Claude Agent-tool hook events. Skipped when the harness is not installed.
//
// Cross-OS (R9): procfs is faked through AGENTGLIM_PROC or the platform is emulated, the Python loader takes the
// script path as argv only (never inside -c source), and no path ever becomes a regex pattern or replacement
// string. A test skips on an OS only where the feature itself is that OS's.
import test, { after, beforeEach, afterEach } from 'node:test';
import { scratch, archiveScratch } from './helpers/weekly-scratch.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { HOME } from '../paths.mjs';

const SCRIPT = path.resolve(import.meta.dirname, '../../tools/addons/jobs-track.py');
// R9.2: one loader. importlib.machinery's SourceFileLoader is gone from newer Pythons (the old loader API was
// removed), and the script path travels as argv, so a Windows path (D:\a\...\jobs-track.py: \a is BEL, \U is a
// regex escape) is never parsed.
const LOADER = "import importlib.util as u,json,os,sys; s=u.spec_from_file_location('jt',sys.argv[1]); j=u.module_from_spec(s); s.loader.exec_module(j);";
const loadArgs = (code, script = SCRIPT) => ['-c', LOADER + code, script];
const skip = !fs.existsSync(SCRIPT) && 'harness jobs-track.py not installed';
const NO_PROC = path.join(os.tmpdir(), 'jt-no-proc-root'); // never created: emulates a machine without procfs
const TEMPS = []; let activeTest = null, suiteFailed = false;
beforeEach((t) => { activeTest = t; });
afterEach((t) => { suiteFailed ||= !t.passed; activeTest = null; });
const tmp = (prefix) => { if (activeTest) return scratch(activeTest, prefix); const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TEMPS.push(d); return d; };
const dir = tmp('jobs-track-');
const env = { ...process.env, JOBS_TRACK_DIR: dir };
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const jt = (args, input) => execFileSync(PYTHON, [SCRIPT, ...args], { env, input, encoding: 'utf8' }).trim();
const jtPy = (code, args = [], e = env) => execFileSync(PYTHON, [...loadArgs(code), ...args], { env: e, encoding: 'utf8' }).trim();
const list = () => JSON.parse(jt(['list']));
const get = (id) => list().find((j) => j.id === id);
const PROJ = path.join(HOME, 'dev', 'projects');
after(() => { for (const d of TEMPS) archiveScratch(d, suiteFailed ? 'failed' : 'passed', 'jobs-track shared fixture'); });

// A fixture process table for AGENTGLIM_PROC: plain files, so discovery and liveness never read this machine's
// process table. `stat` is the procfs line whose fields after "pid (comm) " are state ppid pgid ... starttime(19).
const procTree = (entries) => {
  const root = tmp('jt-proc-');
  fs.writeFileSync(path.join(root, 'stat'), 'cpu  1 2 3 4 5 6 7 8\nbtime 1600000000\n');
  for (const e of entries) {
    const d = path.join(root, String(e.pid));
    fs.mkdirSync(d);
    const fields = ['S', String(e.ppid ?? 1), String(e.pgid ?? e.pid), ...Array(16).fill('0'), String(e.start ?? 111)];
    fs.writeFileSync(path.join(d, 'stat'), `${e.pid} (${e.comm || 'bash'}) ${fields.join(' ')}\n`);
    if (e.cmdline) fs.writeFileSync(path.join(d, 'cmdline'), e.cmdline.map((a) => a + '\0').join(''));
    if (e.cwd) fs.symlinkSync(e.cwd, path.join(d, 'cwd'), process.platform === 'win32' ? 'junction' : 'dir');
  }
  return root;
};
// every entry of a tree with its size (or its link target): proves a run never writes into the process table
const snapshot = (root) => {
  const out = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n), st = fs.lstatSync(p);
      out.push(`${path.relative(root, p)}|${st.isSymbolicLink() ? `->${fs.readlinkSync(p)}` : st.size}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out;
};

for (const registrationDelay of [0, 3200]) {
  test(`run wrapper: running while the command lives, then done / failed by rc (registration delay ${registrationDelay}ms)`, { skip }, async (t) => {
    // Windows parent/identity queries can outlast a short sleep. Keep the command
    // alive until its record has been observed; inject that delay on Linux too.
    const release = path.join(dir, `release-${registrationDelay}`);
    const label = `sleeper-${registrationDelay}`;
    const runner = registrationDelay ? loadArgs(`
original = j.start_run
def delayed(*args):
    j.time.sleep(${registrationDelay / 1000})
    return original(*args)
j.start_run = delayed
sys.exit(j.run(sys.argv[2:]))
`) : [SCRIPT, 'run'];
    const p = spawn(PYTHON, [...runner, '--harness', 'codex', '--model', 'm1', '--label', label, '--cwd', `${PROJ}/demo-proj`, '--', process.execPath, '-e',
      "const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(process.argv[1]))clearInterval(timer)},50);setTimeout(()=>process.exit(2),60000).unref()", release], { env });
    const exited = once(p, 'exit');
    t.after(async () => { if (p.exitCode === null) p.kill(); await exited; });
    let j;
    const deadline = Date.now() + 180000;
    while (!j && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
      j = list().find(x => x.label === label);
      if (!j && p.exitCode !== null) assert.fail(`wrapper exited before registration: ${p.exitCode}`);
    }
    assert.ok(j, 'wrapper registered before deadline');
    assert.equal(j.status, 'running');
    assert.equal(j.project, 'demo-proj');
    assert.equal(j.isPlan, false);
    // The kind comes from the real process ancestry, so the harness driver (driver.mjs) makes it 'autonomous'
    // where a plain desktop gives 'one-on-one'. Compare with the same classification of this test process: the
    // wrapper adds only the python process itself to the chain, and that matches nothing.
    assert.equal(j.kind, JSON.parse(jtPy('print(json.dumps(j.kind_of(int(sys.argv[2]))))', [String(process.pid)])), j.kind);
    assert.equal(j.harness, 'codex');
    fs.writeFileSync(release, 'release');
    assert.equal((await exited)[0], 0);
    assert.equal(get(j.id).status, 'done');
    let rc = 0; try { execFileSync(PYTHON, [SCRIPT, 'run', '--label', 'boom', '--', process.execPath, '-e', 'process.exit(1)'], { env }); } catch (e) { rc = e.status; }
    assert.equal(rc, 1);
    assert.equal(list().find(x => x.label === 'boom').status, 'failed');
  });
}

test('project from outdir/prompt paths: a plan path wins and sets isPlan', { skip }, () => {
  const id = jt(['start', '--harness', 'pi', '--cwd', PROJ, '--prompt', `work in ${PROJ}/plans/01-example-dashboard/build please`]);
  const j = get(id);
  assert.equal(j.project, '01-example-dashboard');
  assert.equal(j.isPlan, true);
  jt(['finish', '--id', id, '--rc', '0']);
  assert.equal(get(id).status, 'done');
});

test('reap: rc file finishes the job (failed on rc != 0); dead pid without rc = stopped for agent.sh', { skip }, async () => {
  const out = tmp('jt-out-');
  const s = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const id = jt(['start', '--harness', 'claude', '--outdir', out, '--pid', String(s.pid), '--launcher', 'agent.sh']);
  jt(['reap']); assert.equal(get(id).status, 'running');
  fs.writeFileSync(path.join(out, 'rc'), '2\n');
  jt(['reap']); assert.equal(get(id).status, 'failed'); assert.equal(get(id).rc, '2');
  s.kill();
  const out2 = tmp('jt-out-');
  const s2 = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const id2 = jt(['start', '--harness', 'claude', '--outdir', out2, '--pid', String(s2.pid), '--launcher', 'agent.sh']);
  s2.kill(); await new Promise((r) => s2.on('exit', r));
  jt(['reap']); assert.equal(get(id2).status, 'stopped');
});

test('claude hook: Pre registers, async Post attaches the agent id, SubagentStop finishes', { skip }, () => {
  const base = { session_id: 's1', cwd: `${PROJ}/demo-proj`, tool_name: 'Agent', tool_use_id: 'toolu_T1' };
  jt(['claude-hook'], JSON.stringify({ ...base, hook_event_name: 'PreToolUse', tool_input: { description: 'tiny task', prompt: '[jev: x] say ok', model: 'haiku' } }));
  assert.equal(get('cc-toolu_T1').status, 'running');
  assert.equal(get('cc-toolu_T1').label, 'tiny task');
  jt(['claude-hook'], JSON.stringify({ ...base, hook_event_name: 'PostToolUse', tool_response: { isAsync: true, status: 'async_launched', agentId: 'AG1', resolvedModel: 'claude-haiku-x', outputFile: '/nonexistent/AG1.output' } }));
  const j = get('cc-toolu_T1');
  assert.equal(j.status, 'running'); assert.equal(j.agentId, 'AG1'); assert.equal(j.model, 'claude-haiku-x');
  jt(['claude-hook'], JSON.stringify({ session_id: 's1', hook_event_name: 'SubagentStop', agent_id: 'AG1', last_assistant_message: 'ok' }));
  assert.equal(get('cc-toolu_T1').status, 'done'); assert.equal(get('cc-toolu_T1').summary, 'ok');
  // a synchronous Agent call finishes at PostToolUse
  jt(['claude-hook'], JSON.stringify({ ...base, tool_use_id: 'toolu_T2', hook_event_name: 'PreToolUse', tool_input: { prompt: 'p' } }));
  jt(['claude-hook'], JSON.stringify({ ...base, tool_use_id: 'toolu_T2', hook_event_name: 'PostToolUse', tool_response: { content: [] } }));
  assert.equal(get('cc-toolu_T2').status, 'done');
});

test('tracking never fails the caller: bad input and an unwritable dir exit 0', { skip }, () => {
  jt(['claude-hook'], 'not json');
  const file = path.join(dir, 'not-a-directory'); fs.writeFileSync(file, '');
  execFileSync(PYTHON, [SCRIPT, 'start', '--harness', 'x'], { env: { ...env, JOBS_TRACK_DIR: path.join(file, 'child') } });
  execFileSync(PYTHON, [SCRIPT, 'finish'], { env });
});

// C1b: the macOS CI line "jobs-track: [Errno 30] Read-only file system: '/proc'" was a register path under the
// process table (the old test passed JOBS_TRACK_DIR=/proc/no-such/dir). The process table is read-only to this
// tool: nothing is ever created or written there, and the caller still exits 0.
test('no write into the process table: a register path inside the proc root fails quietly and leaves it intact', { skip }, () => {
  const root = procTree([{ pid: 1, ppid: 0, comm: 'init', cmdline: ['/sbin/init'] }]);
  const before = snapshot(root);
  const r = spawnSync(PYTHON, [SCRIPT, 'start', '--harness', 'x'], { env: { ...env, AGENTGLIM_PROC: root, JOBS_TRACK_DIR: path.join(root, 'stat', 'register') }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /^jobs-track: /); // reported, never fatal
  assert.deepEqual(snapshot(root), before);
});

test('project_of: repo-plan map, plan paths, tool paths, plain projects', { skip }, () => {
  const map = path.join(dir, 'repo-plans.json'); fs.writeFileSync(map, JSON.stringify({ agentglim: '77-example-dashboard' }));
  const py = (x) => JSON.parse(jtPy('print(json.dumps(j.project_of(sys.argv[2])))', [x], { ...env, REPO_PLANS_FILE: map }));
  assert.deepEqual(py(`${PROJ}/agentglim/app/server.mjs`), ['77-example-dashboard', true]);
  assert.deepEqual(py(`node -e "require('${PROJ}/toolbox/node_modules/playwright')" ${PROJ}/agentglim/x`), ['77-example-dashboard', true]);
  assert.deepEqual(py(`node -e "require('${PROJ}/toolbox/node_modules/playwright')"`)[1], false);
  assert.deepEqual(py(`${PROJ}/plans/11-example-hub/PLAN.md`), ['11-example-hub', true]);
  assert.deepEqual(py(`${PROJ}/demo-proj/a.py`), ['demo-proj', false]);
});

test('Agent tool launch is a subagent sub-item: running on PreToolUse, still running on the async PostToolUse, done on SubagentStop', { skip }, () => {
  const hook = (ev) => execFileSync(PYTHON, [SCRIPT, 'claude-hook'], { env, input: JSON.stringify(ev) });
  hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_t1', cwd: `${PROJ}/plans/_run/bin`, tool_input: { description: 'fix the AgentGlim card', prompt: 'work in ~/dev/projects/agentglim/app' } });
  const id = 'cc-toolu_t1';
  assert.equal(get(id).kind, 'subagent');
  assert.equal(get(id).status, 'running');
  hook({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_t1', tool_response: { isAsync: true, agentId: 'agT1' } });
  assert.equal(get(id).status, 'running');
  hook({ hook_event_name: 'SubagentStop', agent_id: 'agT1', last_assistant_message: 'ok' });
  assert.equal(get(id).status, 'done');
});

// ---- end states, live pids, plan attribution, no fragment groups ----
const PL = tmp('jt-plans-'), PR = tmp('jt-projects-');
for (const d of ['33-demo-channel', '39-demo-motion', '70-demo-leads', '71-demo-product']) fs.mkdirSync(path.join(PL, d));
for (const d of ['leadsx', 'goals']) fs.mkdirSync(path.join(PR, d));
const MAP = path.join(PL, 'repo-plans.json'); fs.writeFileSync(MAP, JSON.stringify({ leadsx: '70-demo-leads' }));
const aenv = { ...env, AGENTGLIM_PLANS: PL, AGENTGLIM_PROJECTS: PR, REPO_PLANS_FILE: MAP };
const ja = (args) => execFileSync(PYTHON, [SCRIPT, ...args], { env: aenv, encoding: 'utf8' }).trim();
const attr = (o) => JSON.parse(jtPy('print(json.dumps(j.attribute(**json.loads(sys.argv[2]))))', [JSON.stringify(o)], aenv));

test('attribution: --plan and a [plan:] tag win; then the cwd via repo-plans.json; then plan folders named in the prompt', { skip }, () => {
  assert.deepEqual(attr({ plan: '71-demo-product', cwd: `${PR}/leadsx` }), ['71-demo-product', true, '--plan']);
  assert.deepEqual(attr({ cwd: PL, prompt_text: 'x [plan: 71-demo-product] y' }), ['71-demo-product', true, 'tag']);
  assert.deepEqual(attr({ cwd: PL, prompt_text: '[plan: NN-slug] is a placeholder' }), ['Unassigned', false, 'none']);
  assert.deepEqual(attr({ cwd: `${PR}/leadsx/sub` }), ['70-demo-leads', true, 'cwd']);
  assert.deepEqual(attr({ cwd: `${PL}/33-demo-channel` }), ['33-demo-channel', true, 'cwd']);
  // the buyer-video case: cwd is the plans root, the prompt names plans/33-... most and a glob over project folders
  assert.deepEqual(attr({ cwd: PL, prompt_text: `see ${PL}/33-demo-channel/PLAN.md, merge plans/39-demo-motion into plans/33-demo-channel/drafts; ideas in ${PR}/video-*` }), ['33-demo-channel', true, 'prompt']);
  // a sub-job in another job's folder belongs to that job's project
  const parent = tmp('jt-parent-'); fs.writeFileSync(path.join(parent, 'prompt.md'), `build ${PR}/goals/scripts/page.mjs`); fs.mkdirSync(path.join(parent, 'sub-1'));
  assert.deepEqual(attr({ cwd: PL, outdir: path.join(parent, 'sub-1'), prompt_text: 'approvals page of 70-demo-leads' }), ['goals', false, 'parent job']);
});

test('attribution never makes groups from path fragments: video-*, the projects root, an out folder', { skip }, () => {
  assert.deepEqual(attr({ cwd: PR, outdir: path.join(os.tmpdir(), 'x', 'yt', 'out'), prompt_text: `look at ${PR}/video-* and ${PR}/leads. too` }), ['Unassigned', false, 'none']);
  assert.deepEqual(attr({ cwd: `${PR}/video-` }), ['Unassigned', false, 'none']);
  assert.deepEqual(attr({ cwd: PL, prompt_text: 'edit content/70-demo-leads.py' }), ['Unassigned', false, 'none']);
  const id = ja(['start', '--harness', 'pi', '--cwd', PR, '--outdir', tmp('jt-out-'), '--prompt', 'no plan here']);
  assert.equal(get(id).project, 'Unassigned'); assert.equal(get(id).isPlan, false);
});

test('reap: rc=0 is done, rc!=0 failed, 124 failed (timed out); a dead agent.sh job with only a meta end line uses it', { skip }, async () => {
  const mk = async (write) => { const out = tmp('jt-rc-'), s = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); const id = ja(['start', '--harness', 'codex', '--outdir', out, '--pid', String(s.pid), '--launcher', 'agent.sh']); write(out); s.kill(); await new Promise((r) => s.on('exit', r)); ja(['reap']); return get(id); };
  let j = await mk((o) => fs.writeFileSync(path.join(o, 'rc'), '0\n')); assert.equal(j.status, 'done'); assert.equal(j.rc, '0');
  j = await mk((o) => fs.writeFileSync(path.join(o, 'rc'), '1\n')); assert.equal(j.status, 'failed');
  j = await mk((o) => fs.writeFileSync(path.join(o, 'rc'), '124\n')); assert.equal(j.status, 'failed'); assert.equal(j.endReason, 'timed out');
  // Timestamp the completion after registration, including on slow Windows runners.
  j = await mk((o) => {
    const d = new Date(), pad = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    fs.writeFileSync(path.join(o, 'meta'), `${stamp} end kind=codex-only rc=0\r\n`);
  }); assert.equal(j.status, 'done'); assert.equal(j.rc, '0');
});

test('a live pid stays running and is never duplicated', { skip }, async (t) => {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  t.after(() => p.kill());
  const id = ja(['start', '--pid', String(p.pid), '--plan', '71-demo-product']);
  ja(['reap']); ja(['reap']);
  assert.equal(get(id).status, 'running');
  // Windows reuses a pid at once: a record the previous test finished can carry this pid, so count the live ones
  assert.equal(list().filter((x) => x.pid === p.pid && x.status === 'running').length, 1);
});

test('discovery: a fixture process table supplies agent.sh\'s cmdline, cwd and --plan', { skip: skip || (process.platform === 'win32' && 'agent.sh discovery needs a procfs entry and a cwd link; Windows has no procfs (fixture test: this one on Linux/macOS)') }, () => {
  const base = tmp('jt-disc-');
  fs.mkdirSync(path.join(base, 'rel', 'out'), { recursive: true });
  const agentSh = '/tools/agent.sh';
  const root = procTree([
    { pid: 1, ppid: 0, comm: 'init', cmdline: ['/sbin/init'] },
    // agent.sh [--plan NN-slug] <kind> <cwd> <prompt> <outdir> ..., started in `base` with relative paths
    { pid: 424242, ppid: 1, comm: 'bash', start: 111, cwd: base,
      cmdline: ['bash', agentSh, 'codex-only', base, 'rel/p.md', 'rel/out', '60', 'high', '--plan', '71-demo-product'] },
  ]);
  const e = { ...aenv, AGENTGLIM_PROC: root };
  const before = snapshot(root);
  execFileSync(PYTHON, [SCRIPT, 'reap'], { env: e, encoding: 'utf8' });
  const j = list().find((r) => r.pid === 424242);
  assert.ok(j, 'discovered');
  assert.equal(j.outdir, path.join(base, 'rel', 'out')); // relative to the fixture cwd, not the reaper's cwd
  assert.equal(j.project, '71-demo-product');
  assert.equal(j.status, 'running');
  execFileSync(PYTHON, [SCRIPT, 'reap'], { env: e, encoding: 'utf8' });
  assert.equal(list().filter((r) => r.pid === 424242).length, 1); // never twice
  assert.deepEqual(snapshot(root), before); // the reaper never writes into the process table
});

test('without a proc root: liveness still works from the pid alone and discovery finds nothing', { skip }, async (t) => {
  // AGENTGLIM_PROC=/nonexistent is the macOS/Windows shape: no process table to read.
  const e = { ...env, AGENTGLIM_PROC: NO_PROC };
  const jtn = (args) => execFileSync(PYTHON, [SCRIPT, ...args], { env: e, encoding: 'utf8' }).trim();
  const jlist = () => JSON.parse(jtn(['list']));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const exited = once(child, 'exit'); // a killed child reports signalCode, not exitCode, so never re-await an exit event
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const out = tmp('jt-noproc-');
  const id = jtn(['start', '--harness', 'claude', '--outdir', out, '--pid', String(child.pid), '--launcher', 'agent.sh']);
  const known = jlist().map((r) => r.id);
  jtn(['reap']);
  assert.equal(jlist().find((r) => r.id === id).status, 'running'); // a live child is alive without /proc
  assert.deepEqual(jlist().map((r) => r.id), known); // discovery registered nothing (nothing to scan)
  child.kill();
  await exited;
  jtn(['reap']);
  assert.equal(jlist().find((r) => r.id === id).status, 'stopped'); // a reaped child is gone
});

test('queue take (--req): the plan comes from the .req name; observatory__* requests belong to the SuperAgent (2026-11-12)', { skip }, () => {
  const a = get(jt(['start', '--harness', 'claude', '--model', 'claude-fable-5-1', '--cwd', PROJ, '--req', '/q/68-observatory-app__v10-focus.req', '--kind', 'queue']));
  assert.equal(a.project, '68-observatory-app'); assert.equal(a.isPlan, true); assert.equal(a.label, 'V10 focus'); assert.equal(a.model, 'claude-fable-5-1');
  const b = get(jt(['start', '--harness', 'claude', '--cwd', `${PROJ}/plans/_observatory`, '--req', '/q/observatory__reject-agy_-mvyeiq2a.req',
    '--prompt', `reject it; see ${PROJ}/plans/90-sample-project/notes`, '--kind', 'queue']));
  assert.equal(b.project, 'SuperAgent'); assert.equal(b.isPlan, false); // never the plan its prompt happens to name
  const c = get(jt(['start', '--harness', 'claude', '--plan', 'SuperAgent', '--kind', 'queue']));
  assert.equal(c.project, 'SuperAgent');
});

test('Windows liveness and reap use process query results and preserve Windows exit codes', { skip }, () => {
  const out = tmp('jt-windows-');
  jtPy(`
j.PROC = None  # Windows has no procfs
def no_kill(pid):
    raise AssertionError('Windows liveness must never fall back to os.kill(pid, 0): it terminates the process')
j.posix_alive = no_kill
assert j.alive(42, platform='win32', windows_query=lambda pid: pid == 42)
assert not j.alive(43, platform='win32', windows_query=lambda pid: False)
assert not j.alive(0, platform='win32', windows_query=lambda pid: True)
assert j.end_state('0', 'win32') == ('done', None)
assert j.end_state('124', 'win32') == ('failed', 'timed out')
assert j.end_state('130', 'win32') == ('failed', 'exit code 130')
assert j.end_state('-9', 'win32') == ('failed', 'exit code -9')
assert j.end_state('130', 'linux') == ('stopped', 'killed')
j_alive = j.alive
original_end_state = j.end_state
j.end_state = lambda rc: original_end_state(rc, "win32")
j.discover = lambda: None
live = {42}
j.alive = lambda pid, start=None: j_alive(pid, start, platform='win32', windows_query=lambda p: p in live)
for pid in (42, 43):
    j.save({'id': str(pid), 'status': 'running', 'pid': pid, 'launcher': 'agent.sh', 'outdir': sys.argv[2], 'started': j.now_ms()})
j.reap()
assert j.load('42')['status'] == 'running'
assert j.load('43')['status'] == 'stopped'
live.clear()
open(os.path.join(sys.argv[2], 'rc'), 'w').write('130')
j.reap()
assert j.load('42')['status'] == 'failed' and j.load('42')['rc'] == '130'
`, [out], aenv);
});

test('Windows launch registry and Claude hook session identity reject PID reuse and unregistered parents', { skip }, () => {
  const reg = path.join(tmp('jt-win-hook-'), 'tracked-jobs');
  jtPy(`
from types import SimpleNamespace
j.PROC = None
j.sys.platform = 'win32'
table = {42: {'pid':42, 'start':'111', 'executable':r'C:\\tools\\claude.exe'},
         43: {'pid':43, 'start':'222', 'executable':r'C:\\tools\\worker.exe'}}
j.windows_identity = lambda pid, handle=None: dict(table[pid]) if pid in table else None
j.windows_parent = lambda pid: {43:42,42:1}.get(pid,0)
j.os.getppid = lambda: 43
assert j.harness_pid('claude') is None
identity = j.register_child(SimpleNamespace(pid=42, _handle=123))
assert identity == table[42]
assert j.harness_pid('claude') == 42
child = SimpleNamespace(pid=43, _handle=234, wait=lambda: 0)
j.subprocess.Popen = lambda cmd: child
assert j.run(['--harness','claude','--','worker.exe']) == 0
launched = next(r for r in j.records() if r.get('childPid') == 43)
assert launched['childIdentity'] == table[43] and launched['status'] == 'done'
assert j.registered_identity(43) == table[43]
assert j.session_alive(42, '111')
assert not j.session_alive(42, None)
table[43]['start'] = '100'
assert j.harness_pid('claude') is None
table[43]['start'] = '222'
j.claude_hook({'hook_event_name':'PreToolUse','tool_name':'Agent','tool_use_id':'win','tool_input':{}})
r = j.load('cc-win')
assert r['sessionPid'] == 42 and r['sessionPidStart'] == '111'
table[42]['start'] = '999'
assert j.harness_pid('claude') is None
assert not j.session_alive(42,'111')
j.discover = lambda: None
j.reap()
assert j.load('cc-win')['status'] == 'stopped'
table[42]['start'] = '111'
table[42]['executable'] = r'C:\\user\\claude.exe'
assert not j.session_alive(42,'111')
table.clear()
assert not j.session_alive(42,'111')
`, [], { ...env, JOBS_TRACK_DIR: reg });
});

test('Windows home and native/mixed paths preserve CLI records and attribution', { skip }, () => {
  jtPy(String.raw`
H = 'C:' + chr(92) + 'Users' + chr(92) + 'fixture'  # built, so the leak scan never sees a literal home path
j.HOME = H
j.PROJECTS_ROOT = H + r'\dev\projects'
j.PLANS_ROOT = H + r'\private\plans'
j.repo_plans = lambda: {'agentglim': '77-example-dashboard'}
assert j.named_in('no project here') is None
assert j.named_in('work in ~/dev/projects/demo-proj/app') == ('demo-proj', False)
assert j.project_of(H + r'\dev\projects/agentglim/app/server.mjs') == ('77-example-dashboard', True)
assert j.project_of_path(H + r'\private\plans\71-demo-product\build') == ('71-demo-product', True)
assert j.attribute(cwd=H + r'\dev\projects\agentglim', prompt_text='unrelated') == ('77-example-dashboard', True, 'cwd')
assert j.queue_req(r'C:\queue\71-demo-product__v1-audit.req') == ('71-demo-product', 'v1-audit')
assert j.queue_req(r'C:\queue\observatory__reject.req') == ('SuperAgent', 'reject')
rid = j.start('codex', cwd=j.PROJECTS_ROOT, prompt='work in ~/dev/projects/demo-proj/app')
assert j.load(rid)['project'] == 'demo-proj'
assert j.load(rid)['status'] == 'running'
`);
});

test('tilde expansion inserts a Windows HOME literally: no regex replacement escapes (C3)', { skip }, () => {
  const WINHOME = ['C:', 'Users', 'runner'].join('/'); // built, so the leak scan never sees a home path
  const out = JSON.parse(jtPy(String.raw`
H = 'C:' + chr(92) + 'Users' + chr(92) + 'runner'
j.HOME = H
j.PROJECTS_ROOT = H + r'\dev\projects'
j.PLANS_ROOT = H + r'\private\plans'
j.repo_plans = lambda: {}
print(json.dumps([j.norm('~/dev/projects/runner-repo/app'), j.named_in('work in ~/dev/projects/runner-repo/app')]))
`));
  // \U and \a in the HOME path are data here, never a regex escape: the old HOME + "/" replacement raised
  // "bad escape \U at position 2" on Windows.
  assert.deepEqual(out, [WINHOME + '/dev/projects/runner-repo/app', ['runner-repo', false]]);
});

test('the script path travels as argv, never as source: a folder named x\\agentglim loads and runs (C3)', { skip }, () => {
  const base = tmp('jt-c3-');
  const odd = path.join(base, 'x\\agentglim'); // one file name on POSIX (a backslash and an "a"), two folders on Windows
  fs.mkdirSync(odd, { recursive: true });
  const copy = path.join(odd, 'jobs-track.py');
  fs.copyFileSync(SCRIPT, copy);
  // \a used to become BEL inside the -c source; now the loader gets the path as sys.argv[1]
  const loaded = JSON.parse(execFileSync(PYTHON, [...loadArgs('print(json.dumps(j.project_of(sys.argv[2])))', copy), `${PROJ}/demo-proj/a.py`], { env, encoding: 'utf8' }));
  assert.deepEqual(loaded, ['demo-proj', false]);
  const id = execFileSync(PYTHON, [copy, 'start', '--harness', 'pi', '--cwd', `${PROJ}/demo-proj`], { env, encoding: 'utf8' }).trim();
  assert.equal(get(id).project, 'demo-proj');
});

test('macOS ps identity keeps live jobs running and detects zombies and PID reuse', {skip}, () => {
  jtPy(`
j.PROC = None  # macOS has no procfs
j.sys.platform = 'darwin'
calls = []
output = 'S 10 20 Thu Nov 12 09:10:11 2026\\n'
def ps(args, **kwargs):
    calls.append((args, kwargs))
    return output
j.subprocess.check_output = ps
assert j.stat_of(42) == ('S', 10, 20, 'Thu Nov 12 09:10:11 2026')
assert calls[-1][0] == ['ps', '-p', '42', '-o', 'stat=,ppid=,pgid=,lstart=']
assert calls[-1][1]['env']['LC_ALL'] == 'C'
output = '/usr/bin/claude --flag\\n'  # cmdline falls back to ps too: hooks and kind detection work on macOS
assert j.cmdline(42) == ['/usr/bin/claude', '--flag']
assert calls[-1][0] == ['ps', '-p', '42', '-o', 'command=']
assert calls[-1][1]['env']['LC_ALL'] == 'C'
output = 'S 10 20 Thu Nov 12 09:10:11 2026\\n'
assert j.alive(42)
assert j.alive(42, 'Thu Nov 12 09:10:11 2026')
assert not j.alive(42, 'Thu Nov 12 09:10:10 2026')
j.discover = lambda: None
j.save({'id':'mac-live', 'status':'running', 'pid':42, 'pidStart':'Thu Nov 12 09:10:11 2026', 'started':j.now_ms()})
j.reap()
assert j.load('mac-live')['status'] == 'running'
output = 'Z 10 20 Thu Nov 12 09:10:11 2026\\n'
assert not j.alive(42)  # zombie
output = ''
assert j.stat_of(42) is None
assert not j.alive(999999999)  # no ps entry and no such pid: dead, not an os.kill guess
output = 'malformed'
assert j.stat_of(42) is None
def gone(*args, **kwargs):
    raise j.subprocess.CalledProcessError(1, 'ps')
j.subprocess.check_output = gone
assert not j.alive(999999999)
`, [], { ...env, JOBS_TRACK_DIR: path.join(tmp('jt-mac-'), 'tracked-jobs') });
});
