// harness.mjs: data for the Harness page (/harness, GET /api/harness). Read-only: it never writes a harness file.
// Shows every harness piece from harness/manifest.json with a live check of its path, plus the settings
// that matter day to day: worker lanes, Jev routing rules, the disk guard, the local model supervisor,
// the watcher queues and the harness skills. Paths and defaults come from app/settings.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { harnessConfig, AGENTGLIM_ROOT } from './settings.mjs';
import { superagentView } from './heartbeats.mjs'; // the private data heartbeat a fresh SuperAgent touches (AGENTS.md)
import { keySource } from './env.mjs';
import { readProcText } from './proc.mjs';

const MANIFEST = harnessConfig().harness?.manifest || path.join(AGENTGLIM_ROOT, 'harness', 'manifest.json');
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const tildeSlash = (s) => String(s || '').replace(/\\/g, '/');
const tilde = (p, home) => {
  if (!home || !p) return p;
  const h = String(home).replace(/[\\/]+$/, ''), s = String(p);
  // Compare through '/' on every platform: a Windows path keeps its letters, never turns into '~'.
  return tildeSlash(s) === tildeSlash(h) || tildeSlash(s).startsWith(tildeSlash(h) + '/') ? '~' + s.slice(h.length) : p;
};
const ageS = (ms) => (ms == null ? null : Math.max(0, Math.round((Date.now() - ms) / 1000)));

function pathInfo(p) {
  if (!p) return null;
  let st; try { st = fs.lstatSync(p); } catch { return { path: p, exists: false }; }
  const link = st.isSymbolicLink() ? (() => { try { return fs.realpathSync(p); } catch { return fs.readlinkSync(p); } })() : null;
  let ok = true; if (link) { try { fs.statSync(p); } catch { ok = false; } }
  return { path: p, exists: ok, link, mtime: st.mtimeMs, dir: st.isDirectory() };
}

// inodes of files someone holds a flock or POSIX lock on right now (from <proc>/locks;
// empty where there is no procfs, so the page never guesses)
function heldInodes() {
  const s = new Set();
  for (const l of (readProcText('locks') || '').split('\n')) { const m = l.match(/\s(\S+):(\S+):(\d+)\s/); if (m) s.add(Number(m[3])); }
  return s;
}
const inode = (f) => { try { return fs.statSync(f).ino; } catch { return null; } };

// the free lane list, from the FREE_WORKERS / ZEN_SLOTS assignment lines of worker.sh (assignments only, cached by mtime)
let laneCache = { mtime: 0, list: null, error: null };
function laneList(workerSh) {
  const st = pathInfo(workerSh);
  if (!st?.exists) return { list: null, error: 'worker.sh not found' };
  if (laneCache.mtime === st.mtime) return laneCache;
  const lines = readText(workerSh).split('\n').filter((l) => /^(ZEN_SLOTS|FREE_WORKERS)=/.test(l));
  let list = null, error = null;
  if (!lines.length) error = 'no FREE_WORKERS lines in worker.sh';
  else try {
    const out = execFileSync('bash', ['--norc', '--noprofile', '-c', lines.join('\n') + '\nprintf "%s\\n" $FREE_WORKERS'], { encoding: 'utf8', timeout: 2000, env: { PATH: '/usr/bin:/bin' } });
    list = out.split('\n').filter(Boolean).map((e) => { const i = e.indexOf('='); return { name: e.slice(0, i), kind: e.slice(i + 1) }; });
  } catch (e) { error = `could not read the lane list: ${e.message.split('\n')[0]}`; }
  laneCache = { mtime: st.mtime, list, error };
  return laneCache;
}

function lanes(cfg, held) {
  const src = readText(cfg.files.workerSh), patched = /harness-config\.mjs/.test(src); // config patch applied (docs/watcher-cutover-2026-11-06.md)
  const fromCfg = patched && Array.isArray(cfg.lanes.free) && cfg.lanes.free.length
    ? cfg.lanes.free.map((e) => { const i = String(e).indexOf('='); return { name: String(e).slice(0, i), kind: String(e).slice(i + 1) }; }) : null;
  const { list, error } = fromCfg ? { list: fromCfg, error: null } : laneList(cfg.files.workerSh);
  const live = src.match(/^FREE_PAUSE=(\d+)/m);
  const pauseS = patched && cfg.lanes.freePauseS != null ? +cfg.lanes.freePauseS : live ? +live[1] : 3600;
  const now = Date.now() / 1000, flags = cfg.files.flags, slots = cfg.files.slots;
  const rows = (list || []).map(({ name, kind }) => {
    const until = +(readText(`${flags}/free_${name}_until`).trim() || 0);
    const p = pathInfo(`${flags}/free_${name}_paused`);
    const pausedUntil = until > now ? until : p?.exists && now - p.mtime / 1000 < pauseS ? p.mtime / 1000 + pauseS : null;
    const ino = inode(`${slots}/free-${name}.lock`);
    return { name, kind, busy: ino != null && held.has(ino), pausedUntil: pausedUntil ? Math.round(pausedUntil * 1000) : null };
  });
  const b = readJson(cfg.files.budget, {});
  return { error, pauseS, lanes: rows, order: b.order || null, routerMode: b.mode || null, budgetAgeS: ageS(b.at), source: fromCfg ? 'harness config lanes.free' : cfg.files.workerSh, configPatched: patched };
}

