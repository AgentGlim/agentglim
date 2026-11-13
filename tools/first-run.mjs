#!/usr/bin/env node
// first-run.mjs: the agent-led first-run setup, driven by the user's own AI agent (Claude Code, Codex, ...).
// The agent interviews the user in chat, one question at a time, then calls this tool once with the answers.
//   node tools/first-run.mjs status            JSON: does setup / goals still need doing, what was detected here
//   node tools/first-run.mjs apply answers.json   (or "-" for stdin) saves setup.json, the goals and links the tools
// answers.json: { "harnesses": ["codex"], "subs": { "codex": { "tier": "plus" } }, "jev": false, "apiDailyUsd": 5,
//   "goals": [ { "title": "Ship the app", "outcome": "...", "next_action": "...", "allocation": 60 } ] }
// Everything is written under $AGENTGLIM_DATA (default ~/.agentglim). No credentials are read into the output.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..', 'app');
const { DATA, GOALS, goalsFile } = await import(`${APP}/paths.mjs`);
const { detect, loadSetup, saveSetup, setupFilled, SETUP_FILE, HARNESSES } = await import(`${APP}/setup.mjs`);
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const bundled = (name) => readText(path.join(APP, 'defaults', 'goals', name));
const norm = (t) => { try { return JSON.stringify(JSON.parse(t)); } catch { return null; } };
const COLORS = ['#2fd69c', '#8ab4ff', '#f5b84a', '#c58bff', '#ff8f6b', '#5fd0e0'];

// goals count as personal once goals.json differs from the example goals the app seeds on first start
export function goalsPersonal() {
  const f = goalsFile(); if (!f) return false;
  const cur = norm(readText(f)), def = norm(bundled('goals.json'));
  return !!cur && cur !== def;
}

export function status() {
  const d = detect();
  const setupDone = setupFilled();
  const goalsDone = goalsPersonal();
  return {
    needsSetup: !setupDone || !goalsDone,
    setupDone, goalsDone,
    dataDir: DATA, setupFile: SETUP_FILE, goalsDir: GOALS,
    harnesses: d.harnesses.map((h) => ({ id: h.id, name: h.name, binary: !!h.bin, loggedIn: !!h.auth })),
    questions: [!setupDone && 'harnesses', !setupDone && 'jev', !setupDone && 'budget', !goalsDone && 'goals'].filter(Boolean),
  };
}

const slug = (s, n) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || `goal${n + 1}`;
export function buildGoals(list) {
  const items = (Array.isArray(list) ? list : []).map((g) => (typeof g === 'string' ? { title: g } : g)).filter((g) => g && String(g.title || '').trim()).slice(0, 12);
  if (!items.length) throw new Error('goals: at least one goal with a title is needed');
  const ids = new Set(), even = Math.floor(100 / items.length);
  const goals = items.map((g, n) => {
    let id = slug(g.title, n); while (ids.has(id)) id += '_'; ids.add(id);
    const title = String(g.title).trim().slice(0, 120);
    return { id, title, label: String(g.label || title).slice(0, 24), lane: g.lane === 'support' ? 'support' : 'now',
      allocation: Number.isFinite(+g.allocation) && g.allocation !== undefined ? Math.max(0, Math.min(100, +g.allocation)) : even + (n === 0 ? 100 - even * items.length : 0),
      status: 'active', next_action: String(g.next_action || 'Write down the first step').slice(0, 200), color: COLORS[n % COLORS.length],
      outcome: String(g.outcome || title).slice(0, 300), acceptance: (Array.isArray(g.acceptance) ? g.acceptance : []).map(String).slice(0, 8), sources: [] };
  });
  const metrics = items.flatMap((g, n) => (g.metric ? [{ id: `${goals[n].id}_metric`, goal: goals[n].id, label: String(g.metric).slice(0, 80), target_min: null, target_max: null, actual: null }] : []));
  return {
    goals: { version: 1, baseline: new Date().toISOString().slice(0, 10), planning_policy: 'Share of agent time after fixed commitments; adjust weekly.', goals, metrics },
    map: { plans: Object.fromEntries(goals.map((g) => [g.id, []])), effort: Object.fromEntries(goals.map((g) => [g.id, []])), labels: Object.fromEntries(goals.map((g) => [g.id, g.label])) },
  };
}

function backup(f) { if (fs.existsSync(f)) fs.copyFileSync(f, `${f}.bak-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`); }

export async function apply(a, { scaffold = true } = {}) {
  const wantSetup = !setupFilled() || a.force === true || a.harnesses !== undefined;
  const out = { ok: true };
  if (wantSetup) {
    const cfg = loadSetup(detect());
    const on = new Set(Array.isArray(a.harnesses) ? a.harnesses : HARNESSES.filter((h) => cfg.harnesses[h.id]).map((h) => h.id));
    for (const h of HARNESSES) cfg.harnesses[h.id] = on.has(h.id);
    for (const [id, v] of Object.entries(a.subs || {})) if (cfg.subs[id]) { cfg.subs[id].on = v !== false; if (v && v.tier && cfg.subs[id].entries?.[0]) cfg.subs[id].entries[0].tier = String(v.tier); }
    if (a.jev !== undefined) cfg.jev = { on: !!a.jev };
    cfg.budget = { apiDailyUsd: Number.isFinite(+a.apiDailyUsd) ? +a.apiDailyUsd : 5 };
    const saved = saveSetup(cfg);
    out.setup = { file: SETUP_FILE, harnesses: Object.keys(saved.harnesses).filter((k) => saved.harnesses[k]), jev: saved.jev.on, apiDailyUsd: saved.budget.apiDailyUsd };
  }
  if (a.goals !== undefined) {
    const { goals, map } = buildGoals(a.goals);
    fs.mkdirSync(GOALS, { recursive: true });
    const gf = goalsFile() || path.join(GOALS, 'goals.json'), mf = path.join(GOALS, 'goal-map.json');
    backup(gf); backup(mf);
    fs.writeFileSync(gf, JSON.stringify(goals, null, 2) + '\n');
    fs.writeFileSync(mf, JSON.stringify(map, null, 2) + '\n');
    out.goals = { file: gf, count: goals.goals.length, ids: goals.goals.map((g) => g.id) };
    try { (await import(`${APP}/goals-sync.mjs`)).syncGoals(); } catch (e) { out.goalsSync = String(e.message || e); }
  }
  if (a.globalHints === true) {
    try { out.globalHints = (await import('./install-agent-hints.mjs')).install({ root: path.resolve(HERE, '..') }); }
    catch (e) { out.globalHints = [`failed: ${e.message}`]; }
  }
  if (scaffold) {
    try { out.scaffold = execFileSync(process.execPath, [path.join(HERE, 'scaffold-harness.mjs')], { env: process.env, encoding: 'utf8', timeout: 20000 }).trim(); }
    catch (e) { out.ok = false; out.scaffold = String(e.stdout || e.message).trim(); }
  }
  return out;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'status') console.log(JSON.stringify(status(), null, 2));
    else if (cmd === 'apply' && arg) {
      const a = JSON.parse(arg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(arg, 'utf8'));
      const r = await apply(a); console.log(JSON.stringify(r, null, 2)); if (!r.ok) process.exitCode = 1;
    } else { console.error('usage: first-run.mjs status | apply <answers.json|->'); process.exitCode = 2; }
  } catch (e) { console.error(`first-run: ${e.message}`); process.exitCode = 1; }
}
