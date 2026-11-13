// Tracked jobs: reading, the 30 min "recently finished" window, plan / other grouping, reports.
import test from 'node:test';
import { scratch } from './helpers/weekly-scratch.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTracked, visibleJobs, groupJobs, jobReport, RECENT_MS, jobSize, isOneOff, saveFeatures, readFeatures, liveJobs, endState, cleanLabel, shownStatus, UNASSIGNED } from '../jobs.mjs';

const tmp = (t) => scratch(t, 'agentglim-jobs-');
const NOW = 1_800_000_000_000;
const rec = (o) => ({ id: o.id, project: 'demo', isPlan: false, kind: 'one-on-one', harness: 'claude', model: 'm', label: 'x', status: 'running', started: NOW - 60e3, ended: null, ...o });

test('readTracked skips broken files and missing dirs', (t) => {
  const d = tmp(t);
  fs.writeFileSync(path.join(d, 'a.json'), JSON.stringify(rec({ id: 'a' })));
  fs.writeFileSync(path.join(d, 'b.json'), '{broken');
  fs.writeFileSync(path.join(d, 'c.txt'), 'not a job');
  assert.deepEqual(readTracked(d).map((j) => j.id), ['a']);
  assert.deepEqual(readTracked(path.join(d, 'nope')), []);
});

test('visibleJobs keeps running and recently finished, newest first; done ones stay to fold into "N done, hidden"', (t) => {
  const list = [
    rec({ id: 'run', started: NOW - 10e3 }),
    rec({ id: 'fresh', status: 'done', ended: NOW - RECENT_MS + 60e3, started: NOW - RECENT_MS }),
    rec({ id: 'old', status: 'done', ended: NOW - RECENT_MS - 1 }),
    rec({ id: 'bad', status: 'failed', rc: '1', ended: NOW - 5e3, started: NOW - 20e3, kind: 'weird' }),
  ];
  const v = visibleJobs(list, NOW);
  assert.deepEqual(v.map((j) => j.id), ['run', 'bad', 'fresh']);
  assert.equal(v.find((j) => j.id === 'fresh').status, 'done');
  assert.equal(v.find((j) => j.id === 'bad').kind, 'one-on-one'); // unknown kinds fall back
  assert.equal(v.find((j) => j.id === 'bad').rc, '1');
});

test('shown status: unknown transcript activity is running, not idle; finished transcript is done', (t) => {
  assert.equal(shownStatus({ status: 'running', activity: 'unknown' }), 'running');
  assert.equal(shownStatus({ status: 'running', activity: 'finished' }), 'done');
  assert.equal(shownStatus({ status: 'running', activity: 'idle' }), 'idle');
  assert.equal(shownStatus({ status: 'stopped' }), 'stopped');
});

test('exit codes: rc=0 is done, rc!=0 failed, 124 failed (timed out), a kill is stopped', (t) => {
  assert.deepEqual(endState('0'), ['done', null]);
  assert.deepEqual(endState('2'), ['failed', 'exit code 2']);
  assert.deepEqual(endState('124'), ['failed', 'timed out']);
  assert.deepEqual(endState('143'), ['stopped', 'killed']);
});

test('liveJobs: a live pid is running even with no transcript; a dead agent.sh job takes rc=0 from meta and shows done', (t) => {
  const d = tmp(t), proc = tmp(t);
  fs.mkdirSync(path.join(proc, '4242')); fs.writeFileSync(path.join(proc, '4242', 'stat'), '4242 (bash) S 1 4242 4242 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 777 0 0');
  fs.writeFileSync(path.join(d, 'events.jsonl'), '{}\n');
  const [live] = liveJobs([rec({ id: 'a', kind: 'subagent', pid: 4242, pidStart: 777, outdir: d })], { root: proc, now: Date.now() });
  assert.equal(live.activity, 'running'); assert.equal(visibleJobs([live])[0].status, 'running');
  const o = tmp(t); fs.writeFileSync(path.join(o, 'meta'), '2026-11-11 13:42:24 start kind=codex-only\n2099-01-01 00:00:00 end kind=codex-only rc=0\n');
  const [gone] = liveJobs([rec({ id: 'b', pid: 999999, outdir: o, started: Date.parse('2026-11-11T13:42:24') })], { root: proc });
  assert.equal(gone.status, 'done'); assert.equal(gone.rc, '0');
  // an old record the reaper marked "stopped" without an rc, whose rc file says 0, shows done
  const r = tmp(t); fs.writeFileSync(path.join(r, 'rc'), '0');
  assert.equal(liveJobs([rec({ id: 'c', status: 'stopped', rc: null, outdir: r, started: 0, ended: NOW })])[0].status, 'done');
  const f = tmp(t); fs.writeFileSync(path.join(f, 'rc'), '3');
  assert.equal(liveJobs([rec({ id: 'd', status: 'stopped', rc: null, outdir: f, started: 0, ended: NOW })])[0].status, 'failed');
});

