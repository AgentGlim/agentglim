// Skill auto-grouping (Plan 2): hashing, code-first matching, the model stub, the move log and undo.
// Every test runs against a temp HOME fixture; no test starts a model or touches a real skill folder.
import { waitForServerReady } from './helpers/server-ready.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  CATALOG, STATE_FILE, LOG_FILE, skillHash, tokenize, frontmatter, buildProfiles, classifyByCode,
  readState, readLog, groupsPayload, runGrouping, acceptSuggestion, rejectSuggestion, undoLast, askPi,
} from '../skill-groups.mjs';

const FIXED = '2026-11-12T09:00:00.000Z';

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-skill-groups-'));
  const data = path.join(home, 'data');
  const write = (rel, text) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
  const skill = (name, description, body = '') => write(`.agents/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`);
  return { home, data, write, skill };
}

const opts = (fx, ask) => ({ home: fx.home, root: path.join(fx.home, 'no-bundled-skills'), data: fx.data, ask, now: () => FIXED });

test('catalog matches the Skill Editor and the retire page, and tokens/hash are stable', () => {
  const ids = (list) => list.map((c) => `${c.id}:${c.label}`).join(',');
  const editor = fs.readFileSync(new URL('../skill-editor.html', import.meta.url), 'utf8');
  const editorCats = /var CATS = \[([\s\S]*?)\n  \];/.exec(editor)[1];
  const editorIds = [...editorCats.matchAll(/\{ id: '([^']+)', label: '([^']+)'/g)].map((m) => `${m[1]}:${m[2]}`);
  const retire = fs.readFileSync(new URL('../skills-retire.mjs', import.meta.url), 'utf8');
  const retireIds = [.../export const CATS = \[([\s\S]*?)\n\];/.exec(retire)[1].matchAll(/\{ id: '([^']+)', label: '([^']+)'/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.equal(ids(CATALOG), editorIds.join(','), 'the job and the editor share one category list');
  assert.equal(ids(CATALOG), retireIds.join(','), 'the retire page still uses the same ids and colours');

  assert.deepEqual(tokenize('Review-logins and reviews'), ['review', 'login', 'review']);
  assert.equal(skillHash('a\r\nb'), skillHash('a\nb'), 'CRLF and LF hash the same');
  assert.notEqual(skillHash('a\nb'), skillHash('a\nb '.trim() + ' '));
  assert.deepEqual(frontmatter('---\nname: x\ncategory: Design\n---\n\nbody'), { name: 'x', category: 'Design' });
});

test('code first: keyword, folder, frontmatter and TF-IDF similarity place skills without the model', async () => {
  const fx = fixture();
  fx.skill('brand-kit', 'create brand logos and visual identity assets for launches');
  fx.skill('logo-finder', 'find brand logos and visual identity assets from the web');
  fx.skill('weekly-review', 'review pull requests and report problems');
  fx.write('.agents/skills/design/pattern-library/SKILL.md', '---\nname: pattern-library\ndescription: color palettes and typography for interfaces\n---\n');
  fx.skill('search-helper', 'nothing here', '');
  fx.write('.agents/skills/search-helper/SKILL.md', '---\nname: search-helper\ndescription: sorts documents into shelves\ncategory: review\n---\n');
  let called = 0;
  const ask = async () => { called++; return null; };
  const run = await runGrouping(opts(fx, ask));
  assert.equal(called, 0, 'nothing was left for the model');
  assert.deepEqual(run.payload.assignments, {
    'brand-kit': 'design', 'logo-finder': 'design', 'pattern-library': 'design',
    'weekly-review': 'review', 'search-helper': 'review',
  });
  const state = readState(fx.data);
  assert.equal(state.assignments['logo-finder'].source, 'similar', 'similarity placed it');
  assert.equal(state.assignments['weekly-review'].source, 'keyword');
  assert.equal(state.assignments['pattern-library'].source, 'folder');
  assert.equal(state.assignments['search-helper'].source, 'frontmatter');
  for (const row of readLog(fx.data)) assert.ok(!String(row.skill || '').includes(fx.home), 'log holds skill names only');
});

test('only new or changed skills are looked at again', async () => {
  const fx = fixture();
  fx.skill('weekly-review', 'review pull requests');
  fx.skill('orchard-keeper', 'tend apple trees and harvest fruit');
  let called = 0;
  const ask = async () => { called++; return { model: 'stub', text: JSON.stringify({ create: [{ label: 'Orchard', skills: ['orchard-keeper'], reason: 'garden work' }] }) }; };
  const first = await runGrouping(opts(fx, ask));
  assert.equal(first.changed, 2);
  assert.equal(called, 1);
  assert.equal(first.payload.assignments['weekly-review'], 'review');
  assert.equal(first.payload.suggestions[0].label, 'Orchard');

  const second = await runGrouping(opts(fx, ask));
  assert.equal(second.changed, 0, 'unchanged skills are skipped by hash');
  assert.equal(called, 1, 'no second model call');

  fx.skill('weekly-review', 'review pull requests and close stale issues');
  const third = await runGrouping(opts(fx, ask));
  assert.equal(third.changed, 1, 'the changed skill is picked up again');
  assert.equal(third.payload.assignments['weekly-review'], 'review');
});

test('a new category waits as a suggestion, is logged, and Accept applies it undoably', async () => {
  const fx = fixture();
  fx.skill('orchard-keeper', 'tend apple trees and harvest fruit');
  fx.skill('vine-tender', 'prune grape vines each season');
  const ask = async () => ({ model: 'stub', text: JSON.stringify({ create: [{ label: 'Orchard', skills: ['orchard-keeper', 'vine-tender'], reason: 'garden work' }] }) });
  const run = await runGrouping(opts(fx, ask));
  assert.equal(run.payload.assignments['orchard-keeper'], undefined, 'a new category is never applied by itself');
  assert.equal(run.payload.suggestions.length, 1);
  assert.equal(run.payload.suggestions[0].label, 'Orchard');
  assert.deepEqual(run.payload.suggestions[0].skills.sort(), ['orchard-keeper', 'vine-tender']);
  assert.equal(run.payload.canUndo, false);

  const accepted = acceptSuggestion(run.payload.suggestions[0].id, { data: fx.data, now: () => FIXED });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.payload.assignments['orchard-keeper'], 'orchard');
  assert.equal(accepted.payload.assignments['vine-tender'], 'orchard');
  assert.equal(accepted.payload.suggestions.length, 0);
  const cat = accepted.payload.categories.find((c) => c.id === 'orchard');
  assert.ok(cat && cat.label === 'Orchard' && !cat.builtin, 'the category now exists');
  assert.equal(accepted.payload.canUndo, true);

  const log = readLog(fx.data);
  assert.ok(log.some((r) => r.action === 'accept' && r.label === 'Orchard'), 'the accept is logged');
  assert.equal(log.filter((r) => r.action === 'move' && r.source === 'accepted').length, 2, 'both moves are logged');
  assert.ok(JSON.parse(fs.readFileSync(path.join(fx.data, STATE_FILE), 'utf8')).assignments['orchard-keeper'], 'state is in the data folder');

  const undone = undoLast({ data: fx.data, now: () => FIXED });
  assert.equal(undone.ok, true);
  assert.deepEqual(undone.payload.assignments, {});
  assert.ok(!undone.payload.categories.some((c) => c.id === 'orchard'), 'undo removes the created category');
  assert.equal(undone.payload.suggestions.length, 1, 'undo brings the chip back');
  assert.ok(readLog(fx.data).some((r) => r.action === 'undo'), 'the undo is logged');
});

test('Reject is logged, undoable, and not proposed again for the same skill content', async () => {
  const fx = fixture();
  fx.skill('orchard-keeper', 'tend apple trees and harvest fruit');
  let called = 0;
  const ask = async () => { called++; return { model: 'stub', text: JSON.stringify({ create: [{ label: 'Orchard', skills: ['orchard-keeper'], reason: 'garden work' }] }) }; };
  const run = await runGrouping(opts(fx, ask));
  const id = run.payload.suggestions[0].id;
  const rejected = rejectSuggestion(id, { data: fx.data, now: () => FIXED });
  assert.equal(rejected.ok, true);
  assert.equal(rejected.payload.suggestions.length, 0);
  assert.equal(rejected.payload.canUndo, true);
  assert.ok(readLog(fx.data).some((r) => r.action === 'reject' && r.label === 'Orchard'));

  const again = await runGrouping(opts(fx, ask));
  assert.equal(again.payload.suggestions.length, 0, 'the same content is not re-proposed');

  const undone = undoLast({ data: fx.data, now: () => FIXED });
  assert.equal(undone.ok, true);
  assert.equal(undone.payload.suggestions.length, 1, 'undo restores the rejected chip');

  const missing = rejectSuggestion('nope', { data: fx.data });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);
  const nothing = undoLast({ data: path.join(fx.home, 'empty') });
  assert.equal(nothing.ok, false);
  assert.equal(nothing.status, 409);
});

test('the model may choose an existing category, and its answer is validated', async () => {
  const fx = fixture();
  fx.skill('orchard-keeper', 'tend apple trees and harvest fruit');
  fx.skill('vine-tender', 'prune grape vines each season');
  const ask = async () => ({
    model: 'haiku',
    text: '```json\n' + JSON.stringify({
      assign: [{ skill: 'orchard-keeper', category: 'Design' }, { skill: 'not-a-skill', category: 'design' }, { skill: 'vine-tender', category: 'invented' }],
      create: [{ label: 'Review', skills: ['vine-tender'] }, { label: 'Vineyard', skills: ['not-a-skill'] }],
    }) + '\n```',
  });
  const run = await runGrouping(opts(fx, ask));
  assert.equal(run.payload.assignments['orchard-keeper'], 'design', 'label "Design" maps to the built-in id');
  assert.equal(run.payload.assignments['vine-tender'], 'review', 'a "new" label that already exists becomes an assignment');
  assert.equal(run.payload.suggestions.length, 0, 'unknown skills are dropped');
  assert.equal(run.model, 'haiku');
  assert.ok(readLog(fx.data).some((r) => r.action === 'move' && r.model === 'haiku'));
});

test('no model available: the job skips quietly and retries on the next run', async () => {
  const fx = fixture();
  fx.skill('orchard-keeper', 'tend apple trees and harvest fruit');
  let called = 0;
  const ask = async () => { called++; return null; };
  const first = await runGrouping(opts(fx, ask));
  assert.equal(first.skipped, 1);
  assert.equal(first.payload.suggestions.length, 0);
  assert.deepEqual(first.payload.assignments, {});
  assert.equal(readState(fx.data).attempts['orchard-keeper'].blocked, true);
  assert.equal(readLog(fx.data).length, 0, 'a skip is not a move and is not logged as one');

  const second = await runGrouping(opts(fx, ask));
  assert.equal(called, 2, 'the unplaced skill is retried');
  assert.equal(second.skipped, 1);

  // A model that throws is the same as an unavailable one.
  const throwing = async () => { throw new Error('pi not installed'); };
  const third = await runGrouping(opts(fx, throwing));
  assert.equal(third.skipped, 1);

  // Never ask at all when the owner turned the model off.
  const off = await runGrouping({ ...opts(fx, async () => { throw new Error('must not be called'); }), ask: async () => null });
  assert.equal(off.skipped, 1);
});

test('a human (manual or accepted) choice is never overridden', async () => {
  const fx = fixture();
  fx.skill('weekly-review', 'review pull requests');
  const data = fx.data;
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, STATE_FILE), JSON.stringify({
    version: 1,
    categories: [{ id: 'research', label: 'Research', source: 'model', color: 0 }],
    assignments: { 'weekly-review': { category: 'research', source: 'accepted', at: FIXED } },
    hashes: { 'weekly-review': 'stale' }, suggestions: [], rejected: {}, history: [],
  }));
  let called = 0;
  const run = await runGrouping(opts(fx, async () => { called++; return null; }));
  assert.equal(run.changed, 0, 'the locked skill is not even re-classified');
  assert.equal(run.payload.assignments['weekly-review'], 'research');
  assert.equal(called, 0);
});

