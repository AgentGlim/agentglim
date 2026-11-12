// jobs.mjs: tracked jobs. Every agent a SuperAgent hands work to (Claude Agent-tool subagents,
// OpenCode task subagents, agent.sh and headless-take.sh runs, `jobs-track run` wrappers) is written by the
// harness's jobs-track register as one JSON file in $AGENTGLIM_DATA/tracked-jobs/. Code only, no model calls.
// The server runs `jobs-track reap` every 20 s (pid / rc-file liveness), then reads the files here.
import fs from 'node:fs';
import path from 'node:path';
import { RUN } from './paths.mjs';
import { execFile } from 'node:child_process';

export const RECENT_MS = 30 * 60e3; // a finished job stays on its row, marked done/failed, for 30 min
export const KIND_LABEL = { autonomous: 'Autonomous', 'one-on-one': 'One-on-one', queue: 'Queue', subagent: 'Subagent' };
const REPORT_FILES = ['last.txt', 'headless.txt', 'events.jsonl', 'stderr.log', 'headless.err'];

export function readTracked(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) { try { out.push(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))); } catch {} }
  return out;
}

// repo -> owning plan map, built by plans/_run/bin/repo-plans-build.py
export function repoPlans(file = path.join(RUN, 'repo-plans.json')) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

// small task vs feature-sized task. Small: under ~60 s or a single tool touch. Feature: 5 min or more,
// or 6+ touches. In between counts as small too, so only real work is kept. Records without `touches` (subagents, agent.sh) go by time.
export const FEATURE_MS = 5 * 60e3, FEATURE_TOUCHES = 6, ONEOFF_MS = 60e3;
export function jobSize(j, now = Date.now()) {
  const dur = Math.max(0, (j.ended || now) - (j.started || now)), t = Number(j.touches) || 0;
  if (dur >= FEATURE_MS || t >= FEATURE_TOUCHES) return 'feature';
  return 'small';
}
// a hand-off (subagent, queue, driver job) is a real sub-item from launch; only one-on-one chat touches can be one-offs
export const isOneOff = (j, now = Date.now()) => (!j.kind || j.kind === 'one-on-one') && jobSize(j, now) === 'small' && ((j.ended || now) - (j.started || now) < ONEOFF_MS || (Number(j.touches) || 0) <= 1);

// finished feature-sized jobs of a plan are kept for good in data/feature-subitems.json: {items:[{id,plan,label,finished,harness}]}
export function readFeatures(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j.items) ? j.items : []; } catch { return []; }
}
export function saveFeatures(file, list) {
  if (!file) return [];
  const have = readFeatures(file), ids = new Set(have.map((x) => x.id)); let add = 0;
  // a saved item follows its job record when that record is re-attributed or relabelled (jobs-track fix)
  const byId = new Map(list.filter((j) => j && j.id).map((j) => [j.id, j]));
  for (const it of have) {
    const j = byId.get(it.id); if (!j) continue;
    const plan = j.isPlan ? j.project : null, label = cleanLabel(j.label || it.label);
    if (plan && plan !== it.plan) { it.plan = plan; add++; }
    if (!j.isPlan && it.plan) { it.plan = null; it.movedTo = j.project; add++; }
    if (label !== it.label) { it.label = label; add++; }
  }
  for (const j of list) {
    // only hand-offs (subagents, agent.sh, queue takes) are kept; the SuperAgent's own chat turns (one-on-one) are not sub-tasks
    if (!j || j.status !== 'done' || !j.isPlan || ids.has(j.id) || jobSize(j) !== 'feature' || !j.kind || j.kind === 'one-on-one' || j.kind === 'autonomous') continue;
    if (typeof j.project === 'string' && (j.project.startsWith('_') || j.project === 'jobtrack-test')) continue;
    have.push({ id: j.id, plan: j.project, label: cleanLabel(j.label || 'job'), finished: new Date(j.ended || Date.now()).toISOString().slice(0, 10), harness: j.harness || null, model: j.model || null, kind: j.kind || null, started: j.started || null, ended: j.ended || null }); ids.add(j.id); add++;
  }
  if (add) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify({ items: have }, null, 1)); fs.renameSync(file + '.tmp', file); } catch {} }
  return have;
}

