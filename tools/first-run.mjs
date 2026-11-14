#!/usr/bin/env node
// first-run.mjs: the agent-led first-run setup, driven by the user's own AI agent (Claude Code, Codex, ...).
// The agent interviews the user in chat, one question at a time, then calls this tool once with the answers.
//   node tools/first-run.mjs status            JSON: does setup / goals still need doing, what was detected here
//   node tools/first-run.mjs apply answers.json   (or "-" for stdin) saves setup.json, the goals and links the tools;
//                                                 setup is recorded as complete only after the tools are linked
//   node tools/first-run.mjs paths             JSON: the resolved data, plans and run folders, heartbeat file and
//                                                 listener command (the one source agents should use)
//   node tools/first-run.mjs doctor [--json]   checks data-folder and run-folder writes, a localhost call to the
//                                                 dashboard, the tool links and listener/heartbeat freshness, and
//                                                 prints the exact fix for each failure (exit 1 if any check fails)
// answers.json: { "harnesses": ["codex"], "subs": { "codex": { "tier": "plus" } }, "jev": false, "apiDailyUsd": 5,
//   "goals": [ { "title": "Ship the app", "outcome": "...", "next_action": "...", "allocation": 60 } ] }
// Everything is written under $AGENTGLIM_DATA (default ~/.agentglim). No credentials are read into the output.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HARNESS_TOOLS } from '../app/harness-tools.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..', 'app');
// file URLs, never bare paths: on Windows `C:\...` would be read as a URL scheme (ERR_UNSUPPORTED_ESM_URL_SCHEME)
const appMod = (name) => import(pathToFileURL(path.join(APP, name)).href);
const { DATA, GOALS, RUN, goalsFile, pathsInfo } = await appMod('paths.mjs');
const { detect, loadSetup, saveSetup, completeSetup, setupFilled, SETUP_FILE, HARNESSES } = await appMod('setup.mjs');
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

// the shipped tools the SuperAgent needs, linked into <run>/bin by scaffold-harness
export const REQUIRED_TOOLS = ['status-write.mjs', 'chat-write.mjs', 'owner-check.mjs', 'auditq-wait.sh'];
export const toolsReady = () => REQUIRED_TOOLS.every((n) => fs.existsSync(path.join(RUN, 'bin', n)));

export function paths() {
  const info = pathsInfo();
  const warnings = [];
  if (info.restartNeeded) warnings.push(`Setup saved plans folder ${info.configuredPlans} but this shell resolves ${info.plans}; restart AgentGlim and use the saved folder.`);
  return { ...info, toolsReady: toolsReady(), warnings };
}

export function status() {
  const d = detect();
  const setupDone = setupFilled();
  const goalsDone = goalsPersonal();
  return {
    needsSetup: !setupDone || !goalsDone,
    setupDone, goalsDone,
    toolsReady: toolsReady(), needsRepair: setupDone && !toolsReady(), // repair = run `npm run scaffold-harness`
    run: RUN,
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
    const saved = saveSetup(cfg, { complete: false }); // marked complete below, once the tools are linked
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
    try { (await appMod('goals-sync.mjs')).syncGoals(); } catch (e) { out.goalsSync = String(e.message || e); }
  }
  if (a.globalHints === true) {
    try { out.globalHints = (await import('./install-agent-hints.mjs')).install({ root: path.resolve(HERE, '..') }); }
    catch (e) { out.globalHints = [`failed: ${e.message}`]; }
  }
  if (scaffold) {
    try { out.scaffold = execFileSync(process.execPath, [path.join(HERE, 'scaffold-harness.mjs')], { env: process.env, encoding: 'utf8', timeout: 20000 }).trim(); }
    catch (e) { out.ok = false; out.scaffold = String(e.stdout || e.message).trim(); }
  }
  out.ready = out.ok && toolsReady();
  if (wantSetup) {
    if (out.ready || (!scaffold && out.ok)) { completeSetup(); out.setupComplete = true; }
    else { out.setupComplete = false; out.error = 'Setup saved but not complete: the tools were not linked. Fix the scaffold error and run apply again.'; }
  }
  out.paths = pathsInfo();
  return out;
}

