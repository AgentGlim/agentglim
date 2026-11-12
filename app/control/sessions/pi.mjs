// Pi sessions: <PI_HOME>/agent/sessions/<dashed cwd>/*.jsonl (newest file whose `session` header cwd matches).
// Records used: session (cwd), model_change (modelId), message with message.role user|assistant|toolResult|system;
// assistant content [{type:text|thinking|toolCall}]. Thinking is skipped; the system prompt shows as one line.
import fs from 'node:fs';
import path from 'node:path';
import { makeReader, toolBubble, oneLine } from './transcript.mjs';

const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.type === 'text' ? x.text : '').filter(Boolean).join('\n') : '';

export function parsePi(rec, ctx) {
  const at = rec?.timestamp || null;
  if (rec?.type === 'session') { ctx.cwd = rec.cwd; return null; }
  if (rec?.type === 'model_change') { ctx.model = rec.modelId || ctx.model; return null; }
  if (rec?.type !== 'message' || !rec.message) return null;
  const m = rec.message;
  if (m.model) ctx.model = m.model;
  if (m.role === 'system') { const t = textOf(m.content); return { role: 'system', text: `system prompt (${t.length} chars)`, at }; }
  if (m.role === 'user') { const t = textOf(m.content); return t ? { role: 'user', text: t, at } : null; }
  if (m.role === 'toolResult') { const t = textOf(m.content); return { role: 'tool', text: t, tool: { name: `${m.toolName || 'tool'} result${m.isError ? ' (error)' : ''}`, summary: oneLine(t), collapsed: true }, at }; }
  if (m.role === 'assistant') {
    const out = []; let text = '';
    for (const p of Array.isArray(m.content) ? m.content : []) {
      if (p?.type === 'text' && p.text) text += (text ? '\n' : '') + p.text;
      else if (p?.type === 'toolCall') out.push({ ...toolBubble(p.name, p.arguments), at });
    }
    if (text) out.unshift({ role: 'assistant', text, at, ...(m.model ? { model: m.model } : {}) });
    return out;
  }
  return null;
}

export function makePiAdapter({ piHome = process.env.PI_HOME || `${process.env.HOME}/.pi` } = {}) {
  const reader = makeReader(parsePi);
  const root = path.join(piHome, 'agent', 'sessions');
  const head = new Map();
  function cwdOf(f) {
    if (head.has(f)) return head.get(f);
    let cwd = null; try { const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(8192); const n = fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd); cwd = JSON.parse(b.subarray(0, n).toString('utf8').split('\n')[0])?.cwd || null; } catch {}
    head.set(f, cwd); return cwd;
  }
  function locate(s) {
    if (!s.cwd) return null;
    let dirs = []; try { dirs = fs.readdirSync(root); } catch { return null; }
    let best = null, bm = 0;
    for (const d of dirs) {
      let fs_ = []; try { fs_ = fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of fs_) { const p = path.join(root, d, f); if (cwdOf(p) !== s.cwd) continue; let m = 0; try { m = fs.statSync(p).mtimeMs; } catch {} if (m > bm) { bm = m; best = p; } }
    }
    return best;
  }
  return { harness: 'pi', locate, read: (s) => { const f = locate(s); return f ? reader.read(f) : null; }, reader };
}
