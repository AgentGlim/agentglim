// The harness register (_run/bin/jobs-track.py) end to end on a temp dir: run wrapper, kind/project detection,
// rc-file and pid reaping, the Claude Agent-tool hook events. Skipped when the harness is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { RUN, HOME } from '../paths.mjs';

const SCRIPT = path.resolve(import.meta.dirname,'../../tools/addons/jobs-track.py');
const skip = !fs.existsSync(SCRIPT) && 'harness jobs-track.py not installed';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-track-'));
const env = { ...process.env, JOBS_TRACK_DIR: dir };
const jt = (args, input) => execFileSync('python3', [SCRIPT, ...args], { env, input, encoding: 'utf8' }).trim();
const list = () => JSON.parse(jt(['list']));
const get = (id) => list().find((j) => j.id === id);
const PROJ = path.join(HOME, 'dev', 'projects');

test('run wrapper: running while the command lives, then done / failed by rc', { skip }, async () => {
  const p = spawn('python3', [SCRIPT, 'run', '--harness', 'codex', '--model', 'm1', '--label', 'sleeper', '--cwd', `${PROJ}/demo-proj`, '--', 'sleep', '3'], { env });
  let j; for (let i = 0; i < 40 && !j; i++) { await new Promise((r) => setTimeout(r, 50)); j = list().find((x) => x.label === 'sleeper'); }
  assert.equal(j.status, 'running');
  assert.equal(j.project, 'demo-proj');
  assert.equal(j.isPlan, false);
  assert.ok(['one-on-one', 'subagent'].includes(j.kind), j.kind); // subagent when the test itself runs inside a harness session
  assert.equal(j.harness, 'codex');
  await new Promise((r) => p.on('exit', r));
  assert.equal(get(j.id).status, 'done');
  let rc = 0; try { execFileSync('python3', [SCRIPT, 'run', '--label', 'boom', '--', 'false'], { env }); } catch (e) { rc = e.status; }
  assert.equal(rc, 1); // the wrapped command's rc passes through
  assert.equal(list().find((x) => x.label === 'boom').status, 'failed');
});

test('project from outdir/prompt paths: a plan path wins and sets isPlan', { skip }, () => {
  const id = jt(['start', '--harness', 'pi', '--cwd', PROJ, '--prompt', `work in ${PROJ}/plans/01-example-dashboard/build please`]);
  const j = get(id);
  assert.equal(j.project, '01-example-dashboard');
  assert.equal(j.isPlan, true);
  jt(['finish', '--id', id, '--rc', '0']);
  assert.equal(get(id).status, 'done');
});

test('reap: rc file finishes the job (failed on rc != 0); dead pid without rc = stopped for agent.sh', { skip }, async () => {
  const out = fs.mkdtempSync(path.join(dir, 'out-'));
  const s = spawn('sleep', ['30']);
  const id = jt(['start', '--harness', 'claude', '--outdir', out, '--pid', String(s.pid), '--launcher', 'agent.sh']);
  jt(['reap']); assert.equal(get(id).status, 'running');
  fs.writeFileSync(path.join(out, 'rc'), '2\n');
  jt(['reap']); assert.equal(get(id).status, 'failed'); assert.equal(get(id).rc, '2');
  s.kill();
  const out2 = fs.mkdtempSync(path.join(dir, 'out-'));
  const s2 = spawn('sleep', ['30']);
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
  execFileSync('python3', [SCRIPT, 'start', '--harness', 'x'], { env: { ...env, JOBS_TRACK_DIR: '/proc/no-such/dir' } });
  execFileSync('python3', [SCRIPT, 'finish'], { env });
});

