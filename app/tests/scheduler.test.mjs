import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createScheduler } from '../scheduler.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('register validates name, interval and function', () => {
  const s = createScheduler();
  assert.throws(() => s.register('', 10, () => {}), /name/);
  assert.throws(() => s.register('x', 0, () => {}), /everyMs/);
  assert.throws(() => s.register('x', 10, null), /fn/);
  s.register('x', 1000, () => {});
  assert.throws(() => s.register('x', 1000, () => {}), /already exists/);
});

test('status reports every job and its schedule', () => {
  const s = createScheduler();
  s.register('one', 60_000, async () => 1, { catchUp: true });
  const st = s.status();
  assert.equal(st.started, false);
  assert.equal(st.jobs.length, 1);
  assert.deepEqual(Object.keys(st.jobs[0]).sort(), ['backoffMs', 'catchUp', 'everyMs', 'failures', 'lastError', 'lastErrorAt', 'lastRun', 'name', 'nextRun', 'running', 'runs'].sort());
  assert.equal(st.jobs[0].name, 'one');
  assert.equal(st.jobs[0].catchUp, true);
});

test('catchUp runs once at start; a job without catchUp waits for its interval', async (t) => {
  t.after(() => { s.stop(); });
  let caught = 0, waited = 0;
  const s = createScheduler();
  s.register('caught', 10_000, async () => { caught++; }, { catchUp: true });
  s.register('waited', 25, async () => { waited++; }, { catchUp: false });
  s.start();
  await sleep(10);
  assert.equal(caught, 1, 'catchUp job ran at start');
  assert.equal(waited, 0, 'no-catchUp job did not run at start');
  await sleep(45);
  assert.ok(waited >= 1, 'no-catchUp job ran on its interval');
});

test('a failing job records the error and keeps its cadence', async (t) => {
  t.after(() => s.stop());
  let runs = 0;
  const s = createScheduler();
  s.register('bad', 20, async () => { runs++; throw new Error('boom'); }, { catchUp: true });
  s.start();
  await sleep(35);
  const job = s.status().jobs[0];
  assert.ok(runs >= 1);
  assert.equal(job.failures >= 1, true);
  assert.match(job.lastError, /boom/);
  assert.ok(job.nextRun, 'next run stays scheduled');
});

test('defer moves the next run without changing the interval', async (t) => {
  t.after(() => s.stop());
  let runs = 0;
  const s = createScheduler();
  s.register('defer', 20, async () => { runs++; }, { catchUp: false });
  s.start();
  const before = Date.now();
  s.defer('defer', 120);
  const st = s.status().jobs[0];
  assert.equal(st.everyMs, 20);
  assert.ok(st.nextRun >= before + 100);
  await sleep(50);
  assert.equal(runs, 0, 'deferred job did not run early');
});

test('runNow returns the job value and never overlaps a running job', async (t) => {
  t.after(() => s.stop());
  let started = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const s = createScheduler();
  s.register('work', 60_000, async () => { started++; await gate; return 7; }, { catchUp: false });
  s.start();
  const first = s.runNow('work');
  await sleep(5);
  const second = await s.runNow('work');
  assert.equal(second, null, 'second run is skipped while the first is running');
  release();
  assert.equal(await first, 7);
  assert.equal(started, 1);
});

test('last-run state persists across scheduler instances', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-scheduler-'));
  const file = path.join(dir, 'state.json');
  const a = createScheduler({ stateFile: file });
  a.register('persist', 3600_000, async () => 'ok', { catchUp: false });
  a.start();
  await a.runNow('persist');
  a.stop();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(saved.persist);
  const b = createScheduler({ stateFile: file });
  b.register('persist', 3600_000, async () => 'ok', { catchUp: true });
  assert.equal(b.status().jobs[0].lastRun, saved.persist);
  b.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
