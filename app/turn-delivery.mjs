// turn-delivery.mjs: the server owns the SuperAgent queue for turn-based harnesses (v0.2.17).
//
// Codex, Pi and OpenCode chats cannot hold the 50-minute listener (auditq-wait.sh) between turns, so a dashboard
// request would wait for the 5-minute auto-answer. Instead the SuperAgent registers its session once, and the server
// delivers each pending request (status_ask, chat_inbox, owner_check) as one resumed turn through the send-to-agent
// adapters: `codex exec resume <id> -`, `claude --resume <id> -p`, `pi --session <id> -p`, `opencode run --session <id>`.
// The agent answers with the same tools as the listener path (status-write.mjs, chat-write.mjs, owner-check.mjs).
//
// The listener path is unchanged: while auditq-wait.sh has beaten in the last 10 minutes, nothing is delivered here.
//
//   node app/turn-delivery.mjs register --harness codex|claude|pi|opencode --session <id|auto> [--cwd DIR]
//        auto (Codex only): the one interactive Codex session of this user whose cwd is DIR (default: the current
//        folder); refused when none or several match. The chosen session is printed. Pi: start pi with --session-id.
//        The cwd is recorded and every resumed turn runs there (Claude, Pi and OpenCode look sessions up per folder).
//   node app/turn-delivery.mjs unregister | status | once
// State: <data>/superagent-session.json (the registration) and <data>/turn-delivery/state.json (per request:
// delivered at, attempts, answered at, failed at; consecutive failures and the next retry time).
//
// Delivered is not answered. A request counts as answered only when its queue file is consumed (status-write.mjs,
// chat-write.mjs, owner-check.mjs). A delivered request still pending after ANSWER_WAIT_MS is delivered once more,
// then marked failed. turnArmed() is healthy only after a real answered round trip since registration.
// Failed deliveries back off exponentially (2, 4, 8, 16 min) and stop after MAX_FAILS until the session is registered
// again. Each turn carries at most MAX_BATCH characters; long chat texts are passed by file reference.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendToAgent, sendConfig, runProcess, MAX_TEXT } from './send-to-agent.mjs';

export const TURN_HARNESSES = ['codex', 'claude', 'pi', 'opencode'];
export const LISTENER_FRESH_MS = 10 * 60e3;
export const RETRY_MS = 2 * 60e3;
export const MAX_FAILS = 5;
export const ANSWER_WAIT_MS = 10 * 60e3;
export const TURN_TIMEOUT_MS = 15 * 60e3;
export const MAX_BATCH = 12000; // under send-to-agent's 16 KB limit, with room for the re-delivery line
export const INLINE_CHAT = 1500;
const QUEUES = ['status_ask', 'chat_inbox', 'owner_check'];
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.tmp${process.pid}`; fs.writeFileSync(t, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(t, f); };
const q = (s) => /^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;

export const sessionFile = (data) => path.join(data, 'superagent-session.json');
const stateFile = (data) => path.join(data, 'turn-delivery', 'state.json');
export const readSession = (data) => { const s = readJson(sessionFile(data)); return s && TURN_HARNESSES.includes(s.harness) && /^[\w-]{6,80}$/.test(String(s.session || '')) ? s : null; };
const freshState = (registeredAt = null) => ({ registeredAt, items: {}, fails: 0, nextAt: null, stopped: false, lastAnsweredAt: null, lastUnansweredAt: null, last: null });
export function readState(data) {
  const st = readJson(stateFile(data));
  if (!st) return freshState();
  if (!st.items) { // v0.2.16 WIP state: {delivered: [...], last}
    const at = Date.parse(st.last?.at) || 0, items = {};
    for (const k of st.delivered || []) items[k] = { deliveredAt: at, attempts: 1 };
    return { ...freshState(), items, last: st.last || null };
  }
  return { ...freshState(), ...st };
}

// ---------- Codex --session auto ----------
function sessionMeta(file) {
  try {
    const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(65536), n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    const j = JSON.parse(buf.subarray(0, n).toString('utf8').split('\n')[0]);
    return j.payload || j;
  } catch { return null; }
}
const samePath = (a, b) => { try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return path.resolve(a) === path.resolve(b); } };
// all Codex rollouts of this user: {id, file, t, cwd, source}
export function codexSessions(codexHome) {
  const out = [], uid = process.getuid?.();
  const walk = (d, depth) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const f = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 4) walk(f, depth + 1); continue; }
      const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(e.name); if (!m) continue;
      const st = fs.statSync(f); if (uid != null && st.uid !== uid) continue; // ownership: only this user's sessions
      const meta = sessionMeta(f) || {};
      out.push({ id: m[1], file: f, t: st.mtimeMs, cwd: meta.cwd || null, source: typeof meta.source === 'string' ? meta.source : meta.originator || null }); } };
  walk(path.join(codexHome, 'sessions'), 0);
  return out.sort((a, b) => b.t - a.t);
}
// the one interactive session in cwd; throws on none or several (never guesses)
export function pickCodexSession(codexHome, cwd) {
  const all = codexSessions(codexHome);
  const mine = all.filter((s) => s.cwd && samePath(s.cwd, cwd) && !/exec/i.test(String(s.source || '')));
  if (!mine.length) throw new Error(`no interactive Codex session with cwd ${cwd} under ${path.join(codexHome, 'sessions')} (${all.length} other sessions); run register from the SuperAgent's folder, pass --cwd, or pass the session id`);
  if (mine.length > 1) throw new Error(`${mine.length} Codex sessions have cwd ${cwd}: ${mine.slice(0, 5).map((s) => `${s.id} (${new Date(s.t).toISOString()})`).join(', ')}; pass --session <id> (your session id is shown by /status in Codex)`);
  return mine[0];
}
export function newestCodexSession(codexHome) { return codexSessions(codexHome)[0]?.id || null; }