// Jev settings the page can change: requests waiting in the run-modes queue (the watcher applies them) and recent changes
export const EDIT_KEYS = ['jev.close', 'jev.notifyPicks'];
function jevEdits(cfg) {
  const q = cfg.files.modeQueue, pending = [];
  try { for (const f of fs.readdirSync(q).filter((x) => /\.json$/.test(x)).sort()) { const r = readJson(`${q}/${f}`, {}); if (EDIT_KEYS.includes(r.key)) pending.push({ key: r.key, value: r.value, at: r.at, by: r.by }); } } catch {}
  const recent = readText(path.join(cfg.roots.data, 'harness-settings.ndjson')).trim().split('\n').filter(Boolean).slice(-5).reverse()
    .map((l) => { try { const r = JSON.parse(l); return { at: r.at, key: r.key, old: r.old, value: r.value, by: r.by }; } catch { return null; } }).filter(Boolean);
  return { keys: EDIT_KEYS, pending, recent };
}
function jev(cfg, pieces) {
  const rules = readJson(cfg.jev.routes);
  const rows = readText(cfg.jev.log).trim().split('\n').filter(Boolean);
  let last = null; try { last = rows.length ? JSON.parse(rows[rows.length - 1]) : null; } catch {}
  const live = pieces.find((p) => p.id === 'jev-router');
  return {
    file: cfg.jev.routes, found: !!rules, keyEnv: cfg.jev.keyEnv, keySource: keySource(cfg.jev.keyEnv || 'JEV_API_KEY'),
    close: rules?.close ?? null, strength: rules?.strength || [], effortOrder: rules?.effortOrder || [], fallback: rules?.fallback || null,
    notifyPicks: rules?.notify?.picks || [],
    design: rules?.design ? { allowed: rules.design.allowed || [], threshold: rules.design.threshold ?? 0.5, keywords: rules.design.keywords || [], question: rules.design.question || '' } : null,
    options: Object.entries(rules?.options || {}).map(([id, o]) => ({ id, group: o.group || '', efforts: o.efforts || [], desc: o.desc || '' })),
    decisions: rows.length, last: last ? { t: last.t, pick: last.pick, effort: last.effort, p: last.pPick, design: last.design === true, pDesign: last.pDesign ?? null } : null,
    harnessPathIsLink: !!live?.linked,
    edits: jevEdits(cfg),
  };
}

