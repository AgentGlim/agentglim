// OpenCode: opencode.db opened read-only and immutable (file:...?mode=ro&immutable=1).
// Tables: session (id, directory, time_updated), message (id, session_id, time_created, data JSON: role, modelID),
// part (id, message_id, session_id, time_created, data JSON: type text|tool|reasoning). Reasoning is skipped.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { clip, oneLine, MAX_BUBBLES } from './transcript.mjs';

export function partToBubble(part, msg) {
  const role = msg?.role === 'user' ? 'user' : 'assistant';
  if (part.type === 'text' && part.text && !part.synthetic) return { role, text: part.text };
  if (part.type === 'tool') {
    const s = part.state || {};
    return { role: 'tool', text: clip(typeof s.output === 'string' ? s.output : '', 4000), tool: { name: String(part.tool || 'tool').slice(0, 60), summary: oneLine(s.title || s.input?.command || s.input || ''), collapsed: true } };
  }
  return null;
}

export function makeOpencodeAdapter({ dbPath = process.env.OPENCODE_DB || `${process.env.HOME}/.local/share/opencode/opencode.db` } = {}) {
  const cache = new Map(); // session id -> { seq, last, bubbles }
  function open() {
    if (!fs.existsSync(dbPath)) return null;
    try { return new DatabaseSync(`file:${dbPath}?mode=ro&immutable=1`, { readOnly: true }); } catch { return null; }
  }
  function locate(s) {
    if (s.opencodeSession) return s.opencodeSession;
    const db = open(); if (!db) return null;
    try { return db.prepare('select id from session where directory = ? order by time_updated desc limit 1').get(s.cwd || '')?.id || null; } catch { return null; } finally { db.close(); }
  }
  function read(s) {
    const id = locate(s); if (!id) return null;
    const db = open(); if (!db) return null;
    const c = cache.get(id) || { seq: 0, last: 0, lastId: '', bubbles: [] };
    try {
      const msgs = new Map();
      for (const m of db.prepare('select id, data from message where session_id = ?').all(id)) { try { msgs.set(m.id, JSON.parse(m.data)); } catch {} }
      const rows = db.prepare('select id, message_id, time_created, data from part where session_id = ? and (time_created > ? or (time_created = ? and id > ?)) order by time_created, id limit 2000').all(id, c.last, c.last, c.lastId);
      for (const r of rows) {
        c.last = r.time_created; c.lastId = r.id;
        let p; try { p = JSON.parse(r.data); } catch { continue; }
        const msg = msgs.get(r.message_id);
        const b = partToBubble(p, msg); if (!b) continue;
        c.seq += 1;
        c.bubbles.push({ id: c.seq, role: b.role, text: b.role === 'tool' ? b.text : clip(b.text), ...(b.tool ? { tool: b.tool } : {}), at: new Date(r.time_created).toISOString(), ...(msg?.modelID ? { model: msg.modelID } : {}) });
      }
      if (c.bubbles.length > MAX_BUBBLES) c.bubbles.splice(0, c.bubbles.length - MAX_BUBBLES);
      cache.set(id, c);
      return { bubbles: c.bubbles, seq: c.seq, more: rows.length === 2000 };
    } catch { return null; } finally { db.close(); }
  }
  return { harness: 'opencode', locate, read };
}
