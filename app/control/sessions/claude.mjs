// Claude Code transcripts: <CLAUDE_HOME>/projects/<dashed cwd>/<sessionId>.jsonl
// Records: type user|assistant|system, message.content (string or [{type:text|tool_use|tool_result|thinking}]),
// isMeta (skipped), timestamp, message.model. See docs/harness-adapters.md.
import fs from 'node:fs';
import path from 'node:path';
import { makeReader, toolBubble, oneLine } from './transcript.mjs';

const dash = (p) => String(p || '').replace(/[^a-zA-Z0-9]/g, '-');
const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.type === 'text' ? x.text : '').filter(Boolean).join('\n') : '';

export function parseClaude(rec, ctx) {
  if (!rec || rec.isMeta || rec.isSidechain) return null;
  const at = rec.timestamp || null;
  if (rec.type === 'system' && typeof rec.content === 'string') return { role: 'system', text: rec.content, at };
  if (rec.type !== 'user' && rec.type !== 'assistant') return null;
  const m = rec.message || {};
  if (m.model && m.model !== '<synthetic>') ctx.model = m.model;
  const content = m.content;
  if (typeof content === 'string') return content.trim() ? { role: rec.type, text: content, at } : null;
  if (!Array.isArray(content)) return null;
  const out = [];
  let text = '';
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && part.text) text += (text ? '\n' : '') + part.text;
    else if (part.type === 'tool_use') out.push({ ...toolBubble(part.name, part.input), at });
    else if (part.type === 'tool_result') {
      const t = typeof part.content === 'string' ? part.content : textOf(part.content);
      out.push({ role: 'tool', text: t, tool: { name: part.is_error ? 'result (error)' : 'result', summary: oneLine(t), collapsed: true }, at });
    }
  }
  if (text.trim()) out.unshift({ role: rec.type, text, at, ...(rec.type === 'assistant' && m.model ? { model: m.model } : {}) });
  return out;
}

export function makeClaudeAdapter({ claudeHome = process.env.CLAUDE_HOME || `${process.env.HOME}/.claude` } = {}) {
  const reader = makeReader(parseClaude);
  const found = new Map();
  function locate(s) {
    if (!s.sessionId || !/^[\w-]{8,80}$/.test(s.sessionId)) return null;
    if (found.has(s.sessionId) && fs.existsSync(found.get(s.sessionId))) return found.get(s.sessionId);
    const root = path.join(claudeHome, 'projects');
    const guess = path.join(root, dash(s.cwd), `${s.sessionId}.jsonl`);
    let file = fs.existsSync(guess) ? guess : null;
    if (!file) { let ds = []; try { ds = fs.readdirSync(root); } catch {} file = ds.map((d) => path.join(root, d, `${s.sessionId}.jsonl`)).find((f) => fs.existsSync(f)) || null; }
    if (file) found.set(s.sessionId, file);
    return file;
  }
  return { harness: 'claude', locate, read: (s) => { const f = locate(s); return f ? reader.read(f) : null; }, reader };
}
