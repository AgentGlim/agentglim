// goals-jobs.mjs: the two scheduled Goals jobs, built on app/scheduler.mjs.
//
//   goals-refresh  every AGENTGLIM_GOALS_REFRESH_HOURS (default 4 h), catch up after downtime
//   goals-weekly   every AGENTGLIM_GOALS_REVIEW_DAYS (default 7 days), catch up after downtime
//
// The refresh job runs the goals folder's own `goals.py refresh` (local, no AI) and rebuilds the
// cached JSON. A refresh over 60 s or three failures in a row backs off 1 h -> 6 h -> 24 h, sets
// the red error chip and sends one SuperAgent inbox message per incident.
// The weekly job runs the cheap collection, then queues the goals-weekly-review skill to the
// SuperAgent inbox. It never starts a paid model call itself.
import path from 'node:path';
import { createScheduler } from './scheduler.mjs';
import { DATA, goalsFile } from './paths.mjs';
import { REFRESH_EVERY_MS, REVIEW_EVERY_MS, markRefreshFailure, queueIncidentOnce, queueWeeklyReview, readState, runRefresh, writeState } from './goals-report.mjs';

const scheduler = createScheduler({ stateFile: path.join(DATA, 'scheduler-state.json') });
let config = { started: false, enabled: false, dev: false, reason: 'not started' };
let incidentAt = null;

const backoffLabel = (ms) => ms >= 864e5 ? `${Math.round(ms / 864e5)} day` : `${Math.round(ms / 3600e3)} h`;

async function refreshJob() {
  if (!config.enabled) return { skipped: config.reason };
  try {
    const result = await runRefresh({ demo: false, dev: config.dev, reason: 'scheduled' });
    incidentAt = null;
    return { goals: result.goals.length, refresh: result.refresh };
  } catch (error) {
    const fail = markRefreshFailure(error);
    if (fail.backoff) scheduler.defer('goals-refresh', fail.backoff);
    if (fail.incidentAt && fail.incidentAt !== incidentAt) {
      incidentAt = fail.incidentAt;
      queueIncidentOnce(fail.incidentAt, `Goals refresh failed ${fail.failures} times in a row (last: ${String(error.message || error)}). `
        + `Next try is in about ${backoffLabel(fail.backoff || REFRESH_EVERY_MS)}. Open /goals for the red error chip.`);
    }
    throw error;
  }
}

async function weeklyJob() {
  if (!config.enabled) return { skipped: config.reason };
  let refresh = null, refreshError = null;
  try {
    refresh = await runRefresh({ demo: false, dev: config.dev, reason: 'weekly collection' });
  } catch (error) {
    refreshError = String(error.message || error);
  }
  const queued = queueWeeklyReview({ reason: 'scheduled' });
  if (queued.queued) writeState({ lastReviewAt: queued.at });
  return { refresh: refresh?.refresh || null, refreshError, queued };
}

export function startGoalsJobs({ dev = false } = {}) {
  if (config.started) return goalsJobsStatus();
  const hasGoals = !!goalsFile();
  config = { started: true, enabled: !dev && hasGoals, dev, reason: dev ? 'dev copy: automatic goals jobs are off' : hasGoals ? 'running' : 'no goals file yet' };
  scheduler.register('goals-refresh', REFRESH_EVERY_MS, refreshJob, { catchUp: true });
  scheduler.register('goals-weekly', REVIEW_EVERY_MS, weeklyJob, { catchUp: true });
  scheduler.start();
  return goalsJobsStatus();
}

export function goalsJobsStatus() {
  const st = readState();
  return {
    ...scheduler.status(),
    enabled: config.enabled,
    dev: config.dev,
    reason: config.reason,
    refreshEveryMs: REFRESH_EVERY_MS,
    reviewEveryMs: REVIEW_EVERY_MS,
    failures: st.failures || 0,
    lastError: st.lastError || null,
    backoffUntil: st.backoffUntil || null,
    incidentAt,
  };
}

export function runGoalsJob(name) { return scheduler.runNow(name); }
export { scheduler as goalsScheduler };