test('groupJobs: plans by plan, folded plans under their parent, fragments and the plans root to Unassigned', (t) => {
  const v = visibleJobs([
    rec({ id: 'p', project: '01-example-dashboard', isPlan: true, kind: 'autonomous' }),
    rec({ id: 'f', project: '05-example-snapshot', isPlan: true, kind: 'subagent' }),
    rec({ id: 'o', project: 'jobtrack-test', kind: 'queue' }),
    rec({ id: 'r', project: 'plans' }), rec({ id: 'v', project: 'video-' }), rec({ id: 'x', project: 'projects' }), rec({ id: 'y', project: 'out' }),
    rec({ id: 'g', project: 'goals' }),
  ], NOW);
  const g = groupJobs(v, { folds: { '05-example-snapshot': { parent: '70-example-leads' }, '01-example-dashboard': { parent: '71-example-product' } } });
  assert.deepEqual([...g.plans.keys()].sort(), ['01-example-dashboard', '70-example-leads']); // a driver job stays on its own plan
  assert.equal(g.plans.get('70-example-leads')[0].viaPlan, '05-example-snapshot');
  assert.deepEqual([...g.other.keys()].sort(), ['Unassigned', 'goals']);
  assert.equal(g.other.get(UNASSIGNED).length, 4);
});

test('labels: raw outdir slugs become readable', (t) => {
  assert.equal(cleanLabel('plan70-phase1'), 'Plan 70 phase 1');
  assert.equal(cleanLabel('agentglim-setup-deps'), 'AgentGlim setup deps');
  assert.equal(cleanLabel('Fix board job status'), 'Fix board job status');
});

test('jobReport: agent summary first, then the outdir output tail; nothing for unknown jobs', (t) => {
  const d = tmp(t);
  fs.writeFileSync(path.join(d, 'last.txt'), 'final answer');
  assert.match(jobReport({ outdir: d }), /== last.txt\nfinal answer/);
  assert.match(jobReport({ summary: 'ok', outdir: d }), /^ok\n\n== last.txt/);
  const f = path.join(d, 'agent.output'); fs.writeFileSync(f, 'x'.repeat(100));
  assert.match(jobReport({ outdir: f }, 10), /\(tail\)\nxxxxxxxxxx$/);
  assert.equal(jobReport(null), null);
  assert.equal(jobReport({ outdir: path.join(d, 'gone') }), null);
});

test('internal and test projects never form tracked rows', (t) => {
  const jobs = ['_archive', '_private', 'jobtrack-test', 'goals'].map(project => rec({ id: project, project }));
  assert.deepEqual([...groupJobs(jobs).other.keys()], ['goals']);
});

test('jobReport: Codex events.jsonl gives the last agent message when last.txt is missing', (t) => {
  const d = tmp(t);
  fs.writeFileSync(path.join(d, 'events.jsonl'), [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }), JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done: all good' } }), JSON.stringify({ type: 'turn.completed' })].join('\n'));
  fs.writeFileSync(path.join(d, 'stderr.log'), 'noise');
  assert.match(jobReport({ outdir: d }), /last agent message[^\n]*\nDone: all good/);
});
test('small vs feature decision', (t) => {
  const j = (o) => rec({ status: 'done', started: NOW - 10e3, ended: NOW, touches: 2, ...o });
  assert.equal(jobSize(j({})), 'small');
  assert.equal(jobSize(j({ touches: 1, started: NOW - 20 * 60e3 })), 'feature'); // long
  assert.equal(jobSize(j({ touches: 9 })), 'feature'); // many edits
  assert.equal(jobSize(j({ touches: undefined, started: NOW - 4 * 60e3 })), 'small');
  assert.equal(isOneOff(j({ touches: 4, started: NOW - 30e3 })), true);
  assert.equal(isOneOff(j({ touches: 1, started: NOW - 3 * 60e3 })), true);
  assert.equal(isOneOff(j({ touches: 4, started: NOW - 3 * 60e3 })), false);
});

