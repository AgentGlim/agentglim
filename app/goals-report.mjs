// goals-report.mjs: the data behind the Goals sub-app (app/goals-app.mjs).
//
// Reads only:
//   $AGENTGLIM_GOALS/goals.json (or data/goals.json), goal-map.json, reviews/*-review.json,
//   data/news.json, knowledge/*.md
//   $AGENTGLIM_PLANS/NN-*/ (PLAN.md title, HOLD, AUTO_COMPLETE, OWNER-APPROVED) and
//   $AGENTGLIM_PLANS/_run/state.json
//   AgentGlim approvals() (read-only)
// Writes only its own cache state in $AGENTGLIM_DATA/goals-app-state.json and, when asked,
// SuperAgent inbox messages in $AGENTGLIM_PLANS/_run/chat_inbox/.
//
// Demo mode (?demo=1, or a fresh install with no goals file) reads the bundled example data in
// app/defaults/goals/ and never the owner's private folder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GOALS, PLANS, RUN, DATA, goalsFile } from './paths.mjs';
import { buildGoalsReview, buildGoalsContext } from './goals-sync.mjs';
import { scanSkills } from './skills.mjs';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED = path.join(HERE, 'defaults', 'goals');
const STATE_FILE = path.join(DATA, 'goals-app-state.json');
const PALETTE = ['#2fd69c', '#5fb8ff', '#b79cff', '#e0a84f', '#e2554f', '#8ab4ff', '#7c78ec', '#c792ea', '#a9b0ba', '#6f7782'];
const LANES = new Set(['now', 'floor', 'support']);
const PLAN_DIR = /^\d\d-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REFRESH_HOURS = positive(process.env.AGENTGLIM_GOALS_REFRESH_HOURS, 4);
const REVIEW_DAYS = positive(process.env.AGENTGLIM_GOALS_REVIEW_DAYS, 7);
export const REFRESH_EVERY_MS = REFRESH_HOURS * 3600e3;
export const REVIEW_EVERY_MS = REVIEW_DAYS * 864e5;
const USAGE_GATE_PCT = 90;

let cache = { demo: null, data: null, at: 0 };
let inflight = null;

function positive(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const listDir = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
const exists = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const clip = (s, n = 400) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}...` : t; };

function bad(file, field, message) {
  const error = new Error(`${file}: ${field}: ${message}`);
  error.file = file;
  error.field = field;
  return error;
}

// A small validator for the fields the page depends on, so a broken file names its file and field
// instead of rendering an empty page. Extra fields stay allowed and forward compatible.
export function validateGoals(doc, file = 'goals.json') {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw bad(file, '(root)', 'must be an object');
  if (!Number.isInteger(doc.version)) throw bad(file, 'version', 'must be an integer');
  if (!Array.isArray(doc.goals)) throw bad(file, 'goals', 'must be an array');
  const ids = new Set();
  doc.goals.forEach((goal, i) => {
    const at = `goals[${i}]`;
    if (!goal || typeof goal !== 'object') throw bad(file, at, 'must be an object');
    if (typeof goal.id !== 'string' || !/^[a-z0-9_-]+$/.test(goal.id)) throw bad(file, `${at}.id`, 'must match ^[a-z0-9_-]+$');
    if (ids.has(goal.id)) throw bad(file, `${at}.id`, `duplicate goal id ${goal.id}`);
    ids.add(goal.id);
    if (typeof goal.title !== 'string' || !goal.title.trim()) throw bad(file, `${at}.title`, 'must be a non-empty string');
    if (goal.lane != null && !LANES.has(goal.lane)) throw bad(file, `${at}.lane`, 'must be now, floor or support');
    if (goal.allocation != null && !Number.isFinite(goal.allocation)) throw bad(file, `${at}.allocation`, 'must be a number or null');
    if (goal.color != null && !/^#[0-9a-f]{6}$/i.test(String(goal.color))) throw bad(file, `${at}.color`, 'must be a #rrggbb colour');
    if (goal.sources != null && !Array.isArray(goal.sources)) throw bad(file, `${at}.sources`, 'must be an array');
    if (goal.acceptance != null && !Array.isArray(goal.acceptance)) throw bad(file, `${at}.acceptance`, 'must be an array');
  });
  if (doc.metrics != null) {
    if (!Array.isArray(doc.metrics)) throw bad(file, 'metrics', 'must be an array');
    doc.metrics.forEach((m, i) => {
      const at = `metrics[${i}]`;
      if (!m || typeof m !== 'object') throw bad(file, at, 'must be an object');
      if (typeof m.goal !== 'string' || !ids.has(m.goal)) throw bad(file, `${at}.goal`, `must name one of: ${[...ids].join(', ')}`);
      if (typeof m.label !== 'string' || !m.label.trim()) throw bad(file, `${at}.label`, 'must be a non-empty string');
      for (const k of ['target_min', 'target_max', 'actual']) if (m[k] != null && !Number.isFinite(m[k])) throw bad(file, `${at}.${k}`, 'must be a number or null');
    });
  }
  return doc;
}

export function validateGoalMap(doc, file = 'goal-map.json') {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw bad(file, '(root)', 'must be an object');
  for (const key of ['plans', 'effort']) {
    if (doc[key] == null) continue;
    if (typeof doc[key] !== 'object' || Array.isArray(doc[key])) throw bad(file, key, 'must be an object of goal id to plan array');
    for (const [goal, list] of Object.entries(doc[key])) {
      if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) throw bad(file, `${key}.${goal}`, 'must be an array of strings');
    }
  }
  if (doc.labels != null) {
    if (typeof doc.labels !== 'object' || Array.isArray(doc.labels)) throw bad(file, 'labels', 'must be an object');
    for (const [goal, label] of Object.entries(doc.labels)) if (typeof label !== 'string') throw bad(file, `labels.${goal}`, 'must be a string');
  }
  return doc;
}

function colourFor(goal, index) {
  return typeof goal.color === 'string' && /^#[0-9a-f]{6}$/i.test(goal.color) ? goal.color : PALETTE[index % PALETTE.length];
}

function planTitle(dir) {
  const m = readText(path.join(PLANS, dir, 'PLAN.md')).match(/^#\s+(?:Plan\s+\d+\s*[:.-]\s*)?(.+)$/m);
  return m ? m[1].replace(/[`*_]/g, '').trim().slice(0, 100) : dir.replace(/^\d\d-/, '').replace(/-/g, ' ');
}

