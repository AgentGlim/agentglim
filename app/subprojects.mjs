// Sub-projects: whole plans that were merged into another project (plan 51-54 into 03, 55 into 68).
// ../subprojects.json is the hand-kept list; this adds where each folder and each parent lives now (realpath, so a plan
// that moved out of plans/ or sits behind a symlink shows its real home). Cached by file mtime, 60 s for the paths.
import fs from 'node:fs';
import { PLANS } from './paths.mjs';
import { foldEntries } from './plan-meta.mjs';

const FILE = new URL('../subprojects.json', import.meta.url);
const HOME = process.env.HOME || '';
const short = (p) => (p && HOME && p.startsWith(HOME + '/') ? `~${p.slice(HOME.length)}` : p);
const real = (dir) => { try { return short(fs.realpathSync(`${PLANS}/${dir}`)); } catch { return null; } };
let cache = { mtime: 0, at: 0, out: null };

const PINS = process.env.REPO_PLANS_FILE || `${PLANS}/_run/repo-plans.json`;
export function repoPins(file = PINS) { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { return {}; } }

export function subProjects() {
  const now = Date.now();
  let st; try { st = fs.statSync(FILE); } catch { st = { mtimeMs: 0 }; }
  let pm = 0; try { pm = fs.statSync(PINS).mtimeMs; } catch {}
  if (cache.out && cache.mtime === st.mtimeMs + pm && now - cache.at < 30e3) return cache.out;
  let j = {}; try { j = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { j = {}; }
  const parents = {}, parentReal = {};
  for (const [dir, list] of Object.entries(j.parents || {})) {
    parentReal[dir] = real(dir);
    parents[dir] = (list || []).map((e) => ({ ...e, real: real(e.plan) }));
  }
  // fold notes: a "Folded into NN" note at the top of a plan's PLAN.md is the one place a merge is
  // written down; it nests that plan here automatically. A hand-kept entry above (same plan) wins: it carries more detail.
  for (const [dir, list] of Object.entries(foldEntries(PLANS))) {
    parentReal[dir] ||= real(dir);
    const have = parents[dir] || (parents[dir] = []);
    for (const e of list) if (!have.some((x) => x.plan === e.plan)) have.push({ ...e, real: real(e.plan) });
  }
  // repo pins (project row template): plans/_run/repo-plans.json maps a repo folder to the plan that builds it.
  // That plan becomes a merged-project card under the repo's own row (parent key = repo name), same as a hand-kept merge.
  const repos = repoPins();
  for (const [repo, plan] of Object.entries(repos)) {
    const list = parents[repo] || (parents[repo] = []);
    if (!list.some((e) => e.plan === plan)) list.push({ plan, pin: true, name: ((w) => w.charAt(0).toUpperCase() + w.slice(1))(plan.slice(3).replace(/-/g, ' ')), full: `Plan ${plan} builds the ${repo} repo (pinned in plans/_run/repo-plans.json)`,
      merged: 'pinned', ver: 'repo pin', where: `~/dev/projects/${repo}`, code: '', items: [], src: 'plans/_run/repo-plans.json', real: real(plan) });
  }
  cache = { mtime: st.mtimeMs + pm, at: now, out: { updated: j.updated || null, parents, parentReal, repos } };
  return cache.out;
}
