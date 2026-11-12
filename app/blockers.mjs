// blockers.mjs - Status card additions:
//   1. rankBlockers: every open owner item scored by how much clearing it advances the plans,
//      weighted by project tier (P1 x4, P2 x2, P3 x1, owner's choice). The watcher can pin items with a reason.
//   2. optimizeTips: rules over run data that point at lost time, wasted tokens, weak quality and
//      unclean stops (a stop with no PAUSE.md / HANDOFF.md loses the round's in-progress work).
//   3. owner claims: the owner clicks "done" on an item; it stays open as "waiting for the watcher's check"
//      until the watcher confirms it (approvals done mark) or reopens it with a reason (owner's choice: verify first).
// Files: data/owner-claims.json (claims), data/blocker-pins.json (watcher pins), _run/owner_check/<ms>.json
// (wake files; auditq-wait.sh prints CHECK: and the watcher runs _run/bin/owner-check.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
import { PLANS, DATA } from './paths.mjs';
export const CLAIMS_FILE = `${DATA}/owner-claims.json`;
export const PINS_FILE = `${DATA}/blocker-pins.json`;
export const CHECK_DIR = `${PLANS}/_run/owner_check`;
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 1) + '\n'); fs.renameSync(`${f}.tmp`, f); };
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const money = (n) => `$${n >= 100 ? Math.round(n) : n.toFixed(2)}`;
const tok = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

// ---------- owner claims ----------
export const readClaims = () => readJson(CLAIMS_FILE, {});
export const readPins = () => readJson(PINS_FILE, { items: [] }).items || [];
export const claimsMtime = () => Math.max(mtime(CLAIMS_FILE), mtime(PINS_FILE));
export function claim(item, note) { // owner says done; the watcher is woken to check
  const c = readClaims(), at = new Date().toISOString();
  c[item.id] = { state: 'checking', at, note: String(note || '').slice(0, 600), title: item.title, project: item.project, kind: item.kind, src: item.src || '', cmd: item.cmd || '', history: [...(c[item.id]?.history || []), { at, state: 'claimed', note: String(note || '').slice(0, 600) }].slice(-10) };
  writeJson(CLAIMS_FILE, c);
  fs.mkdirSync(CHECK_DIR, { recursive: true }); fs.writeFileSync(`${CHECK_DIR}/${Date.now()}.json`, JSON.stringify({ at, id: item.id }) + '\n');
  return c[item.id];
}
const clearWakes = (c) => { if (!Object.values(c).some((x) => x.state === 'checking')) try { for (const f of fs.readdirSync(CHECK_DIR)) if (/^\d+\.json$/.test(f)) fs.unlinkSync(`${CHECK_DIR}/${f}`); } catch {} };
export function unclaim(id) { const c = readClaims(); if (!c[id]) return null; delete c[id]; writeJson(CLAIMS_FILE, c); clearWakes(c); return { state: 'open' }; }
export function resolveClaim(id, state, reason, by = 'watcher') { // state: confirmed | reopened
  const c = readClaims(); if (!c[id]) return null; const at = new Date().toISOString();
  Object.assign(c[id], { state, checkedAt: at, reason: String(reason || '').slice(0, 800), by });
  c[id].history = [...(c[id].history || []), { at, state, note: c[id].reason }].slice(-10);
  writeJson(CLAIMS_FILE, c);
  clearWakes(c);
  return c[id];
}