test('project_of: repo-plan map, plan paths, tool paths, plain projects', { skip }, () => {
  const map = path.join(dir, 'repo-plans.json'); fs.writeFileSync(map, JSON.stringify({ agentglim: '77-example-dashboard' }));
  const py = (x) => JSON.parse(execFileSync('python3', ['-c', `import importlib.machinery as m,json,sys;j=m.SourceFileLoader('jt','${SCRIPT}').load_module();print(json.dumps(j.project_of(sys.argv[1])))`, x], { env: { ...env, REPO_PLANS_FILE: map }, encoding: 'utf8' }));
  assert.deepEqual(py(`${PROJ}/agentglim/app/server.mjs`), ['77-example-dashboard', true]);
  assert.deepEqual(py(`node -e "require('${PROJ}/toolbox/node_modules/playwright')" ${PROJ}/agentglim/x`), ['77-example-dashboard', true]);
  assert.deepEqual(py(`node -e "require('${PROJ}/toolbox/node_modules/playwright')"`)[1], false);
  assert.deepEqual(py(`${PROJ}/plans/11-example-hub/PLAN.md`), ['11-example-hub', true]);
  assert.deepEqual(py(`${PROJ}/demo-proj/a.py`), ['demo-proj', false]);
});

test('Agent tool launch is a subagent sub-item: running on PreToolUse, still running on the async PostToolUse, done on SubagentStop', { skip }, () => {
  const hook = (ev) => execFileSync('python3', [SCRIPT, 'claude-hook'], { env, input: JSON.stringify(ev) });
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
const tdir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const PL = tdir('jt-plans-'), PR = tdir('jt-projects-');
for (const d of ['33-demo-channel', '39-demo-motion', '70-demo-leads', '71-demo-product']) fs.mkdirSync(path.join(PL, d));
for (const d of ['leadsx', 'goals']) fs.mkdirSync(path.join(PR, d));
const MAP = path.join(PL, 'repo-plans.json'); fs.writeFileSync(MAP, JSON.stringify({ leadsx: '70-demo-leads' }));
const aenv = { ...env, AGENTGLIM_PLANS: PL, AGENTGLIM_PROJECTS: PR, REPO_PLANS_FILE: MAP };
const ja = (args) => execFileSync('python3', [SCRIPT, ...args], { env: aenv, encoding: 'utf8' }).trim();
const attr = (o) => JSON.parse(execFileSync('python3', ['-c', `import importlib.machinery as m,json,sys;j=m.SourceFileLoader('jt','${SCRIPT}').load_module();print(json.dumps(j.attribute(**json.loads(sys.argv[1]))))`, JSON.stringify(o)], { env: aenv, encoding: 'utf8' }));

test('attribution: --plan and a [plan:] tag win; then the cwd via repo-plans.json; then plan folders named in the prompt', { skip }, () => {
  assert.deepEqual(attr({ plan: '71-demo-product', cwd: `${PR}/leadsx` }), ['71-demo-product', true, '--plan']);
  assert.deepEqual(attr({ cwd: PL, prompt_text: 'x [plan: 71-demo-product] y' }), ['71-demo-product', true, 'tag']);
  assert.deepEqual(attr({ cwd: PL, prompt_text: '[plan: NN-slug] is a placeholder' }), ['Unassigned', false, 'none']);
  assert.deepEqual(attr({ cwd: `${PR}/leadsx/sub` }), ['70-demo-leads', true, 'cwd']);
  assert.deepEqual(attr({ cwd: `${PL}/33-demo-channel` }), ['33-demo-channel', true, 'cwd']);
  // the buyer-video case: cwd is the plans root, the prompt names plans/33-... most and a glob over project folders
  assert.deepEqual(attr({ cwd: PL, prompt_text: `see ${PL}/33-demo-channel/PLAN.md, merge plans/39-demo-motion into plans/33-demo-channel/drafts; ideas in ${PR}/video-*` }), ['33-demo-channel', true, 'prompt']);
  // a sub-job in another job's folder belongs to that job's project
  const parent = tdir('jt-parent-'); fs.writeFileSync(path.join(parent, 'prompt.md'), `build ${PR}/goals/scripts/page.mjs`); fs.mkdirSync(path.join(parent, 'sub-1'));
  assert.deepEqual(attr({ cwd: PL, outdir: path.join(parent, 'sub-1'), prompt_text: 'approvals page of 70-demo-leads' }), ['goals', false, 'parent job']);
});

test('attribution never makes groups from path fragments: video-*, the projects root, an out folder', { skip }, () => {
  assert.deepEqual(attr({ cwd: PR, outdir: '/tmp/x/yt/out', prompt_text: `look at ${PR}/video-* and ${PR}/leads. too` }), ['Unassigned', false, 'none']);
  assert.deepEqual(attr({ cwd: `${PR}/video-` }), ['Unassigned', false, 'none']);
  assert.deepEqual(attr({ cwd: PL, prompt_text: 'edit content/70-demo-leads.py' }), ['Unassigned', false, 'none']);
  const id = ja(['start', '--harness', 'pi', '--cwd', PR, '--outdir', tdir('jt-out-'), '--prompt', 'no plan here']);
  assert.equal(get(id).project, 'Unassigned'); assert.equal(get(id).isPlan, false);
});

test('reap: rc=0 is done, rc!=0 failed, 124 failed (timed out); a dead agent.sh job with only a meta end line uses it', { skip }, async () => {
  const mk = async (write) => { const out = tdir('jt-rc-'), s = spawn('sleep', ['30']); const id = ja(['start', '--harness', 'codex', '--outdir', out, '--pid', String(s.pid), '--launcher', 'agent.sh']); write(out); s.kill(); await new Promise((r) => s.on('exit', r)); ja(['reap']); return get(id); };
  let j = await mk((o) => fs.writeFileSync(path.join(o, 'rc'), '0\n')); assert.equal(j.status, 'done'); assert.equal(j.rc, '0');
  j = await mk((o) => fs.writeFileSync(path.join(o, 'rc'), '1\n')); assert.equal(j.status, 'failed');
  j = await mk((o) => fs.writeFileSync(path.join(o, 'rc'), '124\n')); assert.equal(j.status, 'failed'); assert.equal(j.endReason, 'timed out');
  const stamp = new Date(Date.now() + 2000).toLocaleString('sv').slice(0, 19);
  j = await mk((o) => fs.writeFileSync(path.join(o, 'meta'), `${stamp} end kind=codex-only rc=0\n`)); assert.equal(j.status, 'done'); assert.equal(j.rc, '0');
});

test('a live pid stays running; discovery resolves relative agent.sh paths against its own cwd and reads --plan', { skip }, async () => {
  const base = tdir('jt-disc-'); fs.mkdirSync(path.join(base, 'rel/out'), { recursive: true }); fs.writeFileSync(path.join(base, 'rel/p.md'), 'x');
  const sh = path.join(base, 'agent.sh'); fs.writeFileSync(sh, 'sleep 30\n');
  const p = spawn('bash', [sh, 'codex-only', base, 'rel/p.md', 'rel/out', '60', 'high', '--plan', '71-demo-product'], { cwd: base });
  let j;
  for (let i = 0; i < 30 && !j; i++) { // bash needs a moment before /proc shows its cmdline
    await new Promise((r) => setTimeout(r, 100));
    execFileSync('python3', [SCRIPT, 'reap'], { env: aenv, cwd: os.tmpdir() });
    j = list().find((x) => x.pid === p.pid);
  }
  assert.ok(j, 'discovered'); assert.equal(j.outdir, path.join(base, 'rel/out')); assert.equal(j.project, '71-demo-product'); assert.equal(j.status, 'running');
  execFileSync('python3', [SCRIPT, 'reap'], { env: aenv });
  assert.equal(list().filter((x) => x.pid === p.pid).length, 1); // never twice
  assert.equal(get(j.id).status, 'running');
  p.kill(); await new Promise((r) => p.on('exit', r));
});
