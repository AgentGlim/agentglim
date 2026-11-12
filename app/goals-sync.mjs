#!/usr/bin/env node
// goals-sync: distills $AGENTGLIM_GOALS (goals.json + latest reviews/*-strategy-review.md, see SETUP.md)
// into $AGENTGLIM_DATA/goals-context.json for the Status card's Goals section. Run on POST /api/status-refresh
// and on server start; also runnable by hand. Read-only on the goals project.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA, GOALS, PLANS, goalsFile } from './paths.mjs';
import { ownerAttention, GAP_MIN, TAIL_MIN } from './owner-attention.mjs';
const OUT = `${DATA}/goals-context.json`;
// Seed bundled examples on first start; exclusive copies preserve private edits.
export function ensureDefaultGoals() {
  fs.mkdirSync(GOALS, { recursive: true });
  for (const name of ['goals.json', 'goal-map.json']) {
    // Older setups keep their goals under goals/data/; do not shadow them.
    if (name === 'goals.json' && goalsFile()) continue;
    try {
      fs.copyFileSync(new URL(`./defaults/goals/${name}`, import.meta.url), path.join(GOALS, name), fs.constants.COPYFILE_EXCL);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}
// goal id -> plans that move it (sources in goals.json that point into plans/ are added automatically)
// goal-map.json (private, next to goals.json): { "plans": {goal: [plan dirs]}, "effort": {goal: [plan number prefixes]}, "labels": {goal: label} }
const readMap = () => { try { return JSON.parse(fs.readFileSync(`${GOALS}/goal-map.json`, 'utf8')); } catch { return {}; } };
const readGoals = () => { const f = goalsFile(); if (!f) { const e = new Error(`no goals.json in ${GOALS} (see SETUP.md)`); e.code = 'NOGOALS'; throw e; } return JSON.parse(fs.readFileSync(f, 'utf8')); };
export function buildGoalsContext() {
  const g = readGoals(), PLAN_MAP = readMap().plans || {};
  let planDirs0 = []; try { planDirs0 = fs.readdirSync(PLANS); } catch {}
  const planDirs = new Set(planDirs0.filter((d) => /^\d\d-/.test(d)));
  const goals = g.goals.map((x) => {
    const fromSrc = (x.sources || []).map((s) => (s.match(/plans\/(\d\d-[^/]+)/) || [])[1]).filter(Boolean);
    const plans = [...new Set([...(PLAN_MAP[x.id] || []), ...fromSrc])].filter((d) => planDirs.has(d));
    const metrics = (g.metrics || []).filter((m) => m.goal === x.id).map((m) => ({ label: m.label, actual: m.actual, target: m.target_max ? `${m.target_min}-${m.target_max}` : m.target_min ?? null }));
    return { id: x.id, title: x.title, lane: x.lane, allocation: x.allocation, status: x.status, next: x.next_action, plans, metrics };
  });
  const order = { now: 0, floor: 1, support: 2 };
  goals.sort((a, b) => (order[a.lane] ?? 3) - (order[b.lane] ?? 3) || (b.allocation || 0) - (a.allocation || 0));
  // latest strategy review: the "next seven days" numbered list
  let week = [], reviewFile = null;
  try {
    const rf = fs.readdirSync(`${GOALS}/reviews`).filter((f) => /^\d{4}-\d\d-\d\d-.*review\.md$/.test(f)).sort();
    const pick = rf.filter((f) => f.includes('strategy')).pop() || rf.pop();
    if (pick) {
      reviewFile = pick; const t = fs.readFileSync(`${GOALS}/reviews/${pick}`, 'utf8');
      const sec = t.split(/^## /m).find((s) => /next seven days|this week/i.test(s.split('\n')[0])) || '';
      week = sec.split('\n').filter((l) => /^\d+\.\s/.test(l)).map((l) => l.replace(/^\d+\.\s*/, '').trim()).slice(0, 8);
    }
  } catch {}
  const mapped = new Set(goals.flatMap((x) => x.plans));
  const unmapped = [...planDirs].filter((d) => !mapped.has(d)).sort();
  return { at: Date.now(), source: 'goals.json', baseline: g.baseline, policy: g.planning_policy, reviewFile, week, goals, unmapped };
}
export function syncGoals() {
  const out = buildGoalsContext();
  try { syncGoalsReview(); } catch (e) { console.error('goals review failed', e.message); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(`${OUT}.next`, JSON.stringify(out, null, 2) + '\n'); fs.renameSync(`${OUT}.next`, OUT);
  return out;
}

// goals-review (2026-11-10): Goals tab data. Effort = owner interactive minutes (owner-attention.mjs) x owner_weight + finished harness
// agent-minutes from _run/driver.log x agent_weight (goals.json effort_weighting), vs goals.json allocation; priorities/drift/gaps from the latest reviews/*-review.json.
const REVIEW_OUT = `${DATA}/goals-review.json`;
// 2026-11-10 design: weeks backfilled from the first driver.log line; paused goals (goals.json status "paused") are
// excluded from alignment math; per-week top plans and events (reopen, hold, owner/watcher pause, circuit breaker).
export function buildGoalsReview(now = Date.now()) {
  const g = readGoals(), M = readMap(), EFFORT_MAP = M.effort || {}, LABEL = M.labels || {};
  const inv = {}; for (const [k, ps] of Object.entries(EFFORT_MAP)) for (const p of ps) inv[p] = k;
  const DAY = 864e5, lines = (() => { try { return fs.readFileSync(`${PLANS}/_run/driver.log`, 'utf8'); } catch { return ''; } })().split('\n');
  const first = Date.parse((lines.find((l) => /^\d{4}-\d\d-\d\d /.test(l)) || '').slice(0, 19).replace(' ', 'T')) || now - 28 * DAY;
  const WEEKS = Math.min(26, Math.max(1, Math.ceil((now - first) / (7 * DAY))));
  const weeks = Array.from({ length: WEEKS }, (_, i) => ({ end: new Date(now - i * 7 * DAY).toISOString().slice(0, 10), minutes: 0, by: {}, plans: {}, events: [] }));
  const wkOf = (ts) => { const k = Math.floor((now - Date.parse(ts.replace(' ', 'T'))) / (7 * DAY)); return k >= 0 && k < WEEKS ? weeks[k] : null; };
  for (const l of lines) {
    const ts = l.slice(0, 19); let m;
    if ((m = l.match(/^\S+ \S+ done (\d\d)(-\S+) .* (\d+)min$/))) { const w = wkOf(ts); if (!w) continue; const id = inv[m[1]] || 'other', n = +m[3]; w.minutes += n; w.by[id] = (w.by[id] || 0) + n; w.plans[m[1] + m[2]] = (w.plans[m[1] + m[2]] || 0) + n; continue; }
    const ev = (m = l.match(/^\S+ \S+ reopen (\d\d)(-\S+) as (v\d+)/)) ? { t: 'reopen', plan: m[1] + m[2], v: m[3], goal: inv[m[1]] || 'other' }
      : (m = l.match(/^\S+ \S+ hold (\d\d)(-\S+)/)) ? { t: 'hold', plan: m[1] + m[2], goal: inv[m[1]] || 'other' }
      : / paused by /.test(l) ? { t: 'pause' } : / CIRCUIT BREAKER/.test(l) ? { t: 'breaker' } : null;
    if (ev) { const w = wkOf(ts); if (w) w.events.push({ at: ts.slice(0, 10), ...ev }); }
  }
  // owner attention: interactive minutes per goal area per week (owner-attention.mjs)
  const OA = ownerAttention({ since: now - WEEKS * 7 * DAY, inv });
  for (const w of weeks) { w.owner = 0; w.ownerBy = {}; }
  for (const [t, by] of OA.minutes) { const k = Math.floor((now - t) / (7 * DAY)), w = k >= 0 && k < WEEKS ? weeks[k] : null; if (!w) continue; for (const [a, m] of Object.entries(by)) { w.ownerBy[a] = (w.ownerBy[a] || 0) + m; w.owner += m; } }
  // W_a = owner minutes spent supervising the harness (factory area) per autonomous agent-minute, whole window, clamped 0.05-0.15
  const agentTot = weeks.reduce((a, w) => a + w.minutes, 0), superTot = weeks.reduce((a, w) => a + (w.ownerBy.factory || 0), 0);
  const EW = g.effort_weighting || {}, [lo, hi] = EW.agent_weight_range || [0.05, 0.15], WH = typeof EW.owner_weight === 'number' ? EW.owner_weight : 1;
  const WA_RAW = agentTot ? superTot / agentTot : 0.1, WA = typeof EW.agent_weight === 'number' ? EW.agent_weight : Math.round(100 * Math.min(hi, Math.max(lo, WA_RAW))) / 100;
  for (const w of weeks) { w.wBy = {}; for (const a of new Set([...Object.keys(w.by), ...Object.keys(w.ownerBy)])) w.wBy[a] = WH * (w.ownerBy[a] || 0) + WA * (w.by[a] || 0); w.wMin = Object.values(w.wBy).reduce((a, x) => a + x, 0); }
  const pausedIds = new Set(g.goals.filter((x) => x.status === 'paused').map((x) => x.id));
  for (const x of g.goals) if (x.paused?.on) { const w = wkOf(`${x.paused.on} 12:00:00`); if (w) w.events.push({ at: x.paused.on, t: 'goalpause', goal: x.id, recheck: x.paused.recheck }); }
  const tg = g.goals.filter((x) => x.allocation && !pausedIds.has(x.id)); const tot = tg.reduce((a, x) => a + x.allocation, 0);
  // alignment = overlap between where time went and the goal weights (clients floor and paused goals excluded).
  // Three views: weighted (default: owner + W_a x agent), owner (interactive only), agent (old score, harness minutes only).
  const den = (by) => Object.values(by).reduce((a, x) => a + x, 0) - (by.clients || 0) - [...pausedIds].reduce((a, id) => a + (by[id] || 0), 0);
  const align = (by) => { const d = den(by); return d > 0 ? Math.round(100 * tg.reduce((a, x) => a + Math.min((by[x.id] || 0) / d, x.allocation / tot), 0)) : null; };
  const offOf = (by) => { const d = den(by); return d > 0 ? Math.round(100 * (by.other || 0) / d) : null; };
  const denOf = (w) => den(w.by);
  for (const w of weeks) { w.alignment = align(w.wBy); w.offGoal = offOf(w.wBy); w.ownerAlign = align(w.ownerBy); w.agentAlign = align(w.by); w.agentOff = offOf(w.by); }
  const cur = weeks[0], wden = den(cur.wBy) || 1, oden = den(cur.ownerBy) || 1, aden = den(cur.by) || 1;
  const goals = g.goals.map((x) => {
    const ms = (g.metrics || []).filter((m) => m.goal === x.id), paused = pausedIds.has(x.id) ? { on: x.paused?.on || null, recheck: x.paused?.recheck || null, reason: x.paused?.reason || null } : null;
    const target = x.allocation && !paused ? Math.round(100 * x.allocation / tot) : null, share = target != null ? Math.round(100 * (cur.wBy[x.id] || 0) / wden) : null;
    const aOf = (s) => s == null || target == null ? null : Math.round(100 * Math.min(s, target) / Math.max(s, target, 1));
    const trend = weeks.map((w) => { const d = den(w.wBy); return d > 0 ? Math.round(100 * (w.wBy[x.id] || 0) / d) : null; }).reverse();
    return { id: x.id, label: LABEL[x.id] || x.label || x.id, lane: x.lane, status: x.status, paused, target, share, minutes: cur.by[x.id] || 0,
      ownerMin: Math.round(cur.ownerBy[x.id] || 0), ownerShare: target != null ? Math.round(100 * (cur.ownerBy[x.id] || 0) / oden) : null,
      agentShare: target != null ? Math.round(100 * (cur.by[x.id] || 0) / aden) : null,
      alignment: aOf(share), trend, weekAlign: target == null ? null : trend.map(aOf),
      gates: { total: ms.length, met: ms.filter((m) => m.actual != null && m.actual >= (m.target_min ?? Infinity)).length, unknown: ms.filter((m) => m.actual == null).length } };
  });
  let review = null, reviewFile = null;
  try { const rf = fs.readdirSync(`${GOALS}/reviews`).filter((f) => /^\d{4}-\d\d-\d\d-review\.json$/.test(f)).sort().pop(); if (rf) { review = JSON.parse(fs.readFileSync(`${GOALS}/reviews/${rf}`, 'utf8')); reviewFile = rf; } } catch {}
  const off = Object.entries(cur.plans).filter(([p]) => !inv[p.slice(0, 2)]).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([plan, minutes]) => ({ plan, minutes }));
  // per-week plan contribution: top plans by minutes with their goal (other = off-goal), as % of the alignment denominator
  const wout = weeks.map(({ plans, wBy, ...w }) => { w.owner = Math.round(w.owner); w.ownerBy = Object.fromEntries(Object.entries(w.ownerBy).map(([a, m]) => [a, Math.round(m)])); w.wMin = Math.round(w.wMin); const d = denOf(w) || 1; return { ...w, top: Object.entries(plans).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([plan, minutes]) => ({ plan, minutes, goal: inv[plan.slice(0, 2)] || 'other', pct: Math.round(100 * minutes / d) })) }; }).reverse();
  const oTot = {}; for (const w of weeks) for (const [a, m] of Object.entries(w.ownerBy)) oTot[a] = (oTot[a] || 0) + m;
  return { at: now, source: 'interactive sessions + harness driver.log + goals.json', reviewFile, reviewDate: review?.date || null, method: review?.method || null,
    weighting: { WH, WA, WA_RAW: Math.round(1000 * WA_RAW) / 1000, gapMin: GAP_MIN, tailMin: TAIL_MIN, sessions: OA.sessions, blocks: OA.blocks, rawMin: OA.rawMin, superMin: Math.round(superTot), agentMin: agentTot,
      formula: `effort = owner_min x ${WH} + agent_min x ${WA}`, why: `W_a = owner minutes supervising the harness / harness agent-minutes over the window (${Math.round(superTot)} / ${agentTot} = ${(WA_RAW).toFixed(3)}), clamped to 0.05-0.15`,
      ownerTotal: Object.fromEntries(Object.entries(oTot).map(([a, m]) => [a, Math.round(m)])) },
    overall: { alignment: cur.alignment, prev: weeks[1]?.alignment ?? null, ownerAlign: cur.ownerAlign, agentAlign: cur.agentAlign, agentPrev: weeks[1]?.agentAlign ?? null,
      minutes: cur.minutes, ownerMin: Math.round(cur.owner), paused: [...pausedIds] },
    weeks: wout, goals, offGoal: off,
    priorities: review?.priorities || [], drift: review?.drift || [], gaps: review?.gaps || [], experiment: review?.experiment || null };
}
export function syncGoalsReview() { fs.mkdirSync(DATA, { recursive: true }); const o = buildGoalsReview(); fs.writeFileSync(`${REVIEW_OUT}.next`, JSON.stringify(o, null, 2) + '\n'); fs.renameSync(`${REVIEW_OUT}.next`, REVIEW_OUT);
  // full goals page (2026-11-10): rebuild $AGENTGLIM_GOALS/goals.html when the goals folder ships the builder (not from the dev copy)
  const B = `${GOALS}/scripts/build_goals_page.mjs`;
  if (!process.env.AGENTGLIM_DEV && fs.existsSync(B)) try { execFileSync(process.execPath, [B, REVIEW_OUT, `${GOALS}/goals.html`], { stdio: 'ignore', timeout: 20000 }); } catch (e) { console.error('goals page build failed', e.message); }
  return o; }
if (fs.realpathSync(process.argv[1] || '') === fs.realpathSync(fileURLToPath(import.meta.url))) { const o = syncGoals(); console.log(`goals-context: ${o.goals.length} goals, ${o.week.length} week items -> ${OUT}`); }