// ---------- ranked blockers ----------
export const TIER_W = { 1: 4, 2: 2, 3: 1 };
// how much a single item holds back: a gate freezes a whole plan, harness decisions touch every plan
const IMPACT = { gate: [10, 'freezes the whole plan until you act'], harness: [6, 'run-system decision: affects every plan'], ask: [5, 'the watcher is waiting on it'], verify: [4, 'final check only you can do'], audit: [3, 'the auditor needs you'] };
function impactOf(it, plan) {
  if (IMPACT[it.kind]) return IMPACT[it.kind];
  const live = plan && plan.state !== 'done';
  if (it.kind === 'decision') return live ? [4, 'open plan decision: the build guesses until you answer'] : [2, 'open plan decision'];
  if (it.kind === 'deferred') return it.prio === '0' || it.prio === '1' ? [4, `P${it.prio} deferred: blocks part of the plan`] : it.prio === '2' ? [2, 'P2 deferred'] : [1, 'deferred'];
  return [1, it.kind];
}
export function rankBlockers({ items, prio, plans, max = 40, perPlan = 2 }) {
  const claims = readClaims(), pins = readPins(), pinIdx = new Map(pins.map((p, i) => [p.id, { ...p, i }]));
  const byDir = new Map((plans || []).map((p) => [p.dir, p])), now = Date.now();
  const open = (items || []).filter((i) => i.owner && !i.done);
  const scored = open.map((it) => {
    const pr = prio.projects?.[it.project] || {}, tier = pr.tier || (['watcher', 'harness'].includes(it.project) ? 1 : 3), plan = byDir.get(it.project);
    const [imp, why] = impactOf(it, plan);
    const liveF = !plan ? 1 : ['running', 'gate', 'waiting', 'cooldown'].includes(plan.state) ? 1.5 : plan.state === 'held' ? 1.2 : 1;
    const days = it.added ? (now - Date.parse(it.added)) / 86400e3 : 0, ageF = 1 + Math.min(14, Math.max(0, days || 0)) / 28;
    const score = Math.round(TIER_W[tier] * imp * liveF * ageF * 10) / 10, cl = claims[it.id], pin = pinIdx.get(it.id);
    return { id: it.id, project: it.project, kind: it.kind, key: it.key, title: it.title, detail: it.detail, cmd: it.cmd || '', added: it.added || '', src: it.src || '', tier, score, pin: pin ? { why: pin.why || '', i: pin.i } : null,
      why: `${why}${liveF > 1 ? ` · plan ${plan.state}` : ''}${days >= 1 ? ` · ${Math.round(days)} d old` : ''}`, parts: { tier: TIER_W[tier], impact: imp, live: liveF, age: +ageF.toFixed(2) },
      claim: cl ? { state: cl.state, at: cl.at, note: cl.note, reason: cl.reason || '', checkedAt: cl.checkedAt || null } : null };
  }).sort((a, b) => (a.pin ? -1e6 + a.pin.i : 0) - (b.pin ? -1e6 + b.pin.i : 0) || b.score - a.score || a.id.localeCompare(b.id));
  const per = {}, top = [], restOf = {};
  for (const s of scored) { per[s.project] = (per[s.project] || 0) + 1; if (s.pin || per[s.project] <= perPlan) { if (top.length < max) top.push(s); } else restOf[s.project] = (restOf[s.project] || 0) + 1; }
  for (const s of top) s.more = restOf[s.project] || 0;
  const sumTop = (n) => top.slice(0, n).reduce((x, s) => x + s.score, 0), all = scored.reduce((x, s) => x + s.score, 0);
  const recent = Object.entries(claims).filter(([, c]) => c.state === 'confirmed' && c.checkedAt && now - Date.parse(c.checkedAt) < 86400e3).map(([id, c]) => ({ id, title: c.title, project: c.project, reason: c.reason, at: c.checkedAt }));
  const roll = {};
  for (const x of scored) { const r = (roll[x.project] ||= { project: x.project, tier: x.tier, n: 0, score: 0, kinds: {}, best: x.title, bestScore: x.score, state: byDir.get(x.project)?.state || null }); r.n++; r.score += x.score; r.kinds[x.kind] = (r.kinds[x.kind] || 0) + 1; }
  const byPlan = Object.values(roll).map((r) => ({ ...r, score: Math.round(r.score) })).sort((a, b) => b.score - a.score).slice(0, 30);
  const claimLog = Object.entries(claims).map(([id, c]) => ({ id, title: c.title, project: c.project, state: c.state, at: c.at, note: c.note, reason: c.reason || '', checkedAt: c.checkedAt || null, history: c.history || [] })).sort((a, b) => Date.parse(b.checkedAt || b.at) - Date.parse(a.checkedAt || a.at)).slice(0, 30);
  return { byPlan, claimLog, top, total: open.length, share8: all ? Math.round(100 * sumTop(8) / all) : 0, checking: Object.values(claims).filter((c) => c.state === 'checking').length, recent,
    byTier: [1, 2, 3].map((t) => ({ tier: t, n: scored.filter((s) => s.tier === t).length })) };
}

