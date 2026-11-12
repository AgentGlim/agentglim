// Jev routing dashboard data: reads the decision log written by plans/_run/bin/jev-route.mjs,
// stores owner feedback beside it, and sums the feedback into a plain-words "what you prefer" view.
// Read-only toward jev-route.mjs: this module never edits the router, it only suggests tweaks as text.
// The option list (strongest first), tie margin and ping picks come from the router's rules file, harness/jev-routes.json
// (path from app/settings.mjs), read on every call; the constants below are only the fallback when it can't be read.
import fs from 'node:fs';
import { DATA } from './paths.mjs';
let hcfg = null; import('./settings.mjs').then((m) => { hcfg = m; }).catch(() => {}); // the fallback constants below cover a missing rules file

export const ROUTE_FILE = `${DATA}/jev-route.ndjson`;
export const FEEDBACK_FILE = `${DATA}/jev-route-feedback.ndjson`;
// fallback only: same order as "strength" in harness/jev-routes.json (strongest first)
export const MODELS = ['claude-opus', 'codex-sol', 'claude-fable', 'codex-astra', 'claude-sonnet', 'codex-terra', 'deepseek-flash', 'codex-luna', 'claude-haiku', 'opencode-free', 'local-qwen'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
export const VERDICTS = ['right', 'stronger', 'cheaper'];
export const TIER = { 'claude-fable': 'top', 'codex-astra': 'top', 'claude-opus': 'top', 'codex-sol': 'mid', 'claude-sonnet': 'mid', 'codex-terra': 'mid',
  'claude-haiku': 'cheap', 'codex-luna': 'cheap', 'deepseek-flash': 'cheap', 'opencode-free': 'free', 'local-qwen': 'free' };
export const TIER_COST = { top: 10, mid: 4, cheap: 1, free: 0 }; // rough relative points per pick, not dollars
const HEAVY = ['claude-fable', 'codex-astra']; // fallback for notify.picks
const CLOSE = 0.05; // fallback for close
// { models, efforts, close, heavy, file }: live rules when readable, else the constants above
export function jevRules() {
  try {
    const file = hcfg.harnessConfig().jev.routes, r = JSON.parse(fs.readFileSync(file, 'utf8')), ids = Object.keys(r.options || {});
    if (!ids.length) throw new Error('no options');
    const models = [...(r.strength || []).filter((m) => ids.includes(m)), ...ids.filter((m) => !(r.strength || []).includes(m))];
    const used = new Set(ids.flatMap((m) => r.options[m].efforts || []));
    const efforts = [...(r.effortOrder || []).slice().reverse().filter((e) => used.has(e)), ...[...used].filter((e) => !(r.effortOrder || []).includes(e))];
    const tiers = Object.fromEntries(models.map((m) => [m, TIER[m] || (['free', 'local'].includes(r.options[m].group) ? 'free' : 'mid')]));
    const design = r.design?.allowed?.length ? { allowed: r.design.allowed.filter((m) => ids.includes(m)), threshold: r.design.threshold ?? 0.5, keywords: r.design.keywords || [], question: r.design.question || '' } : null;
    return { models, efforts: efforts.length ? efforts : EFFORTS, close: Number.isFinite(r.close) ? r.close : CLOSE, heavy: r.notify?.picks || [], tiers, design, file };
  } catch { return { models: MODELS, efforts: EFFORTS, close: CLOSE, heavy: HEAVY, tiers: TIER, design: null, file: null }; }
}

const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const shortTask = (t) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > 90 ? s.slice(0, 87) + '...' : s; };

export function loadFeedback() { // latest feedback per decision wins
  const by = {};
  for (const r of readLines(FEEDBACK_FILE)) if (r && typeof r.id === 'string') by[r.id] = r;
  return by;
}

export function saveFeedback(b) {
  if (!b || typeof b.id !== 'string') return { status: 422, error: 'id required' };
  const d = readLines(ROUTE_FILE).find((r) => r.t === b.id);
  if (!d) return { status: 422, error: 'unknown decision' };
  if (!VERDICTS.includes(b.verdict)) return { status: 422, error: 'verdict must be right, stronger or cheaper' };
  const better = b.better == null || b.better === '' ? null : b.better;
  if (better !== null && !jevRules().models.includes(better)) return { status: 422, error: 'unknown model' };
  const note = typeof b.note === 'string' ? b.note.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 500) : '';
  const rec = { t: new Date().toISOString(), id: d.t, verdict: b.verdict, better, note, pick: d.pick, effort: d.effort };
  fs.appendFileSync(FEEDBACK_FILE, JSON.stringify(rec) + '\n');
  return { status: 200, feedback: rec };
}

