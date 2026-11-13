// Regression: a SuperAgent heartbeat touched where AGENTS.md/SETUP.md tell it to (private data,
// `heartbeats/superagent`) must show in the dashboard. Before this test, /api/snapshot only read the plans
// harness heartbeat files, so a Codex SuperAgent on a fresh install "had never done anything" forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureServer } from './helpers/fixture-server.mjs';
import { superagentView, watchersView, SUPERAGENT_MAX_MIN } from '../heartbeats.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ag-heartbeats-'));
const touch = (file, at) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  fs.utimesSync(file, new Date(at), new Date(at));
};
const MIN = 60e3;

test('the private data heartbeat is the SuperAgent beat; the harness beats are read too, freshness is 45 min', () => {
  const root = tmp(), data = path.join(root, 'data'), run = path.join(root, 'plans', '_run');
  const now = Date.now();
  let v = superagentView({ data, run, now });
  assert.deepEqual([v.at, v.ok, v.maxMin], [null, false, SUPERAGENT_MAX_MIN]);
  touch(path.join(data, 'heartbeats', 'superagent'), now - 2 * MIN);
  v = superagentView({ data, run, now });
  assert.equal(v.ok, true);
  assert.ok(Math.abs(v.at - (now - 2 * MIN)) < 1000);
  touch(path.join(data, 'heartbeats', 'superagent'), now - 46 * MIN);
  assert.equal(superagentView({ data, run, now }).ok, false);
  // older harnesses may keep it under the run folder; the newest of the two wins
  touch(path.join(run, 'heartbeats', 'superagent'), now - 1 * MIN);
  assert.equal(superagentView({ data, run, now }).ok, true);
});

test('watchersView separates the private heartbeat from harness watchers and says whether a harness exists', () => {
  const root = tmp(), data = path.join(root, 'data'), run = path.join(root, 'plans', '_run');
  const now = Date.now();
  touch(path.join(data, 'heartbeats', 'superagent'), now);
  let w = watchersView({ data, run, now });
  assert.equal(w.superagent.ok, true);
  assert.equal(w.queue.ok, false);
  assert.equal(w.check.ok, false);
  assert.equal(w.harness, false); // no plans harness: queue/check must not be demanded
  fs.mkdirSync(run, { recursive: true });
  touch(path.join(run, 'heartbeats', 'auditq-wait'), now);
  touch(path.join(run, 'heartbeats', 'superagent-check'), now - 5 * MIN);
  w = watchersView({ data, run, now });
  assert.equal(w.harness, true);
  assert.equal(w.queue.ok, true);
  assert.equal(w.check.ok, true);
  // the queue watcher's older fallback file still counts
  fs.rmSync(path.join(run, 'heartbeats', 'auditq-wait'));
  touch(path.join(run, 'audit_queue', '.alive'), now - 3 * MIN);
  assert.equal(watchersView({ data, run, now }).queue.ok, true);
});

test('a fresh heartbeat in private data reaches /api/snapshot and /api/harness without a plans harness', async (t) => {
  const fx = fixtureServer('ag-hb-');
  t.after(() => fx.close());
  const base = await fx.start();
  let snap = await (await fetch(`${base}/api/snapshot`)).json();
  assert.equal(snap.watchers.superagent?.ok, false);
  assert.equal(snap.watchers.harness, false);
  touch(path.join(fx.data, 'heartbeats', 'superagent'), Date.now());
  snap = await (await fetch(`${base}/api/snapshot`)).json();
  assert.equal(snap.watchers.superagent.ok, true);
  assert.ok(snap.watchers.superagent.at > 0);
  assert.equal(snap.watchers.harness, false);
  const portable = await (await fetch(`${base}/api/portable`)).json();
  assert.equal(portable.watcher, true); // the banner already agreed; the dot and the Harness page now do too
  const h = await (await fetch(`${base}/api/harness`)).json();
  assert.ok(Number.isFinite(h.watcher.superagentAgeS), 'a real age, not null: the Harness page sees the beat');
  assert.equal(h.watcher.superagentOk, true);
  assert.equal(h.watcher.queueFound, false);
});

// The header dot, the portable banner and the Harness page must agree on a heartbeat the portable reader already
// accepted (a healthy Codex bridge, any file in a heartbeats folder, the queue's .alive): the snapshot used to
// re-read only the literal `superagent` file and reported "never" while the banner said the watcher was active.
test('a bridge-only beat reaches /api/snapshot and /api/harness, not only the portable banner', async (t) => {
  const fx = fixtureServer('ag-hb-bridge-');
  t.after(() => fx.close());
  const base = await fx.start();
  const run = path.join(fx.home, 'plans', '_run');
  fs.mkdirSync(path.join(run, 'flags'), { recursive: true });
  fs.writeFileSync(path.join(run, 'flags', 'watcher-bridge-health.json'), JSON.stringify({ at: Date.now() / 1000, error: null }));
  const snap = await (await fetch(`${base}/api/snapshot`)).json();
  assert.equal(snap.watchers.superagent.ok, true, 'the snapshot reads the same bridge the banner reads');
  assert.equal(snap.watchers.queue, undefined, 'no watcher scripts installed: no queue entry to report');
  assert.equal(snap.watchers.check, undefined);
  const portable = await (await fetch(`${base}/api/portable`)).json();
  assert.equal(portable.watcher, true);
  const h = await (await fetch(`${base}/api/harness`)).json();
  assert.ok(Number.isFinite(h.watcher.superagentAgeS), 'the Harness page shows the same beat, not null');
  assert.equal(h.watcher.superagentOk, true);
});

// A run folder with no watcher scripts (a fresh scaffold before auditq-wait.sh/superagent-check.sh are linked)
// must not make the header name two scripts that cannot run yet; only the private heartbeat is reported.
test('an empty run folder reports no harness watchers, only the private heartbeat', async (t) => {
  const fx = fixtureServer('ag-hb-run-');
  t.after(() => fx.close());
  const base = await fx.start();
  fs.mkdirSync(path.join(fx.home, 'plans', '_run'), { recursive: true });
  touch(path.join(fx.data, 'heartbeats', 'superagent'), Date.now());
  const snap = await (await fetch(`${base}/api/snapshot`)).json();
  assert.equal(snap.watchers.harness, true);
  assert.equal(snap.watchers.queue, undefined);
  assert.equal(snap.watchers.check, undefined);
  assert.equal(snap.watchers.superagent.ok, true);
});

test('the header names only the watcher entries the snapshot carries', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /if \(w\.queue\) \{ if \(w\.queue\.ok\)/, 'queue watcher is named only when the snapshot has it');
  assert.match(html, /if \(w\.check\) \{ if \(w\.check\.ok\)/, '30-minute check is named only when the snapshot has it');
  assert.doesNotMatch(html, /const harness = w\.harness/, 'a run folder alone must not demand both watcher scripts');
});
