#!/usr/bin/env node
// jev-route.mjs: pick the model and reasoning effort for a subagent job with two Jev (typesafe.ai) calls.
//   node jev-route.mjs "<task prompt>"      route one job
//   node jev-route.mjs -f promptfile        same, prompt read from a file
//   node jev-route.mjs --rules              print the rules in force (no Jev call)
// 0) gate checks, one Jev call with two noul questions, keywords if Jev fails:
//    design: a design job only considers rules.design.allowed (the Claude models);
//    simple: rules.simple.gated (local Qwen) stays on the menu only for an absolutely simple, self-contained
//    text or coding job (p >= rules.simple.threshold, never a design job);
//    usage: the AgentGlim usage tiers from _run/budget.json; a tier-3 (paused or stopped) option
//    leaves the menu, a tier-2 (slowed) option loses close calls and Jev is told the tiers; a design job keeps its
//    Claude options even at tier 3 and says so ("over") on the plain line;
//    1) which option fits the job best; 2) which reasoning effort for it.
//   node jev-route.mjs --local-ok "<task>" | --local-ok -f file   only the gate: prints {localOk, ...}, exit 0 = local
//                                            Qwen may take it, 1 = not (plans/_run/bin/worker.sh asks this per task)
// Prints JSON {pick, effort, launch, p, pEffort, ranked, efforts}; on a Jev error it prints the fallback
// pick with "error" and exits 1.
// Prints a plain line "model: <pick> <p>% | reasoning: <effort> <p>%" (plus " | design <p>%" for a design job) first,
// then the JSON line (with design and pDesign for a design job). The log also records design, pDesign and designSource,
// and simple, pSimple and simpleSource (plus " | simple <p>%" on the plain line when the local option was allowed),
// and usage (per provider: pct, window, tier, step), usageExcluded, usageDemoted, usageOver (plus " | usage: ..." on the line).
// Rules (options, strength order, close margin, efforts, notify picks) live in a JSON file: harness/jev-routes.json
// by default, or jev.routes in your harness.json, or AGENTGLIM_JEV_ROUTES. Each pick is appended to jev.log
// (default <data>/jev-route.ndjson, the file the Routing page reads: {t, task, pick, pPick, effort, pEffort, ranked, efforts}).
// The API key comes from the env var named by jev.keyEnv (default JEV_API_KEY); see app/classify.mjs jevAsk.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { jevAsk } from '../../app/classify.mjs';
import { harnessConfig } from '../config.mjs';
import { loadSetup } from '../../app/setup.mjs';

const fill = (t, v) => String(t).replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(v, k) ? String(v[k]) : m));

export function loadRules(cfg = harnessConfig()) {
  const r = JSON.parse(fs.readFileSync(cfg.jev.routes, 'utf8'));
  const ids = Object.keys(r.options || {});
  if (!ids.length) throw new Error(`no options in ${cfg.jev.routes}`);
  if (!r.options[r.fallback?.pick]) throw new Error(`fallback pick ${r.fallback?.pick} is not an option`);
  for (const id of ids) if (!Array.isArray(r.options[id].efforts) || !r.options[id].efforts.length || !r.options[id].launch) throw new Error(`option ${id} needs efforts[] and launch`);
  if (r.design) {
    const bad = (r.design.allowed || []).filter((x) => !r.options[x]);
    if (!r.design.question || !(r.design.allowed || []).length || bad.length) throw new Error(`design rule needs a question and allowed options that exist${bad.length ? ` (unknown: ${bad.join(', ')})` : ''}`);
  }
  if (r.simple) {
    const bad = (r.simple.gated || []).filter((x) => !r.options[x]);
    if (!r.simple.question || !(r.simple.gated || []).length || bad.length) throw new Error(`simple rule needs a question and gated options that exist${bad.length ? ` (unknown: ${bad.join(', ')})` : ''}`);
    if ((r.simple.gated || []).includes(r.fallback.pick)) throw new Error(`fallback pick ${r.fallback.pick} cannot be a gated (local) option`);
  }
  if (r.usage) {
    const bad = Object.keys(r.usage.map || {}).filter((x) => !r.options[x] || !Array.isArray(r.usage.map[x]) || r.usage.map[x].length !== 2);
    if (bad.length) throw new Error(`usage.map entries need an existing option and [provider, role] (bad: ${bad.join(', ')})`);
  }
  return r;
}