// what the board shows for a job: "running" while the record runs (a live pid, or an agent whose transcript
// could not be located: unknown is not idle), "done" when its transcript says it finished, "idle" only for an agent that
// waits on background work with no new records for 20 min. Finished records keep their status: done / failed / stopped.
export function shownStatus(j) {
  if (j.status !== 'running') return j.status || 'done';
  if (j.activity === 'finished') return 'done';
  if (j.activity === 'idle') return 'idle';
  return 'running';
}
// a raw outdir slug (old records) -> a readable label, like jobs-track's nice_label: plan70-phase1 -> "Plan 70 phase 1"
const LABEL_WORDS = { agentglim: 'AgentGlim', ai: 'AI', ui: 'UI', api: 'API', pu: 'PU', html: 'HTML' };
export function cleanLabel(label) {
  const s = String(label || '').trim();
  if (!s || /\s/.test(s) || !/[-_]/.test(s) && !/[a-z]{2}\d/.test(s)) return s ? s[0].toUpperCase() + s.slice(1) : 'job';
  const w = s.replace(/(?<=[a-z]{2})(?=\d)|(?<=\d)(?=[a-z]{2})/g, ' ').split(/[-_\s]+/).filter(Boolean).map((t) => LABEL_WORDS[t.toLowerCase()] || t).join(' ');
  return w[0].toUpperCase() + w.slice(1);
}

// running jobs, plus finished ones from the last RECENT_MS: failed / stopped stay visible, done ones fold into "N done,
// hidden" on their row. Older done jobs disappear: a small one for good, a feature-sized one lives on as a saved sub-item
// (saveFeatures). Newest first.
export function visibleJobs(list, now = Date.now()) {
  return list.filter((j) => j && (j.status === 'running' || now - (j.ended || 0) < RECENT_MS))
    .sort((a, b) => (b.started || 0) - (a.started || 0))
    .map((j) => ({ id: j.id, project: j.project, isPlan: !!j.isPlan, kind: KIND_LABEL[j.kind] ? j.kind : 'one-on-one',
      harness: j.harness || '?', model: j.model || null, label: cleanLabel(j.label), slug: j.slug || null, note: j.note || null, status: shownStatus(j), activity: j.activity, activityHint: j.activityHint, rc: j.rc ?? null,
      endReason: j.endReason || null, started: j.started || null, touches: j.touches || null, oneOff: isOneOff(j, now), ended: j.ended || null, outdir: j.outdir || null, launcher: j.launcher || null,
      projectFrom: j.projectFrom || null, hasReport: !!(j.summary || j.outdir) }));
}

// pid-backed jobs (agent.sh, headless-take, jobs-track run): the process is the truth, not a transcript. Alive = running,
// with a hint once its output files have been quiet for 20 min. A finished record without an exit code gets one from
// <outdir>/rc or agent.sh's "end ... rc=N" meta line (the reaper uses the same files).
const PROC = process.env.AGENTGLIM_PROC || '/proc';
export function pidAlive(pid, start, root = PROC) {
  try { const s = fs.readFileSync(`${root}/${pid}/stat`, 'utf8'), f = s.slice(s.lastIndexOf(')') + 2).split(' '); return f[0] !== 'Z' && (start == null || Number(f[19]) === Number(start)); } catch { return false; }
}
const OUT_FILES = ['events.jsonl', 'last.txt', 'stderr.log', 'headless.txt', 'meta'];
export function outdirRc(o, since = 0) {
  if (!o) return null;
  for (const n of ['rc', 'headless.rc']) { try { const f = path.join(o, n); if (fs.statSync(f).mtimeMs >= since - 5000) return fs.readFileSync(f, 'utf8').trim() || '0'; } catch {} }
  try { const ends = [...fs.readFileSync(path.join(o, 'meta'), 'utf8').matchAll(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) end kind=\S+ rc=(-?\d+)/gm)]; const e = ends.at(-1); if (e && Date.parse(e[1].replace(' ', 'T')) >= since - 5000) return e[2]; } catch {}
  return null;
}
export function endState(rc) {
  rc = rc == null ? null : String(rc).trim();
  if (rc == null || rc === '' || rc === '0') return ['done', null];
  if (rc === '124') return ['failed', 'timed out'];
  if (['130', '137', '143'].includes(rc) || rc.startsWith('-')) return ['stopped', 'killed'];
  return ['failed', `exit code ${rc}`];
}
export function liveJobs(list, { now = Date.now(), root = PROC, quietMs = 20 * 60e3 } = {}) {
  return list.map((j) => {
    if (!j) return j;
    if (j.status === 'running' && j.pid) {
      if (!pidAlive(j.pid, j.pidStart, root)) {
        const rc = outdirRc(j.outdir, j.started || 0);
        if (rc == null) return j; // the reaper settles it within 20 s
        const [status, endReason] = endState(rc); return { ...j, status, rc, endReason, ended: j.ended || now };
      }
      let last = 0; for (const f of OUT_FILES) { try { last = Math.max(last, fs.statSync(path.join(j.outdir || '', f)).mtimeMs); } catch {} }
      const quiet = last && now - last > quietMs;
      return { ...j, activity: 'running', activityHint: quiet ? `process alive; no new output for ${Math.round((now - last) / 60e3)} min` : null };
    }
    if ((j.status === 'stopped' || j.status === 'failed') && (j.rc == null || j.rc === '') && j.outdir) {
      const rc = outdirRc(j.outdir, j.started || 0);
      if (rc != null) { const [status, endReason] = endState(rc); return { ...j, status, rc, endReason }; }
    }
    return j;
  });
}