// ---------- optimize tips ----------
// lines: driver.log lines; plans: digest plans (steps, auditHist, rev, state); health: healthNow(); speed: speedNow(); tally
export function optimizeTips({ lines, plans, health, speed, tally, prio }) {
  const tips = [], now = Date.now(), WEEK = 7 * 86400e3, tw = (dir) => TIER_W[prio.projects?.[dir]?.tier || 3];
  // 1. clean pauses and handoffs (owner: crucial; without a note the round's in-progress work is lost)
  // (handoff review, _observatory/handoff-fix-review.html): every step kind (vN-rK, verify, focus,
  // p1, setup), rc != 0 that advanced in the same second counts as a "late" stop (outputs were complete, no work
  // lost, own bucket), "done rc=0 missing=[...]" with no pause line counts too, and each stop carries a cause.
  const STEP = '(p1|focus|verify|v\\d+-(?:r\\d+|focus|verify|setup))';
  const stops = [];
  const advOk = new Set(); for (const l of lines) { const m = new RegExp(`^(\\S+ \\S+) advance (\\d\\d-[\\w.-]+) ${STEP} -> \\S+ \\(ok`).exec(l); if (m) advOk.add(`${m[1]} ${m[2]} ${m[3]}`); }
  const pausedAt = new Set(); for (const l of lines) { const m = new RegExp(`^(\\S+ \\S+) (?:paused|limit|checkpoint) (\\d\\d-[\\w.-]+) ${STEP}`).exec(l); if (m) pausedAt.add(`${m[1]} ${m[2]} ${m[3]}`); }
  const CAUSE = { lost: 'restart', 75: 'limit', paused: 'limit', checkpoint: 'checkpoint', 124: 'kill', 137: 'kill', 143: 'kill' };
  for (const l of lines) {
    const m = new RegExp(`^(\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d) (done|paused|checkpoint) (\\d\\d-[\\w.-]+) ${STEP}(?::| rc=(\\S+)(?: missing=\\[([^\\]]*)\\])?)`).exec(l); if (!m) continue;
    const key = `${m[1]} ${m[3]} ${m[4]}`, kind = m[2], rc = m[5], miss = m[6] || '';
    if (kind === 'done' && rc === '0' && (!miss || pausedAt.has(key))) continue; // clean, or the pause line covers it
    if (m[4] === 'p1') continue; // planning steps have no round state to hand off
    const mins = Number((/ (\d+)min$/.exec(l) || [])[1] || 0); if (kind === 'done' && rc === '0' && mins < 5) continue; // a quick no-output exit had nothing in progress
    const t = Date.parse(m[1].replace(' ', 'T')); if (now - t > WEEK) continue;
    const late = kind === 'done' && rc !== '0' && advOk.has(key);
    const cause = late ? 'late' : kind !== 'done' ? CAUSE[kind] : rc === '0' ? 'missing' : CAUSE[rc] || 'error';
    const b = /^(p1|focus|verify)$/.test(m[4]) || /-(focus|verify|setup)$/.test(m[4]) ? `${PLANS}/${m[3]}/_build/${m[4]}` : `${PLANS}/${m[3]}/_build/${m[4]}`;
    const note = ['PAUSE.md', 'HANDOFF.md'].some((n) => { const x = mtime(`${b}/${n}`); return x && x >= t - 20 * 60e3 && (x <= t + 3 * 3600e3 || (kind === 'paused' && n === 'HANDOFF.md')); });
    stops.push({ t, dir: m[3], round: m[4], rc: kind === 'done' ? rc : kind, cause, late, note });
  }
  const byRound = new Map(); for (const s of stops) { const k = `${s.dir} ${s.round}`, o = byRound.get(k); if (!o || (o.note && !s.note) || (o.note === s.note && s.t > o.t)) byRound.set(k, s); } // one row per round: its worst (unclean) stop
  const rounds = [...byRound.values()].sort((a, b) => a.t - b.t);
  const SINCE = Date.parse('2026-10-29T15:00:00'); // checkpoint.sh + driver handoff() exist since 2026-10-29 ~15:00
  const main = rounds.filter((s) => !s.late), lateR = rounds.filter((s) => s.late), bad = main.filter((s) => !s.note);
  const split = (arr) => ({ n: arr.length, noted: arr.filter((s) => s.note).length, unnoted: arr.filter((s) => !s.note).length });
  const daily = {}; for (const s of rounds) { const d = new Date(s.t).toLocaleDateString('sv-SE'), r = (daily[d] ||= { date: d, noted: 0, unnoted: 0, late: 0 }); if (s.late) r.late++; else if (s.note) r.noted++; else r.unnoted++; }
  const stopStats = { pre: split(main.filter((s) => s.t < SINCE)), post: split(main.filter((s) => s.t >= SINCE)), late: lateR.length,
    byCause: Object.fromEntries(['limit', 'restart', 'kill', 'checkpoint', 'missing', 'error'].map((c) => [c, bad.filter((s) => s.cause === c).length])), daily: Object.values(daily) };
  if (bad.length) {
    const recent = bad.filter((s) => s.t >= SINCE), bc = stopStats.byCause;
    const causes = [bc.restart && `${bc.restart} lost to driver restarts`, bc.limit && `${bc.limit} usage-limit stops`, bc.kill && `${bc.kill} timeouts or kills`, bc.checkpoint && `${bc.checkpoint} checkpoints`, bc.missing && `${bc.missing} finished without their output`, bc.error && `${bc.error} errors`].filter(Boolean).join(', ');
    tips.push({ kind: 'handoff', weight: (recent.length ? 60 + recent.length * 10 : 15) + bad.length, title: recent.length ? `${recent.length} round${recent.length === 1 ? '' : 's'} stopped with no PAUSE.md or HANDOFF.md since the 10-29 fixes; ${bad.length} of ${main.length} in 7 days` : `${bad.length} of ${main.length} rounds stopped in 7 days with no PAUSE.md or HANDOFF.md (all before the 10-29 fixes)`,
      text: `Those rounds restart from task DONE files only; whatever the coordinator had in progress is gone. 7 days: ${causes}.${lateR.length ? ` Not counted: ${lateR.length} late stop${lateR.length === 1 ? '' : 's'} (rc != 0 after the outputs were complete; nothing lost).` : ''}`,
      list: bad.slice(-8).reverse().map((s) => `${s.t >= SINCE ? 'NEW ' : ''}${s.dir} ${s.round} ${s.cause} (rc=${s.rc}) ${new Date(s.t).toTimeString().slice(0, 5)} ${new Date(s.t).toISOString().slice(5, 10)}`),
      fix: recent.length ? 'Read the newest ones: a stop the 11-03 harness fixes should cover (reap() late notes, checkpoint for luna/pi, audit-only resumes) points at a gap. Before a reboot run the checkpoint pause.' : 'Nothing new since the fixes. Before a reboot or driver restart run the checkpoint pause (no plan names: it also writes _run/STOP).', cmd: 'bash _run/bin/checkpoint.sh' });
  }
  for (const p of plans) if (p.held && /^v\d+-r\d$/.test(p.stage) && !fs.existsSync(`${PLANS}/${p.dir}/_build/${p.stage}/PAUSE.md`) && fs.existsSync(`${PLANS}/${p.dir}/_build/${p.stage}`))
    tips.push({ kind: 'handoff', dir: p.dir, weight: 20 * tw(p.dir) / 2, title: `${p.dir} is held mid-round (${p.stage}) with no PAUSE.md`, text: 'Whoever resumes it has no note on what was in progress.', fix: 'Ask the watcher to write one from the round folder, or resume the round soon.' });
  // 2. tokens: steps far above the plan's median, and audits eating the budget
  const heavy = [], auditHeavy = [];
  for (const p of plans) {
    const st = (p.steps || []).filter((s) => s.tok + s.atok > 0), md = median(st.map((s) => s.tok + s.atok)), mc = median(st.map((s) => s.cost + s.acost));
    for (const s of st) { const v = s.tok + s.atok, c = s.cost + s.acost; if (md && v >= 2 * md && v >= 2e6) heavy.push({ p, s, v, x: v / md, over: Math.max(0, c - mc) }); }
    const ac = st.reduce((n, s) => n + s.acost, 0), wc = st.reduce((n, s) => n + s.cost, 0);
    if (ac + wc >= 5 && ac / (ac + wc) >= 0.45) auditHeavy.push({ dir: p.dir, ac, all: ac + wc });
  }
  if (auditHeavy.length) { const ac = auditHeavy.reduce((n, x) => n + x.ac, 0), all = auditHeavy.reduce((n, x) => n + x.all, 0);
    tips.push({ kind: 'tokens', weight: 10 + ac / 4, title: `Audits are ${Math.round(100 * ac / all)}% of spend in ${auditHeavy.length} plans (${money(ac)} of ${money(all)}, last 12 steps each)`, text: 'Checking costs more than building in these plans. Counted as audits: round audits, the final verify and feature-loop audits; planning (p1, focus check) is not.',
      list: auditHeavy.sort((a, b) => b.ac - a.ac).map((x) => `${x.dir}: ${Math.round(100 * x.ac / x.all)}% (${money(x.ac)} of ${money(x.all)})`), fix: 'Audit r1/r2 with a cheaper model (Sonnet) and keep Opus for r3 and the final verify, or audit every other round.', ...(fs.existsSync(`${PLANS}/_run/AUDIT-SPEND-REVIEW.html`) ? { href: '/audit-spend', hrefLabel: '14-day session review' } : {}) }); }
  for (const h of heavy.sort((a, b) => b.over - a.over).slice(0, 4)) tips.push({ kind: 'tokens', dir: h.p.dir, weight: 6 + h.over, title: `${h.p.dir} ${h.s.step} used ${tok(h.v)} tokens, ${h.x.toFixed(1)}x its median step${h.over >= 0.5 ? ` (~${money(h.over)} over)` : ''}`, text: 'One step far above the rest usually means a task too big for one worker, a retry loop, or a large file read again and again.', fix: `Read ${h.p.dir}/_build/${h.s.step}/BUILD-LOG.md (or its job logs) for repeats; split big tasks or pin a cheaper worker for this plan.` });
  // 3. quality: flat or falling audit scores, many revisions without reaching 90
  for (const p of plans) {
    const a = (p.auditHist || []).map((x) => x.pct), l = a.slice(-3), last = a.at(-1);
    if (l.length === 3 && last < 90 && Math.max(...l) - Math.min(...l) <= 4) tips.push({ kind: 'quality', dir: p.dir, weight: 9 * tw(p.dir), title: `${p.dir}: audit flat at ~${last}% for 3 rounds`, text: 'More rounds of the same brief are not moving it; each costs a full round of tokens.', fix: 'Read the last AUDIT.md misses and rescope the brief (or accept partial and stop the loop).' });
    else if (a.length >= 2 && a.at(-2) - last >= 10) tips.push({ kind: 'quality', dir: p.dir, weight: 8 * tw(p.dir), title: `${p.dir}: audit fell ${a.at(-2)}% -> ${last}% (${p.auditHist.at(-1).round})`, text: 'The last round broke something that worked.', fix: 'Point the next round at the regressions first, or revert that round.' });
    if ((p.rev || 0) >= 5 && last != null && last < 85 && p.state !== 'done') tips.push({ kind: 'quality', dir: p.dir, weight: 5 * tw(p.dir), title: `${p.dir} is on v${p.rev} and still at ${last}%`, text: 'Many reopenings with little gain: the plan may need a decision or a smaller target, not another round.', fix: 'Check its open decisions on the approvals page; a blocker there often explains a stuck score.' });
  }
  // 4. time: slow steps, idle slots while plans wait, hung readers, free models stalled
  // run minutes from the driver's done lines (wall time between steps includes HOLD time, so it is not used)
  const runs = {};
  for (const l of lines) { const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) done (\d\d-[\w.-]+) (\S+) rc=0 .* (\d+)min$/.exec(l); if (m && now - Date.parse(m[1].replace(' ', 'T')) < WEEK) (runs[m[2]] ||= []).push({ step: m[3], mins: +m[4] }); }
  const slow = [];
  for (const [dir, rs] of Object.entries(runs)) { const md = median(rs.map((r) => r.mins)); for (const r of rs) if (md && r.mins >= 2 * md && r.mins >= 90) slow.push({ dir, r, x: r.mins / md }); }
  for (const x of slow.sort((a, b) => b.r.mins - a.r.mins).slice(0, 3)) tips.push({ kind: 'time', dir: x.dir, weight: 4 + x.r.mins / 30, title: `${x.dir} ${x.r.step} ran ${Math.floor(x.r.mins / 60)}h${String(x.r.mins % 60).padStart(2, '0')}, ${x.x.toFixed(1)}x its median step (7 d)`, text: 'Long runs are usually waits (rate limits, a hung reader, a paused slot) or one oversized task, more than steady work.', fix: `Check ${x.dir}/_build/${x.r.step}/ BUILD-LOG.md and the reaper log for pauses and hangs; split the largest task next time.` });
  if (health?.hangs?.n >= 3) tips.push({ kind: 'time', weight: 6 + health.hangs.n, title: `${health.hangs.n} hung readers killed in 24 h`, text: 'Each one holds a worker slot until the reaper finds it (minutes per hang). Most are workers reading stdin (cat, python3 -).', fix: 'Launch workers with stdin from /dev/null in worker.sh / agent.sh, so a stray stdin read ends at once.' });
  if (health?.free?.total && health.free.paused >= Math.ceil(health.free.total / 2)) tips.push({ kind: 'time', weight: 5, title: `${health.free.paused} of ${health.free.total} free models rate-limited`, text: 'Tasks routed to free slots wait or bounce between models.', fix: 'Drop the most-limited models from flags/zen_free_models or lower free concurrency until they recover.' });
  const can = (speed?.providers || []).filter((p) => !p.off && !p.limited).reduce((n, p) => n + Object.values(p.canStart || {}).reduce((a, v) => a + (+v || 0), 0), 0);
  if (tally?.waiting && can) tips.push({ kind: 'time', weight: 7 + tally.waiting, title: `${tally.waiting} plan${tally.waiting === 1 ? '' : 's'} waiting while ${can} slot${can === 1 ? '' : 's'} could start`, text: 'Capacity is idle with work queued.', fix: 'Check HOLD files, the single-loop list and P2_CAP; a raised cap or a removed HOLD starts them.' });
  const spend = plans.map((p) => { const st = p.steps || [], wc = st.reduce((n, x) => n + x.cost, 0), ac = st.reduce((n, x) => n + x.acost, 0), wt = st.reduce((n, x) => n + x.tok, 0), at = st.reduce((n, x) => n + x.atok, 0); return { dir: p.dir, work: +wc.toFixed(2), audit: +ac.toFixed(2), workTok: wt, auditTok: at, steps: st.length, auditPct: p.auditHist?.at(-1)?.pct ?? null, rev: p.rev || null }; }).filter((x) => x.work + x.audit > 0).sort((a, b) => b.work + b.audit - a.work - a.audit);
  const runList = Object.entries(runs).map(([dir, rs]) => ({ dir, n: rs.length, median: median(rs.map((r) => r.mins)), max: Math.max(...rs.map((r) => r.mins)), total: rs.reduce((n, r) => n + r.mins, 0) })).sort((a, b) => b.total - a.total);
  return { tips: tips.sort((a, b) => b.weight - a.weight).map((t) => ({ ...t, weight: Math.round(t.weight) })),
    stops: rounds.slice(-60).reverse().map((x) => ({ t: x.t, dir: x.dir, round: x.round, rc: x.rc, cause: x.cause, late: x.late, note: x.note })), stopStats, spend, runs: runList,
    heavy: heavy.sort((a, b) => b.over - a.over).slice(0, 15).map((h) => ({ dir: h.p.dir, step: h.s.step, tok: h.v, x: +h.x.toFixed(1), over: +h.over.toFixed(2) })) };
}