test('classifyByCode only fires on a close match', () => {
  const skills = [
    { short: 'brand-kit', folder: '', description: 'create brand logos and visual identity assets', fm: {}, body: '' },
    { short: 'ledger-sync', folder: '', description: 'reconcile bank ledgers with invoices', fm: {}, body: '' },
    { short: 'logo-finder', folder: '', description: 'find brand logos and visual identity assets', fm: {}, body: '' },
    { short: 'orchard-keeper', folder: '', description: 'tend apple trees', fm: {}, body: '' },
  ];
  const state = { assignments: { 'brand-kit': { category: 'design', source: 'keyword', at: FIXED } }, categories: [], hashes: {} };
  const profiles = buildProfiles(skills);
  const strong = classifyByCode(skills[2], { state, skills, profiles });
  const weak = classifyByCode(skills[3], { state, skills, profiles });
  assert.equal(strong.category, 'design');
  assert.equal(weak, null);
});

test('the grouping API is same-origin JSON only and applies Accept, Reject and Undo', async (t) => {
  const fx = fixture();
  fx.skill('orchard-keeper', 'tend apple trees');
  fx.skill('vine-tender', 'prune grape vines');
  const child = spawn(process.execPath, ['app/server.mjs', '0'], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: fx.home, USERPROFILE: fx.home,
      AGENTGLIM_DATA: fx.data, AGENTGLIM_ENV_FILE: path.join(fx.home, 'env'),
      AGENTGLIM_CONFIG: path.join(fx.home, 'harness.json'), AGENTGLIM_PLANS: path.join(fx.home, 'plans'), AGENTGLIM_DEV: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, 'exit'); fs.rmSync(fx.home, { recursive: true, force: true }); });
  const port = await waitForServerReady(child);
  const base = `http://127.0.0.1:${port}`;
  const write = (state) => fs.writeFileSync(path.join(fx.data, STATE_FILE), JSON.stringify(state, null, 2));
  const suggestion = (id, label, skills) => ({ id, categoryId: label.toLowerCase(), label, skills, reason: 'fixture', source: 'model', at: FIXED });
  write({ version: 1, categories: [], assignments: {}, hashes: {}, attempts: {}, suggestions: [suggestion('new-orchard', 'Orchard', ['orchard-keeper', 'vine-tender']), suggestion('new-vines', 'Vines', ['vine-tender'])], rejected: {}, history: [] });

  const got = await (await fetch(base + '/api/skills/groups')).json();
  assert.equal(got.suggestions.length, 2);
  assert.deepEqual(got.categories.filter((c) => !c.builtin), []);
  const origin = { origin: base, 'content-type': 'application/json' };

  for (const bad of [
    { headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{"id":"new-orchard"}' },
    { headers: { 'content-type': 'application/json' }, body: '{"id":"new-orchard"}' },
    { headers: { origin: base, 'content-type': 'text/plain' }, body: '{"id":"new-orchard"}' },
    { headers: origin, body: '{bad json' },
  ]) {
    const res = await fetch(base + '/api/skills/groups/accept', { method: 'POST', ...bad });
    assert.ok([400, 403].includes(res.status), `refuses the write (${res.status})`);
  }
  assert.equal((await fetch(base + '/api/skills/groups/accept', { headers: origin })).status, 405);
  assert.equal((await fetch(base + '/api/skills/groups/unknown', { method: 'POST', headers: origin, body: '{}' })).status, 404);

  const acceptRes = await fetch(base + '/api/skills/groups/accept', { method: 'POST', headers: origin, body: '{"id":"new-orchard"}' });
  assert.equal(acceptRes.status, 200);
  const accepted = await acceptRes.json();
  assert.deepEqual(accepted.assignments, { 'orchard-keeper': 'orchard', 'vine-tender': 'orchard' });
  assert.ok(accepted.categories.some((c) => c.id === 'orchard' && c.label === 'Orchard'));
  assert.equal(accepted.suggestions.length, 1);

  assert.equal((await fetch(base + '/api/skills/groups/reject', { method: 'POST', headers: origin, body: '{"id":"new-vines"}' })).status, 200);
  const rejected = await (await fetch(base + '/api/skills/groups')).json();
  assert.equal(rejected.suggestions.length, 0);
  assert.equal(rejected.canUndo, true);

  const undoRes = await fetch(base + '/api/skills/groups/undo', { method: 'POST', headers: origin, body: '{}' });
  assert.equal(undoRes.status, 200);
  const undone = await undoRes.json();
  assert.equal(undone.suggestions.length, 1, 'undo restored the rejected Vines chip');
  assert.equal(undone.assignments['vine-tender'], 'orchard', 'the accept is still applied');
  const log = readLog(fx.data);
  assert.ok(log.some((r) => r.action === 'reject' && r.label === 'Vines'));
  assert.ok(log.some((r) => r.action === 'undo'));
});