export const launchOf = (rules, pick, effort) => fill(rules.options[pick].launch, { effort });

// [[name, p], ...] best first, from Jev's noul answers under one prefix
export const rank = (answers, pre) => Object.entries(answers || {}).filter(([q]) => q.startsWith(pre))
  .map(([q, v]) => [q.slice(pre.length), Number(v?.noul)]).filter(([, p]) => Number.isFinite(p)).sort((x, y) => y[1] - x[1]);

// within `close` of the top score, an entry not in `demoted` (usage tier 2) wins, then the one earlier in `order`
// (names missing from order go last)
export function stronger(list, order, close, demoted = []) {
  if (!list.length) return null;
  const top = list[0][1], at = (k) => { const i = order.indexOf(k); return i < 0 ? Infinity : i; }, dm = new Set(demoted);
  return list.filter(([, v]) => top - v <= close).sort((x, y) => (dm.has(x[0]) - dm.has(y[0])) || at(x[0]) - at(y[0]))[0];
}

export function stateOf(rules, task) { return fill(rules.stateTemplate, { task: task.slice(0, rules.taskMaxChars || 6000) }); }

export function modelQuestions(rules, ids = Object.keys(rules.options)) {
  const q = {};
  for (const [k, o] of Object.entries(rules.options)) if (ids.includes(k)) q[`m_${k}`] = { type: 'noul', instructions: fill(rules.modelQuestion, { desc: o.desc }) };
  return q;
}

