// paths.mjs: where Agentglim finds its runtime data and the plans harness it watches.
// Code lives in this repo; runtime data (history, caches, probes, imported logs) lives outside it.
//   AGENTGLIM_WORK      working dir holding data/, probes/, imported/, human-loaded-data/, _build/
//                       (default: ~/.agentglim; never auto-select a plans harness)
//   AGENTGLIM_DATA      your private data: goals, plan state, usage, caches (default: $AGENTGLIM_WORK/data when
//                       AGENTGLIM_WORK is set, else ~/.agentglim). Never inside the repo. See SETUP.md.
//   AGENTGLIM_GOALS     goals folder (default: $AGENTGLIM_DATA/goals): goals.json (or data/goals.json), goal-map.json, reviews/
//   AGENTGLIM_PLANS     optional plans root (default: $AGENTGLIM_DATA/plans, or saved Setup path)
//   AGENTGLIM_RUN       the harness run folder (default: $AGENTGLIM_PLANS/_run)
//   AGENTGLIM_PROJECTS  the folder that holds your projects, for the optional panels (default: ~/dev/projects)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
export const WORK = process.env.AGENTGLIM_WORK || process.env.AGENTGLIM_DATA || path.join(HOME, '.agentglim');
export const DATA = process.env.AGENTGLIM_DATA || (process.env.AGENTGLIM_WORK ? `${WORK}/data` : path.join(HOME, '.agentglim'));
const readSaved = ()=>{try{return JSON.parse(fs.readFileSync(path.join(DATA,'setup.json'),'utf8'));}catch{return {};}};
const saved = readSaved();
// Expand a leading ~ followed by / or \ (Windows Setup saves "~\\plans"), or a bare ~.
export const expandHome = (p, home = HOME) => String(p ?? '').replace(/^~(?=[\\/]|$)/, home);
// The harness.json "run" override (same file app/settings.mjs reads), so every reader agrees on the run folder.
export function harnessRunOverride(plans, env = process.env, home = HOME) {
  const file = env.AGENTGLIM_CONFIG || path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'agentglim', 'harness.json');
  let run; try { run = JSON.parse(fs.readFileSync(file, 'utf8'))?.run; } catch { return null; }
  if (typeof run !== 'string' || !run.trim()) return null;
  // normalized like settings.mjs harnessConfig().run, so "{plans}/custom-run" has native separators on Windows too
  return path.normalize(expandHome(run, home).replace(/\{plans\}/g, plans).replace(/\{data\}/g, DATA));
}
export const PROJECTS = process.env.AGENTGLIM_PROJECTS || path.join(HOME, 'dev', 'projects');
export const PLANS = process.env.AGENTGLIM_PLANS || (saved.plans?.path ? expandHome(saved.plans.path) : path.join(DATA,'plans'));
export const RUN = process.env.AGENTGLIM_RUN || harnessRunOverride(PLANS) || path.join(PLANS,'_run');
export const GOALS = process.env.AGENTGLIM_GOALS || `${DATA}/goals`;
// dataPath('goals', 'goals.json') -> first existing of the candidates under DATA, else the first one (for writes)
export function dataPath(...cands) {
  const list = cands.map((c) => (Array.isArray(c) ? path.join(DATA, ...c) : path.join(DATA, c)));
  return list.find((f) => fs.existsSync(f)) || list[0];
}
export const goalsFile = () => [path.join(GOALS, 'goals.json'), path.join(GOALS, 'data', 'goals.json')].find((f) => fs.existsSync(f)) || null;
// what the app has to show; the UI shows a blank "Set up" card for each missing section
export function setupState() {
  return { dataDir: DATA.replace(HOME, '~'), goals: !!goalsFile(), plans: fs.existsSync(PLANS), guide: 'SETUP.md' };
}

// Quote a path for the Bash listener command, including spaces, apostrophes and shell metacharacters.
export const shellQuote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";

// The one place that answers "where is everything right now": agents, the dashboard notice, the setup skill and
// the first-run tool all read this instead of guessing defaults. `restartNeeded` is true when Setup has saved a
// plans folder that this running process did not start with (paths are read once at import), so the dashboard
// still watches the old run folder until it is restarted.
export function pathsInfo({ plans = PLANS, run = RUN } = {}) {
  const sp = readSaved().plans?.path;
  const configuredPlans = process.env.AGENTGLIM_PLANS || (sp ? expandHome(sp) : path.join(DATA, 'plans'));
  const configuredRun = process.env.AGENTGLIM_RUN || harnessRunOverride(configuredPlans) || path.join(configuredPlans, '_run');
  // native Windows has no bash: use the Node twin of the listener (same output, same heartbeats)
  const win = process.platform === 'win32';
  const wait = path.join(run, 'bin', win ? 'auditq-wait.mjs' : 'auditq-wait.sh');
  return {
    data: DATA, plans, run, goals: GOALS,
    heartbeat: path.join(DATA, 'heartbeats', 'superagent'),
    waitCommand: win ? `node "${wait}"` : `bash ${shellQuote(wait)}`,
    configuredPlans, configuredRun,
    restartNeeded: path.resolve(configuredPlans) !== path.resolve(plans) || path.resolve(configuredRun) !== path.resolve(run),
  };
}
