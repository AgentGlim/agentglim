import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const defaults = path.join(root, 'app/defaults/goals');
const publicListFile = path.join(root, 'dev/goals-public-strings.txt');
const textFiles = [
  ...fs.readdirSync(defaults, { recursive: true }).filter((f) => fs.statSync(path.join(defaults, f)).isFile()).map((f) => path.join(defaults, f)),
  path.join(root, 'app/goals-app.html'), path.join(root, 'app/goals-app.mjs'), path.join(root, 'app/goals-app.css'),
  path.join(root, 'examples/goals.example.json'),
];
const publicText = textFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const allowed = new Set(fs.readFileSync(publicListFile, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#')));

function privateStrings() {
  const out = new Set();
  const add = (value) => { if (typeof value === 'string' && value.trim().length >= 12) out.add(value.trim()); };
  const file = [path.join(process.env.AGENTGLIM_GOALS || '', 'goals.json'), path.join(process.env.AGENTGLIM_DATA || '', 'goals', 'goals.json')].find((f) => f && fs.existsSync(f));
  if (!file) return [];
  let doc = null; try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  for (const goal of doc.goals || []) { add(goal.title); add(goal.next_action); add(goal.outcome); for (const a of goal.acceptance || []) add(a); }
  for (const m of doc.metrics || []) add(m.label);
  const dir = path.dirname(file);
  let reviews = []; try { reviews = fs.readdirSync(path.join(dir, 'reviews')).filter((f) => /-review\.json$/.test(f)).sort(); } catch {}
  if (reviews.length) {
    try {
      const review = JSON.parse(fs.readFileSync(path.join(dir, 'reviews', reviews.at(-1)), 'utf8'));
      for (const p of review.priorities || []) { add(p.title); add(p.action); add(p.next); }
      for (const x of review.drift || []) add(x);
      for (const x of review.gaps || []) add(x);
    } catch {}
  }
  return [...out];
}

test('the demo publishes only reviewed public strings', () => {
  const goals = JSON.parse(fs.readFileSync(path.join(defaults, 'goals.json'), 'utf8'));
  for (const goal of goals.goals) {
    for (const value of [goal.title, goal.next_action, goal.outcome]) {
      assert.ok(allowed.has(value), `add this demo string to dev/goals-public-strings.txt: ${value}`);
    }
  }
  for (const metric of goals.metrics || []) assert.ok(allowed.has(metric.label), `add this demo metric to dev/goals-public-strings.txt: ${metric.label}`);
});

test('no private goals string reaches a public file', () => {
  const privateOnes = privateStrings();
  for (const value of privateOnes) assert.ok(!publicText.includes(value), 'a private goals string reached a public file');
  assert.ok(publicText.length > 0);
});
