// Shared incremental JSONL reader for the transcript adapters.
// Per file: byte offset (reset when the file shrinks), at most MAX_READ bytes read per call, the last
// MAX_BUBBLES bubbles kept. An incomplete last line (a writer mid-append, or a truncated file) is left
// unread until it is complete.
import fs from 'node:fs';

export const MAX_BUBBLES = 400;
export const MAX_READ = 2 * 1024 * 1024;
export const MAX_TEXT = 20000;
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const stripAnsi = (s) => String(s ?? '').replace(ANSI, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
export const clip = (s, n = MAX_TEXT) => { const t = stripAnsi(s); return t.length > n ? `${t.slice(0, n)}\n... (${t.length - n} more chars)` : t; };
export const oneLine = (s, n = 120) => { const t = stripAnsi(typeof s === 'string' ? s : JSON.stringify(s ?? '')).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
export const toolBubble = (name, input) => ({ role: 'tool', text: '', tool: { name: String(name || 'tool').slice(0, 60), summary: oneLine(input), collapsed: true } });

export function makeReader(parseRecord, { maxRead = MAX_READ, maxBubbles = MAX_BUBBLES } = {}) {
  const files = new Map(); // path -> { offset, size, seq, bubbles, ctx }
  function read(file) {
    let st; try { st = fs.statSync(file); } catch { return null; }
    let c = files.get(file);
    if (!c || st.size < c.offset) { c = { offset: 0, seq: 0, bubbles: [], ctx: {} }; files.set(file, c); }
    if (c.offset === 0 && st.size > maxRead) c.offset = st.size - maxRead, c.skipFirst = true;
    if (st.size > c.offset) {
      const n = Math.min(st.size - c.offset, maxRead);
      const buf = Buffer.alloc(n);
      const fd = fs.openSync(file, 'r'); try { fs.readSync(fd, buf, 0, n, c.offset); } finally { fs.closeSync(fd); }
      let end = buf.lastIndexOf(0x0a);
      if (end < 0) end = -1;
      let start = 0;
      if (c.skipFirst) { const nl = buf.indexOf(0x0a); start = nl < 0 ? n : nl + 1; c.skipFirst = false; }
      const text = end >= start ? buf.subarray(start, end + 1).toString('utf8') : '';
      // a line longer than the read window can never complete inside it: skip past it
      c.offset += end >= 0 ? end + 1 : n === maxRead ? n : 0;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let rec; try { rec = JSON.parse(line); } catch { continue; }
        let out; try { out = parseRecord(rec, c.ctx) || []; } catch { out = []; }
        for (const b of [].concat(out)) {
          if (!b) continue;
          c.seq += 1;
          c.bubbles.push({ id: c.seq, role: b.role, text: b.role === 'tool' ? clip(b.text || '', 4000) : clip(b.text), ...(b.tool ? { tool: b.tool } : {}), at: b.at || null, ...(b.model || c.ctx.model ? { model: b.model || c.ctx.model } : {}) });
        }
      }
      if (c.bubbles.length > maxBubbles) c.bubbles.splice(0, c.bubbles.length - maxBubbles);
    }
    return { bubbles: c.bubbles, seq: c.seq, offset: c.offset, size: st.size, more: st.size > c.offset + 1 };
  }
  return { read, files };
}

// bubbles after a cursor (the id of the last bubble the client has)
export const after = (r, cursor) => {
  const n = Number(cursor) || 0;
  return { bubbles: r ? r.bubbles.filter((b) => b.id > n) : [], cursor: r ? r.seq : n, more: !!r?.more };
};
