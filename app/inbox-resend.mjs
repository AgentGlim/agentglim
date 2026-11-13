// inbox-resend.mjs: keep an unanswered SuperAgent chat message from sitting unseen.
//
// The harness inbox is <run>/chat_inbox/<ms>.json (see _run/bin/chat-write.mjs and auditq-wait.sh).
// When a message is still pending after AGENTGLIM_INBOX_RESEND_SECS (default 120), this job:
//   1. re-touches the pending <ms>.json (the wake file the waiter watches and the Codex bridge hashes),
//   2. nudges the registered headed session's tmux pane, when an explicitly registered identity exists,
//   3. writes <ms>.json.resent ({at, count, reason, via, ...}) so the SuperAgent can see it is the same
//      message and so the next interval grows: 2, 5, 15, 30 min, then every 30 min.
// It never creates a new inbox message, never answers, never guesses a session and never removes a file.
//
// Session identity comes only from <data>/inbox-session.json, written by
//   node app/inbox-resend.mjs register
// from inside the headed session (it walks its own parent chain to the claude process and requires the
// session registry record for that pid). Without this file only the wake-file re-touch happens.
//
// CLI: run-once | status | register [--pid N] [--name NAME] [--json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA, PLANS, RUN } from './paths.mjs';
import { makeProc } from './control/sessions/procscan.mjs';
import { makeTmux } from './control/sessions/tmux.mjs';
import { register as registerJob, start as startJobs } from './scheduler.mjs';

export const DEFAULT_RESEND_SECS = 120;
export const MAX_AGE_HOURS = 24;
export const CHECK_EVERY_MS = 30e3;
export const BACKOFF_MINUTES = [2, 5, 15, 30];
export const BACKOFF_MS = BACKOFF_MINUTES.map((m) => m * 60e3);
export const RECENT_MS = 24 * 3600e3;
export const MAX_NUDGE = 800;
const PENDING_RE = /^(\d{10,16})\.json$/;
const RESENT_RE = /^(\d{10,16})\.json\.resent$/;
const OFF_RE = /^(0|off|false|no)$/i;