// ---------- in-depth data for the Warnings and flags view ----------
const FLAG_HELP = {
  driver: ['Nothing launches, advances or reaps while the driver is down; running agents finish but their results are not picked up.', 'Start the driver.', 'bash _run/start-driver.sh'],
  stall: ['A running round that writes nothing for 40+ min is usually hung (stdin read, rate-limit loop, dead child) and holds a slot.', 'Open the round folder, check the newest worker log; kill the hung process (the hang reaper only catches stdin readers) or run a checkpoint pause for that plan.', ''],
  paused: ['The agent is SIGSTOPped or cooling down on a usage window; it resumes on its own after the reset.', 'Nothing unless the reset is far away; then move the plan to another provider (speed strip) or hold it.', ''],
  'coordinator note': ['The coordinator\'s last message uses data-loss words (deleted, overwritten, lost...). Work may have been removed.', 'Read the coordinator note in full and diff the round against the previous one before approving anything.', ''],
  'audit risk': ['The auditor\'s biggest-risk line uses data-loss words.', 'Read the AUDIT.md risk section; check the files it names still exist.', ''],
  'audit verdict': ['The auditor\'s verdict uses data-loss words.', 'Read the AUDIT.md verdict; check the files it names still exist.', ''],
  audit: ['The last audit scored under 60%: the round delivered well under half of what the brief asked.', 'Read the AUDIT.md misses; rescope the brief or answer its open decisions before the next round spends more.', ''],
  gate: ['The plan is frozen at its owner gate; nothing runs until you approve or ask for a redo.', 'Audit the round, then approve or redo on the approvals page.', ''],
  'watcher ask': ['The watcher asked you for something it cannot do itself (permissions, money, a decision).', 'Do it, then click done on the blocker so the watcher checks and closes it.', ''],
  'free models': ['Half or more of the free models answered 429 in the last hour; free-slot tasks wait or bounce.', 'Drop the worst models from flags/zen_free_models or lower free concurrency until they recover.', ''],
  'audit queue': ['Nobody is listening on the audit queue; premium audits fall back to Codex or wait.', 'Re-arm the watcher\'s queue listener.', 'bash _run/bin/auditq-wait.sh'],
  memory: ['RAM above 85%: new agents may be OOM-killed mid-round (rc 137, no handoff note).', 'Lower concurrency (speed strip) or stop the heaviest agent.', ''],
  '/tmp': ['/tmp is a RAM disk; when full, every agent that writes scratch files fails.', 'Find the largest scratch folders and move or delete them.', 'du -sh /tmp/* 2>/dev/null | sort -h | tail'],
  usage: ['A subscription window is near its cap; when it hits, every agent on it stops at once.', 'Slow that provider (speed strip) or let limit-pause stop agents cleanly before the cap.', ''],
};
export function enrichFlags(flags, { plans, items, apPages, lim }) {
  const byDir = new Map((plans || []).map((p) => [p.dir, p])), asks = (items || []).filter((i) => i.kind === 'ask' && !i.done), claims = readClaims();
  return flags.map((f) => {
    const [why, fix, cmd] = FLAG_HELP[f.where] || ['', '', ''], p = f.dir ? byDir.get(f.dir) : null, ev = [];
    if (p) {
      ev.push(`stage ${p.stage} (${p.headline || ''}), state ${p.state}${p.since ? `, since ${new Date(p.since).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}`);
      if (p.audit) ev.push(`audit ${p.audit.round}: ${p.audit.pct}%${(p.auditHist || []).length > 1 ? ` (trend ${p.auditHist.slice(-6).map((a) => `${a.round} ${a.pct}%`).join(' -> ')})` : ''}`);
      if (p.says?.verdict) ev.push(`audit verdict: ${p.says.verdict}`); if (p.says?.risk) ev.push(`biggest risk: ${p.says.risk}`);
      if (p.orch) ev.push(`coordinator: ${p.orch}`); if (p.last) ev.push(`last driver event ${new Date(p.last.t).toISOString().slice(5, 16).replace('T', ' ')}: ${p.last.text}`);
      if (p.idleMin != null) ev.push(`newest write in the round folder ${p.idleMin} min ago`);
      if ((p.workers || []).length) ev.push(`workers: ${p.workers.map((w) => `${w.name} ${w.state}`).join(', ')}`);
      if ((p.models || []).length) ev.push(`agents: ${p.models.map((m) => `${m.role} ${m.model || m.provider}${m.paused ? ' (paused)' : ''}`).join(', ')}`);
      if (p.held) ev.push(`HOLD: ${p.held}`); if (p.open) ev.push(`${p.open} open owner items for this plan`);
    }
    let c = cmd, src = p && p.audit ? `${f.dir}/_build/${p.audit.round}/AUDIT.md` : p ? `${f.dir}/_build/${p.stage}/` : '';
    if (f.where === 'gate' && p) c = `touch ~/dev/projects/plans/${f.dir}/_build/${p.stage}/APPROVED`;
    if (f.where === 'stall' && p) c = `ls -lt ~/dev/projects/plans/${f.dir}/_build/${p.stage}/workers/*/ | head -20`;
    if (f.where === 'watcher ask') { const a = asks.find((x) => f.text.startsWith(String(x.title).slice(0, 60))); if (a) { if (a.detail) ev.push(a.detail); if (a.cmd) c = a.cmd; if (a.src) src = a.src; const cl = claims[a.id]; if (cl) ev.push(`your done claim: ${cl.state}${cl.reason ? ` (${cl.reason})` : ''}`); f.id = a.id; } }
    if (f.where === 'usage') for (const l of lim || []) for (const w of l.windows) if (f.text.startsWith(`${l.name} ${w.label}`) && w.resetsAt) ev.push(`resets ${new Date(w.resetsAt).toISOString().slice(5, 16).replace('T', ' ')} UTC`);
    return { ...f, why, fix, cmd: c, src, evidence: ev, apPage: f.dir ? apPages?.[f.dir] || null : null };
  });
}
export function healthDeep(health) {
  const RUN = `${PLANS}/_run`, now = Date.now(), out = {};
  out.hangs = (() => { try { return fs.readFileSync(`${RUN}/flags/hang-reaper.log`, 'utf8').trim().split('\n').filter((l) => now - Date.parse(l.slice(0, 19).replace(' ', 'T')) < 86400e3).slice(-30).reverse(); } catch { return []; } })();
  out.queue = (() => { try { const Q = `${RUN}/audit_queue`; return fs.readdirSync(Q).filter((x) => x.endsWith('.req')).map((x) => { const b = x.slice(0, -4), kv = Object.fromEntries(fs.readFileSync(`${Q}/${x}`, 'utf8').split('\n').map((l) => l.split('=')).filter((a) => a[1])); return { name: b, model: kv.model || '', role: kv.role || '', effort: kv.effort || '', age: Math.round((now - mtime(`${Q}/${x}`)) / 60e3), state: fs.existsSync(`${Q}/${b}.taken`) ? 'taken' : fs.existsSync(`${Q}/${b}.decline`) ? 'declined' : 'pending' }; }).filter((q) => q.state !== 'declined').sort((a, b) => a.age - b.age).slice(0, 20); } catch { return []; } })();
  out.free = (health?.free?.list || []).map((m) => { const t = mtime(`${RUN}/flags/zen_model_${m.m}_paused`); return { ...m, lastLimit: t || null }; });
  out.limitPause = (() => { try { return fs.readFileSync(`${RUN}/flags/limit-pause.log`, 'utf8').trim().split('\n').slice(-8).reverse(); } catch { return []; } })();
  return out;
}
export function watcherDeep() {
  const j = readJson(`${DATA}/status.json`, null); if (!j) return null;
  return { at: j.at, source: j.source, linesAt: j.linesAt, mode: j.mode, usage: j.usage?.text || null, counts: j.counts, history: (j.history || []).slice(-24), lines: j.lines || {} };
}
