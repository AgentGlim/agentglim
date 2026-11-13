// send-to-agent.mjs: "Send to agent" for Approvals. Delivers the owner's answer straight to the agent that asked.
//
// The adapter is picked from the request's source ({kind, session?}):
//   plans  -> the harness chat inbox: <inbox>/<ms>.json, the file the waiter watches (chat-write.mjs pattern).
//             read = the waiter renamed it to <ms>.json.answered (or wrote <ms>.json.read).
//   claude -> a session inbox file <data>/session-inbox/<session>.ndjson, read by the hook below on the next
//             UserPromptSubmit/Stop of a running session; when the session is idle, `claude --resume <id> -p TEXT`.
//             read = the hook appended the delivery id to <session>.read.
//   codex  -> `codex exec resume <id> -` with the text on stdin.
//   other  -> no adapter: the UI falls back to Copy.
// Every send has a delivery id = sha256(adapter, target, text). The id is recorded before and after each attempt
// in <data>/send-to-agent/<id>.json, and each adapter checks its own target for the id first, so a retry or a
// second click never delivers the same text twice. One retry, then state "failed" with fallback "copy" and the reason.
//
// Hook (Claude Code settings.json, UserPromptSubmit and Stop):  node app/send-to-agent.mjs hook
// Install it with:  node app/send-to-agent.mjs install-hooks [--claude] [--codex] [--dry-run]  (see send-to-agent-install.mjs)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MAX_TEXT = 16 * 1024;
const ID_RE = /^[\w-]{6,80}$/;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.tmp${process.pid}`; fs.writeFileSync(t, JSON.stringify(v) + '\n', { mode: 0o600 }); fs.renameSync(t, f); };
const lines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } };

export function deliveryId(adapter, target, text) {
  return crypto.createHash('sha256').update(`${adapter}\0${target || ''}\0${text}`).digest('hex').slice(0, 24);
}

export function pickAdapter(source) {
  const k = String(source?.kind || '').toLowerCase();
  if (k === 'plans' || k === 'harness' || k === 'superagent') return 'plans';
  if ((k === 'claude' || k === 'claude-code') && ID_RE.test(String(source.session || ''))) return 'claude';
  if (k === 'codex' && ID_RE.test(String(source.session || ''))) return 'codex';
  return 'copy';
}

// run(cmd, args, input) -> Promise<{code, out}>; tests pass a fake.
export function runProcess(cmd, args, input, timeoutMs = 120e3) {
  return new Promise((resolve) => {
    let out = '', done = false;
    let c; try { c = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return resolve({ code: -1, out: String(e.message) }); }
    const fin = (r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    const t = setTimeout(() => { try { c.kill(); } catch {} fin({ code: -1, out: 'timed out' }); }, timeoutMs);
    c.on('error', (e) => fin({ code: -1, out: e.code === 'ENOENT' ? `${cmd} is not installed` : String(e.message) }));
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => fin({ code, out }));
    c.stdin.on('error', () => {}); c.stdin.end(input || '');
  });
}

// ---------- adapters: each has find(id) -> 'delivered'|'read'|null and send(id, text) -> throws on failure ----------
function plansAdapter(cfg) {
  const inbox = cfg.inbox;
  const all = () => { try { return fs.readdirSync(inbox); } catch { return []; } };
  return {
    target: 'inbox',
    find(id) {
      for (const f of all()) {
        const m = /^(\d{10,16})\.json(\.answered|\.read)?$/.exec(f); if (!m) continue;
        if (readJson(path.join(inbox, f))?.deliveryId !== id) continue;
        if (m[2] || fs.existsSync(path.join(inbox, `${m[1]}.json.read`))) return 'read';
        return 'delivered';
      }
      return null;
    },
    send(id, text) {
      if (!fs.existsSync(inbox)) throw new Error('no harness inbox on this machine');
      let ms = Date.now();
      while (fs.existsSync(path.join(inbox, `${ms}.json`)) || fs.existsSync(path.join(inbox, `${ms}.json.answered`))) ms++;
      writeJson(path.join(inbox, `${ms}.json`), { at: new Date().toISOString(), from: 'approvals', text, deliveryId: id });
    },
  };
}

export function sessionInboxDir(data) { return path.join(data, 'session-inbox'); }

function claudeAdapter(cfg, session) {
  const dir = sessionInboxDir(cfg.data), box = path.join(dir, `${session}.ndjson`), readF = path.join(dir, `${session}.read`);
  return {
    target: session,
    find(id) {
      if (lines(readF).includes(id)) return 'read';
      if (lines(box).some((l) => { try { return JSON.parse(l).deliveryId === id; } catch { return false; } })) return 'delivered';
      const resumed = lines(path.join(dir, `${session}.resumed`));
      return resumed.includes(id) ? 'read' : null;
    },
    async send(id, text) {
      const st = await cfg.claudeState(session); // 'running' | 'idle' | 'gone'
      if (st === 'gone') throw new Error('Claude Code session not found (closed or deleted)');
      if (st === 'running') {
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(box, JSON.stringify({ at: new Date().toISOString(), deliveryId: id, text }) + '\n', { mode: 0o600 });
        return;
      }
      const r = await cfg.run(cfg.claudeBin, ['--resume', session, ...(cfg.claudeArgs || []), '-p', text], '');
      if (r.code !== 0) throw new Error(`claude --resume failed: ${String(r.out).trim().slice(0, 160) || 'exit ' + r.code}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, `${session}.resumed`), id + '\n');
    },
  };
}

