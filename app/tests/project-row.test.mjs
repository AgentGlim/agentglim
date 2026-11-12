// Project row template: any project, plan or custom, gets Merged projects from repo pins and Sub-tasks from
// tracked jobs, all from data. Uses made-up names only, so nothing here is keyed to AgentGlim.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'row-tpl-'));
const pins = path.join(tmp, 'repo-plans.json');
fs.writeFileSync(pins, JSON.stringify({ 'widget-shop': '77-widget-shop', 'other-repo': '78-other' }));
process.env.REPO_PLANS_FILE = pins;
const { subProjects, repoPins } = await import('../subprojects.mjs');
const { visibleJobs, groupJobs, saveFeatures, readFeatures } = await import('../jobs.mjs');

test('repo pins become merged-project cards under the repo row, for any repo', () => {
  assert.deepEqual(repoPins(pins), { 'widget-shop': '77-widget-shop', 'other-repo': '78-other' });
  const sp = subProjects();
  assert.equal(sp.repos['widget-shop'], '77-widget-shop');
  const card = (sp.parents['widget-shop'] || []).find((e) => e.plan === '77-widget-shop');
  assert.ok(card && card.pin, 'pinned plan card under its repo');
  assert.ok((sp.parents['other-repo'] || []).some((e) => e.plan === '78-other'));
});

test('a subagent launched for a custom project is a running sub-task row at once, then a saved done sub-task', () => {
  const now = Date.now();
  const run = { id: 'cc-x', project: 'widget-shop', isPlan: false, kind: 'subagent', status: 'running', started: now - 5e3, touches: 1, label: 'fix cart', harness: 'claude', model: 'claude-sonnet-5-5' };
  const g = groupJobs(visibleJobs([run], now));
  const row = g.other.get('widget-shop');
  assert.equal(row.length, 1);
  assert.equal(row[0].kind, 'subagent');
  assert.equal(row[0].oneOff, false, 'a hand-off is never folded into one-off tasks');
  const f = path.join(tmp, 'feat.json');
  const done = { ...run, project: '77-widget-shop', isPlan: true, status: 'done', started: now - 600e3, ended: now };
  const chat = { ...done, id: 'chat-1', kind: 'one-on-one', label: 'chat turn' };
  saveFeatures(f, [done, chat]);
  const items = readFeatures(f);
  assert.deepEqual(items.map((x) => x.id), ['cc-x']);
  assert.equal(items[0].model, 'claude-sonnet-5-5');
  assert.equal(items[0].kind, 'subagent');
});

test('every project row renders its sections in order: Merged projects, Sub-features, Sub-tasks', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const calls = [...html.matchAll(/\+ (subProj|subRows|tjRows)\(/g)].map((m) => m[1]);
  const at = calls.flatMap((c, i) => (c === 'subRows' ? [i] : []));
  assert.ok(at.length >= 3, 'renderer calls found');
  for (const i of at) assert.deepEqual(calls.slice(i - 1, i + 2), ['subProj', 'subRows', 'tjRows']);
});