export function register({ data, harness, session, cwd = process.cwd(), env = process.env }) {
  if (!TURN_HARNESSES.includes(harness)) throw new Error(`--harness must be one of ${TURN_HARNESSES.join(', ')}`);
  cwd = path.resolve(cwd);
  let picked = null;
  if (session === 'auto') {
    if (harness !== 'codex') throw new Error('--session auto works for Codex only; pass the session id');
    picked = pickCodexSession(env.CODEX_HOME || path.join(env.HOME || env.USERPROFILE || '', '.codex'), cwd);
    session = picked.id;
  }
  if (!/^[\w-]{6,80}$/.test(String(session || ''))) throw new Error('--session must be a session id (6-80 letters, digits, - or _)');
  const rec = { harness, session, cwd, registeredAt: new Date().toISOString(), ...(picked ? { picked: { file: picked.file, modified: new Date(picked.t).toISOString() } } : {}) };
  writeJson(sessionFile(data), rec);
  const old = stateFile(data); if (fs.existsSync(old)) fs.renameSync(old, `${old}.prev-${Date.now()}`); // a new registration starts clean (clears a stop)
  writeJson(old, freshState(rec.registeredAt));
  return rec;
}
export function unregister({ data }) {
  const f = sessionFile(data);
  if (fs.existsSync(f)) fs.renameSync(f, `${f}.off-${Date.now()}`); // kept, never deleted
}

const listenerFresh = (run, now) => { try { return now - fs.statSync(path.join(run, 'heartbeats', 'auditq-wait')).mtimeMs < LISTENER_FRESH_MS; } catch { return false; } };
export function pending(run) {
  const out = [];
  for (const dir of QUEUES) {
    let names = []; try { names = fs.readdirSync(path.join(run, dir)); } catch {}
    for (const n of names.filter((x) => /^\d{10,16}\.json$/.test(x)).sort()) {
      if (dir === 'chat_inbox' && fs.existsSync(path.join(run, dir, `${n}.read`))) continue;
      out.push({ dir, name: n, body: readJson(path.join(run, dir, n)) || {} });
    }
  }
  return out;
}