let devCache = null;
function guardDevice(cfg) {
  if (process.env.IO_GUARD_DEV) return process.env.IO_GUARD_DEV;
  if (cfg.ioGuard.device && cfg.ioGuard.device !== 'auto') return cfg.ioGuard.device;
  if (devCache !== null) return devCache;
  try {
    const src = execFileSync('findmnt', ['-no', 'SOURCE', '-T', cfg.roots.plans], { encoding: 'utf8', timeout: 2000 }).trim().split('\n')[0].replace(/\[.*$/, '');
    const out = execFileSync('lsblk', ['-nsro', 'NAME,TYPE', src], { encoding: 'utf8', timeout: 2000 });
    devCache = out.split('\n').map((l) => l.split(' ')).find(([, t]) => t === 'disk')?.[0] || '';
  } catch { devCache = ''; }
  return devCache;
}

function disk(cfg) {
  const a = readJson(cfg.ioGuard.statusFile);
  return {
    guard: { device: guardDevice(cfg) || 'not found', pausePct: +(process.env.IO_GUARD_PCT || cfg.ioGuard.pausePct), resumeGap: cfg.ioGuard.resumeGap },
    service: a ? { device: a.device, busyPct: a.busy_percent, pauseAt: a.pause_at, resumeBelow: a.resume_below, pausedJobs: (a.paused_pids || []).length, newJobsBlocked: !!a.new_jobs_blocked, ageS: ageS(a.updated ? a.updated * 1000 : null) } : null,
    busyFlag: !!pathInfo(cfg.ioGuard.busyFlag)?.exists,
  };
}

function local(cfg, held) {
  const L = cfg.localPilot, st = readJson(L.flags.state, {});
  const src = readText(cfg.files.localPilot);
  const idle = src.match(/^IDLE_STOP_S\s*=\s*(\d+)/m);
  let leases = 0;
  for (let i = 0; i < (L.workers || 0); i++) { const ino = inode(`${cfg.files.slots}/qwen-pilot-worker-${i}.lock`); if (ino != null && held.has(ino)) leases++; }
  return {
    found: !!src, port: L.port, workers: L.workers, idleStopS: idle ? +idle[1] : L.idleStopS,
    enabled: !!pathInfo(L.flags.enabled)?.exists, paused: !!pathInfo(L.flags.paused)?.exists, onDemand: !!pathInfo(L.flags.onDemand)?.exists,
    ready: !!st.ready, reason: st.reason || null, stateAgeS: ageS(st.at ? st.at * 1000 : null), leases,
    onDemandAsleep: !!pathInfo(L.flags.onDemand)?.exists && !st.ready, // on-demand pilot is asleep
  };
}

function watcher(cfg) {
  const ls = (d, re) => { try { return fs.readdirSync(d).filter((f) => re.test(f)); } catch { return null; } };
  const q = cfg.files.auditQueue, reqs = ls(q, /\.req$/) || [];
  const has = (f) => fs.existsSync(`${q}/${f}`);
  const pending = reqs.filter((r) => { const b = r.slice(0, -4); return !has(`${r}.taken`) && !has(`${r}.decline`) && !has(`${b}.taken`) && !has(`${b}.decline`); });
  const alive = pathInfo(`${q}/.alive`);
  // The SuperAgent's own heartbeat lives in private data and exists without a plans harness; the queue
  // listener below is a harness watcher and can legitimately be absent on a fresh install.
  const sa = superagentView({ data: cfg.roots.data, run: cfg.roots.run });
  const bridge = readJson(`${cfg.files.flags}/watcher-bridge-health.json`);
  const n = (d) => { const l = ls(d, /^\d+.*\.json$/); return l == null ? null : l.length; };
  return {
    superagentAgeS: sa.at == null ? null : ageS(sa.at), superagentOk: sa.ok, queueFound: fs.existsSync(q),
    listenerAgeS: alive?.exists ? ageS(alive.mtime) : null, auditPending: pending.length, auditTotal: reqs.length,
    modeQueue: n(cfg.files.modeQueue), statusAsk: n(cfg.files.statusAsk), chatInbox: n(cfg.files.chatInbox), ownerCheck: n(cfg.files.ownerCheck),
    bridge: bridge ? { ageS: ageS(bridge.at ? bridge.at * 1000 : null), pending: bridge.pending ?? null, error: bridge.error || null } : null,
  };
}

function modes(cfg) {
  const m = readJson(cfg.files.modes);
  if (!m) return null;
  return { harness: m.harness, until: m.harnessUntil || null, reaper: m.reaper, cloud: m.cloud, api: m.api,
    subs: Object.fromEntries(Object.entries(m.subs || {}).map(([k, v]) => [k, { mode: v.mode, speed: v.speed }])) };
}

function skills(cfg, list, home) {
  return (list || []).map((s) => {
    for (const d of cfg.skills.dirs || []) {
      const p = path.join(d, s.id), f = pathInfo(path.join(p, 'SKILL.md'));
      if (f?.exists) { const real = (() => { try { return fs.realpathSync(p); } catch { return p; } })(); return { ...s, found: true, at: tilde(p, home), real: real !== p ? tilde(real, home) : null }; }
    }
    return { ...s, found: false, at: null, real: null };
  });
}

export function harnessView() {
  const cfg = harnessConfig(), home = process.env.HOME || '';
  const man = readJson(MANIFEST, { pieces: [], skills: [] });
  const sub = (p) => (typeof p === 'string' ? p.replace(/^~(?=[\\/]|$)/, home).replace(/\{(plans|run|agentglim|data)\}/g, (_, k) => cfg.roots[k]) : p);
  const pieces = (man.pieces || []).map((p) => {
    const live = pathInfo(sub(p.path)), pk = p.packaged ? pathInfo(sub(p.packaged)) : null;
    const linked = !!(live?.link && pk?.exists && live.link === fs.realpathSync(sub(p.packaged)));
    return { ...p, path: tilde(sub(p.path), home), packaged: p.packaged ? tilde(sub(p.packaged), home) : null, rules: p.rules ? tilde(sub(p.rules), home) : undefined,
      live: live ? { exists: live.exists, link: live.link ? tilde(live.link, home) : null, ageS: ageS(live.mtime) } : null,
      packagedFound: pk ? pk.exists : null, linked };
  });
  const held = heldInodes();
  const c = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'string' ? tilde(v, home) : v)));
  return c({
    at: Date.now(), updated: man.updated || null,
    roots: cfg.roots, config: { defaults: cfg.source.defaults, user: cfg.source.user, userFound: cfg.source.userFound },
    harness: { run: cfg.roots.run, found: fs.existsSync(cfg.roots.run), scaffold: 'npm run scaffold-harness',
      packaged: pieces.filter((p) => p.packagedFound).length, missing: pieces.filter((p) => p.live && !p.live.exists).length },
    pieces, lanes: lanes(cfg, held), jev: jev(cfg, pieces), disk: disk(cfg), local: local(cfg, held), watcher: watcher(cfg), modes: modes(cfg),
    skills: skills(cfg, man.skills, home),
  });
}