function planState(dir, stage = null) {
  if (exists(path.join(PLANS, dir, 'OWNER-APPROVED'))) return { state: 'done', stage };
  if (stage === 'done' || exists(path.join(PLANS, dir, 'AUTO_COMPLETE'))) return { state: 'done', stage };
  if (stage && /-gate$/.test(stage)) return { state: 'gate', stage };
  if (exists(path.join(PLANS, dir, 'HOLD'))) return { state: 'held', stage };
  if (stage) return { state: 'building', stage };
  return { state: 'waiting', stage };
}

// Same rule as the plan-status page: an open owner ask with no call, an "I'll do it" check, or an
// ask/gate/harness item an agent sweep set to Other.
export function needsYou(item) {
  return !item.done && !!item.owner && (!item.choice || item.choice === 'will'
    || (/^(ask|gate|harness)$/.test(String(item.kind || '')) && item.choice === 'other'));
}

function askRow(item) {
  const anchor = item.kind === 'decision'
    ? `dec-${item.key || refKey(item.id)}`
    : `ap-${String(item.id || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')}`;
  return {
    id: item.id, kind: item.kind || 'ask', title: clip(item.title || item.q || 'Open ask', 220),
    short: clip(item.detail || item.why || item.q || '', 320), needYou: needsYou(item),
    choice: item.choice || null, prio: item.prio ?? null, src: item.src || null,
    href: item.href || null, anchor,
  };
}
function refKey(id) {
  return String(id || '').split(':').pop() || 'ask';
}

function plansForGoal(goal, map, allDirs) {
  const fromMap = (map.plans?.[goal.id] || []).filter((d) => PLAN_DIR.test(d));
  const fromSources = (goal.sources || []).map((s) => (String(s).match(/plans\/(\d\d-[^/]+)/) || [])[1]).filter(Boolean);
  return [...new Set([...fromMap, ...fromSources])];
}