// ---------- doctor ----------
// The fix hint names the Python doctor actually found (python on Windows, py -3, python3 elsewhere).
export const trackingFix = (py = 'python3') => `run \`${py || 'python3'} tools/addons/jobs-track.py --help\` to see the error`;
function trackingCheck(env) {
  const wl = path.join(HERE, '..', 'harness', 'bin', 'worker-launch.mjs');
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { jobsTrackCmd, track } = await import(${JSON.stringify(pathToFileURL(wl).href)});
      const c = jobsTrackCmd(); if (!c) { console.log(JSON.stringify({ err: 'nopy' })); process.exit(0); }
      const id = 'doctor-' + process.pid;
      const t = await track(c, ['start', '--harness', 'codex', '--id', id, '--pid', String(process.pid), '--label', 'doctor tracking check', '--launcher', 'doctor'], process.env, 30000);
      if (t.id) await track(c, ['finish', '--id', t.id, '--rc', '0'], process.env, 30000);
      console.log(JSON.stringify({ cmd: (c.length > 1 ? c.slice(0, -1) : c).join(' '), custom: c.length === 1, got: t.id, error: t.error, fin: !!t.id }));`], { env, encoding: 'utf8', timeout: 70000 });
    const j = JSON.parse(out.trim().split('\n').pop());
    if (j.err === 'nopy') return [false, 'no Python 3 (python3, python or py): worker-launch runs workers but they will not show in the dashboard', 'install Python 3 (https://www.python.org/downloads/) and run doctor again'];
    if (!j.got) return [false, `jobs-track (${j.cmd}) did not record a test job${j.error ? `: ${j.error}` : ''}`, j.custom ? `run \`${j.cmd} --help\` to see the error` : trackingFix(j.cmd)];
    return [true, `jobs-track round trip ok (${j.cmd})`, ''];
  } catch (e) { return [false, `tracking check failed: ${String(e.message || e).split('\n')[0]}`, 'run `node harness/bin/worker-launch.mjs` by hand to see the error']; }
}