// ---- design rule: design jobs only go to the options in rules.design.allowed
export const designQuestions = (rules) => ({ d_design: { type: 'noul', instructions: rules.design.question } });
const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const wordHits = (list, task) => (list || []).filter((k) => new RegExp(`\\b${reEsc(k)}${k.length >= 4 ? '[a-z]*' : 's?'}\\b`, 'i').test(task));
export function keywordHits(rules, task) { // whole words; longer keywords also match their forms (icons, styled, layouts)
  return wordHits(rules.design?.keywords, task);
}
// answers: Jev answers to designQuestions, or null when that call failed. null when the rules have no design rule.
export function designOf(rules, answers, task) {
  const D = rules.design; if (!D) return null;
  const p = Number(answers?.d_design?.noul);
  if (Number.isFinite(p)) return { design: p >= (D.threshold ?? 0.5), p, source: 'jev', hits: [] };
  const hits = keywordHits(rules, task);
  return { design: hits.length > 0, p: null, source: 'keywords', hits };
}
// ---- simple rule: local Qwen only for absolutely simple, self-contained text or coding jobs
export const simpleQuestions = (rules) => ({ s_simple: { type: 'noul', instructions: rules.simple.question } });
export const gateQuestions = (rules) => ({ ...(rules.design ? designQuestions(rules) : {}), ...(rules.simple ? simpleQuestions(rules) : {}) });
const FILE_RE = /(?:[\w.-]+\/)*[\w-]+(?:\.[\w-]+)*\.(?:mjs|cjs|js|jsx|ts|tsx|py|sh|bash|rs|go|rb|java|kt|c|h|cc|cpp|hpp|cs|swift|php|lua|sql|md|json|jsonl|ndjson|toml|ya?ml|ini|cfg|conf|txt|csv|html?|css|scss|svg|xml)\b/gi;
export function filesNamed(rules, task) { // distinct file names the job mentions, minus the shared round notes (S.ignoreFiles)
  const skip = new Set((rules.simple?.ignoreFiles || []).map((x) => x.toLowerCase()));
  return [...new Set((String(task).match(FILE_RE) || []).map((f) => f.replace(/^\.\//, '')))].filter((f) => !skip.has(path.basename(f).toLowerCase()));
}
// answers: Jev answers to gateQuestions, or null when that call failed; d: designOf result. null when there is no simple rule.
// Jev failed -> simple only with no keyword hit, at most maxChars and at most maxFiles named files (strict on purpose).
export function simpleOf(rules, answers, task, d) {
  const S = rules.simple; if (!S) return null;
  const p = Number(answers?.s_simple?.noul);
  if (d?.design) return { simple: false, p: Number.isFinite(p) ? p : null, source: 'design', hits: [], files: [] };
  if (Number.isFinite(p)) return { simple: p >= (S.threshold ?? 0.8), p, source: 'jev', hits: [], files: [] };
  const hits = wordHits(S.keywords, task), files = filesNamed(rules, task), long = task.length > (S.maxChars ?? 3000);
  return { simple: !hits.length && !long && files.length <= (S.maxFiles ?? 1), p: null, source: 'keywords', hits, files, ...(long ? { long: task.length } : {}) };
}
// s: simpleOf result; a missing result with a simple rule in force keeps the gated options off (fail closed)
// ---- planning rule: plan-writing jobs only go to premium frontier models at high+ effort
export const planningOf = (rules, task) => { const P = rules.planning; if (!P) return null; const t = String(task || '');
  const hits = (P.patterns || []).filter((x) => new RegExp(x, 'i').test(t)); return hits.length ? { planning: true, hits } : null; };
export function candidates(rules, d, s) {
  let ids = d?.design ? Object.keys(rules.options).filter((k) => rules.design.allowed.includes(k)) : Object.keys(rules.options);
  if (rules.simple && !s?.simple) ids = ids.filter((k) => !rules.simple.gated.includes(k));
  return ids;
}
// stage 0 alone: {design, simple} from one Jev call (keywords for both when it fails)
export async function gateOf(rules, task, ask = jevAsk) {
  if (!rules.design && !rules.simple) return { design: null, simple: null };
  const r = await ask(stateOf(rules, task), gateQuestions(rules), 'route-gate');
  const answers = r.error ? null : r.answers;
  const design = designOf(rules, answers, task);
  return { design, simple: simpleOf(rules, answers, task, design), error: r.error || undefined };
}
export const localOk = (rules, g) => (rules.simple ? !!g.simple?.simple : !g.design?.design);

// ---- usage tiers: the tiers the AgentGlim Status page shows, from the budget the driver writes every
// tick (_run/budget.json, computed from modes.json usageLimit/overnightLimit 5h gates, the weekly caps and the ladder).
// No thresholds of its own: tier 1 full speed, tier 2 slowed (step >= 6, the page's "slowed" pill, app/index.html),
// tier 3 paused or stopped (the option's 5h role gate is shut, or step 9, limited, off, or no slots for its role).
export const SLOWED_STEP = 6; // = app/index.html: p.step >= 6 -> "slowed"
export function loadBudget(rules, cfg) { // null without a usage rule; {error} when missing or older than config.json budgetStaleS
  const U = rules.usage; if (!U) return null;
  const file = fill(U.file || '{run}/budget.json', { run: cfg.run });
  let b, staleS = 300;
  try { b = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { error: 'no budget file' }; }
  try { staleS = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'config.json'), 'utf8')).budgetStaleS ?? 300; } catch {}
  if (!b?.at || Date.now() - b.at > staleS * 1000) return { error: 'budget stale' };
  return b;
}
export function providerTier(p, role) { // p: one budget.providers entry
  if (!p?.ok) return null;
  const shut = !!role && p.roleOk?.[role] === false;
  const stopped = !!(p.limited || p.off || p.step >= 9 || (role && p.slots && p.slots[role] === 0));
  const tier = shut || stopped ? 3 : p.step >= SLOWED_STEP ? 2 : 1;
  const w = shut ? { label: '5h', used: p.fiveHour } : (p.windows || []).find((x) => x.label === p.binding) || (p.windows || [])[0] || {};
  return { tier, step: p.step, pct: w.used ?? null, window: w.label ?? null,
    why: shut ? `${role.replace('_', ' ')} paused, 5h at ${p.fiveHour}%` : stopped ? 'stopped' : tier === 2 ? `slowed, step ${p.step}/9` : `full speed, step ${p.step}/9` };
}
// {option: {provider, role, tier, step, pct, window, why}} for the options in usage.map ("go|go2" = the better of the
// two); options with no entry (free, local) or no reading are not limited. null when there is no usable budget.
export function usageOf(rules, budget) {
  if (!rules.usage || !budget || budget.error) return null;
  const out = {};
  for (const [k, [provs, role]] of Object.entries(rules.usage.map || {})) {
    const ts = String(provs).split('|').map((id) => ({ provider: id, role, ...providerTier(budget.providers?.[id], role) })).filter((x) => x.tier);
    if (ts.length) out[k] = ts.sort((a, b) => a.tier - b.tier || (a.pct ?? 0) - (b.pct ?? 0))[0];
  }
  return out;
}
// owner 2026-11-12: a subscription the owner paused (mode stopped) or left out by another sub's "only" mode
// (budget.providers[id].off) never routes, not even for design or planning jobs; options with no usage entry (free, local) stay.
export function ownerOff(rules, budget) {
  if (!rules.usage || !budget || budget.error) return new Set();
  const out = new Set();
  for (const [k, [provs]] of Object.entries(rules.usage.map || {})) {
    const ps = String(provs).split('|').map((id) => budget.providers?.[id]).filter((p) => p?.ok);
    if (ps.length && ps.every((p) => p.off)) out.add(k);
  }
  return out;
}
// tier 3 leaves the menu unless nothing would be left (then all stay and they are "over"); tier 2 is demoted
export function applyUsage(ids, u) {
  if (!u) return { ids, excluded: [], demoted: [], over: [] };
  const keep = ids.filter((k) => u[k]?.tier !== 3), hard = ids.filter((k) => u[k]?.tier === 3);
  if (!keep.length) return { ids, excluded: [], demoted: ids.filter((k) => u[k]?.tier === 2), over: hard };
  return { ids: keep, excluded: hard, demoted: keep.filter((k) => u[k]?.tier === 2), over: [] };
}
// the usage note Jev reads in stage 1 (only when some candidate is above tier 1)
export function usageNote(u, ids) {
  const hi = ids.filter((k) => u?.[k]?.tier >= 2);
  if (!hi.length) return '';
  return '\nUsage limits right now (AgentGlim tiers: 1 full speed, 2 slowed, 3 paused or stopped); prefer an option at a lower tier when it can do the job as well: '
    + hi.map((k) => `${k} tier ${u[k].tier} (${u[k].why}${u[k].pct != null ? `, ${u[k].window} ${u[k].pct}%` : ''})`).join('; ') + '.';
}
// " | usage: claude 72% 7d (tier 2)" for the pick's provider and every provider that was skipped, demoted or over
export function usageTag(u, a, pick, design, budget) {
  if (budget?.error) return ` | usage: unknown (${budget.error})`;
  if (!u) return '';
  const rows = new Map(), add = (k) => { const x = u[k]; if (!x) return; const r = rows.get(x.provider); if (!r || x.tier > r.tier) rows.set(x.provider, x); };
  add(pick); for (const k of [...a.excluded, ...a.demoted, ...a.over]) add(k);
  if (!rows.size) return '';
  const txt = [...rows.values()].map((x) => `${x.provider} ${x.pct ?? '?'}%${x.window ? ` ${x.window}` : ''} (tier ${x.tier})`).join(', ');
  const skipped = [...new Set(a.excluded.map((k) => u[k].provider))];
  const over = a.over.length ? ` OVER the hard tier: ${design ? 'design job stays on Claude' : 'every option is at tier 3, none skipped'}` : '';
  return ` | usage: ${txt}${skipped.length ? `; skipped ${skipped.join(', ')} (tier 3)` : ''}${over}`;
}
const usageLog = (u, a) => (u ? { usage: Object.fromEntries([...new Map(Object.values(u).map((x) => [x.provider, x]))].map(([id, x]) => [id, { pct: x.pct, window: x.window, tier: x.tier, step: x.step }])),
  ...(a.excluded.length ? { usageExcluded: a.excluded } : {}), ...(a.demoted.length ? { usageDemoted: a.demoted } : {}), ...(a.over.length ? { usageOver: a.over } : {}) } : {});

export function effortQuestions(rules, pick) {
  const o = rules.options[pick], q = {};
  for (const e of o.efforts) q[`e_${e}`] = { type: 'noul', instructions: fill(rules.effortQuestion, { name: o.desc.split(':')[0], effortDesc: rules.effortDesc?.[e] || e }) };
  return q;
}

// answers1/answers2: Jev answers objects; answers2 null when the effort call failed
export function choose(rules, answers1, answers2, ids = Object.keys(rules.options), demoted = []) {
  const ranked = rank(answers1, 'm_').filter(([k]) => ids.includes(k));
  const top = stronger(ranked, rules.strength || [], rules.close ?? 0.05, demoted);
  if (!top) return { error: 'Jev returned no usable model scores' };
  const [pick, p] = top;
  const allowed = new Set(rules.options[pick].efforts);
  const efforts = answers2 ? rank(answers2, 'e_').filter(([e]) => allowed.has(e)) : [];
  const best = stronger(efforts, rules.effortOrder || [], rules.close ?? 0.05);
  const [effort, pEffort] = best || [rules.fallback?.effort || 'medium', NaN];
  return { pick, p, ranked, effort, pEffort, efforts: efforts.length ? efforts : [[effort, NaN]] };
}

export function output(rules, c) {
  return { pick: c.pick, effort: c.effort, launch: launchOf(rules, c.pick, c.effort), p: +c.p.toFixed(3), pEffort: +(c.pEffort || 0).toFixed(3),
    ranked: c.ranked.map(([k, v]) => `${k}=${v.toFixed(2)}`), efforts: c.efforts.map(([k, v]) => `${k}=${(v || 0).toFixed(2)}`) };
}

function logPick(cfg, rec) {
  try { fs.mkdirSync(path.dirname(cfg.jev.log), { recursive: true }); fs.appendFileSync(cfg.jev.log, JSON.stringify(rec) + '\n'); } catch {} // read-only sandboxes: skip the log
}

// --local-ok: the stage-0 gate only, for plans/_run/bin/worker.sh before a local Qwen lane.
// Exit 0 = local may take it, 1 = not, 2 = usage. Logged to <log dir>/jev-local-gate.ndjson, not the Routing page's log.
async function localOkMain(cfg, rules, a) {
  const task = a[0] === '-f' ? fs.readFileSync(a[1], 'utf8') : a.join(' ');
  if (!task.trim()) { console.error('usage: jev-route.mjs --local-ok "<task>" | --local-ok -f file'); return 2; }
  if (cfg.jev.keyEnv && cfg.jev.keyEnv !== 'JEV_API_KEY' && process.env[cfg.jev.keyEnv] && !process.env.JEV_API_KEY) process.env.JEV_API_KEY = process.env[cfg.jev.keyEnv];
  const g = await gateOf(rules, task), ok = localOk(rules, g), r3 = (v) => (v == null ? null : +v.toFixed(3));
  const out = { localOk: ok, gated: rules.simple?.gated || [], threshold: rules.simple?.threshold ?? null,
    simple: g.simple?.simple ?? null, pSimple: r3(g.simple?.p), simpleSource: g.simple?.source ?? null,
    design: g.design?.design ?? null, pDesign: r3(g.design?.p), designSource: g.design?.source ?? null,
    ...(g.simple?.hits?.length ? { simpleHits: g.simple.hits } : {}), ...(g.simple?.files?.length ? { files: g.simple.files.slice(0, 12) } : {}),
    ...(g.simple?.long ? { chars: g.simple.long } : {}), ...(g.design?.hits?.length ? { designHits: g.design.hits } : {}), ...(g.error ? { jevError: g.error } : {}) };
  try { const f = path.join(path.dirname(cfg.jev.log), 'jev-local-gate.ndjson'); fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), task: task.slice(0, 300), ...out }) + '\n'); } catch {} // read-only sandboxes: skip the log
  console.log(JSON.stringify(out));
  return ok ? 0 : 1;
}