// One message, same wording and tools as auditq-wait.sh. Short chat texts are inline; a long one is referenced by
// its inbox file, so nothing is truncated.
const HEAD = 'AgentGlim dashboard requests (delivered by the AgentGlim server; answer each with the tool named, then stop):';
function itemLine(i, run) {
  const tool = (n) => `node ${q(path.join(run, 'bin', n))}`, id = i.name.replace(/\.json$/, '');
  if (i.dir === 'status_ask') return `STATUS: ${i.name} (owner pressed Refresh: run ${tool('status-write.mjs')} --done "..." --running "..." --blocked "..." --next "..." --optimize "..." with your own words; it marks the ask answered)`;
  if (i.dir === 'owner_check') return `CHECK: ${i.name} (owner marked items done: run ${tool('owner-check.mjs')} list, verify each, then confirm <id> "evidence" or reopen <id> "what is missing")`;
  const t = String(i.body.text || '');
  const text = t.length > INLINE_CHAT ? `(${t.length} characters; read the "text" field of ${path.join(run, 'chat_inbox', i.name)})` : t;
  return `CHAT ${id}: ${text}\n  (reply: ${tool('chat-write.mjs')} --reply "..." --to ${id})`;
}
export function buildMessage(items, run, { note = '' } = {}) {
  return [HEAD, ...(note ? [note] : []), ...items.map((i) => itemLine(i, run))].join('\n');
}
// the first items that fit in maxChars (always at least one)
export function batch(items, run, maxChars = MAX_BATCH) {
  const out = []; let len = HEAD.length + 200;
  for (const i of items) { const l = itemLine(i, run).length + 1; if (out.length && len + l > maxChars) break; out.push(i); len += l; }
  return out;
}

let busy = false;
// deliverPending: one pass. Returns {state, ...}; never throws.
export async function deliverPending({ data, run, now = Date.now(), send = sendToAgent, cfg } = {}) {
  if (busy) return { state: 'busy' };
  const s = readSession(data);
  if (!s) return { state: 'off', reason: 'no turn-based session registered' };
  if (listenerFresh(run, now)) return { state: 'listener', reason: 'auditq-wait.sh is armed; it delivers instead' };
  let st = readState(data);
  if (st.registeredAt && st.registeredAt !== s.registeredAt) st = freshState(s.registeredAt);
  st.registeredAt = s.registeredAt;
  const iso = new Date(now).toISOString();
  const all = pending(run), open = new Set(all.map((i) => `${i.dir}/${i.name}`));
  // reconcile: a delivered request whose queue file is gone was answered
  let answered = 0;
  for (const [k, r] of Object.entries(st.items)) if (r.deliveredAt != null && !r.answeredAt && !r.failedAt && !open.has(k)) { r.answeredAt = iso; answered++; }
  if (answered) st.lastAnsweredAt = iso;
  const save = (res) => { const keys = Object.keys(st.items); if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete st.items[k]; writeJson(stateFile(data), st); return res; };
  if (st.stopped) return save({ state: 'stopped', reason: st.last?.reason || 'too many failed deliveries; register the session again' });
  if (st.nextAt && now < st.nextAt) return save({ state: 'waiting', reason: st.last?.reason });
  const todo = [], again = [], gaveUp = [];
  for (const i of all) {
    const k = `${i.dir}/${i.name}`, r = st.items[k];
    if (!r) todo.push(i);
    else if (r.failedAt || r.answeredAt) continue;
    else if (now - r.deliveredAt >= ANSWER_WAIT_MS) { if ((r.attempts || 1) < 2) again.push(i); else { r.failedAt = iso; r.reason = 'delivered twice, never answered'; gaveUp.push(k); } }
  }
  if (gaveUp.length) { st.lastUnansweredAt = iso; st.last = { at: iso, state: 'unanswered', items: gaveUp, harness: s.harness, reason: `no answer to ${gaveUp.join(', ')} after two deliveries` }; }
  const queue = [...again, ...todo];
  if (!queue.length) return save(gaveUp.length ? { state: 'unanswered', items: gaveUp, reason: st.last.reason } : { state: answered ? 'answered' : 'idle' });
  busy = true;
  try {
    const items = batch(queue, run);
    const note = items.some((i) => again.includes(i)) ? `(Re-delivery: some requests below were delivered ${Math.round(ANSWER_WAIT_MS / 60e3)} min ago and are still unanswered. Answer them with the tool named; if you cannot write or reach the dashboard, say why.)` : '';
    let text = buildMessage(items, run, { note });
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT - 1); // unreachable with batch(): kept as a hard guard
    const c = cfg || sendConfig(process.env, { data, run, run_: (cmd, args, input, o = {}) => runProcess(cmd, args, input, { ...o, timeoutMs: TURN_TIMEOUT_MS }) });
    let r; try { r = await send({ text, source: { kind: s.harness, session: s.session, cwd: s.cwd } }, c); } catch (e) { r = { state: 'failed', reason: String(e.message || e) }; }
    const ok = r.state === 'delivered' || r.state === 'read';
    const keys = items.map((i) => `${i.dir}/${i.name}`);
    if (ok) {
      for (const k of keys) { const p = st.items[k] || { attempts: 0 }; st.items[k] = { ...p, deliveredAt: now, attempts: (p.attempts || 0) + 1 }; }
      st.fails = 0; st.nextAt = null;
    } else {
      st.fails = (st.fails || 0) + 1;
      if (st.fails >= MAX_FAILS) st.stopped = true;
      else st.nextAt = now + RETRY_MS * 2 ** (st.fails - 1);
    }
    st.last = { at: iso, state: ok ? 'delivered' : 'failed', items: keys, harness: s.harness, ...(ok ? {} : { reason: `${r.reason || r.state}${st.stopped ? ` (stopped after ${MAX_FAILS} failures; register the session again)` : ''}` }) };
    return save({ state: st.stopped ? 'stopped' : st.last.state, items: keys, left: queue.length - items.length, reason: st.last.reason });
  } finally { busy = false; }
}