const clampInt = (v, fallback, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};
const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const under = (child, parent) => {
  if (!child || !parent) return false;
  const c = real(child), p = real(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
};

// Settings: every value has a default and an environment override; tests pass paths/config directly.
export function resendConfig(env = process.env, roots = {}) {
  const plans = roots.plans || env.AGENTGLIM_PLANS || PLANS;
  const run = roots.run || env.AGENTGLIM_RUN || (env.AGENTGLIM_PLANS ? path.join(plans, '_run') : RUN);
  const data = roots.data || env.AGENTGLIM_DATA || DATA;
  const secs = clampInt(env.AGENTGLIM_INBOX_RESEND_SECS, DEFAULT_RESEND_SECS, 10, 86400);
  const maxHours = clampInt(env.AGENTGLIM_INBOX_RESEND_MAX_HOURS, MAX_AGE_HOURS, 1, 720);
  return {
    plans, run, data,
    inbox: env.AGENTGLIM_CHAT_INBOX || env.CHAT_INBOX || path.join(run, 'chat_inbox'),
    sessionFile: env.AGENTGLIM_INBOX_SESSION || path.join(data, 'inbox-session.json'),
    lockFile: path.join(data, 'inbox-resend.lock'),
    thresholdMs: secs * 1000,
    maxAgeMs: maxHours * 3600e3,
    backoffMs: BACKOFF_MS,
    enabled: !OFF_RE.test(String(env.AGENTGLIM_INBOX_RESEND ?? '')),
    tmux: !OFF_RE.test(String(env.AGENTGLIM_INBOX_RESEND_TMUX ?? '')),
    dev: env.AGENTGLIM_DEV === '1',
  };
}

// Resend #1 is due at message time + threshold; then 2, 5, 15, 30 min, then every 30 min.
export function nextDueAt(message, cfg) {
  const count = Math.max(0, Number(message.resent?.count) || 0);
  if (!count) return message.at + cfg.thresholdMs;
  const last = Date.parse(message.resent?.at || '') || (message.at + cfg.thresholdMs);
  return last + cfg.backoffMs[Math.min(count - 1, cfg.backoffMs.length - 1)];
}

export function dueState(message, cfg, now = Date.now()) {
  const ageMs = Math.max(0, now - message.at);
  const dueAt = nextDueAt(message, cfg);
  if (ageMs > cfg.maxAgeMs) return { due: false, stale: true, dueAt, ageMs };
  return { due: now >= dueAt, stale: false, dueAt, ageMs, dueInMs: Math.max(0, dueAt - now) };
}

export function readResent(file) {
  const r = readJson(file);
  if (!r || typeof r !== 'object') return null;
  const count = Number(r.count);
  return {
    at: typeof r.at === 'string' && Number.isFinite(Date.parse(r.at)) ? r.at : null,
    count: Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0,
    reason: typeof r.reason === 'string' ? r.reason.slice(0, 300) : '',
    via: r.via === 'wake' || r.via === 'wake+tmux' ? r.via : null,
    session: typeof r.session === 'string' ? r.session.slice(0, 120) : null,
    delivered: r.delivered === true,
    error: typeof r.error === 'string' ? r.error.slice(0, 300) : null,
  };
}

// Pending messages only: <ms>.json. .answered, .accepted, .tmp and non numeric files are not ours.
export function scanInbox(inbox) {
  let names = [];
  try { names = fs.readdirSync(inbox); } catch { return { exists: false, messages: [] }; }
  const messages = [];
  for (const name of names) {
    const m = PENDING_RE.exec(name);
    if (!m) continue;
    const file = path.join(inbox, name);
    let st; try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile() || fs.existsSync(`${file}.answered`)) continue; // answered already, even if the pending file lingers
    const rec = readJson(file);
    const at = rec && typeof rec.at === 'string' && Number.isFinite(Date.parse(rec.at)) ? Date.parse(rec.at) : st.mtimeMs;
    messages.push({
      id: m[1], file, resentFile: `${file}.resent`, at,
      ageMs: Math.max(0, Date.now() - at),
      from: rec && typeof rec.from === 'string' ? rec.from.slice(0, 40) : null,
      resent: readResent(`${file}.resent`),
    });
  }
  return { exists: true, messages: messages.sort((a, b) => a.at - b.at) };
}

// All .resent marks, including messages answered since: they give the "last resend" line.
export function scanResent(inbox, now = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(inbox); } catch { return { total: 0, recent: 0, lastAt: null, lastReason: null, lastId: null, lastVia: null }; }
  let total = 0, recent = 0, lastAt = null, lastReason = null, lastId = null, lastVia = null;
  for (const name of names) {
    if (!RESENT_RE.test(name) || !isFile(path.join(inbox, name))) continue;
    const r = readResent(path.join(inbox, name));
    if (!r) continue;
    const at = r.at ? Date.parse(r.at) : NaN;
    total += r.count;
    if (Number.isFinite(at) && now - at <= RECENT_MS) recent += r.count;
    if (Number.isFinite(at) && (!lastAt || at > lastAt)) { lastAt = at; lastReason = r.reason; lastId = Number(RESENT_RE.exec(name)[1]); lastVia = r.via; }
  }
  return { total, recent, lastAt, lastReason, lastId, lastVia };
}

export function buildNudge(message, count, cfg) {
  const id = message.id;
  const idx = Math.min(Math.max(0, count - 1), cfg.backoffMs.length - 1);
  const nextMin = count ? Math.round(cfg.backoffMs[idx] / 60e3) : Math.round(cfg.thresholdMs / 60e3);
  const text = `[AgentGlim] Unanswered chat ${id} (resend ${count}). Read _run/chat_inbox/${id}.json, act, then answer with `
    + `_run/bin/chat-write.mjs --reply "..." --to ${id}. Same message, not new work. `
    + `If the waiter is not armed, re-arm _run/bin/auditq-wait.sh. Next resend in ${nextMin} min.`;
  return text.slice(0, MAX_NUDGE);
}

