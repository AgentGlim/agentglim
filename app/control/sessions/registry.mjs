// Session registry: merges Claude registry files, a /proc scan, run agents, the watcher, other-project agents and
// the Remote Control note into one row list. Every root is injectable for tests.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { argOf, headlessOf } from './procscan.mjs';
import { scanRunAgents } from './runagents.mjs';

export const STOPPED_KEEP_MS = 10 * 60e3;
export const WORKING_MS = 120e3;
// a run agent's process must have started within this window of its recorded start (meta `start` line or the loop
// state's `started`); otherwise the pid now belongs to some other process (audit r1 M2)
export const RUN_START_TOL_MS = 120e3;

// C2: the state of one session from its observed facts. Order: stopped > paused > waiting > working > idle.
export function stateOf({ alive, procState, prompt, status, transcriptMtime, now = Date.now() }) {
  if (!alive) return 'stopped';
  if (procState === 'T' || procState === 't') return 'paused';
  if (prompt) return 'waiting';
  if (status === 'busy' || status === 'shell') return 'working';
  if (transcriptMtime && now - transcriptMtime < WORKING_MS) return 'working';
  return 'idle';
}

const globRe = (g) => new RegExp(`^${String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

export function readClaudeRegistry(claudeHome) {
  const dir = path.join(claudeHome, 'sessions'), out = [];
  let names = []; try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue; // never the <pid>.<sha>.key token files
    try { const j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); if (j && Number(j.pid) > 1) out.push(j); } catch {}
  }
  return out;
}

export function makeRegistry({ proc, tmux, cfg, adapters = {}, prompts = null, claudeHome = process.env.CLAUDE_HOME || `${process.env.HOME}/.claude`,
  plansDir = process.env.PLANS_DIR || path.join(os.homedir(), 'projects', 'dev', 'plans'), projectsRoots = [path.join(os.homedir(), 'dev', 'projects'), path.join(os.homedir(), 'projects', 'dev')],
  snapshot = null, now = () => Date.now(), selfPid = process.pid } = {}) {
  const prev = new Map(); // id -> row (for stopped retention)
  const stoppedSince = new Map(); // `${id}|${procStart}` -> first time seen stopped; survives the drop (audit r1 M3)
  let snapCache = { at: 0, v: null };
  const snap = () => { if (!snapshot) return null; if (now() - snapCache.at > 15000) { try { snapCache = { at: now(), v: snapshot() }; } catch { snapCache = { at: now(), v: null }; } } return snapCache.v; };
  const plansReal = (() => { try { return fs.realpathSync(plansDir); } catch { return plansDir; } })();
  const rootsReal = [...new Set(projectsRoots.flatMap((r) => { try { return [r, fs.realpathSync(r)]; } catch { return [r]; } }))];

  function projectOf(cwd) {
    if (!cwd) return { project: null, other: false };
    for (const pr of [plansReal, plansDir]) if (cwd === pr || cwd.startsWith(pr + '/')) { const rest = cwd.slice(pr.length + 1).split('/')[0]; return { project: rest || 'plans', other: false }; }
    for (const r of rootsReal) if (cwd.startsWith(r + '/')) return { project: cwd.slice(r.length + 1).split('/')[0], other: true };
    return { project: null, other: false };
  }
  function isWatcher(c) {
    const w = cfg.load().watcher || {};
    if (c.name && (w.names || []).some((g) => globRe(g).test(c.name))) return true;
    return !!(w.cwd && c.cwd && (c.cwd === w.cwd || c.cwd === (() => { try { return fs.realpathSync(w.cwd); } catch { return w.cwd; } })()));
  }
  function mtime(f) { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }

  async function build() {
    const t = now(), conf = cfg.load();
    const panes = tmux ? await tmux.listPanes() : [];
    const rows = new Map();
    const paneFor = (pid, hint) => {
      if (hint) { const h = panes.find((p) => p.id === hint); if (h && proc.isAncestor(h.pid, pid)) return h; }
      return panes.find((p) => proc.isAncestor(p.pid, pid)) || null;
    };
    const add = (r) => { const old = rows.get(r.id); rows.set(r.id, old ? { ...old, ...Object.fromEntries(Object.entries(r).filter(([, v]) => v != null)) } : r); };

    // agent processes seen by the /proc scan (folded children too): pid -> kind
    const scanned = proc.scanAgents({ skipPid: selfPid });
    const agentAt = new Map();
    for (const a of scanned) { agentAt.set(a.pid, a.kind); for (const f of a.folded || []) agentAt.set(f, a.kind); }

    // (a) Claude registry files. With procStart: alive only when it matches. Without it the file proves nothing about
    // whoever holds the pid now, so the row is alive only when the /proc scan sees a Claude process there.
    for (const c of readClaudeRegistry(claudeHome)) {
      const pid = Number(c.pid), st = proc.stat(pid);
      const alive = !!st && (c.procStart != null ? String(st.starttime) === String(c.procStart) : agentAt.get(pid) === 'claude');
      const paneHint = typeof c.tmux === 'string' ? (c.tmux.match(/%\d+/) || [])[0] : null;
      add({ id: `claude:${pid}`, harness: 'claude', source: 'claude-registry', pid, pgid: st?.pgid ?? null, procStart: c.procStart ?? (alive ? st.starttime : null), alive, unverified: !alive && !!st && c.procStart == null ? true : null,
        procState: alive ? st.state : null, sessionId: c.sessionId || null, cwd: c.cwd || null, name: c.name || null, kind: c.kind || null, status: c.status || null,
        tempo: c.tempo || null, needs: c.needs || null, detail: c.detail || null, bridgeSessionId: c.bridgeSessionId || null,
        socket: c.messagingSocketPath || null, peerProtocol: c.peerProtocol ?? null, paneHint, role: isWatcher(c) ? 'watcher' : 'interactive',
        argv: alive ? proc.cmdline(pid) : [] });
    }
    // (b) /proc scan
    for (const a of scanned) {
      const id = `${a.kind}:${a.pid}`;
      const headless = headlessOf(a.kind, a.argv);
      add({ id, harness: a.kind, source: rows.has(id) ? rows.get(id).source : 'proc', pid: a.pid, pgid: a.pgid, procStart: rows.get(id)?.procStart ?? a.starttime, alive: rows.get(id)?.alive ?? true,
        procState: a.state, cwd: rows.get(id)?.cwd || a.cwd, argv: a.argv, headless, folded: a.folded,
        model: argOf(a.argv, '--model', '-m'), effort: argOf(a.argv, '--effort') || (argOf(a.argv, '-c') || '').replace(/^model_reasoning_effort=/, '') || null });
    }
    // (c) run agents: the pid file outlives the run when a driver dies without writing rc, so the process at that
    // pid must prove it is the run's: its start time matches the recorded start, or (no clock to compare) the /proc
    // scan sees an agent there, or a loop/goal runner's cmdline names its runner.
    for (const r of scanRunAgents(plansDir)) {
      const st = proc.stat(r.pid);
      const who = runIdentity(r, st, agentAt);
      const existing = rows.has(`${r.harness}:${r.pid}`) ? `${r.harness}:${r.pid}` : [...rows.keys()].find((k) => k.endsWith(`:${r.pid}`));
      if (!who.ok && existing) continue; // the pid is someone else's live row now: keep that row, drop the stale run
      const id = existing || `${r.harness}:${r.pid}`;
      const alive = who.ok && (rows.get(id)?.alive ?? true);
      add({ id, harness: rows.get(id)?.harness || r.harness, source: r.source, pid: r.pid, pgid: r.pgid ?? (alive ? st?.pgid : null) ?? null, procStart: rows.get(id)?.procStart ?? (alive ? st.starttime : null),
        alive, stoppedWhy: who.ok || who.why === 'pid gone' ? null : who.why, procState: alive ? st?.state ?? null : null, cwd: rows.get(id)?.cwd || r.cwd || path.join(plansDir, r.plan), project: r.plan, role: r.role, step: r.step, task: r.task,
        model: rows.get(id)?.model || r.model, effort: rows.get(id)?.effort || r.effort, started: r.started, runDir: r.dir, headless: r.source === 'run' ? true : rows.get(id)?.headless });
    }
    // resolve the rest of each row
    const sn = snap();
    const seen = new Set();
    for (const r of rows.values()) {
      const pj = projectOf(r.cwd);
      r.project = r.project || pj.project || (r.cwd ? path.basename(r.cwd) : null);
      if (!r.role) r.role = r.headless ? 'headless' : pj.other ? 'other-project' : 'interactive';
      else if (r.role === 'interactive' && pj.other) r.role = 'other-project';
      r.otherProject = pj.other;
      const pane = r.alive ? paneFor(r.pid, r.paneHint) : null;
      r.pane = pane ? pane.id : null; r.paneTarget = pane ? pane.target : null; r.panePid = pane ? pane.pid : null; r.tmuxSession = pane ? pane.session : null;
      const ad = adapters[r.harness];
      let tFile = null; try { tFile = ad?.locate ? ad.locate(r) : null; } catch {}
      r.transcript = typeof tFile === 'string' && tFile.includes('/') ? tFile : null;
      const tm = r.transcript ? mtime(r.transcript) : 0;
      r.lastActivity = tm || r.started || null;
      r.model = r.model || null;
      // prompt signals, strongest first: registry tempo/needs, the pane pattern pack, agent-notify (only without a pane to confirm)
      r.prompt = null;
      if (prompts && r.alive) {
        r.prompt = prompts.fromRegistry(r);
        if (!r.prompt && r.pane && tmux) { try { r.prompt = await prompts.fromPane(r, tmux); } catch { r.prompt = null; } }
        if (!r.prompt && !r.pane) r.prompt = prompts.fromNotify(r);
      }
      r.state = stateOf({ alive: r.alive, procState: r.procState, prompt: r.prompt, status: r.status, transcriptMtime: tm, now: t });
      r.delivery = deliveryOf(r, conf);
      const tok = tokensFor(sn, r); r.tokens = tok?.tokens ?? null; r.cost = tok?.cost ?? null;
      if (r.bridgeSessionId) r.remote = 'linked to Remote Control';
      delete r.argv; delete r.paneHint;
      r.stoppedAt = r.alive ? null : stoppedAtOf(r, t, seen);
    }
    // stopped retention: rows that vanished stay 10 min as stopped
    for (const [id, old] of prev) {
      if (rows.has(id) || old.role === 'remote-note') continue;
      const stoppedAt = stoppedAtOf(old, t, seen);
      if (t - stoppedAt < STOPPED_KEEP_MS) rows.set(id, { ...old, alive: false, state: 'stopped', stoppedAt, pane: null, delivery: { mode: 'read-only', reason: 'session stopped' }, prompt: null });
    }
    for (const [id, r] of rows) if (!r.alive && r.stoppedAt && t - r.stoppedAt >= STOPPED_KEEP_MS) rows.delete(id);
    // forget the first-stopped time only once no source reports that session any more
    for (const k of stoppedSince.keys()) if (!seen.has(k)) stoppedSince.delete(k);
    prev.clear(); for (const [id, r] of rows) prev.set(id, r);
    const list = [...rows.values()].sort((a, b) => (a.role === 'watcher' ? -1 : b.role === 'watcher' ? 1 : 0) || (b.lastActivity || 0) - (a.lastActivity || 0));
    list.push({ id: 'remote:note', harness: 'remote', role: 'remote-note', state: 'idle', note: 'cloud sessions are not reachable from this PC', delivery: { mode: 'read-only', reason: 'cloud session' }, alive: false });
    return list;
  }

  function stoppedAtOf(r, t, seen) {
    const k = `${r.id}|${r.procStart ?? ''}`;
    seen.add(k);
    if (!stoppedSince.has(k)) stoppedSince.set(k, prev.get(r.id)?.stoppedAt || r.stoppedAt || t);
    return stoppedSince.get(k);
  }

  function runIdentity(r, st, agentAt) {
    if (!st) return { ok: false, why: 'pid gone' };
    const started = typeof r.started === 'number' ? r.started : Date.parse(r.started || '');
    const sm = proc.startMs ? proc.startMs(r.pid) : null;
    if (sm != null && Number.isFinite(started) && started > 0) return Math.abs(sm - started) <= RUN_START_TOL_MS ? { ok: true } : { ok: false, why: 'pid reused: process start does not match the run' };
    if (agentAt.has(r.pid)) return { ok: true };
    if ((r.source === 'feature-loop' || r.source === 'goal') && /(feature-loop|goal)/.test(proc.cmdline(r.pid).join(' '))) return { ok: true };
    return { ok: false, why: 'identity unverified' };
  }

  function deliveryOf(r, conf) {
    if (!r.alive) return { mode: 'read-only', reason: r.stoppedWhy || (r.unverified ? 'identity unverified: no controls' : 'session stopped') };
    if (conf.peer?.enabled && r.socket && r.harness === 'claude' && (r.peerProtocol ?? 0) >= 1) return { mode: 'peer', reason: null };
    if (r.pane) return { mode: 'tmux', reason: r.prompt ? 'prompt open: answer it first' : null };
    if (r.headless || r.source === 'run') return { mode: 'read-only', reason: 'headless agent: view and controls only' };
    return { mode: 'read-only', reason: 'no pane or socket' };
  }

  function tokensFor(sn, r) {
    if (!sn || !Array.isArray(sn.agents)) return null;
    const a = sn.agents.find((x) => x.active && x.project === r.project && (r.step ? x.step === r.step : false));
    return a ? { tokens: a.tokens ?? null, cost: a.cost ?? null } : null;
  }

  return { build, stateOf, prev, get: (id) => prev.get(id) || null };
}