// For the header dot and doctor: healthy only after a real answered round trip since registration, with no failed or
// unanswered delivery after it. `verified:false` means registered but not yet proven (click Refresh).
export function turnArmed(data) {
  const s = readSession(data); if (!s) return null;
  const st = readState(data), last = st.last;
  const sameReg = !st.registeredAt || st.registeredAt === s.registeredAt;
  const answeredAt = sameReg && st.lastAnsweredAt ? Date.parse(st.lastAnsweredAt) : null;
  const unansweredAt = sameReg && st.lastUnansweredAt ? Date.parse(st.lastUnansweredAt) : null;
  const failing = sameReg && (st.stopped || (st.fails || 0) > 0);
  const ok = !!answeredAt && !failing && !(unansweredAt && unansweredAt > answeredAt);
  const reason = failing || (unansweredAt && (!answeredAt || unansweredAt > answeredAt)) ? last?.reason || 'delivery failing'
    : !answeredAt ? 'registered, no answered request yet: click Refresh in the dashboard and wait for the reply' : null;
  return { harness: s.harness, cwd: s.cwd || null, registeredAt: Date.parse(s.registeredAt) || null, ok, verified: !!answeredAt, stopped: !!(sameReg && st.stopped),
    answeredAt, lastAt: last ? Date.parse(last.at) : null, reason };
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const { DATA, RUN } = await import('./paths.mjs');
  const a = process.argv.slice(2), opt = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  try {
    if (a[0] === 'register') console.log(JSON.stringify(register({ data: DATA, harness: opt('--harness'), session: opt('--session'), cwd: opt('--cwd') || process.cwd() })));
    else if (a[0] === 'unregister') { unregister({ data: DATA }); console.log('unregistered'); }
    else if (a[0] === 'status') console.log(JSON.stringify({ session: readSession(DATA), state: readState(DATA).last, armed: turnArmed(DATA), pending: pending(RUN).map((i) => `${i.dir}/${i.name}`) }, null, 2));
    else if (a[0] === 'once') console.log(JSON.stringify(await deliverPending({ data: DATA, run: RUN })));
    else { console.error('usage: turn-delivery.mjs register --harness H --session ID|auto [--cwd DIR] | unregister | status | once'); process.exitCode = 2; }
  } catch (e) { console.error(`turn-delivery: ${e.message}`); process.exitCode = 1; }
}
