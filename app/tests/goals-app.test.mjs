import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Paths are read at import time, so set the private roots before loading the module.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-goals-app-'));
const data = path.join(home, 'data');
const plans = path.join(home, 'plans');
const goals = path.join(data, 'goals');
fs.mkdirSync(goals, { recursive: true });
fs.mkdirSync(plans, { recursive: true });
fs.writeFileSync(path.join(home, 'env'), '');
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.AGENTGLIM_DATA = data;
process.env.AGENTGLIM_WORK = home;
process.env.AGENTGLIM_PLANS = plans;
process.env.AGENTGLIM_ENV_FILE = path.join(home, 'env');
process.env.AGENTGLIM_DEV = '1';

const root = path.resolve(import.meta.dirname, '../..');
for (const name of ['goals.json', 'goal-map.json']) fs.copyFileSync(path.join(root, 'app/defaults/goals', name), path.join(goals, name));

const mod = await import('../goals-report.mjs');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('validateGoals names the file and the field', () => {
  const good = { version: 1, goals: [{ id: 'ship', title: 'Ship', lane: 'now', allocation: 60, color: '#2fd69c' }] };
  assert.equal(mod.validateGoals(good, 'goals.json').goals.length, 1);
  assert.throws(() => mod.validateGoals({ version: 1, goals: [{ id: 'Bad Id', title: 'x' }] }, 'my-goals.json'), (error) => {
    assert.match(error.message, /my-goals\.json/);
    assert.equal(error.field, 'goals[0].id');
    return true;
  });
  assert.throws(() => mod.validateGoals({ version: 1, goals: [{ id: 'a', title: 'x', color: 'green' }] }, 'g.json'), /goals\[0\]\.color/);
  assert.throws(() => mod.validateGoals({ version: 1, goals: [{ id: 'a', title: 'x' }], metrics: [{ goal: 'missing', label: 'M' }] }, 'g.json'), /metrics\[0\]\.goal/);
});

test('validateGoalMap checks plan arrays and labels', () => {
  assert.equal(mod.validateGoalMap({ plans: { ship: ['01-a'] }, labels: { ship: 'Ship' } }, 'm.json').plans.ship[0], '01-a');
  assert.throws(() => mod.validateGoalMap({ plans: { ship: '01-a' } }, 'm.json'), /plans\.ship/);
  assert.throws(() => mod.validateGoalMap({ labels: { ship: 4 } }, 'm.json'), /labels\.ship/);
});

test('needsYou follows the plan-status rule', () => {
  assert.equal(mod.needsYou({ owner: true, done: false, choice: null }), true);
  assert.equal(mod.needsYou({ owner: true, done: false, choice: 'will' }), true);
  assert.equal(mod.needsYou({ owner: true, done: false, kind: 'ask', choice: 'other' }), true);
  assert.equal(mod.needsYou({ owner: true, done: false, kind: 'decision', choice: 'other' }), false);
  assert.equal(mod.needsYou({ owner: true, done: false, choice: 'fix' }), false);
  assert.equal(mod.needsYou({ owner: false, done: false }), false);
  assert.equal(mod.needsYou({ owner: true, done: true }), false);
});

test('demo overview is complete and private-free', async () => {
  mod.invalidate();
  const ov = await mod.getOverview({ demo: true, force: true });
  assert.equal(ov.demo, true);
  assert.deepEqual(ov.goals.map((g) => g.id), ['ship', 'learn']);
  assert.equal(ov.goals[0].color, '#2fd69c');
  assert.equal(ov.goals[0].asks.open, 2);
  assert.equal(ov.goals[0].asks.needYou, 1);
  assert.equal(ov.counts.plans, 2);
  assert.equal(ov.overall.alignment, 68);
  assert.equal(ov.rules.length, 2);
  assert.ok(ov.news.items.length);
  assert.ok(ov.week.length);
  assert.ok(ov.goals.every((g) => !g.asks.projects.some((p) => p.asks === undefined || !Array.isArray(p.asks))));
});

test('the real overview reads the seeded goals and falls back cleanly', async () => {
  mod.invalidate();
  const ov = await mod.getOverview({ demo: false, force: true });
  assert.equal(ov.demo, false);
  assert.deepEqual(ov.goals.map((g) => g.id), ['ship', 'learn']);
  assert.equal(ov.counts.goals, 2);
  assert.equal(ov.goals[0].plans[0].state, 'example', 'map plans without folders are shown as examples');
});

test('a broken goals file returns the file and field', async () => {
  const file = path.join(goals, 'goals.json');
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, JSON.stringify({ version: 1, goals: [{ id: 'NOT VALID', title: 'x' }] }));
  mod.invalidate();
  await assert.rejects(() => mod.getOverview({ demo: false, force: true }), (error) => {
    assert.match(error.message, /goals\.json/);
    assert.equal(error.field, 'goals[0].id');
    return true;
  });
  fs.writeFileSync(file, original);
  mod.invalidate();
});

test('refresh rebuilds the cache without external commands in dev', async () => {
  mod.invalidate();
  const out = await mod.runRefresh({ demo: false, dev: true, reason: 'test' });
  assert.equal(out.refresh.external.ran, false);
  const st = mod.readState();
  assert.ok(st.lastRefreshAt);
  assert.equal(st.lastError, null);
});

test('fresh install skips the scheduled weekly chat without the optional skill', async () => {
  assert.equal(mod.queueWeeklyReview().queued, false, 'manual requests need the skill too');
  const jobs = await import('../goals-jobs.mjs');
  jobs.startGoalsJobs();
  try {
    const result = await jobs.runGoalsJob('goals-weekly');
    assert.deepEqual(result.queued, { queued: false, reason: 'goals-weekly-review skill is not installed' });
    assert.equal(fs.existsSync(path.join(plans, '_run', 'chat_inbox')), false);
    assert.equal(mod.weeklyStatus().pending, null);
    assert.equal(mod.readState().lastWeeklyQueuedAt, undefined);
    assert.equal(mod.readState().lastReviewAt, undefined);
  } finally { jobs.goalsScheduler.stop(); }
});

test('the weekly queue writes one inbox message when the skill is installed and reports it pending', async () => {
  const skill = path.join(home, '.agents', 'skills', 'goals-weekly-review');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: goals-weekly-review\n---\nReview the goals.\n');
  const q = mod.queueWeeklyReview({ reason: 'test' });
  assert.equal(q.queued, true);
  const inbox = path.join(plans, '_run', 'chat_inbox');
  const files = fs.readdirSync(inbox).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1);
  const body = JSON.parse(fs.readFileSync(path.join(inbox, files[0]), 'utf8'));
  assert.equal(body.from, 'goals-app');
  assert.match(body.text, /weekly goals review/i);
  const weekly = mod.weeklyStatus();
  assert.equal(weekly.pending.id, files[0].replace(/\.json$/, ''));
});

test('three failures in a row set the first backoff step', () => {
  mod.writeState({ failures: 2, lastError: null, backoffUntil: null });
  const fail = mod.markRefreshFailure(new Error('disk full'));
  assert.equal(fail.failures, 3);
  assert.equal(fail.backoff, 3600e3);
  assert.ok(fail.incidentAt);
  const st = mod.readState();
  assert.ok(st.backoffUntil > Date.now());
  assert.match(st.lastError, /disk full/);
  mod.writeState({ failures: 0, lastError: null, backoffUntil: null });
});