test('saveFeatures keeps finished feature jobs of plans, drops small ones, never duplicates or loses', (t) => {
  const f = path.join(tmp(t), 'feature-subitems.json');
  const big = rec({ id: 'big', project: '68-observatory-app', isPlan: true, status: 'done', started: NOW - 600e3, ended: NOW, label: 'Nested jobs', kind: 'subagent' });
  const chat = rec({ id: 'chat', project: '68-observatory-app', isPlan: true, status: 'done', started: NOW - 600e3, ended: NOW, kind: 'one-on-one' });
  const small = rec({ id: 'sm', project: '68-observatory-app', isPlan: true, status: 'done', started: NOW - 20e3, ended: NOW });
  const run = rec({ id: 'rn', project: '68-observatory-app', isPlan: true, started: NOW - 900e3 });
  saveFeatures(f, [big, small, run, chat]); // a chat turn (one-on-one) is never a sub-task
  saveFeatures(f, [big]); // twice
  let items = readFeatures(f);
  assert.deepEqual(items.map((x) => x.id), ['big']);
  assert.equal(items[0].plan, '68-observatory-app'); assert.equal(items[0].label, 'Nested jobs');
  saveFeatures(f, []); // the job record is gone (archived): the saved item stays
  assert.equal(readFeatures(f).length, 1);
});

test('saved feature sub-items follow their job when it is re-attributed (a new task lands under the right plan)', (t) => {
  const f = path.join(tmp(t), 'feat.json');
  const job = rec({ id: 'j1', project: '70-example-leads', isPlan: true, kind: 'subagent', status: 'done', label: 'sub-67', started: NOW - 10 * 60e3, ended: NOW });
  saveFeatures(f, [job]); assert.equal(readFeatures(f)[0].plan, '70-example-leads');
  saveFeatures(f, [{ ...job, project: '33-example-channel', label: 'Asks pages: sub 67' }]);
  assert.equal(readFeatures(f)[0].plan, '33-example-channel'); assert.equal(readFeatures(f)[0].label, 'Asks pages: sub 67');
  saveFeatures(f, [{ ...job, project: 'goals', isPlan: false }]);
  assert.equal(readFeatures(f)[0].plan, null); assert.equal(readFeatures(f)[0].movedTo, 'goals');
});

test('a repo mapped in repo-plans.json (agentglim) lands on its plan row (68), never an Other-projects folder row', (t) => {
  const rp = { agentglim: '68-observatory-app', 'agentglim-dev-work': '68-observatory-app' };
  const vis = [{ id: 'a', project: 'agentglim', isPlan: false, kind: 'subagent' },
    { id: 'b', project: 'agentglim-dev-work', isPlan: false, kind: 'subagent' }, { id: 'c', project: 'leads', isPlan: false }];
  const g = groupJobs(vis, { rp });
  assert.deepEqual(g.plans.get('68-observatory-app').map((j) => j.id), ['a', 'b']);
  assert.equal(g.other.has('agentglim'), false);
  assert.equal(g.other.has('agentglim-dev-work'), false);
  assert.deepEqual([...g.other.keys()], ['leads']);
});

// follow-up 2026-11-13: opus48 claudeq jobs were labelled Sonnet; they map to claude-opus-4-8 / "Opus 4.8"
test('opus48 maps to Opus 4.8, never Sonnet', async () => {
  const { claudeKindId, claudeLabel, visibleJobs } = await import('../jobs.mjs');
  assert.equal(claudeKindId('opus48'), 'claude-opus-4-8');
  assert.equal(claudeLabel(claudeKindId('opus48')), 'Opus 4.8');
  assert.equal(claudeKindId('opus'), 'claude-opus-5-5');
  assert.equal(visibleJobs([rec({ id: 'o48', model: 'opus48' })], NOW)[0].model, 'claude-opus-4-8');
  const src = (await import('node:fs')).readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(src, /premium: done by \(fable\|opus48\|opus\) subagent/);
  assert.match(src, /j\.model = claudeKindId\(j\.claude\)/);
});
