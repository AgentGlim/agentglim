// working.mjs: one list of the agents really running on a project row (2026-11-13, agent-icons fix).
// The WORKING cell used to add two independent views of the same processes: the harness scan (agent.sh outdirs,
// queue takes, interactive sessions, the goal agent) and the jobs-track records. Both are keyed here by the job's
// outdir and merged, so a row shows one icon per agent and its count is this list's length. Pure code, no I/O
// except an optional realpath for path normalisation.
import fs from 'node:fs';

// an outdir as one comparable string: forward slashes, no trailing slash, symlinks resolved when the path exists
// (~/projects/dev/plans and ~/dev/projects/plans are the same folder)
const realCache = new Map();
export function normDir(d, real = true) {
  if (!d || typeof d !== 'string') return null;
  let s = d.replace(/^file:\/\//, '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (real) {
    if (realCache.has(s)) return realCache.get(s);
    let r = s; try { r = fs.realpathSync(s).replace(/\\/g, '/'); } catch {}
    if (realCache.size > 5000) realCache.clear();
    realCache.set(s, r); return r;
  }
  return s;
}

const isTake = (j) => !!j && (!!j.req || /^headless-take/.test(j.launcher || ''));
const isWrapper = (j) => !!j && !isTake(j) && /^agent\.sh/.test(j.launcher || '');

// A queued Claude job has two records: the agent.sh wrapper (writes a .req and waits) and the headless-take run
// (the real `claude -p`). Fold the wrapper into its take: one record, the take's model and req, the wrapper's
// start time, `wrapperOf` naming the folded record. Order of the list is kept.
export function foldWrappers(list, { real = true } = {}) {
  const takes = new Map();
  for (const j of list) { if (!isTake(j)) continue; const k = normDir(j.outdir, real); if (k) takes.set(k, [...(takes.get(k) || []), j]); }
  if (!takes.size) return list;
  const drop = new Set(), into = new Map();
  for (const w of list) {
    if (!isWrapper(w)) continue;
    const cand = takes.get(normDir(w.outdir, real)); if (!cand) continue;
    // the take started after the wrapper and the wrapper was still alive then
    const t = cand.find((x) => (x.started || 0) >= (w.started || 0) - 5000 && (w.status === 'running' || (w.ended || Infinity) >= (x.started || 0) - 5000));
    if (!t) continue;
    drop.add(w); into.set(t, w);
  }
  return list.filter((j) => !drop.has(j)).map((j) => {
    const w = into.get(j); if (!w) return j;
    const status = j.status === 'running' || (w.status === 'running' && j.status == null) ? 'running' : j.status;
    const st = [j.started, w.started].filter(Boolean);
    return { ...j, status, wrapperOf: w.id, started: st.length ? Math.min(...st) : j.started };
  });
}

// harness: working entries from the scan ({ provider, role, task, model, paused, outdir }); tracked: the row's
// visible tracked jobs; manual: interactive-session working entries; goal: the goal agent's working entry or null.
// Returns [{ key, work?, job? }]: `work` drives the icon when the scan saw the agent (real model), else `job`.
export function agentsOf({ harness = [], tracked = [], manual = [], goal = null } = {}, { real = true } = {}) {
  const out = [], byDir = new Map();
  for (const w of harness) {
    const k = normDir(w.outdir, real);
    const a = { key: k || `h:${out.length}`, work: w };
    out.push(a); if (k) byDir.set(k, a);
  }
  const running = foldWrappers(tracked.filter((j) => j && j.status === 'running'), { real });
  const sessions = manual.map((m) => ({ key: `m:${out.length}`, work: m })); let freeSession = 0;
  for (const j of running) {
    // a one-on-one record is a chat turn of an interactive session on this row: the session's icon already stands for it
    if (j.kind === 'one-on-one' && freeSession < sessions.length) { sessions[freeSession++].job = j; continue; }
    const k = normDir(j.outdir, real), hit = k && byDir.get(k);
    if (hit) {
      if (hit.job) continue; // a second record for the same outdir (agent.sh re-run): still one agent
      hit.job = j; hit.work = { ...hit.work, label: j.label, jobId: j.id, model: hit.work.model || j.model };
      continue;
    }
    const a = { key: k || `t:${j.id}`, job: j };
    out.push(a); if (k) byDir.set(k, a);
  }
  out.push(...sessions);
  if (goal) out.push({ key: 'goal', work: goal });
  return out;
}

// SuperAgent row: transcript helpers (superagent.mjs) and tracked records (`all`, with statusOf = shownStatus).
// Only its own work counts: a helper whose record sits on a plan or has finished is dropped; plan headless takes and
// plan-tagged subagents stay on their plan rows. Returns { helpers, run }: helpers kept, plus own running records not
// already drawn as a helper.
export function superagentLive(wrLive = [], all = [], statusOf = (j) => j.status) {
  const byAgent = new Map(all.filter((j) => j && j.agentId).map((j) => [j.agentId, j]));
  const helpers = wrLive.filter((h) => { const j = byAgent.get(h.id); return !j || (j.project === 'SuperAgent' && statusOf(j) === 'running'); });
  const seen = new Set(helpers.map((h) => h.id));
  const run = all.filter((j) => j && j.project === 'SuperAgent' && statusOf(j) === 'running' && !seen.has(j.agentId) && !seen.has(j.id));
  return { helpers, run };
}