async function main() {
  const a = process.argv.slice(2);
  const cfg = harnessConfig();
  if (a[0] !== '--rules' && loadSetup().jev?.on === false) {
    if (a[0] === '--local-ok') { console.log(JSON.stringify({ localOk: false, disabled: true })); return 1; }
    console.log(JSON.stringify({ pick: 'claude-sonnet', p: 1, effort: 'medium', launch: 'Agent tool, model "sonnet", effort "medium"', disabled: true }));
    return 0;
  }
  const rules = loadRules(cfg);
  if (a[0] === '--rules') { console.log(JSON.stringify({ file: cfg.jev.routes, ...rules }, null, 2)); return 0; }
  if (a[0] === '--local-ok') return localOkMain(cfg, rules, a.slice(1));
  const task = a[0] === '-f' ? fs.readFileSync(a[1], 'utf8') : a.join(' ');
  if (!task.trim()) { console.error('usage: jev-route.mjs "<task>" | -f file | --rules'); return 2; }
  if (cfg.jev.keyEnv && cfg.jev.keyEnv !== 'JEV_API_KEY' && process.env[cfg.jev.keyEnv] && !process.env.JEV_API_KEY) process.env.JEV_API_KEY = process.env[cfg.jev.keyEnv];
  let design = null, ids = Object.keys(rules.options);
  const fail = (e) => {
    let fb = rules.fallback;
    if (!ids.includes(fb.pick)) fb = { pick: (rules.strength || []).find((k) => ids.includes(k)) || ids[0], effort: fb.effort };
    console.log(JSON.stringify({ error: e, pick: fb.pick, effort: fb.effort, launch: launchOf(rules, fb.pick, fb.effort), ...(design?.design ? { design: true, pDesign: design.p } : {}) }));
    return 1;
  };
  let state = stateOf(rules, task);
  let simple = null;
  if (rules.design || rules.simple) { // 0) design and simple checks, one Jev call
    const g = await gateOf(rules, task);
    ({ design, simple } = g);
    ids = candidates(rules, design, simple);
  }
  const budget = loadBudget(rules, cfg), offSubs = ownerOff(rules, budget);
  if (offSubs.size) { // paused / not-the-only subscription: drop it; a design job with nothing left falls back to the full menu
    let keep = ids.filter((k) => !offSubs.has(k));
    if (!keep.length) keep = candidates(rules, null, simple).filter((k) => !offSubs.has(k));
    if (!keep.length) keep = Object.keys(rules.options).filter((k) => !offSubs.has(k));
    if (keep.length) { ids = keep; if (design?.design) state += '\nThe Claude subscription is paused by the owner, so this design job goes to the best non-Claude option.'; }
  }
  const pz = rules.paused; // paused options leave the menu until the date
  if (pz && (!pz.until || Date.now() < Date.parse(pz.until))) { const keep = ids.filter((k) => !(pz.ids || []).includes(k)); if (keep.length) ids = keep; }
  const plan = planningOf(rules, task);
  if (plan) { const keep = ids.filter((k) => rules.planning.allowed.includes(k)); const alt = rules.planning.allowed.filter((k) => rules.options[k] && !offSubs.has(k)); ids = keep.length ? keep : alt.length ? alt : ids; }
  const usage = usageOf(rules, budget), ua = applyUsage(ids, usage); // usage tiers
  ids = ua.ids; state += usageNote(usage, ids);
  const r1 = await jevAsk(state, modelQuestions(rules, ids), 'route-model');
  if (r1.error) return fail(r1.error);
  const first = rank(r1.answers, 'm_').filter(([k]) => ids.includes(k));
  const pre = stronger(first, rules.strength || [], rules.close ?? 0.05, ua.demoted);
  if (!pre) return fail('Jev returned no usable model scores');
  const r2 = await jevAsk(state, effortQuestions(rules, pre[0]), 'route-effort');
  const c = choose(rules, r1.answers, r2.error ? null : r2.answers, ids, ua.demoted);
  if (plan && !c.error) { const ord = rules.effortOrder || [], min = ord.indexOf(rules.planning.minEffort || 'high');
    if (ord.indexOf(c.effort) > min) { const up = ord.slice(0, min + 1).reverse().find((e) => rules.options[c.pick].efforts.includes(e)); if (up) c.effort = up; } }
  const out = output(rules, c);
  if (plan) Object.assign(out, { planning: true });
  if (design?.design) Object.assign(out, { design: true, pDesign: design.p == null ? null : +design.p.toFixed(3) });
  if (simple) Object.assign(out, { simple: simple.simple, pSimple: simple.p == null ? null : +simple.p.toFixed(3) });
  Object.assign(out, usageLog(usage, ua), budget?.error ? { usageError: budget.error } : {});
  if ((rules.notify?.picks || []).includes(c.pick) && cfg.notify?.command) {
    const v = { pick: c.pick, effort: c.effort, task90: task.slice(0, 90) };
    spawnSync(cfg.notify.command, ['--event', 'info', '--title', fill(rules.notify.title, v), fill(rules.notify.body, v)], { stdio: 'ignore', timeout: 15000 });
  }
  logPick(cfg, { t: new Date().toISOString(), task: task.slice(0, 500), pick: c.pick, pPick: +c.p.toFixed(3), effort: c.effort, pEffort: +(c.pEffort || 0).toFixed(3),
    ranked: Object.fromEntries(c.ranked.map(([k, v]) => [k, +v.toFixed(3)])), efforts: Object.fromEntries(c.efforts.map(([k, v]) => [k, +(v || 0).toFixed(3)])),
    ...(design ? { design: design.design, pDesign: design.p == null ? null : +design.p.toFixed(3), designSource: design.source, ...(design.hits.length ? { designHits: design.hits } : {}) } : {}),
    ...(simple ? { simple: simple.simple, pSimple: simple.p == null ? null : +simple.p.toFixed(3), simpleSource: simple.source, ...(simple.hits.length ? { simpleHits: simple.hits } : {}) } : {}),
    ...usageLog(usage, ua), ...(budget?.error ? { usageError: budget.error } : {}) });
  const pct = (v) => `${Math.round((v || 0) * 100)}%`;
  const dTag = design?.design ? ` | design ${design.p == null ? `(keywords: ${design.hits.join(', ')})` : pct(design.p)}` : '';
  const sTag = simple?.simple ? ` | simple ${simple.p == null ? '(keywords)' : pct(simple.p)}` : '';
  console.log(`model: ${c.pick} ${pct(c.p)} | reasoning: ${c.effort} ${pct(c.pEffort)}${dTag}${sTag}${usageTag(usage, ua, c.pick, design?.design, budget)}`);
  console.log(JSON.stringify(out));
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => { console.error(`jev-route: ${e.message}`); process.exit(1); });
}