test('the pi model call tries local Strata, then Haiku on the subscription, and never with an API key', { skip: process.platform === 'win32' && 'fake pi is a shell script' }, async () => {
  const fx = fixture();
  const bin = path.join(fx.home, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  const calls = path.join(fx.home, 'calls.log');
  fs.writeFileSync(path.join(bin, 'pi'), `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
if [ -n "$ANTHROPIC_API_KEY" ]; then printf 'api-key-visible\\n' >> '${calls}'; fi
case "$*" in
  *"--provider strata"*) exit 1 ;;
esac
printf '{"assign":[],"create":[]}'
`);
  fs.chmodSync(path.join(bin, 'pi'), 0o755);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ANTHROPIC_API_KEY: 'fixture-key' };
  const answer = await askPi('sort these skills', { env, timeoutMs: 10000 });
  assert.equal(answer.model, 'haiku', 'the local model failed, so Haiku answered');
  assert.match(answer.text, /assign/);
  const rows = fs.readFileSync(calls, 'utf8').trim().split('\n');
  assert.match(rows[0], /--provider strata/);
  assert.match(rows[1], /--provider anthropic --model haiku/);
  assert.ok(!rows.some((r) => r.includes('api-key-visible')), 'API keys are removed from the child environment');

  // Neither provider answering is a quiet skip, not an error.
  fs.writeFileSync(path.join(bin, 'pi'), '#!/bin/sh\nexit 1\n');
  assert.equal(await askPi('anything', { env, timeoutMs: 10000 }), null);
  fs.rmSync(fx.home, { recursive: true, force: true });
});

test('the scheduler exposes the interface the skill grouping job uses', async () => {
  const { createScheduler } = await import('../scheduler.mjs');
  const sched = createScheduler();
  const job = sched.register('fixture-job', 60_000, async () => {}, { catchUp: true });
  assert.equal(job.name, 'fixture-job');
  assert.equal(job.everyMs, 60_000);
  assert.equal(job.running, false);
  sched.start();
  try {
    assert.ok(job.nextRun, 'a started scheduler sets nextRun');
    const row = sched.status().jobs.find((j) => j.name === 'fixture-job');
    assert.ok(row && row.everyMs === 60_000 && row.lastRun === null, 'status() lists the registered job');
  } finally { sched.stop(); }
});
