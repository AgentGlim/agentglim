import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { watcherState, harnessInstalled, superagentBeat } from '../watchers.mjs';
import { watcherActive } from '../portable.mjs';
import { fixtureServer } from './helpers/fixture-server.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ag-watchers-'));
const touch = (file, at) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ''); fs.utimesSync(file, new Date(at), new Date(at)); };

// A brand-new install has no `_run/bin/auditq-wait.sh` and no `_run/bin/superagent-check.sh`. The header used to
// report those two scripts anyway, so it said "off, last beat never" whatever the user's SuperAgent did.
test('a fresh install without the harness scripts reports one SuperAgent heartbeat, not two missing harness watchers', () => {
  const data = tmp(), run = tmp(), now = Date.now();
  assert.equal(harnessInstalled(run), false);
  const w = watcherState({ data, run, now });
  assert.equal(w.kind, 'superagent');
  assert.equal(w.queue, undefined);
  assert.equal(w.check, undefined);
  assert.equal(w.superagent.at, null);
  assert.equal(w.superagent.ok, false);
  assert.equal(w.armed, false);
});

test('the documented private heartbeat arms the generic watcher, and the header agrees with the "send status" banner', () => {
  const data = tmp(), run = tmp(), now = Date.now();
  const beat = path.join(data, 'heartbeats', 'superagent'); // SETUP.md and AGENTS.md: touch this while supervising
  touch(beat, now - 2 * 60e3);
  const w = watcherState({ data, run, now });
  assert.equal(w.kind, 'superagent');
  assert.equal(w.superagent.ok, true);
  assert.equal(w.armed, true);
  assert.ok(Math.abs(w.superagent.at - (now - 2 * 60e3)) < 1000);
  assert.equal(watcherActive(now, { data, run }), true);
  assert.equal(watcherState({ data, run, now: now + 46 * 60e3 }).armed, false);
  assert.equal(watcherState({ data, run, now: now + 46 * 60e3 }).superagent.ok, false);
  assert.equal(watcherActive(now + 46 * 60e3, { data, run }), false);
});

test('the generic heartbeat also reads a harness heartbeats folder and the Codex bridge health file in seconds', () => {
  const data = tmp(), run = tmp(), now = Date.now();
  touch(path.join(run, 'heartbeats', 'superagent'), now - 60e3);
  assert.equal(watcherState({ data, run, now }).superagent.ok, true);
  const data2 = tmp(), run2 = tmp();
  fs.mkdirSync(path.join(run2, 'flags'), { recursive: true });
  fs.writeFileSync(path.join(run2, 'flags', 'watcher-bridge-health.json'), JSON.stringify({ at: now / 1000, error: null }));
  assert.equal(superagentBeat({ data: data2, run: run2 }) != null, true);
  assert.equal(watcherState({ data: data2, run: run2, now }).superagent.ok, true);
  fs.writeFileSync(path.join(run2, 'flags', 'watcher-bridge-health.json'), JSON.stringify({ at: now / 1000, error: 'stopped' }));
  assert.equal(watcherState({ data: data2, run: run2, now }).superagent.ok, false); // an errored bridge is not a beat
});

test('only the installed harness scripts are reported, so a missing one never shows as off forever', () => {
  const data = tmp(), run = tmp(), now = Date.now();
  fs.mkdirSync(path.join(run, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(run, 'bin', 'auditq-wait.sh'), '');
  touch(path.join(run, 'heartbeats', 'auditq-wait'), now - 60e3);
  const w = watcherState({ data, run, now });
  assert.equal(w.kind, 'harness');
  assert.equal(w.queue.ok, true);
  assert.equal(w.check, undefined); // superagent-check.sh is not installed here
  // the listener's own beat is also read by the broad SuperAgent reader (it lives in the harness heartbeats folder),
  // but the queue entry is reported separately as extra information
  assert.equal(w.superagent.ok, true);
  assert.equal(w.armed, true);
});

// The reported bug: setup links auditq-wait.sh, which switched the old state to harness mode and made only the
// listener's beat count, so the documented SuperAgent heartbeat never armed the header.
test('the SuperAgent heartbeat arms the header on a harness install, whatever the listener is doing', () => {
  const data = tmp(), run = tmp(), now = Date.now();
  fs.mkdirSync(path.join(run, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(run, 'bin', 'auditq-wait.sh'), '');
  touch(path.join(run, 'heartbeats', 'auditq-wait'), now - 60 * 60e3);
  assert.equal(watcherState({ data, run, now }).queue.ok, false, 'the listener is silent here');
  assert.equal(watcherState({ data, run, now }).armed, false, 'a silent listener and no SuperAgent beat is not armed');
  touch(path.join(data, 'heartbeats', 'superagent'), now - 2 * 60e3);
  const w = watcherState({ data, run, now });
  assert.equal(w.armed, true, 'a fresh SuperAgent heartbeat is armed even while the listener is silent');
  assert.equal(w.superagent.ok, true);
  assert.equal(w.queue.ok, false, 'the listener entry stays extra information');
});

test('installed harness scripts keep the queue watcher and the 30-minute check as extra information', () => {
  const data = tmp(), run = tmp(), now = Date.now();
  fs.mkdirSync(path.join(run, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(run, 'bin', 'auditq-wait.sh'), '');
  fs.writeFileSync(path.join(run, 'bin', 'superagent-check.sh'), '');
  assert.equal(harnessInstalled(run), true);
  touch(path.join(run, 'heartbeats', 'auditq-wait'), now - 60e3);
  touch(path.join(run, 'heartbeats', 'superagent-check'), now - 20 * 60e3);
  const w = watcherState({ data, run, now });
  assert.equal(w.kind, 'harness');
  assert.equal(w.queue.ok, true);
  assert.equal(w.check.ok, true);
  assert.equal(typeof w.armed, 'boolean');
  assert.equal(watcherState({ data, run, now: now + 11 * 60e3 }).queue.ok, false);
  assert.equal(watcherState({ data, run, now: now + 46 * 60e3 }).armed, false, 'nothing beats for 46 minutes: not armed');
  // older installs armed before the heartbeat file existed only touch the queue's .alive
  touch(path.join(run, 'audit_queue', '.alive'), now - 60e3);
  fs.rmSync(path.join(run, 'heartbeats', 'auditq-wait'));
  assert.equal(watcherState({ data, run, now }).queue.ok, true);
});

test('the snapshot behind the header dot uses the generic watcher, not missing harness scripts, on a fresh server', async (t) => {
  const f = fixtureServer('ag-watchers-ui-');
  t.after(() => f.stop());
  const base = await f.start();
  const fresh = (await (await fetch(base + '/api/snapshot')).json()).watchers;
  assert.equal(fresh.kind, 'superagent'); // pre-fix: { queue, check } with ok false and at null
  assert.equal(fresh.queue, undefined);
  assert.equal(fresh.check, undefined);
  assert.equal(fresh.superagent.ok, false);
  assert.equal(fresh.armed, false);
  assert.equal(fresh.superagent.maxMin, 45);
});