// ---- session identity (never guessed): <data>/inbox-session.json -> pid + procStart + tmux pane ----------
export function readSession(file) {
  const s = readJson(file);
  if (!s || typeof s !== 'object') return null;
  return {
    pid: Number(s.pid) || null,
    procStart: s.procStart == null ? null : String(s.procStart),
    sessionId: typeof s.sessionId === 'string' ? s.sessionId : null,
    name: typeof s.name === 'string' ? s.name.slice(0, 80) : null,
    cwd: typeof s.cwd === 'string' ? s.cwd : null,
    tmux: typeof s.tmux === 'string' ? s.tmux : null,
    socket: typeof s.socket === 'string' ? s.socket : null,
    at: typeof s.at === 'string' ? s.at : null,
    disabled: s.disabled === true,
  };
}

export function sessionFileFor(env = process.env, roots = {}) {
  return resendConfig(env, roots).sessionFile;
}

export function validateSession(session, { proc, plans = PLANS } = {}) {
  if (!session) return { ok: false, live: false, reason: 'no session registered' };
  if (session.disabled) return { ok: false, live: false, reason: 'session registration is off' };
  if (!session.pid) return { ok: false, live: false, reason: 'session file has no pid' };
  const st = proc?.stat?.(session.pid);
  if (!st) return { ok: false, live: false, reason: 'registered session is not running' };
  if (session.procStart && String(st.starttime) !== String(session.procStart)) return { ok: false, live: true, reason: 'pid was reused by another process' };
  const cwd = proc.cwd(session.pid);
  if (!cwd) return { ok: false, live: true, reason: 'cannot read the session working folder' };
  if (!under(cwd, plans)) return { ok: false, live: true, reason: 'registered session is not in the plans folder' };
  return { ok: true, live: true, reason: null };
}

export function identityStatus(session, opts = {}) {
  const check = validateSession(session, opts);
  return {
    registered: !!session,
    ok: check.ok,
    live: check.live,
    pane: session?.tmux || null,
    name: session?.name || null,
    sessionId: session?.sessionId || null,
    pid: session?.pid || null,
    registeredAt: session?.at || null,
    reason: check.reason,
  };
}

// The pane recorded in the session file must still belong to that process; otherwise no keystroke is sent.
export function paneFor(session, { proc, tmux } = {}) {
  const target = String(session?.tmux || '');
  const paneId = target.split('.').pop();
  if (!/^%\d+$/.test(paneId)) return { ok: false, reason: 'session file has no tmux pane' };
  if (!tmux?.listPanes || !tmux?.paste) return { ok: false, reason: 'tmux is not available' };
  return { ok: true, paneId };
}

export async function verifiedPane(session, { proc, tmux } = {}) {
  const base = paneFor(session, { proc, tmux });
  if (!base.ok) return base;
  let panes = [];
  try { panes = await tmux.listPanes(); } catch (e) { return { ok: false, reason: `tmux list failed: ${e.message || e}` }; }
  const pane = panes.find((p) => p.id === base.paneId);
  if (!pane) return { ok: false, reason: 'the recorded tmux pane is gone' };
  if (!(pane.pid === session.pid || proc?.isAncestor?.(pane.pid, session.pid))) return { ok: false, reason: 'the tmux pane belongs to another process' };
  if (!/claude/i.test(String(pane.cmd || ''))) return { ok: false, reason: 'the tmux pane is not running Claude Code' };
  return { ok: true, paneId: base.paneId, pane };
}

