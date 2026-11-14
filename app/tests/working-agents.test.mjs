// One icon per real agent (agent-icons fix 2026-11-13, plans/68-observatory-app/_build/agent-icons-diag-20261113/DIAG.md).
// Fixtures are the shapes of the incident: plan 69 (queued Claude jobs: agent.sh wrapper + headless take) and plan 83
// (Pi workers seen by both the harness scan and jobs-track). Made-up plan names, no machine paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentsOf, foldWrappers, normDir, superagentLive } from '../working.mjs';
import { visibleJobs, liveJobs, shownStatus } from '../jobs.mjs';
import { subagentStatus } from '../subagent-status.mjs';

const P = '/nonexistent/plans/69-demo/_build/v4-r1';
const now = Date.now();
const rec = (o) => ({ status: 'running', harness: 'claude', isPlan: true, project: '69-demo', started: now - 60e3, ...o });

const plan69 = {
  harness: [
    { provider: 'claude', role: 'orchestrator', task: 'round v4-r1', model: 'claude-opus-4-8', outdir: `${P}/orch` },
    { provider: 'claude', role: 'worker', task: 'opus48', model: 'claude-opus-4-8', outdir: `${P}/workers/fix/opus48/` },
  ],
  tracked: [
    rec({ id: 'w1', launcher: 'agent.sh', kind: 'autonomous', model: 'sonnet', outdir: `${P}/orch`, started: now - 120e3 }),
    rec({ id: 't1', launcher: 'headless-take.sh', kind: 'queue', model: 'claude-opus-4-8', outdir: `${P}/orch`, req: '/q/69__orch.req' }),
    rec({ id: 'w2', launcher: 'agent.sh (discovered)', kind: 'queue', model: 'opus48', outdir: `${P}/workers/fix/opus48`, started: now - 90e3 }),
    rec({ id: 't2', launcher: 'headless-take.sh', kind: 'queue', model: 'claude-opus-4-8', outdir: `${P}/workers/fix/opus48`, req: '/q/69__w.req' }),
  ],
};

test('plan 69 shape: 2 harness jobs + 4 records (2 outdirs) are 2 agents', () => {
  const a = agentsOf(plan69);
  assert.equal(a.length, 2);
  assert.ok(a.every((x) => x.work && x.job), 'each agent joins scan and record');
  assert.deepEqual(a.map((x) => x.job.id).sort(), ['t1', 't2'], 'the headless take is kept, the wrapper folded');
  assert.equal(a.find((x) => x.job.id === 't1').job.wrapperOf, 'w1');
  assert.equal(a.find((x) => x.job.id === 't1').job.started, now - 120e3, 'wrapper start time kept');
});

test('records only (no scan): wrapper + take are still one agent each', () => {
  assert.equal(agentsOf({ tracked: plan69.tracked }).length, 2);
});

test('plan 83 shape: 4 harness jobs + 4 records are 4 agents, model from the scan', () => {
  const B = '/nonexistent/plans/83-demo/_build/v1-r3';
  const dirs = ['orch', 'workers/publisher/luna', 'workers/integration/luna', 'workers/fix-path/luna'];
  const a = agentsOf({
    harness: dirs.map((d) => ({ provider: 'codex', role: d === 'orch' ? 'orchestrator' : 'worker', task: d, model: 'gpt-6.1-sol', outdir: `${B}/${d}` })),
    tracked: dirs.map((d, i) => rec({ id: `r${i}`, project: '83-demo', harness: 'codex', launcher: i ? 'agent.sh (discovered)' : 'agent.sh', kind: 'autonomous', model: i ? 'luna' : 'gpt-6-luna', outdir: `${B}/${d}` })),
  });
  assert.equal(a.length, 4);
  assert.ok(a.every((x) => x.work.model === 'gpt-6.1-sol'));
});

test('a harness job with no record and a record with no harness job each give 1; manual and goal add 1 each', () => {
  const a = agentsOf({
    harness: [{ provider: 'pi', role: 'worker', model: 'm', outdir: '/x/a' }],
    tracked: [rec({ id: 's1', kind: 'subagent', launcher: 'claude Agent tool', outdir: '/tmp/t/a1.output' }), rec({ id: 'd1', status: 'done', outdir: '/x/b' })],
    manual: [{ role: 'manual', task: 'session x' }], goal: { role: 'goal' },
  });
  assert.equal(a.length, 4);
});