function prefs(rows, fb, CLOSE) {
  const byId = Object.fromEntries(rows.map((r) => [r.t, r]));
  const list = Object.values(fb).filter((f) => byId[f.id]);
  const out = { total: list.length, right: 0, stronger: 0, cheaper: 0, lines: [], suggestions: [] };
  const cheaperBy = {}, strongerBy = {}, simple = {}, betterCount = {};
  for (const f of list) {
    out[f.verdict]++;
    const d = byId[f.id], easy = d.effort === 'low' || d.effort === 'medium';
    if (f.verdict === 'cheaper') { cheaperBy[d.pick] = (cheaperBy[d.pick] || 0) + 1; if (easy) simple[d.pick] = (simple[d.pick] || 0) + 1; }
    if (f.verdict === 'stronger') strongerBy[d.pick] = (strongerBy[d.pick] || 0) + 1;
    if (f.better) { const k = `${d.pick}>${f.better}`; betterCount[k] = (betterCount[k] || 0) + 1; }
  }
  if (!list.length) { out.lines.push('No feedback yet. Use the buttons in the table and this panel will start to fill in.'); return out; }
  out.lines.push(`${list.length} decision${list.length === 1 ? '' : 's'} rated: ${out.right} right call, ${out.stronger} should be stronger, ${out.cheaper} should be cheaper.`);
  for (const [m, n] of Object.entries(cheaperBy).sort((a, b) => b[1] - a[1])) {
    const s = simple[m] || 0;
    out.lines.push(`You said "too strong" ${n} time${n === 1 ? '' : 's'} for ${m}${s ? `, ${s} of them on simple jobs (low or medium reasoning)` : ''}.`);
  }
  for (const [m, n] of Object.entries(strongerBy).sort((a, b) => b[1] - a[1])) out.lines.push(`You said "too weak" ${n} time${n === 1 ? '' : 's'} for ${m}.`);
  for (const [k, n] of Object.entries(betterCount).sort((a, b) => b[1] - a[1]).slice(0, 3)) { const [a, b] = k.split('>'); out.lines.push(`You picked ${b} instead of ${a} ${n} time${n === 1 ? '' : 's'}.`); }
  // suggestions: text only, jev-route.mjs is not changed
  if (out.cheaper >= 2 && out.cheaper > out.stronger) {
    out.suggestions.push(`Most of your corrections say "too strong". Try shrinking the tie margin from ${CLOSE} to ${Math.max(0, CLOSE - 0.02).toFixed(2)}, so close calls stop going to the stronger model. You can change it on the Harness page.`);
    for (const [m, n] of Object.entries(cheaperBy)) if (n >= 2) out.suggestions.push(`Add a bias of -0.05 to ${m}'s score when the job is simple (low or medium reasoning). It was called too strong ${n} times.`);
  } else if (out.stronger >= 2 && out.stronger > out.cheaper) {
    out.suggestions.push(`Most of your corrections say "too weak". Try widening the tie margin from ${CLOSE} to ${(CLOSE + 0.03).toFixed(2)}, so more close calls go to the stronger model. You can change it on the Harness page.`);
    for (const [m, n] of Object.entries(strongerBy)) if (n >= 2) out.suggestions.push(`Add a bias of +0.05 to the model above ${m} when it is picked. ${m} was called too weak ${n} times.`);
  } else if (out.total >= 3 && out.right / out.total >= 0.7) out.suggestions.push('Most picks were right. Leave the tie margin and biases as they are.');
  else out.suggestions.push(`Not enough one-sided feedback yet (need 2 or more in the same direction). Keep rating decisions.`);
  return out;
}

export function routingView() {
  const rows = readLines(ROUTE_FILE).filter((r) => r && r.t && r.pick);
  const fb = loadFeedback();
  const decisions = rows.map((r) => {
    const rk = Object.entries(r.ranked || {}).sort((a, b) => b[1] - a[1]);
    const ru = rk.find(([m]) => m !== r.pick);
    return { id: r.t, t: r.t, task: shortTask(r.task), taskFull: String(r.task || '').slice(0, 600), pick: r.pick, pPick: r.pPick, effort: r.effort, pEffort: r.pEffort,
      runnerUp: ru ? { model: ru[0], p: ru[1] } : null, ranked: r.ranked || {}, efforts: r.efforts || {}, feedback: fb[r.t] || null,
      design: r.design === true, pDesign: typeof r.pDesign === 'number' ? r.pDesign : null, designSource: r.designSource || null };
  }).sort((a, b) => (a.t < b.t ? 1 : -1));
  const count = (key) => decisions.reduce((o, d) => { o[d[key]] = (o[d[key]] || 0) + 1; return o; }, {});
  const picks = count('pick'), efforts = count('effort');
  const R = jevRules(), heavy = new Set(R.heavy);
  const tiers = { top: 0, mid: 0, cheap: 0, free: 0 };
  for (const [m, n] of Object.entries(picks)) tiers[R.tiers[m] || TIER[m] || 'mid'] += n;
  const models = [...R.models, ...Object.keys(picks).filter((m) => !R.models.includes(m))]; // old decisions for a removed option still show
  const tierOf = Object.fromEntries(models.map((m) => [m, R.tiers[m] || TIER[m] || 'mid']));
  return { at: new Date().toISOString(), total: decisions.length, models, efforts: R.efforts, tiers: tierOf, tierCost: TIER_COST,
    picks, effortCounts: efforts, tierCounts: tiers, heavy: decisions.filter((d) => heavy.has(d.pick)).length, heavyPicks: [...heavy], close: R.close, rulesFile: R.file, design: R.design, designCount: decisions.filter((d) => d.design).length,
    decisions: decisions.slice(0, 500), prefs: prefs(rows, fb, R.close) };
}