function writeResent(file, rec) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp`);
  const body = JSON.stringify(rec) + '\n';
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function acquireLock(file, now) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { return false; }
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }) + '\n');
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      let st; try { st = fs.statSync(file); } catch { continue; }
      if (now - st.mtimeMs > 120e3) { try { fs.unlinkSync(file); } catch {} continue; }
      return false;
    }
  }
  return false;
}

export function makeInboxResend({
  env = process.env, config = null, roots = {}, now = () => Date.now(),
  proc = null, tmux = null, session = null,
} = {}) {
  const cfg = { ...resendConfig(env, roots), ...(config || {}) };
  const pr = proc || makeProc();
  const tm = tmux || makeTmux({});
  const loadSession = () => (session !== null ? session : readSession(cfg.sessionFile));
  let cache = { at: 0, status: null };

  function status({ fresh = false } = {}) {
    const t = now();
    if (!fresh && cache.status && t - cache.at < 1500) return cache.status;
    const scan = scanInbox(cfg.inbox);
    const history = scanResent(cfg.inbox, now());
    const sess = loadSession();
    const identity = identityStatus(sess, { proc: pr, plans: cfg.plans });
    const messages = scan.messages.map((m) => {
      const d = dueState(m, cfg, t);
      return { id: m.id, from: m.from, at: m.at, ageSec: Math.round(d.ageMs / 1000), resends: m.resent?.count || 0,
        lastResentAt: m.resent?.at ? Date.parse(m.resent.at) || null : null, dueAt: d.dueAt, dueInSec: Math.max(0, Math.round((d.dueAt - t) / 1000)),
        stale: !!d.stale, due: !!d.due };
    });
    const pendingResends = messages.reduce((n, m) => n + m.resends, 0);
    const out = {
      inboxExists: scan.exists,
      enabled: cfg.enabled,
      sending: cfg.enabled && !cfg.dev,
      tmux: cfg.tmux,
      dev: cfg.dev,
      thresholdSecs: Math.round(cfg.thresholdMs / 1000),
      backoffMinutes: BACKOFF_MINUTES,
      maxAgeHours: Math.round(cfg.maxAgeMs / 3600e3),
      pending: messages.length,
      pendingResends,
      totalResends: history.total,
      recentResends: history.recent,
      lastAt: history.lastAt,
      lastReason: history.lastReason,
      lastId: history.lastId,
      lastVia: history.lastVia,
      identity,
      messages,
      checkedAt: t,
    };
    cache = { at: t, status: out };
    return out;
  }

  // One resend for one pending message. Always touches the wake file; the tmux nudge is best effort.
  async function resendOne(message, t) {
    const prev = message.resent;
    const count = (prev?.count || 0) + 1;
    const ageSec = Math.max(0, Math.round((t - message.at) / 1000));
    const result = { id: message.id, count, at: new Date(t).toISOString(), reason: `auto-resent: unanswered after ${ageSec}s`, via: 'wake', delivered: false, session: null, error: null };
    try {
      const sec = t / 1000;
      fs.utimesSync(message.file, sec, sec); // the wake file itself: no content change, never a new message
      result.delivered = true;
    } catch (e) { result.error = `wake touch failed: ${e.message || e}`; }

    const sess = loadSession();
    const check = validateSession(sess, { proc: pr, plans: cfg.plans });
    if (cfg.tmux && check.ok) {
      result.session = sess.name || sess.sessionId || `pid ${sess.pid}`;
      const pane = await verifiedPane(sess, { proc: pr, tmux: tm });
      if (pane.ok) {
        try {
          await tm.paste(pane.paneId, buildNudge(message, count, cfg));
          result.via = 'wake+tmux';
        } catch (e) { result.error = `${result.error ? result.error + '; ' : ''}tmux nudge failed: ${e.message || e}`; }
      } else {
        result.error = `${result.error ? result.error + '; ' : ''}${pane.reason}`;
      }
    } else if (cfg.tmux && !check.ok && check.reason !== 'no session registered') {
      result.error = `${result.error ? result.error + '; ' : ''}${check.reason}`;
    }
    writeResent(message.resentFile, result);
    return result;
  }

  async function runOnce() {
    const t = now();
    const scan = scanInbox(cfg.inbox);
    const out = { ran: false, reason: null, checkedAt: t, pending: scan.messages.length, resends: [], skipped: 0, locked: false };
    if (!cfg.enabled) { out.reason = 'disabled'; return out; }
    if (cfg.dev) { out.reason = 'dev copy: sending is off'; return out; }
    if (!scan.exists) { out.reason = 'no chat_inbox'; return out; }
    const due = scan.messages.filter((m) => { const d = dueState(m, cfg, t); return d.due && !d.stale; });
    out.skipped = scan.messages.length - due.length;
    if (!due.length) { out.reason = 'nothing due'; return out; }
    if (!acquireLock(cfg.lockFile, t)) { out.locked = true; out.reason = 'another check is running'; return out; }
    out.ran = true;
    try {
      for (const m of due) {
        try { out.resends.push(await resendOne(m, t)); } catch (e) { out.resends.push({ id: m.id, error: String(e.message || e) }); }
      }
    } finally {
      try { fs.unlinkSync(cfg.lockFile); } catch {}
    }
    cache = { at: 0, status: null };
    return out;
  }

  return { config: cfg, status, runOnce, identity: () => identityStatus(loadSession(), { proc: pr, plans: cfg.plans }) };
}

// Shared instance for the server: status is cached for 1.5 s, runOnce is lock-guarded.
let shared = null;
export function sharedInboxResend() {
  if (!shared) shared = makeInboxResend();
  return shared;
}
export function inboxResendStatus(opts) {
  return (opts ? makeInboxResend(opts) : sharedInboxResend()).status();
}
export function runInboxResendOnce() {
  return sharedInboxResend().runOnce();
}

// Called once by server.mjs after it binds. Never starts in the dev copy.
export function startInboxResend({ dev = process.env.AGENTGLIM_DEV === '1', everyMs = CHECK_EVERY_MS } = {}) {
  if (dev) return { started: false, reason: 'dev copy' };
  registerJob('inbox-resend', everyMs, () => runInboxResendOnce(), { catchUp: false });
  startJobs();
  return { started: true, everyMs };
}

// ---- CLI ---------------------------------------------------------------------------------------------------
// Walk our own parent chain to the nearest claude process. Explicit --pid is the only other source: this is
// identity from the process tree plus Claude's own session registry, never a guess among other sessions.
export function findClaudeAncestor(proc, startPid = process.pid) {
  let pid = Number(startPid), n = 0;
  while (pid > 1 && n++ < 32) {
    const st = proc.stat(pid);
    if (!st) return null;
    if (st.comm === 'claude' || /(^|\/)claude$/.test(path.basename(proc.cmdline?.(pid)?.[0] || ''))) return pid;
    pid = st.ppid;
  }
  return null;
}

export function sessionRecord(pid, { proc, claudeHome = process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude') } = {}) {
  const st = proc.stat(pid);
  if (!st) return { error: `pid ${pid} is not running` };
  const file = path.join(claudeHome, 'sessions', `${pid}.json`);
  const rec = readJson(file);
  if (!rec) return { error: `no Claude session registry record at ${file}; run register from inside the headed session` };
  if (Number(rec.pid) !== Number(pid)) return { error: `session registry pid ${rec.pid} does not match ${pid}` };
  if (rec.kind && rec.kind !== 'interactive') return { error: `session ${pid} is ${rec.kind}, not interactive` };
  const cwd = rec.cwd || proc.cwd(pid);
  if (!cwd) return { error: `cannot read the working folder of pid ${pid}` };
  return { pid, procStart: String(st.starttime), sessionId: rec.sessionId || null, name: rec.name || null, cwd,
    tmux: rec.tmux || null, socket: rec.messagingSocketPath || null };
}

export function registerSession({ pid = null, name = null, env = process.env, roots = {}, proc = null, claudeHome } = {}) {
  const cfg = resendConfig(env, roots);
  const pr = proc || makeProc();
  const target = Number(pid) || findClaudeAncestor(pr);
  if (!target) return { ok: false, error: 'no headed Claude Code process in the parent chain; pass --pid <session pid>' };
  const rec = sessionRecord(target, { proc: pr, claudeHome });
  if (rec.error) return { ok: false, error: rec.error };
  if (rec.cwd && !under(rec.cwd, cfg.plans)) return { ok: false, error: `session ${target} works in ${rec.cwd}, not under the plans folder ${cfg.plans}` };
  const out = { ...rec, name: name || rec.name, at: new Date().toISOString(), source: 'agentglim inbox-resend register' };
  fs.mkdirSync(path.dirname(cfg.sessionFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(cfg.sessionFile, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
  return { ok: true, file: cfg.sessionFile, session: out };
}

function cli() {
  const a = process.argv.slice(2), opt = {};
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) { opt.cmd = a[i]; continue; }
    const k = a[i].slice(2);
    if (k === 'json') { opt.json = true; continue; }
    const v = a[i + 1];
    if (v === undefined || v.startsWith('--')) { console.error(`--${k} needs a value`); process.exit(2); }
    i++; opt[k] = v;
  }
  const cmd = opt.cmd || 'status';
  const cfg = resendConfig();
  if (cmd === 'run-once') {
    runInboxResendOnce().then((r) => {
      if (opt.json) console.log(JSON.stringify(r, null, 2));
      else console.log(`inbox resend: ${r.ran ? `${r.resends.length} sent` : `no send (${r.reason})`}${r.resends.map((x) => `\n  ${x.id} #${x.count} ${x.via}${x.error ? ` (${x.error})` : ''}`).join('')}`);
      process.exit(0);
    }).catch((e) => { console.error('inbox resend failed:', e.message || e); process.exit(1); });
    return;
  }
  if (cmd === 'register') {
    const r = registerSession({ pid: opt.pid, name: opt.name });
    if (!r.ok) { console.error(`register failed: ${r.error}`); process.exit(1); }
    console.log(`registered headed session ${r.session.name || r.session.sessionId || r.session.pid} (pid ${r.session.pid}, pane ${r.session.tmux || 'none'}) in ${r.file}`);
    return;
  }
  if (cmd === 'status') {
    const s = inboxResendStatus();
    if (opt.json) { console.log(JSON.stringify(s, null, 2)); return; }
    console.log(`inbox ${s.inboxExists ? cfg.inbox : `${cfg.inbox} (missing)`}`);
    console.log(`sending ${s.sending ? 'on' : s.enabled ? 'off' : 'off'}${s.dev ? ' (dev copy)' : ''} · first resend after ${s.thresholdSecs}s · backoff ${s.backoffMinutes.join('/')} min · stop after ${s.maxAgeHours}h`);
    console.log(`${s.pending} unanswered · ${s.pendingResends} resends on them · ${s.recentResends} in 24h · last ${s.lastAt ? new Date(s.lastAt).toISOString() : 'never'}${s.lastReason ? ` (${s.lastReason})` : ''}`);
    console.log(s.identity.ok ? `session ${s.identity.name || s.identity.sessionId} (pid ${s.identity.pid})${s.identity.pane ? ` pane ${s.identity.pane}` : ''}`
      : `session not usable: ${s.identity.reason}`);
    for (const m of s.messages) console.log(`  ${m.id}: ${m.ageSec}s old, ${m.resends} resends, ${m.stale ? 'stale (no more resends)' : m.due ? 'due now' : `next in ${m.dueInSec}s`}`);
    return;
  }
  console.error('usage: node app/inbox-resend.mjs run-once | status | register [--pid N] [--name NAME] [--json]');
  process.exit(2);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
