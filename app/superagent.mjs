// "Agentglim SuperAgent" row of the Active builds table: the owner's SuperAgent Claude Code
// session (an interactive `claude` started in the plans folder itself) and the background helper agents it runs.
// Source: ~/.claude/projects/<plans>/<session id>/subagents/agent-<id>.jsonl (+ .meta.json with the task description).
// The same files are symlinked as /tmp/claude-*/<plans>/<session id>/tasks/<id>.output, but /tmp is wiped on reboot.
// Cheap by design: the result is cached for 10 s, only today's files are looked at, and each transcript is read
// from its tail only (last 512 KB, widened once to 4 MB) and cached by mtime+size, so a finished helper is read once.
import fs from 'node:fs';
import { PLANS } from './paths.mjs';
import { listProcesses } from './proc.mjs';

const HOME = process.env.HOME;
// PLANS can be a symlinked path; Claude Code names its project folder after the real folder the session started in
const PLANS_REAL = (() => { try { return fs.realpathSync(PLANS); } catch { return PLANS; } })();
const PROJ = `${HOME}/.claude/projects/${PLANS_REAL.replace(/[^A-Za-z0-9]/g, '-')}`;
const LIVE_MS = 3 * 60e3, EVERY_MS = 10e3;
const ALIAS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5' };
const cache = new Map(); // file -> { mtime, size, d }
const metaCache = new Map(); // meta file -> { description, alias }
let last = { at: 0, row: null };

function readSpan(file, size, from, n) {
  const fd = fs.openSync(file, 'r'), b = Buffer.alloc(n);
  try { fs.readSync(fd, b, 0, n, from); } finally { fs.closeSync(fd); }
  return b.toString('utf8');
}
const meta = (file) => {
  const f = file.replace(/\.jsonl$/, '.meta.json');
  if (metaCache.has(f)) return metaCache.get(f);
  let m = {}; try { m = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  const out = { description: m.description || '', alias: m.model || '' };
  if (out.description) metaCache.set(f, out); // a not-yet-written meta file is retried
  return out;
};
// tail: the newest assistant entry (model + usage) and whether the transcript has its final result
function readTail(file, size) {
  let model = null, tokens = 0, fin = false, found = false;
  for (const span of [512 << 10, 4 << 20]) {
    const n = Math.min(span, size);
    const lines = readSpan(file, size, size - n, n).split('\n');
    if (n < size) lines.shift(); // first line is cut off
    let ended = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i];
      const isA = ln.includes('"type":"assistant"'), isU = ln.includes('"type":"user"');
      if (!isA && !isU) continue;
      if (ended === null) ended = (isU && ln.includes('"toolEndsTurn":true')) || (isA && ln.includes('"stop_reason":"end_turn"'));
      if (!isA || !ln.includes('"usage"')) continue;
      try {
        const m = JSON.parse(ln).message, u = m?.usage;
        if (!u) continue;
        if (m.model && !m.model.startsWith('<')) model = m.model;
        tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
        found = true; break;
      } catch {}
    }
    fin = !!ended;
    if (found || n === size) break;
  }
  return { model, tokens, fin };
}
function started(file, st) {
  try {
    const t = readSpan(file, st.size, 0, Math.min(st.size, 64 << 10)).match(/"timestamp":"([^"]+)"/)?.[1];
    if (t && Date.parse(t)) return Date.parse(t);
  } catch {}
  return st.birthtimeMs || st.mtimeMs;
}
function helper(file, st) {
  const c = cache.get(file);
  if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.d;
  const mt = meta(file);
  let tail = { model: null, tokens: 0, fin: false };
  try { tail = readTail(file, st.size); } catch {}
  const d = { id: file.match(/agent-([^/.]+)\.jsonl$/)?.[1] || file, task: mt.description || 'background helper', model: tail.model || ALIAS[mt.alias] || mt.alias || null,
    tokens: tail.tokens, final: tail.fin, start: c?.d.start || started(file, st), end: st.mtimeMs };
  cache.set(file, { mtime: st.mtimeMs, size: st.size, d });
  return d;
}
// live watcher sessions: interactive claude whose folder is the plans folder itself
function watcherSessions() {
  const out = [], livePids = new Set(listProcesses().map(p => p.pid));
  let files = []; try { files = fs.readdirSync(`${HOME}/.claude/sessions`); } catch {}
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(`${HOME}/.claude/sessions/${f}`, 'utf8'));
      if (![PLANS, PLANS_REAL].includes(s.cwd) || (s.kind && s.kind !== 'interactive') || !livePids.has(Number(s.pid))) continue;
      out.push({ id: s.sessionId, name: s.name || `pid ${s.pid}`, status: s.status || null });
    } catch {}
  }
  return out;
}
function scan() {
  const now = Date.now(), day = new Date(now).setHours(0, 0, 0, 0);
  const sessions = watcherSessions(), helpers = [];
  // every session folder of the plans project that has a subagents/ folder touched today (a watcher restarted today still counts)
  const dirs = [];
  let ents = []; try { ents = fs.readdirSync(PROJ, { withFileTypes: true }); } catch {}
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const d = `${PROJ}/${e.name}/subagents`;
    try { if (fs.statSync(d).mtimeMs >= day) dirs.push(d); } catch {}
  }
  for (const d of dirs) {
    let names = []; try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!/^agent-.*\.jsonl$/.test(n)) continue;
      let st; try { st = fs.statSync(`${d}/${n}`); } catch { continue; }
      if (st.mtimeMs < day) continue;
      helpers.push(helper(`${d}/${n}`, st));
    }
  }
  const live = helpers.filter((h) => !h.final && now - h.end < LIVE_MS).sort((a, b) => a.start - b.start);
  const liveIds = new Set(live.map((h) => h.id));
  const done = helpers.filter((h) => !liveIds.has(h.id));
  return { sessions, live: live.map((h) => ({ id: h.id, task: h.task, model: h.model, tokens: h.tokens, since: h.start })), running: live.length, done: done.length,
    tokens: helpers.reduce((n, h) => n + h.tokens, 0) };
}
// the row for /api/snapshot: null never, so the row is drawn (as "idle") even with no helpers or no watcher session
export function watcherRow() {
  const now = Date.now();
  if (last.row && now - last.at < EVERY_MS) return last.row;
  let row;
  try { row = { ...scan(), at: now }; } catch (e) { row = last.row || { sessions: [], live: [], running: 0, done: 0, tokens: 0, at: now, error: String(e.message || e) }; }
  last = { at: now, row };
  return row;
}
