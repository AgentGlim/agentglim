// Codex rollouts: <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl (the file the process holds open, else the
// newest rollout whose session_meta.cwd is the session's cwd).
// Records used: session_meta, turn_context (model), response_item (message assistant, custom_tool_call,
// function_call, *_output), event_msg (user_message, task_complete). Reasoning is skipped (encrypted).
import fs from 'node:fs';
import path from 'node:path';
import { makeReader, toolBubble, oneLine } from './transcript.mjs';

const partsText = (c) => Array.isArray(c) ? c.map((x) => x?.text || '').filter(Boolean).join('\n') : typeof c === 'string' ? c : '';

export function parseCodex(rec, ctx) {
  const p = rec?.payload; if (!p) return null;
  const at = rec.timestamp || null;
  if (rec.type === 'session_meta') { ctx.cwd = p.cwd; return null; }
  if (rec.type === 'turn_context') { if (p.model) ctx.model = p.model; return null; }
  if (rec.type === 'event_msg') {
    if (p.type === 'user_message' && p.message) return { role: 'user', text: p.message, at };
    if (p.type === 'task_complete') return { role: 'system', text: 'task complete', at };
    if (p.type === 'error' && p.message) return { role: 'system', text: `error: ${p.message}`, at };
    return null;
  }
  if (rec.type !== 'response_item') return null;
  if (p.type === 'message' && p.role === 'assistant') { const t = partsText(p.content); return t ? { role: 'assistant', text: t, at } : null; }
  if (p.type === 'custom_tool_call') return { ...toolBubble(p.name, p.input), at };
  if (p.type === 'function_call') return { ...toolBubble(p.name, p.arguments), at };
  if (p.type === 'local_shell_call') return { ...toolBubble('shell', p.action?.command), at };
  if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
    const t = typeof p.output === 'string' ? p.output : partsText(p.output) || JSON.stringify(p.output ?? '');
    return { role: 'tool', text: t, tool: { name: 'output', summary: oneLine(t), collapsed: true }, at };
  }
  return null;
}

export function makeCodexAdapter({ codexHome = process.env.CODEX_HOME || `${process.env.HOME}/.codex`, proc = null } = {}) {
  const reader = makeReader(parseCodex);
  const root = path.join(codexHome, 'sessions');
  const metaCwd = new Map();
  function cwdOf(f) {
    if (metaCwd.has(f)) return metaCwd.get(f);
    let cwd = null;
    try { const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(65536); const n = fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd);
      const line = b.subarray(0, n).toString('utf8').split('\n')[0]; cwd = JSON.parse(line)?.payload?.cwd || null; } catch {}
    metaCwd.set(f, cwd); return cwd;
  }
  function rollouts() {
    const out = [];
    const walk = (d, depth) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory() && depth < 3) walk(p, depth + 1); else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) out.push(p); } };
    walk(root, 0); return out;
  }
  function locate(s) {
    if (proc && s.pid) { const f = proc.fds(s.pid).find((l) => l.startsWith(root + path.sep) && l.endsWith('.jsonl')); if (f) return f; }
    if (!s.cwd) return null;
    let best = null, bm = 0;
    for (const f of rollouts()) { if (cwdOf(f) !== s.cwd) continue; let m = 0; try { m = fs.statSync(f).mtimeMs; } catch {} if (m > bm) { bm = m; best = f; } }
    return best;
  }
  return { harness: 'codex', locate, read: (s) => { const f = locate(s); return f ? reader.read(f) : null; }, reader };
}