function codexAdapter(cfg, session) {
  const log = path.join(cfg.data, 'send-to-agent', 'codex-sent.ndjson');
  return {
    target: session,
    find(id) { return lines(log).some((l) => { try { return JSON.parse(l).deliveryId === id; } catch { return false; } }) ? 'read' : null; },
    async send(id, text) {
      if (!(await cfg.codexState(session))) throw new Error('Codex session not found (closed or deleted)');
      const r = await cfg.run(cfg.codexBin, ['exec', 'resume', ...(cfg.codexArgs || []), session, '-'], text);
      if (r.code !== 0) throw new Error(`codex exec resume failed: ${String(r.out).trim().slice(0, 160) || 'exit ' + r.code}`);
      fs.mkdirSync(path.dirname(log), { recursive: true });
      fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), deliveryId: id, session }) + '\n');
    },
  };
}

// default session checks: Claude Code transcripts under <claudeHome>/projects, live pids in <claudeHome>/sessions
function defaultClaudeState(claudeHome) {
  return (session) => {
    let live = false;
    try {
      for (const f of fs.readdirSync(path.join(claudeHome, 'sessions'))) {
        const j = readJson(path.join(claudeHome, 'sessions', f));
        if (j?.sessionId === session && j.pid) { try { process.kill(j.pid, 0); live = true; } catch {} }
      }
    } catch {}
    if (live) return 'running';
    let found = false;
    try { found = fs.readdirSync(path.join(claudeHome, 'projects')).some((d) => fs.existsSync(path.join(claudeHome, 'projects', d, `${session}.jsonl`))); } catch {}
    return found ? 'idle' : 'gone';
  };
}
function defaultCodexState(codexHome) {
  return (session) => {
    const walk = (d, depth) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return false; }
      return es.some((e) => e.isDirectory() ? depth < 4 && walk(path.join(d, e.name), depth + 1) : e.name.includes(session) && e.name.endsWith('.jsonl')); };
    return walk(path.join(codexHome, 'sessions'), 0);
  };
}

const jsonArgs = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };

export function sendConfig(env = process.env, o = {}) {
  const home = env.HOME || env.USERPROFILE || '';
  const data = o.data || env.AGENTGLIM_DATA || path.join(home, '.agentglim');
  const plans = o.plans || env.AGENTGLIM_PLANS || '';
  const run = o.run || env.AGENTGLIM_RUN || (plans ? path.join(plans, '_run') : '');
  const claudeHome = o.claudeHome || env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const codexHome = o.codexHome || env.CODEX_HOME || path.join(home, '.codex');
  return {
    data, inbox: o.inbox || env.AGENTGLIM_CHAT_INBOX || env.CHAT_INBOX || (run ? path.join(run, 'chat_inbox') : ''),
    run: o.run_ || o.runner || runProcess,
    claudeBin: o.claudeBin || 'claude', codexBin: o.codexBin || 'codex',
    // extra CLI args for the resume calls, e.g. AGENTGLIM_SEND_CLAUDE_ARGS='["--model","haiku"]'
    claudeArgs: o.claudeArgs || jsonArgs(env.AGENTGLIM_SEND_CLAUDE_ARGS), codexArgs: o.codexArgs || jsonArgs(env.AGENTGLIM_SEND_CODEX_ARGS),
    claudeState: o.claudeState || defaultClaudeState(claudeHome),
    codexState: o.codexState || defaultCodexState(codexHome),
  };
}

function adapterFor(cfg, kind, source) {
  if (kind === 'plans') return plansAdapter(cfg);
  if (kind === 'claude') return claudeAdapter(cfg, String(source.session));
  if (kind === 'codex') return codexAdapter(cfg, String(source.session));
  return null;
}
const recFile = (cfg, id) => path.join(cfg.data, 'send-to-agent', `${id}.json`);

