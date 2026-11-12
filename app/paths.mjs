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
const saved = (()=>{try{return JSON.parse(fs.readFileSync(path.join(DATA,'setup.json'),'utf8'));}catch{return {};}})();
export const PROJECTS = process.env.AGENTGLIM_PROJECTS || path.join(HOME, 'dev', 'projects');
export const PLANS = process.env.AGENTGLIM_PLANS || (saved.plans?.path ? String(saved.plans.path).replace(/^~(?=\/|$)/,HOME) : path.join(DATA,'plans'));
export const RUN = process.env.AGENTGLIM_RUN || path.join(PLANS,'_run');
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