test('a one-on-one chat record of an interactive session on the row is that session, not a second agent', () => {
  const a = agentsOf({ tracked: [rec({ id: 'c', kind: 'one-on-one', model: 'session' })], manual: [{ role: 'manual', task: 'session 70-x' }] });
  assert.equal(a.length, 1);
  assert.equal(agentsOf({ tracked: [rec({ id: 'c', kind: 'one-on-one' })] }).length, 1, 'with no session on the row it still counts');
});

test('a symlinked plans path joins its real path', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-'));
  t.after(() => fs.renameSync(tmp, `${tmp}-done`)); // never rm (owner rule); the temp folder is left renamed
  fs.mkdirSync(path.join(tmp, 'real', 'plans', '70-x', 'orch'), { recursive: true });
  fs.symlinkSync(path.join(tmp, 'real', 'plans'), path.join(tmp, 'link'));
  assert.equal(normDir(path.join(tmp, 'link', '70-x', 'orch')), normDir(path.join(tmp, 'real', 'plans', '70-x', 'orch')));
  const a = agentsOf({ harness: [{ role: 'worker', outdir: path.join(tmp, 'link', '70-x', 'orch') }], tracked: [rec({ id: 'r', launcher: 'agent.sh', outdir: path.join(tmp, 'real', 'plans', '70-x', 'orch') })] });
  assert.equal(a.length, 1);
});

test('jobs.mjs visibleJobs: wrapper + take with the same outdir collapse to one visible job (take model, req kept)', () => {
  const v = visibleJobs(plan69.tracked, now);
  assert.equal(v.length, 2);
  assert.ok(v.every((j) => j.model === 'claude-opus-4-8' && j.req && j.wrapperOf));
  // different outdirs never fold
  assert.equal(foldWrappers([rec({ id: 'a', launcher: 'agent.sh', outdir: '/x/1' }), rec({ id: 'b', launcher: 'headless-take.sh', outdir: '/x/2' })]).length, 2);
});

test('SuperAgent row: plan headless takes and plan-tagged helpers are excluded; done record drops its helper', () => {
  const all = [
    rec({ id: 'own', project: 'SuperAgent', kind: 'subagent', agentId: 'aOwn' }),
    rec({ id: 'plan68', project: '68-x', kind: 'subagent', agentId: 'a68' }),
    rec({ id: 'old', project: 'SuperAgent', kind: 'subagent', agentId: 'aOld', status: 'done' }),
    plan69.tracked[1], plan69.tracked[3],
  ];
  const wrLive = [{ id: 'aOwn' }, { id: 'a68' }, { id: 'aOld' }, { id: 'aUntracked' }];
  const { helpers, run } = superagentLive(wrLive, all, shownStatus);
  assert.deepEqual(helpers.map((h) => h.id), ['aOwn', 'aUntracked']);
  assert.deepEqual(run, [], 'own running record is already drawn as its helper; plan takes never count');
  assert.equal(helpers.length + run.length, 2);
});

test('phantom subagent (no agent id, retried): stopped once a newer record of the same label has an id', () => {
  const ph = rec({ id: 'p', kind: 'subagent', label: 'Audit', sessionId: 's1', started: now - 10e3 });
  const real = rec({ id: 'r', kind: 'subagent', label: 'Audit', sessionId: 's1', agentId: 'ag', started: now - 4e3 });
  const out = liveJobs([ph, real], { now });
  assert.equal(out[0].status, 'stopped');
  assert.equal(out[0].endReason, 'never started');
  assert.equal(out[1].status, 'running');
  assert.equal(liveJobs([ph], { now })[0].status, 'running', 'alone and young it keeps running');
});

test('subagent-status: a Claude record without agentId is unknown, never matched by the parent sessionId', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-home-'));
  t.after(() => fs.renameSync(home, `${home}-done`));
  const d = path.join(home, '.claude', 'projects', 'p', 'parent-session', 'subagents'); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'agent-zzz.jsonl'), JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [] } }) + '\n');
  const r = subagentStatus([{ id: 'x', kind: 'subagent', status: 'running', harness: 'claude', sessionId: 'parent-session' }], { home, now });
  assert.equal(r.jobs[0].activity, 'unknown');
});

test('index.html: icons come from p.agents, a finished sub-task row has no WORKING icon', () => {
  const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /p\.agents \? p\.agents\.filter\(\(a\) => a\.work\)/);
  assert.match(html, /<div class="who xc">\$\{st === 'running' \? tjIco\(j\) : ''\}<\/div>/);
  assert.doesNotMatch(html, /tjIco\(j, st !== 'running'\)/);
});