function realPlans(goalDefs, map, approvalsRows) {
  const allDirs = listDir(PLANS).filter((d) => PLAN_DIR.test(d) && fs.existsSync(path.join(PLANS, d))).sort();
  const stages = readJson(path.join(RUN, 'state.json'))?.projects || {};
  const anythingExists = allDirs.length > 0;
  const byProject = new Map();
  for (const item of approvalsRows) {
    if (!item.project) continue;
    if (!byProject.has(item.project)) byProject.set(item.project, []);
    byProject.get(item.project).push(item);
  }
  const out = {};
  for (const g of goalDefs) {
    const dirs = plansForGoal(g, map, allDirs);
    const shown = anythingExists ? dirs.filter((d) => allDirs.includes(d)) : dirs;
    out[g.id] = shown.map((dir) => {
      const present = anythingExists && allDirs.includes(dir);
      const st = present ? planState(dir, stages[dir]?.stage || null) : { state: 'example', stage: null };
      const items = (byProject.get(dir) || []).filter((i) => i.owner && !i.done);
      return {
        dir, title: present ? planTitle(dir) : dir.replace(/^\d\d-/, '').replace(/-/g, ' '),
        present, ...st, open: items.length, needYou: items.filter(needsYou).length,
        asks: items.map(askRow),
      };
    });
  }
  return out;
}

function demoPlans(goalDefs, map) {
  const demo = readJson(path.join(BUNDLED, 'plans.json'))?.plans || [];
  const asks = readJson(path.join(BUNDLED, 'asks.json'))?.asks || [];
  const out = {};
  for (const g of goalDefs) {
    const rows = demo.filter((p) => p.goal === g.id || (map.plans?.[g.id] || []).includes(p.dir));
    out[g.id] = rows.map((p) => {
      const items = asks.filter((a) => a.goal === g.id && a.project === p.dir).map((a) => ({
        id: a.id, kind: a.kind, title: a.title, short: a.short, needYou: !!a.needYou, choice: a.choice || null, prio: null, src: null, href: null, anchor: `ap-${a.id}`,
      }));
      return { dir: p.dir, title: p.title, present: true, state: p.state, stage: p.stage || null,
        open: items.length, needYou: items.filter((a) => a.needYou).length, asks: items };
    });
  }
  return out;
}

function metricsFor(goal, doc) {
  return (doc.metrics || []).filter((m) => m.goal === goal.id).map((m) => {
    const target = m.target_max != null ? `${m.target_min ?? 0}-${m.target_max}` : m.target_min ?? null;
    const met = m.actual != null && m.target_min != null ? m.actual >= m.target_min : null;
    return { label: m.label, actual: m.actual ?? null, target, met };
  });
}

function emptyReview() {
  return { at: Date.now(), overall: { alignment: null, prev: null, ownerAlign: null, agentAlign: null, minutes: 0, ownerMin: 0 },
    weighting: {}, weeks: [], goals: [], priorities: [], drift: [], gaps: [], experiment: null };
}

function readReview(defs) {
  try {
    const r = buildGoalsReview();
    const ctx = (() => { try { return buildGoalsContext(); } catch { return { week: [] }; } })();
    return { ...emptyReview(), ...r, week: ctx.week || [] };
  } catch { return { ...emptyReview(), week: [] }; }
}

