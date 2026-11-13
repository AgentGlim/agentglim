// One plan, one section (owner rule 2026-11-13). A demo plan was listed in both Active builds and Pipeline
// because a plan with a live driver stage (liveBuild, no ACTIVE marker) was added to Active builds on 2026-11-12
// but the Pipeline filter only dropped activeBuild plans. The rule now lives in app/sections.mjs, server.mjs
// stamps every project with `section`, and both tables (and the phone cards) read it, so this test can prove:
//   - the precedence: Active builds > Pipeline, held/done stay in Pipeline
//   - no plan is in two sections, in the data split and in the phone cards
//   - index.html's Pipeline filter and Active product rows use the shared section, not their own conditions
//   - a live snapshot (when the app runs) has no plan in two tables
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AGENTGLIM_PLAN, sectionOf, bySection, overlapDirs } from '../sections.mjs';
import { phoneSnapshot } from '../control/push/phone-snapshot.mjs';

// snapshot-shaped plans (server.mjs projects()): only the fields the rule reads, plus what the phone card reads
const plan = (o) => ({ dir: '00-x', stage: '', progress: null, sub: null, active: 0, held: null, cat: 'Agents', tokens: 0, working: [], ...o });
const fixture = () => [
  plan({ dir: '10-demo-app', stage: 'v15-r2', liveBuild: { stage: 'v15-r2', models: ['deepseek-v4.1-flash'], running: true } }), // the 2026-11-13 bug
  plan({ dir: '11-sample-tool', stage: 'v10-setup', activeBuild: { note: 'gate' } }),
  plan({ dir: '20-sample-site', stage: 'v5-r2', liveBuild: { stage: 'v5-r2', running: true }, merged: ['40-merged-a', '41-merged-b'] }),
  plan({ dir: '21-sample-video', stage: 'done', merged: ['22-sample-motion'] }), // product row WITH driver state: Pipeline only
  plan({ dir: '30-sample-leads', stage: 'v1-r1', held: 'on hold', merged: ['31-sample-prospect'] }),
  plan({ dir: '50-new-plan', noState: true }), // plan written, driver never ran it: Active builds
  plan({ dir: '60-sample-product', noState: true, merged: ['61-sample-child'] }),
  plan({ dir: '70-sample-dashboard', stage: 'done', foldedInto: '71-x' }), // folded child: not a product row
  plan({ dir: AGENTGLIM_PLAN, stage: 'v10-r1' }), // the AgentGlim row is always Active builds
];
const dirs = (rows) => rows.map((p) => p.dir).sort();

test('precedence is Active builds > Pipeline; held and done stay in Pipeline', () => {
  const s = bySection(fixture());
  assert.deepEqual(dirs(s.active), ['11-sample-tool', '10-demo-app', '20-sample-site', '60-sample-product', '50-new-plan', AGENTGLIM_PLAN].sort(),
    'live rounds (activeBuild or liveBuild), product rows the driver never ran, and the AgentGlim plan are Active builds');
  assert.deepEqual(dirs(s.pipeline), ['70-sample-dashboard', '21-sample-video', '30-sample-leads'].sort(),
    'a product row with driver state (done, on hold) and a folded child are Pipeline rows');
  assert.equal(sectionOf({ dir: '10-demo-app', activeBuild: { note: 'gate' }, liveBuild: { running: true } }), 'active', 'activeBuild wins too');
  assert.equal(sectionOf({ dir: '30-sample-leads', held: 'on hold', merged: ['31-sample-prospect'], liveBuild: null }), 'pipeline', 'held alone does not make a build');
  assert.equal(sectionOf(null), 'pipeline');
});

test('a plan is never in two sections (data split)', () => {
  const s = bySection(fixture());
  assert.deepEqual(overlapDirs(s.active, s.pipeline), [], 'no dir in both Active builds and Pipeline');
  assert.equal(s.active.length + s.pipeline.length, fixture().length, 'every plan lands in exactly one section');
});

test('a plan is never in two sections (phone cards read the same rule)', () => {
  const projects = fixture().map((p) => ({ ...p, section: sectionOf(p) }));
  const snap = phoneSnapshot({ projects });
  assert.deepEqual(overlapDirs(snap.builds, snap.pipeline), [], 'no dir in both phone cards');
  assert.ok(snap.builds.some((b) => b.dir === '10-demo-app'), 'the demo plan is an Active builds card');
  assert.ok(!snap.pipeline.some((p) => p.dir === '10-demo-app'), 'the demo plan is not a Pipeline card');
  assert.ok(snap.pipeline.some((p) => p.dir === '30-sample-leads'), 'the held product row keeps its Pipeline card');
});

test('the dashboard tables read the shared section field', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /const SEC = \(p\) => p\.section \|\|/, 'one SEC helper from p.section (with a fallback)');
  assert.match(html, /shown\.filter\(\(x\) => SEC\(x\) !== 'active'/, 'the Pipeline loop drops every plan the section says is an Active build');
  assert.match(html, /const parents = s\.projects\.filter\(\(p\) => SEC\(p\) === 'active' && prow\(p\)\)/, 'Active product rows are only the ones in the active section');
  assert.doesNotMatch(html, /shown\.filter\(\(x\) => !x\.activeBuild/, 'the old activeBuild-only Pipeline filter is gone (it let liveBuild plans through)');
});

test('live snapshot (opt in with AGENTGLIM_LIVE_SNAPSHOT=1): no plan in two tables, the app own plan is Active builds only', async (t) => {
  // Opt-in only: this reads a running app's snapshot, which is the owner's live data on this machine.
  if (process.env.AGENTGLIM_LIVE_SNAPSHOT !== '1') {
    t.skip('set AGENTGLIM_LIVE_SNAPSHOT=1 to check a running app (does not touch live data otherwise)');
    return;
  }
  const url = process.env.AGENTGLIM_SNAPSHOT_URL || 'http://127.0.0.1:18990/api/snapshot';
  let snap;
  try {
    snap = await (await fetch(url, { signal: AbortSignal.timeout(20000) })).json();
  } catch {
    t.skip(`app not reachable at ${url}`);
    return;
  }
  const s = bySection(snap.projects || []);
  assert.deepEqual(overlapDirs(s.active, s.pipeline), [], 'live snapshot: no plan in both tables');
  for (const p of snap.projects || []) assert.ok(['active', 'pipeline'].includes(p.section), `${p.dir} carries a section`);
  const own = (snap.projects || []).find((p) => p.dir === AGENTGLIM_PLAN);
  if (own) assert.ok(!s.pipeline.some((p) => p.dir === AGENTGLIM_PLAN), 'the app own plan is an Active builds row, not a Pipeline row');
  const phone = phoneSnapshot(snap);
  assert.deepEqual(overlapDirs(phone.builds, phone.pipeline), [], 'live snapshot: no plan in both phone cards');
});
