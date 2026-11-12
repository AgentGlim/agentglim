import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { liveStatus } from '../live-status.mjs';
import { visibleJobs, groupJobs } from '../jobs.mjs';

const plan = '77-widget-shop';
const items = [
  { id: '02', title: 'Cart editor', status: 'running', updated: '2026-01-01', note: 'Partial implementation', pct: 40 },
  { id: '05', title: 'Checkout flow', status: 'running', updated: '2026-01-02' },
  { id: '06', title: 'Receipt', status: 'done' },
];
const job = (fields = {}) => ({ project: plan, isPlan: true, status: 'running', label: 'Build project', ...fields });

test('stale running items display in progress with idle date without changing stored data', () => {
  const stored = structuredClone(items);
  const display = liveStatus(items, plan);
  assert.equal(display[0].status, 'in progress');
  assert.equal(display[0].statusHint, 'idle since 2026-01-01');
  assert.equal(display[0].pct, 40);
  assert.equal(display[0].note, 'Partial implementation');
  assert.equal(display[2].status, 'done');
  assert.deepEqual(items, stored);
});

test('a live tracked job for the plan backs running; ended and other-plan jobs do not', () => {
  assert.deepEqual(liveStatus(items, plan, [job()]).map((i) => i.status), ['running', 'running', 'done']);
  assert.deepEqual(liveStatus(items, plan, [job({ status: 'done' }), job({ project: '78-other' })]).map((i) => i.status), ['in progress', 'in progress', 'done']);
});

test('a job naming an id prefers that item, including unpadded ids', () => {
  assert.deepEqual(liveStatus(items, plan, [job({ label: 'Build sub-feature 2' })]).map((i) => i.status), ['running', 'in progress', 'done']);
  assert.deepEqual(liveStatus(items, plan, [job({ label: 'Build sub-feature 12' })]).map((i) => i.status), ['running', 'running', 'done']);
});

test('matching job note and title survives trackedNow grouping', () => {
  const g = groupJobs(visibleJobs([job({ note: 'Implement CHECKOUT flow' })]));
  assert.deepEqual(liveStatus(items, plan, g.plans.get(plan)).map((i) => i.status), ['in progress', 'running', 'done']);
});

test('an unqualified job still backs siblings alongside a job naming one item', () => {
  assert.equal(liveStatus(items, plan, [job(), job({ label: 'Checkout flow' })])[0].status, 'running');
});

test('stored sub-tasks and named tests follow the same display rule', () => {
  const saved = [{ label: 'Build cart', status: 'running', finished: '2026-01-03' }];
  assert.equal(liveStatus(saved, plan)[0].statusHint, 'idle since 2026-01-03');
  const tests = [{ name: 'Cart tests', status: 'running' }, { name: 'Checkout tests', status: 'running' }];
  assert.deepEqual(liveStatus(tests, plan, [job({ label: 'Cart tests' })]).map((i) => i.status), ['running', 'in progress']);
  assert.equal(liveStatus(tests, plan)[0].statusHint, 'idle since unknown date');
});

test('dashboard renders stale running as a muted in progress chip; live jobs keep running', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const source = html.slice(html.indexOf('  function subRows('), html.indexOf('  function row(p, names, idx)'));
  const render = (jobs) => vm.runInNewContext(`${source}\nsubRows(p, 4)`, {
    p: { dir: plan, sub: liveStatus([items[0]], plan, jobs) },
    s: { projects: [] }, subOpen: new Set([plan]), subDone: new Set(),
    spList: () => [], cpyRows: {}, esc: (s) => String(s),
  });
  const idle = render([]);
  assert.match(idle, /class="st solid in-progress"[^>]*>in progress<\/span>/);
  assert.match(idle, /idle since 2026-01-01/);
  assert.doesNotMatch(idle, />running<\/span>/);
  assert.match(render([job()]), /--status-color:var\(--free\)[^>]*>running<\/span>/);
});