function readRules(demo) {
  const dir = demo ? path.join(BUNDLED, 'knowledge') : path.join(GOALS, 'knowledge');
  const files = listDir(dir).filter((f) => f.endsWith('.md')).sort().map((f) => {
    const text = readText(path.join(dir, f));
    const title = (text.match(/^#\s+(.+)$/m) || [])[1] || f.replace(/\.md$/, '').replace(/-/g, ' ');
    return { name: f, title: title.trim(), text };
  });
  return files;
}

function readNews(demo) {
  const doc = readJson(demo ? path.join(BUNDLED, 'data', 'news.json') : path.join(GOALS, 'data', 'news.json'))
    || readJson(demo ? path.join(BUNDLED, 'news.json') : path.join(GOALS, 'news.json'))
    || { checked_at: null, sources: [], items: [], note: null };
  return {
    checkedAt: doc.checked_at || null,
    note: doc.note || null,
    sources: (doc.sources || []).map((s) => ({ id: s.id, name: s.name, ok: s.status === 'ok', error: s.error || null, url: s.url || null })),
    items: (doc.items || []).slice(0, 40).map((i) => ({ id: i.id, source: i.source, title: i.title, url: i.url || null,
      published: i.published || null, goals: i.goals || [], assessment: i.assessment || null, confidence: i.confidence || null })),
  };
}

function reviewState() {
  const s = readJson(STATE_FILE) || {};
  const now = Date.now();
  const lastRefresh = Number(s.lastRefreshAt) || null;
  const lastReview = Number(s.lastReviewAt) || null;
  const error = s.lastError || null;
  return {
    at: now,
    updatedAt: lastRefresh || cache.at || now,
    lastRefreshAt: lastRefresh,
    lastReviewAt: lastReview,
    nextRefreshAt: s.backoffUntil && s.backoffUntil > now ? s.backoffUntil : (lastRefresh ? lastRefresh + REFRESH_EVERY_MS : null),
    nextReviewAt: lastReview ? lastReview + REVIEW_EVERY_MS : null,
    refreshEveryMs: REFRESH_EVERY_MS,
    reviewEveryMs: REVIEW_EVERY_MS,
    error,
    failures: Number(s.failures) || 0,
    backoffUntil: s.backoffUntil || null,
    demo: false,
  };
}

export function writeState(patch) {
  const prev = readJson(STATE_FILE) || {};
  const next = { ...prev, ...patch };
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(`${STATE_FILE}.next`, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(`${STATE_FILE}.next`, STATE_FILE);
  } catch { /* the page still works with the cache when the state file cannot be written */ }
  return next;
}
export const readState = () => readJson(STATE_FILE) || {};

function usageGate() {
  if (exists(path.join(RUN, 'STOP'))) return { ok: false, label: 'The harness STOP file is present.', pct: null };
  const budget = readJson(path.join(RUN, 'budget.json'));
  let best = null;
  for (const limit of budget?.limits || []) {
    for (const w of limit.windows || []) {
      if (w.pct == null || w.notApplicable) continue;
      if (!best || w.pct > best.pct) best = { pct: w.pct, label: `${limit.id} ${w.label} ${Math.round(w.pct)}%` };
    }
  }
  if (!best) return { ok: true, label: `No usage data; gate is ${USAGE_GATE_PCT}%.`, pct: null, threshold: USAGE_GATE_PCT };
  return { ok: best.pct < USAGE_GATE_PCT, label: `${best.label} of limit; gate is ${USAGE_GATE_PCT}%.`, pct: best.pct, threshold: USAGE_GATE_PCT };
}

export function weeklyStatus() {
  const dir = path.join(RUN, 'chat_inbox');
  const files = listDir(dir).filter((f) => /^\d+\.json(?:\.answered)?$/.test(f)).sort((a, b) => parseInt(b) - parseInt(a));
  let pending = null;
  for (const f of files) {
    const j = readJson(path.join(dir, f));
    if (!j || j.from !== 'goals-app' || !/weekly goals review/i.test(j.text || '')) continue;
    if (f.endsWith('.answered')) break;
    pending = { at: Number.parseInt(f, 10) || null, id: f.replace(/\.json$/, '') };
    break;
  }
  const st = readState();
  return { pending, queuedAt: pending?.at || Number(st.lastWeeklyQueuedAt) || null, lastQueuedAt: Number(st.lastWeeklyQueuedAt) || null, gate: usageGate() };
}

export function queueWeeklyReview({ reason = 'owner', demo = false } = {}) {
  if (demo) return { queued: false, reason: 'demo mode does not write inbox messages' };
  // Fresh installs do not ship this optional skill. Never leave an unserviceable scheduled chat in the inbox.
  if (!scanSkills().some((skill) => skill.name === 'goals-weekly-review')) {
    return { queued: false, reason: 'goals-weekly-review skill is not installed' };
  }
  const dir = path.join(RUN, 'chat_inbox');
  const at = Date.now();
  const body = JSON.stringify({
    at: new Date(at).toISOString(),
    from: 'goals-app',
    text: `Run the weekly goals review with the goals-weekly-review skill (${reason}). Refresh the goals data first, then record the outcome as JSON in the goals folder.`,
  }) + '\n';
  try {
    fs.mkdirSync(dir, { recursive: true });
    let stamp = at;
    for (;;) {
      try { fs.writeFileSync(path.join(dir, `${stamp}.json`), body, { flag: 'wx' }); break; }
      catch (e) { if (e.code !== 'EEXIST') throw e; stamp++; }
    }
    writeState({ lastWeeklyQueuedAt: stamp });
    return { queued: true, at: stamp, id: String(stamp) };
  } catch (e) { return { queued: false, error: String(e.message || e) }; }
}

// Upgrade cleanup (v0.2.17): installs upgraded from v0.2.13/v0.2.14 can hold a queued goals-app scheduled chat
// ("Run the weekly goals review with the goals-weekly-review skill (scheduled)") whose skill was never installed, so it
// prints before Refresh forever. Move unanswered ones (and their sidecar marks) into chat_inbox/_archive/. Never deletes.
export function archiveStaleScheduledChats({ run = RUN, skills } = {}) {
  const dir = path.join(run, 'chat_inbox');
  const out = { archived: [], dir: path.join(dir, '_archive') };
  const names = listDir(dir);
  if (!names.length) return out;
  let installed = null;
  for (const f of names.filter((x) => /^\d+\.json$/.test(x))) {
    if (names.includes(`${f}.answered`)) continue;
    const j = readJson(path.join(dir, f));
    if (!j || j.from !== 'goals-app') continue;
    const m = /with the ([a-z0-9][a-z0-9-]*) skill \(scheduled\)/i.exec(String(j.text || ''));
    if (!m) continue;
    if (!installed) {
      try { installed = new Set((skills || scanSkills()).map((s) => s.name)); } catch { return out; } // unknown: keep everything
    }
    if (installed.has(m[1])) continue;
    try {
      fs.mkdirSync(out.dir, { recursive: true });
      for (const n of names.filter((x) => x === f || x.startsWith(`${f}.`))) fs.renameSync(path.join(dir, n), path.join(out.dir, n));
      out.archived.push({ id: f.replace(/\.json$/, ''), skill: m[1] });
    } catch (e) { out.error = String(e.message || e); }
  }
  return out;
}

export function queueIncidentOnce(incidentAt, text) {
  const st = readState();
  if (!incidentAt || st.lastIncidentSentAt === incidentAt) return false;
  const dir = path.join(RUN, 'chat_inbox');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const at = Date.now();
    let stamp = at;
    for (;;) {
      try { fs.writeFileSync(path.join(dir, `${stamp}.json`), JSON.stringify({ at: new Date(at).toISOString(), from: 'goals-app', text }) + '\n', { flag: 'wx' }); break; }
      catch (e) { if (e.code !== 'EEXIST') throw e; stamp++; }
    }
    writeState({ lastIncidentSentAt: incidentAt });
    return true;
  } catch { return false; }
}

async function build(demo) {
  const goalsPath = demo ? path.join(BUNDLED, 'goals.json') : goalsFile();
  if (!goalsPath) {
    const error = new Error('No goals.json yet. See SETUP.md to create one.');
    error.code = 'NOGOALS';
    throw error;
  }
  const doc = validateGoals(readJson(goalsPath), goalsPath);
  const mapPath = demo ? path.join(BUNDLED, 'goal-map.json') : path.join(GOALS, 'goal-map.json');
  const map = validateGoalMap(readJson(mapPath) || {}, mapPath);
  const review = demo ? { ...emptyReview(), ...(readJson(path.join(BUNDLED, 'review.json')) || {}) } : readReview(doc);
  const reviewById = Object.fromEntries((review.goals || []).map((g) => [g.id, g]));
  let approvalRows = [];
  if (!demo) {
    try {
      const { approvals } = await import('./approvals.mjs');
      approvalRows = approvals(30000).items || [];
    } catch { approvalRows = []; }
  }
  const plansByGoal = demo ? demoPlans(doc.goals, map) : realPlans(doc.goals, map, approvalRows);
  const allPlans = Object.values(plansByGoal).flat();

  const goals = doc.goals.map((g, i) => {
    const r = reviewById[g.id] || {};
    const plans = plansByGoal[g.id] || [];
    return {
      id: g.id,
      title: g.title,
      label: map.labels?.[g.id] || g.label || g.title,
      lane: g.lane || 'support',
      allocation: g.allocation ?? null,
      status: g.status || null,
      next: g.next_action || null,
      outcome: g.outcome || null,
      acceptance: g.acceptance || [],
      color: colourFor(g, i),
      paused: g.paused || r.paused || null,
      target: r.target ?? null,
      share: r.share ?? null,
      alignment: r.alignment ?? null,
      ownerShare: r.ownerShare ?? null,
      agentShare: r.agentShare ?? null,
      minutes: r.minutes ?? 0,
      ownerMin: r.ownerMin ?? 0,
      ownerAlign: r.ownerAlign ?? null,
      agentAlign: r.agentAlign ?? null,
      trend: r.trend || [],
      weekAlign: r.weekAlign || [],
      gates: r.gates || { total: 0, met: 0, unknown: 0 },
      metrics: metricsFor(g, doc),
      plans: plans.map(({ asks, ...p }) => p),
      asks: {
        open: plans.reduce((n, p) => n + p.open, 0),
        needYou: plans.reduce((n, p) => n + p.needYou, 0),
        projects: plans.filter((p) => p.open > 0),
      },
    };
  });

  const mapped = new Set(Object.values(plansByGoal).flat().map((p) => p.dir));
  const unmapped = demo ? [] : listDir(PLANS).filter((d) => PLAN_DIR.test(d) && !mapped.has(d)).sort();
  const news = readNews(demo);
  return {
    demo,
    at: Date.now(),
    baseline: doc.baseline || null,
    policy: doc.planning_policy || null,
    title: 'Goals',
    source: demo ? 'bundled example data' : goalsPath,
    freshness: demo ? { ...reviewState(), demo: true, updatedAt: Date.now(), lastRefreshAt: null } : reviewState(),
    overall: review.overall || {},
    reviewDate: review.reviewDate || null,
    weighting: review.weighting || {},
    weeks: review.weeks || [],
    goals,
    priorities: review.priorities || [],
    drift: review.drift || [],
    gaps: review.gaps || [],
    experiment: review.experiment || null,
    week: review.week || [],
    news,
    rules: readRules(demo),
    counts: {
      goals: goals.length,
      plans: allPlans.length,
      openAsks: goals.reduce((n, g) => n + g.asks.open, 0),
      needYou: goals.reduce((n, g) => n + g.asks.needYou, 0),
    },
    weekly: weeklyStatus(),
  };
}

export async function getOverview({ demo = false, force = false } = {}) {
  if (!force && cache.data && cache.demo === demo) return { ...cache.data, cached: true };
  if (inflight && inflight.demo === demo) return inflight.promise;
  const promise = (async () => {
    try {
      const data = await build(demo);
      cache = { demo, data, at: Date.now() };
      return data;
    } catch (error) {
      if (!demo && (error.code === 'NOGOALS' || error.code === 'ENOENT')) return await build(true);
      throw error;
    }
  })();
  inflight = { demo, promise };
  try { return await promise; } finally { inflight = null; }
}

export function invalidate() { cache = { demo: null, data: null, at: 0 }; }

export function errorShape(error) {
  return { file: error?.file || null, field: error?.field || null, message: String(error?.message || error) };
}

export async function runRefresh({ demo = false, dev = false, reason = 'manual' } = {}) {
  const started = Date.now();
  let external = { ran: false, reason: 'demo mode' };
  const script = path.join(GOALS, 'scripts', 'goals.py');
  if (!demo && !dev && exists(script)) {
    external = { ran: true, reason: 'goals.py refresh' };
    try {
      await execFileP('python3', [script, 'refresh'], { cwd: GOALS, timeout: 60000, maxBuffer: 1 << 20 });
    } catch (error) {
      const message = String(error?.killed ? 'goals.py refresh timed out after 60 s' : error?.message || error);
      throw new Error(message);
    }
  } else if (!demo && dev) external = { ran: false, reason: 'dev copy: no external commands' };
  invalidate();
  const data = await getOverview({ demo, force: true });
  const elapsed = Date.now() - started;
  if (elapsed > 60000) {
    const message = `The data refresh took ${Math.round(elapsed / 1000)} s, over the 60 s limit.`;
    throw new Error(message);
  }
  writeState({ lastRefreshAt: Date.now(), lastError: null, failures: 0, backoffUntil: null, lastRefreshReason: reason });
  return { ...data, refresh: { elapsed, external } };
}

export function markRefreshFailure(error) {
  const st = readState();
  const failures = (st.failures || 0) + 1;
  const level = Math.min(2, Math.max(0, failures - 3));
  const backoff = failures >= 3 ? [3600e3, 6 * 3600e3, 24 * 3600e3][level] : 0;
  const at = st.lastRefreshAt || Date.now();
  writeState({ lastError: String(error?.message || error), failures, backoffUntil: backoff ? Date.now() + backoff : null });
  return { failures, backoff, incidentAt: failures >= 3 ? at : null };
}