const DOCTOR_TOOLS = HARNESS_TOOLS; // the same list scaffold-harness links, so the count matches SETUP.md
const ageMin = (f) => { try { return (Date.now() - fs.statSync(f).mtimeMs) / 60e3; } catch { return null; } };
const sq = (s) => /^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
// The probe never lands where a heartbeat reader looks: for a heartbeats folder it writes inside a `.doctor`
// subfolder (dot-named; heartbeat readers skip dotfiles), so running doctor can never show "Armed".
function writeProbe(dir, { sub = false } = {}) {
  const base = sub ? path.join(dir, '.doctor') : dir;
  const f = path.join(base, `.doctor-${process.pid}-${Date.now()}`);
  try { fs.mkdirSync(base, { recursive: true }); fs.writeFileSync(f, 'ok'); fs.renameSync(f, `${f}.done`); fs.renameSync(`${f}.done`, path.join(base, '.doctor-last')); return null; }
  catch (e) { return e.code || String(e.message || e); }
}
export function sandboxFix(dir) {
  return `the agent's sandbox blocks writes to ${dir}. Codex: start it with \`codex --add-dir ${sq(dir)}\` (or -c 'sandbox_workspace_write.writable_roots=[${JSON.stringify(dir)}]'); Claude Code: \`claude --add-dir ${sq(dir)}\`; otherwise allow that folder in your harness's sandbox settings`;
}
export function appUrl(env = process.env) {
  // AGENTGLIM_URL, else the running server's own record (any port), else harness config status.appUrl
  let u = env.AGENTGLIM_URL;
  if (!u) { try { const j = JSON.parse(fs.readFileSync(path.join(DATA, 'server-url.json'), 'utf8')); try { process.kill(j.pid, 0); u = j.url; } catch (e) { if (e.code === 'EPERM') u = j.url; } } catch {} }
  if (!u) { try { u = execFileSync(process.execPath, [path.join(HERE, '..', 'harness', 'config.mjs'), '--get', 'status.appUrl'], { encoding: 'utf8', timeout: 5000 }).trim(); } catch {} }
  return String(u || `http://127.0.0.1:${env.PORT || 18990}`).replace(/\/$/, '');
}
export async function doctor({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const checks = [], add = (id, ok, detail, fix, warn = false) => checks.push({ id, ok, ...(warn && !ok ? { warn: true } : {}), detail, ...(ok ? {} : { fix }) });
  const info = pathsInfo();
  let e = writeProbe(DATA);
  add('data-write', !e, e ? `cannot write ${DATA} (${e})` : `wrote ${DATA}`, sandboxFix(DATA));
  e = writeProbe(path.join(DATA, 'heartbeats'), { sub: true });
  add('heartbeat-write', !e, e ? `cannot write ${path.join(DATA, 'heartbeats')} (${e})` : 'heartbeats folder writable', sandboxFix(path.join(DATA, 'heartbeats')));
  if (fs.existsSync(RUN)) { e = writeProbe(RUN); add('run-write', !e, e ? `cannot write ${RUN} (${e})` : `wrote ${RUN}`, sandboxFix(RUN)); }
  else add('run-write', false, `no run folder at ${RUN}`, 'run `npm run scaffold-harness` (or `node tools/first-run.mjs apply answers.json`)');
  const url = appUrl(env);
  try {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 4000);
    const r = await fetchImpl(`${url}/api/status-ask`, { signal: ac.signal }); clearTimeout(t);
    add('localhost', r.ok, r.ok ? `${url} answered` : `${url} answered HTTP ${r.status}`, `restart the dashboard: node ${sq(path.join(HERE, '..', 'app', 'server.mjs'))}`);
  } catch (err) {
    const code = err?.cause?.code || (err?.name === 'AbortError' ? 'timed out' : err?.code || err?.name || String(err?.message || err));
    const refused = code === 'ECONNREFUSED';
    add('localhost', false, `${url} unreachable (${code})`, refused ? `start the dashboard: node ${sq(path.join(HERE, '..', 'app', 'server.mjs'))} (then open ${url})`
      : `the agent's sandbox may block network calls to localhost. Codex: \`codex -c sandbox_workspace_write.network_access=true\` (or run the tools outside the sandbox); Claude Code: allow localhost in its sandbox network settings. If the dashboard runs on another port, set AGENTGLIM_URL`);
  }
  const missing = DOCTOR_TOOLS.filter((n) => { const f = path.join(RUN, 'bin', n); try { fs.statSync(f); return false; } catch { return true; } }); // statSync follows links: a dangling link counts as missing
  add('tool-links', !missing.length, missing.length ? `missing or broken in ${path.join(RUN, 'bin')}: ${missing.join(', ')}` : `${DOCTOR_TOOLS.length} tools linked`, `npm run scaffold-harness   (from ${path.resolve(HERE, '..')})`);
  const sa = ageMin(info.heartbeat), lw = ageMin(path.join(RUN, 'heartbeats', 'auditq-wait'));
  const { turnArmed, readSession } = await appMod('turn-delivery.mjs');
  const turn = turnArmed(DATA), reg = readSession(DATA);
  const td = sq(path.join(APP, 'turn-delivery.mjs'));
  add('superagent-heartbeat', (sa != null && sa < 45) || !!turn?.ok, sa == null ? 'no SuperAgent heartbeat yet' : `SuperAgent heartbeat ${sa.toFixed(1)} min old`,
    `touch ${sq(info.heartbeat)} now and every five minutes while you supervise (or, for Codex/Pi/OpenCode, register the session from its own folder: node ${td} register --harness codex --session auto)`, true);
  // a registration alone is not healthy: only a delivered request that was really answered proves the round trip
  add('listener', (lw != null && lw < 10) || !!turn?.ok,
    turn ? `turn-based delivery to ${turn.harness}${turn.ok ? ', answered round trip verified' : `: ${turn.reason}`}` : lw == null ? 'queue listener never ran' : `queue listener beat ${lw.toFixed(1)} min ago`,
    turn && !turn.verified && !turn.stopped ? 'click Refresh in the dashboard, wait for the reply (status-write.mjs), then run doctor again'
      : `run ${info.waitCommand} in a session whose output you read and re-run it after every exit, or register a turn-based session (turn-delivery.mjs register)`, true);
  if (turn && (turn.stopped || (!turn.ok && turn.verified))) add('turn-delivery', false, `delivery to ${turn.harness} failing: ${turn.reason}`, `check the session id and folder, then re-register: node ${td} register --harness ${turn.harness} --session <id> --cwd <the session's folder>`);
  // the resumed turn must be able to answer: sandbox / permission arguments
  if (reg?.harness === 'codex') {
    const user = env.AGENTGLIM_SEND_CODEX_ARGS;
    const okArgs = !user || /workspace-write|danger-full-access|writable_roots|--add-dir|bypass/.test(user);
    add('turn-permissions', okArgs, user ? `AGENTGLIM_SEND_CODEX_ARGS=${user}` : 'resumed Codex turns run with -s workspace-write --add-dir <data> --add-dir <run> and localhost network access',
      `AGENTGLIM_SEND_CODEX_ARGS replaces the defaults; include ["-s","workspace-write","--add-dir",${JSON.stringify(DATA)},"--add-dir",${JSON.stringify(RUN)},"-c","sandbox_workspace_write.network_access=true"] or unset it`, true);
  } else if (reg?.harness === 'claude') {
    const user = env.AGENTGLIM_SEND_CLAUDE_ARGS;
    const okArgs = !user || /allowedTools|permission-mode|dangerously/.test(user);
    add('turn-permissions', okArgs, user ? `AGENTGLIM_SEND_CLAUDE_ARGS=${user}` : 'resumed Claude turns pre-allow status-write, chat-write and owner-check and add <data> and <run>',
      'AGENTGLIM_SEND_CLAUDE_ARGS replaces the defaults; include --allowedTools for the three writers (see SETUP.md) or unset it', true);
  }
  // worker tracking needs Python 3 and a working jobs-track; check with a real start/finish round trip
  add('worker-tracking', ...trackingCheck(env), true);
  return { ok: checks.every((c) => c.ok || c.warn), url, checks };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'paths') console.log(JSON.stringify(paths(), null, 2));
    else if (cmd === 'status') console.log(JSON.stringify(status(), null, 2));
    else if (cmd === 'doctor') {
      const r = await doctor();
      if (arg === '--json') console.log(JSON.stringify(r, null, 2));
      else for (const c of r.checks) console.log(`${c.ok ? 'ok  ' : c.warn ? 'warn' : 'FAIL'} ${c.id}: ${c.detail}${c.ok ? '' : `\n     fix: ${c.fix}`}`);
      if (!r.ok) process.exitCode = 1;
    }
    else if (cmd === 'apply' && arg) {
      const a = JSON.parse(arg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(arg, 'utf8'));
      const r = await apply(a); console.log(JSON.stringify(r, null, 2)); if (!r.ok) process.exitCode = 1;
    } else { console.error('usage: first-run.mjs status | paths | doctor [--json] | apply <answers.json|->'); process.exitCode = 2; }
  } catch (e) { console.error(`first-run: ${e.message}`); process.exitCode = 1; }
}