// the group a job is drawn under: its plan; a plan folded into another (fold notes) draws under its
// parent unless it is a driver (autonomous) job of the plan's own rounds; a non-plan job under its real project folder.
// Path fragments ("video-", "projects", "out"), the plans root and unknown names all go to "Unassigned".
export const UNASSIGNED = 'Unassigned';
const BAD = new Set(['plans', 'projects', 'dev', 'out', 'tmp', 'bin', 'src', 'app', 'build', 'home', 'user', 'unassigned', 'dist', 'lib', 'plans (no plan named)']);
export const goodProject = (n) => typeof n === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(n) && !BAD.has(n.toLowerCase());
export function groupKey(j, folds = {}) {
  if (j.isPlan && /^\d\d-[a-z0-9-]+$/.test(j.project || '')) {
    const f = folds[j.project];
    return f && j.kind !== 'autonomous' ? { plan: true, key: f.parent, via: j.project } : { plan: true, key: j.project };
  }
  if (j.project === '~') return { plan: false, key: '~' };
  return { plan: false, key: goodProject(j.project) ? j.project : UNASSIGNED };
}

// plan dir -> jobs, and the non-plan project rows ("Other projects" in Active builds)
export function groupJobs(vis, { folds = {} } = {}) {
  const plans = new Map(), other = new Map();
  for (const j of vis) {
    if (typeof j.project === 'string' && (j.project.startsWith('_') || j.project === 'jobtrack-test')) continue;
    const g = groupKey(j, folds), m = g.plan ? plans : other, row = g.via ? { ...j, viaPlan: g.via } : j;
    m.set(g.key, [...(m.get(g.key) || []), row]);
  }
  return { plans, other };
}

// tail of the job's report: the agent's last message, else its outdir's output file. Only files the record names.
export function jobReport(rec, max = 64 * 1024) {
  if (!rec) return null;
  const parts = [];
  if (rec.summary) parts.push(rec.summary);
  const o = rec.outdir;
  let files = [];
  if (o) {
    try { files = fs.statSync(o).isDirectory() ? REPORT_FILES.map((f) => path.join(o, f)) : [o]; } catch {}
  }
  for (const f of files) {
    try {
      const st = fs.statSync(f); if (!st.isFile() || !st.size) continue;
      if (f.endsWith('events.jsonl')) { // Codex --json events: the agent's last message (last.txt can be missing, 2026-11-11)
        const n = Math.min(st.size, 4 << 20), b = Buffer.alloc(n), fd = fs.openSync(f, 'r');
        try { fs.readSync(fd, b, 0, n, st.size - n); } finally { fs.closeSync(fd); }
        const msg = b.toString('utf8').split('\n').reverse().map((l) => { try { const e = JSON.parse(l); return e.item?.type === 'agent_message' ? e.item.text : null; } catch { return null; } }).find(Boolean);
        if (!msg) continue;
        parts.push(`== last agent message (events.jsonl)\n${msg.slice(-max)}`); break;
      }
      const n = Math.min(max, st.size), b = Buffer.alloc(n), fd = fs.openSync(f, 'r');
      try { fs.readSync(fd, b, 0, n, st.size - n); } finally { fs.closeSync(fd); }
      parts.push(`== ${path.basename(f)}${n < st.size ? ' (tail)' : ''}\n${b.toString('utf8')}`);
      break;
    } catch {}
  }
  return parts.join('\n\n') || null;
}

// reaper: one `jobs-track reap` at a time; a missing script or a failure is ignored
export function makeReaper(script, dir) {
  let busy = false;
  return () => {
    if (busy || !fs.existsSync(script)) return;
    busy = true;
    execFile('python3', [script, 'reap'], { timeout: 30e3, env: { ...process.env, JOBS_TRACK_DIR: dir } }, () => { busy = false; });
  };
}
