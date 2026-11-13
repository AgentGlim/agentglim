// scheduler.mjs: one small in-process scheduler shared by the Goals sub-app (plan 1) and the
// skill auto-grouping job (plan 2). Interface documented in docs/scheduler.md.
//
//   import { register, status, start, stop, runNow, defer } from './scheduler.mjs';
//   register('goals-refresh', 4 * 3600e3, refresh, { catchUp: true });
//   start();
//
// Rules: one timer per job, never two runs of the same job at once, errors are recorded and never
// thrown at the timer, and `catchUp` runs a job once at start when its last run is missing or older
// than its interval. State is optional and only stores last-run timestamps.
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_ERROR = 300;

export function createScheduler({
  stateFile = null,
  now = () => Date.now(),
  setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutFn = (timer) => clearTimeout(timer),
} = {}) {
  const jobs = new Map();
  let started = false;
  let persisted = loadState(stateFile);

  function loadState(file) {
    if (!file) return {};
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j === 'object' ? j : {}; }
    catch { return {}; }
  }
  function saveState() {
    if (!stateFile) return;
    const out = {};
    for (const job of jobs.values()) if (job.lastRun) out[job.name] = job.lastRun;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(`${stateFile}.next`, JSON.stringify(out, null, 2) + '\n');
      fs.renameSync(`${stateFile}.next`, stateFile);
    } catch { /* a scheduler must never fail the server because a cache file cannot be written */ }
  }
  function clear(job) {
    if (job.timer) { clearTimeoutFn(job.timer); job.timer = null; }
  }
  function schedule(job, delay = job.everyMs) {
    clear(job);
    if (!started) return;
    job.nextRun = now() + Math.max(0, delay);
    job.timer = setTimeoutFn(() => fire(job), Math.max(0, delay));
    job.timer?.unref?.();
  }
  async function fire(job) {
    if (!started) return null;
    job.timer = null;
    if (job.running) { schedule(job); return null; }
    job.running = true;
    job.runs++;
    const startedAt = now();
    try {
      const value = await job.fn();
      job.lastRun = startedAt;
      job.lastError = null;
      job.failures = 0;
      persisted[job.name] = startedAt;
      saveState();
      return value;
    } catch (error) {
      job.failures++;
      job.lastError = String(error?.message || error).slice(0, DEFAULT_MAX_ERROR);
      job.lastErrorAt = now();
      return null;
    } finally {
      job.running = false;
      schedule(job);
    }
  }

  function register(name, everyMs, fn, { catchUp = false } = {}) {
    if (typeof name !== 'string' || !name) throw new TypeError('register: name must be a non-empty string');
    if (!Number.isFinite(everyMs) || everyMs <= 0) throw new TypeError('register: everyMs must be a positive number');
    if (typeof fn !== 'function') throw new TypeError('register: fn must be a function');
    if (jobs.has(name)) throw new Error(`register: a job named ${name} already exists`);
    const job = { name, everyMs, fn, catchUp, running: false, runs: 0, failures: 0, lastRun: persisted[name] || null,
      lastError: null, lastErrorAt: null, nextRun: null, timer: null };
    jobs.set(name, job);
    if (started) scheduleFirst(job);
    return job;
  }

  function scheduleFirst(job) {
    const due = job.catchUp && (!job.lastRun || now() - job.lastRun >= job.everyMs);
    schedule(job, due ? 0 : job.everyMs);
  }

  function start() {
    if (started) return status();
    started = true;
    for (const job of jobs.values()) scheduleFirst(job);
    return status();
  }

  function stop() {
    started = false;
    for (const job of jobs.values()) { clear(job); job.nextRun = null; }
    saveState();
    return status();
  }

  function defer(name, ms) {
    const job = jobs.get(name);
    if (!job) throw new Error(`defer: unknown job ${name}`);
    if (!Number.isFinite(ms) || ms < 0) throw new TypeError('defer: ms must be a non-negative number');
    job.backoffMs = ms;
    if (started) schedule(job, ms); else job.nextRun = now() + ms;
    return job.nextRun;
  }

  async function runNow(name) {
    const job = jobs.get(name);
    if (!job) throw new Error(`runNow: unknown job ${name}`);
    if (job.running) return null;
    clear(job);
    job.nextRun = null;
    const value = await fire(job);
    // fire() schedules the regular interval; a manual run keeps the normal cadence.
    return value;
  }

  function status() {
    return {
      started,
      jobs: [...jobs.values()].map((job) => ({
        name: job.name, everyMs: job.everyMs, catchUp: job.catchUp, running: job.running,
        runs: job.runs, failures: job.failures, lastRun: job.lastRun, lastError: job.lastError,
        lastErrorAt: job.lastErrorAt, nextRun: job.nextRun, backoffMs: job.backoffMs || null,
      })),
    };
  }

  return { register, status, start, stop, runNow, defer };
}

// Shared process-wide scheduler used by server.mjs. Tests create their own isolated instance.
export const scheduler = createScheduler();
export const register = (...args) => scheduler.register(...args);
export const status = () => scheduler.status();
export const start = () => scheduler.start();
export const stop = () => scheduler.stop();
export const runNow = (name) => scheduler.runNow(name);
export const defer = (name, ms) => scheduler.defer(name, ms);