// send({text, source}) -> {id, adapter, state: delivered|read|failed|copy, attempts, reason?, fallback?}
export async function sendToAgent({ text, source }, cfg = sendConfig()) {
  text = String(text ?? '');
  if (!text.trim()) return { state: 'failed', fallback: 'copy', reason: 'nothing to send', attempts: 0 };
  if (text.length > MAX_TEXT) return { state: 'failed', fallback: 'copy', reason: 'text is over 16 KB', attempts: 0 };
  const kind = pickAdapter(source);
  const ad = adapterFor(cfg, kind, source || {});
  if (!ad) return { adapter: 'copy', state: 'copy', fallback: 'copy', reason: 'this agent has no send adapter: copy works anywhere', attempts: 0 };
  const id = deliveryId(kind, ad.target, text), f = recFile(cfg, id);
  const prev = readJson(f);
  const seen = ad.find(id);
  if (seen) { const r = { ...(prev || {}), id, adapter: kind, state: seen, attempts: prev?.attempts || 1 }; delete r.reason; delete r.fallback; writeJson(f, r); return r; }
  let attempts = 0, reason = '';
  while (attempts < 2) {
    attempts++;
    writeJson(f, { id, adapter: kind, target: ad.target, state: 'sending', attempts, at: new Date().toISOString() });
    try {
      // the target may hold the text from an attempt that threw after writing: check before each try
      if (attempts > 1 && ad.find(id)) break;
      await ad.send(id, text);
      break;
    } catch (e) { reason = String(e.message || e); if (attempts >= 2) { const r = { id, adapter: kind, state: 'failed', fallback: 'copy', reason, attempts, at: new Date().toISOString() }; writeJson(f, r); return r; } }
  }
  const r = { id, adapter: kind, target: ad.target, state: ad.find(id) || 'delivered', attempts, at: new Date().toISOString() };
  writeJson(f, r);
  return r;
}

// status(id): re-reads the target so "delivered" becomes "read" once the agent has picked it up
export function sendStatus(id, sourceOrNull, cfg = sendConfig()) {
  if (!/^[0-9a-f]{24}$/.test(String(id))) return null;
  const rec = readJson(recFile(cfg, id)); if (!rec) return null;
  if (rec.state === 'delivered' && sourceOrNull) {
    const ad = adapterFor(cfg, rec.adapter, sourceOrNull);
    const s = ad?.find(id); if (s && s !== rec.state) { rec.state = s; writeJson(recFile(cfg, id), rec); }
  } else if (rec.state === 'delivered' && rec.adapter === 'plans') {
    const s = plansAdapter(cfg).find(id); if (s) { rec.state = s; writeJson(recFile(cfg, id), rec); }
  } else if (rec.state === 'delivered' && rec.adapter === 'claude' && rec.target) {
    const s = claudeAdapter(cfg, rec.target).find(id); if (s) { rec.state = s; writeJson(recFile(cfg, id), rec); }
  }
  return rec;
}

// Claude Code hook: hands pending inbox lines to the session once, then records them as read.
export function runHook(input, cfg = sendConfig()) {
  let h = {}; try { h = JSON.parse(input || '{}'); } catch {}
  const session = String(h.session_id || ''); if (!ID_RE.test(session)) return '';
  const dir = sessionInboxDir(cfg.data), box = path.join(dir, `${session}.ndjson`), readF = path.join(dir, `${session}.read`);
  const done = new Set(lines(readF));
  const fresh = lines(box).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((m) => m && m.deliveryId && !done.has(m.deliveryId));
  const uniq = [...new Map(fresh.map((m) => [m.deliveryId, m])).values()];
  if (!uniq.length) return '';
  fs.appendFileSync(readF, uniq.map((m) => m.deliveryId).join('\n') + '\n');
  const text = `The owner answered from AgentGlim Approvals:\n\n${uniq.map((m) => m.text).join('\n\n')}`;
  if (h.hook_event_name === 'Stop') return JSON.stringify({ decision: 'block', reason: text });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } });
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain && (process.argv[2] === 'install-hooks' || process.argv[2] === 'uninstall-hooks')) {
  const { runInstall } = await import('./send-to-agent-install.mjs');
  const res = runInstall(process.argv.slice(2));
  for (const r of res) console.log(r.msg);
  if (res.some((r) => !r.ok)) process.exitCode = 1;
}
if (isMain && process.argv[2] === 'hook') {
  let input = ''; process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => { try { const o = runHook(input); if (o) process.stdout.write(o); } catch {} });
}
