// "Other projects" table: every folder in ~/dev/projects except plans/, with its progress
// estimate, status, running processes, last activity, and the tokens/$ its sessions used.
// Read-only toward every project folder (a live leads controller run stops when any file in leads/ changes):
// it only reads files, readlinks /proc/*/cwd and runs `git log -1` with GIT_OPTIONAL_LOCKS=0.
// Writes only data/other-projects.json (created once, empty) in the Observatory's own data/.
//   Progress  <project>/PROGRESS.md, else data/progress/<name>.md (format: data/progress/FORMAT.md)
//   Claude    ~/.claude/projects/-home-user-dev-projects-<name>*/**.jsonl  (message.usage, deduped by message id)
//   Codex     ~/.codex/sessions/**.jsonl whose session cwd is inside the project (token_count deltas)
//   Pi        ~/.pi/agent/sessions/*/*.jsonl whose session cwd is inside the project
//   OpenCode  ~/.local/share/opencode/opencode.db sessions whose directory is inside the project
// Session files are read incrementally (offset per file, reset when a file shrinks or is replaced).
// Live agents (2026-10-21): each Claude Code, Codex, Pi or OpenCode process whose cwd is inside a project, with its
// kind, model and last activity (Claude: ~/.claude/sessions/<pid>.json + its transcript; Codex: the rollout file it
// holds open; Pi/OpenCode: the project's newest session), so the page can flash a dot per agent that is working.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { liveStatus } from './live-status.mjs';

const HOME = process.env.HOME;
const ROOT = PROJECTS;
const ALIASES = [ROOT, path.join(os.homedir(), 'projects', 'dev')]; // the run's symlinked path for the same folder
const HERE = path.dirname(fileURLToPath(import.meta.url));
import { DATA, PROJECTS } from './paths.mjs';
import { repoPlans } from './jobs.mjs'; // repos a plan owns are folded into that plan's row
const CFG = `${DATA}/other-projects.json`;
const PROG_DIR = `${DATA}/progress`;
const CLAUDE = `${HOME}/.claude/projects`;
const CODEX = `${HOME}/.codex/sessions`;
const PI = `${HOME}/.pi/agent/sessions`;
const OPENCODE_DB = `${HOME}/.local/share/opencode/opencode.db`;
const CLAUDE_PIDS = `${HOME}/.claude/sessions`;
const BUCKET = 10 * 60e3;
const ACTIVE_MS = 2 * 60e3; // an agent whose session changed this recently counts as working
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

if (!fs.existsSync(CFG)) { try { fs.writeFileSync(CFG, JSON.stringify({ exclude: [], rename: {} }, null, 2) + '\n'); } catch {} }
const config = () => { try { const c = JSON.parse(readText(CFG)); return { exclude: c.exclude || [], rename: c.rename || {}, kinds: c.kinds || {} }; } catch { return { exclude: [], rename: {}, kinds: {} }; } };

// project folder of a path inside ~/dev/projects; undefined = outside it, null = the root itself or plans/
function projectOf(cwd) {
  cwd = String(cwd || '').replace(/^file:\/\//, '');
  for (const a of ALIASES) if (cwd === a || cwd.startsWith(`${a}/`)) {
    const name = cwd.slice(a.length + 1).split('/')[0];
    return name && name !== 'plans' ? name : null;
  }
  return undefined;
}
function listProjects() {
  let ents = [];
  try { ents = fs.readdirSync(ROOT, { withFileTypes: true }); } catch {}
  return ents.filter((e) => !e.name.startsWith('.') && e.name !== 'plans' && e.name !== 'goals'
    && (e.isDirectory() || (e.isSymbolicLink() && (() => { try { return fs.statSync(`${ROOT}/${e.name}`).isDirectory(); } catch { return false; } })())))
    .map((e) => e.name).sort();
}

// ---------- incremental readers (own offsets: server.mjs's readNewLines state is separate) ----------
const fst = new Map(); // file -> { size, mtime, offset, partial, ...per-source state }
function readNew(file, fresh) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  let s = fst.get(file);
  if (!s || st.size < s.offset) { s = { offset: 0, partial: '', ...fresh() }; fst.set(file, s); }
  s.mtime = st.mtimeMs;
  if (st.size === s.offset) return { s, lines: [] };
  // lines come lazily in 8 MB chunks (memory-safe batch loading)
  const end = st.size;
  function* lines() {
    let fd; try { fd = fs.openSync(file, 'r'); } catch { return; }
    try {
      const buf = Buffer.alloc(Math.min(8 << 20, end - s.offset));
      while (s.offset < end) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, end - s.offset), s.offset);
        if (n <= 0) break;
        s.offset += n;
        const ls = (s.partial + buf.toString('utf8', 0, n)).split('\n');
        s.partial = ls.pop();
        if (s.partial.length > 64 << 20) s.partial = '';
        yield* ls;
      }
    } finally { fs.closeSync(fd); }
  }
  return { s, lines: lines() };
}
// session header cwd from the first 32 KB, so files of other folders are never read in full
function headCwd(file) {
  try {
    const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(32768);
    const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    return buf.toString('utf8', 0, n).match(/"cwd":"([^"]*)"/)?.[1] ?? null;
  } catch { return null; }
}
function walk(dir, depth, out, max) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const f = `${dir}/${e.name}`;
    if (e.isDirectory() && depth < max) walk(f, depth + 1, out, max);
    else if (e.name.endsWith('.jsonl')) out.push(f);
  }
  return out;
}

// ---------- usage records ----------
const claudeMsgs = new Map(); // message id -> record (last line per id wins, as in server.mjs scanClaude)
const dash = (s) => s.replace(/[^a-zA-Z0-9]/g, '-');
function scanClaude(names) {
  let dirs = []; try { dirs = fs.readdirSync(CLAUDE); } catch {}
  const pre = ALIASES.map((a) => dash(a));
  const byLen = [...names].sort((a, b) => b.length - a.length);
  for (const d of dirs) {
    const p = pre.find((x) => d === x || d.startsWith(`${x}-`));
    if (!p || d.startsWith(`${p}-plans`) && (d === `${p}-plans` || d.startsWith(`${p}-plans-`))) continue;
    // folder of the session's start dir, for lines whose cwd is outside ~/dev/projects (scratchpads, /tmp)
    const fromDir = byLen.find((n) => d === `${p}-${dash(n)}` || d.startsWith(`${p}-${dash(n)}-`)) || null;
    for (const f of walk(`${CLAUDE}/${d}`, 0, [], 3)) {
      const r = readNew(f, () => ({})); if (!r) continue;
      for (const line of r.lines) {
        if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        const m = o.message;
        if (o.type !== 'assistant' || !m?.usage || !m.id) continue;
        const inRoot = projectOf(o.cwd);
        const proj = inRoot === undefined ? fromDir : inRoot;
        if (!proj) continue;
        const u = m.usage;
        claudeMsgs.set(m.id, { p: proj, ts: Date.parse(o.timestamp) || 0, provider: 'anthropic', model: m.model || '',
          input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 });
      }
    }
  }
}
// Codex CLI rollouts: cumulative total_token_usage per session, kept as per-turn deltas (as server.mjs scanCodex)
function scanCodex() {
  for (const f of walk(CODEX, 0, [], 4)) {
    let s = fst.get(f);
    if (s?.skip) continue;
    if (!s) {
      const proj = projectOf(headCwd(f));
      if (!proj) { fst.set(f, { skip: true }); continue; }
    }
    const r = readNew(f, () => ({ src: 'codex', p: projectOf(headCwd(f)), model: null, prev: null, recs: [] })); if (!r) continue;
    s = r.s;
    for (const line of r.lines) {
      if (!line.includes('"token_count"')) { const m = line.match(/"model":"(gpt-[^"]+)"/); if (m) s.model = m[1]; continue; }
      let o; try { o = JSON.parse(line); } catch { continue; }
      const u = o.payload?.info?.total_token_usage; if (!u) continue;
      const p = s.prev || {}; s.prev = u;
      const d = (k) => (u[k] || 0) - (p[k] || 0);
      const cached = d('cached_input_tokens'), write = d('cache_write_input_tokens');
      if (d('input_tokens') || d('output_tokens'))
        s.recs.push({ p: s.p, ts: Date.parse(o.timestamp) || 0, provider: 'codex', model: s.model || 'gpt-6.1-sol',
          input: d('input_tokens') - cached - write, cacheRead: cached, cacheWrite: write, output: d('output_tokens') });
    }
  }
}
// Pi sessions: assistant messages with usage, provider names mapped as in server.mjs scanJob
function scanPi() {
  for (const f of walk(PI, 0, [], 1)) {
    let s = fst.get(f);
    if (s?.skip) continue;
    if (!s && !projectOf(headCwd(f))) { fst.set(f, { skip: true }); continue; }
    const r = readNew(f, () => ({ src: 'pi', p: projectOf(headCwd(f)), recs: [] })); if (!r) continue;
    s = r.s;
    for (const line of r.lines) {
      if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const msg = o.message || {}, u = msg.usage || {};
      if (msg.role !== 'assistant') continue;
      const prov = msg.provider === 'openai' ? 'codex' : msg.provider === 'opencode-go2' ? 'opencode-go' : msg.provider || 'unknown';
      s.recs.push({ p: s.p, ts: msg.timestamp || Date.parse(o.timestamp) || 0, provider: prov, model: msg.model || '',
        input: u.input || 0, output: u.output || 0, cacheRead: u.cacheRead || 0, cacheWrite: u.cacheWrite || 0 });
    }
  }
}
// OpenCode (Zen free models and others): messages of sessions run inside a project
const zen = { seen: 0, recs: [] };
function scanOpenCode() {
  if (!fs.existsSync(OPENCODE_DB)) return;
  let db; try { db = new DatabaseSync(OPENCODE_DB, { readOnly: true }); } catch { return; }
  try {
    const like = ALIASES.map((a) => `s.directory like '${a}/%'`).join(' or ');
    const rows = db.prepare(`select s.directory dir, m.time_created t, m.data data from message m join session s on s.id = m.session_id
      where m.time_created > ? and (${like}) order by m.time_created`).all(zen.seen);
    for (const r of rows) {
      zen.seen = Math.max(zen.seen, r.t);
      const p = projectOf(r.dir); if (!p) continue;
      let d; try { d = JSON.parse(r.data); } catch { continue; }
      if (d.role !== 'assistant') continue;
      const tk = d.tokens || {};
      zen.recs.push({ p, ts: r.t, provider: d.providerID === 'opencode' || !d.providerID ? 'opencode' : d.providerID, model: d.modelID || '',
        input: tk.input || 0, output: (tk.output || 0) + (tk.reasoning || 0), cacheRead: tk.cache?.read || 0, cacheWrite: tk.cache?.write || 0 });
    }
  } catch {} finally { db.close(); }
}

// ---------- per-project state: progress file, git, running processes ----------
function progressOf(name) {
  for (const [f, src] of [[`${ROOT}/${name}/PROGRESS.md`, 'PROGRESS.md'], [`${PROG_DIR}/${name}.md`, `data/progress/${name}.md`]]) {
    const t = readText(f); if (!t) continue;
    const field = (k) => t.match(new RegExp(`^${k}:\\s*(.+)$`, 'mi'))?.[1].trim() || null;
    const done = (t.match(/^\s*[-*] \[[xX]\]/gm) || []).length, open = (t.match(/^\s*[-*] \[ \]/gm) || []).length;
    const pct = Number((field('Progress') || '').match(/\d+(?:\.\d+)?/)?.[0]);
    const ledger = field('Spend ledger');
    return { src, goal: field('Goal'), status: (field('Status') || '').toLowerCase().split(/\s/)[0] || null,
      pct: Number.isFinite(pct) ? Math.min(100, pct) : (done + open ? Math.round(done / (done + open) * 100) : null),
      priority: ((field('Priority') || '').match(/^(active|p[123])\b/i)?.[1] || '').toUpperCase().replace('ACTIVE', 'PA') || null, estimated: field('Estimated'), step: field('Current step'), ledger: ledger && !/^none\b/i.test(ledger) ? ledger : null, done, total: done + open };
  }
  return null;
}
// real $ from a spend ledger file: a JSON total (or summed *usd/cost/spend fields), a CSV cost column, or a "total ... $N" line
function ledgerSpend(name, rel) {
  const f = path.resolve(`${ROOT}/${name}`, rel);
  if (!f.startsWith(`${ROOT}/${name}/`)) return null;
  const t = readText(f); if (!t) return { file: rel, usd: null, why: 'file not found' };
  const money = /(usd|cost|spend|amount)/i;
  try {
    const j = JSON.parse(t);
    const top = j && typeof j === 'object' && !Array.isArray(j) ? Object.entries(j).find(([k, v]) => typeof v === 'number' && /total/i.test(k) && money.test(k)) : null;
    if (top) return { file: rel, usd: top[1] };
    let sum = 0, n = 0;
    const visit = (v) => { if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (typeof x === 'number' && money.test(k) && !/total|cap|max|limit|budget/i.test(k)) { sum += x; n++; } else visit(x); } };
    visit(j);
    return { file: rel, usd: n ? sum : null, why: n ? null : 'no spend fields' };
  } catch {}
  const lines = t.trim().split('\n');
  const head = lines[0].split(',').map((x) => x.trim().replace(/^"|"$/g, ''));
  const col = head.findIndex((h) => money.test(h));
  if (lines.length > 1 && head.length > 1 && col >= 0) return { file: rel, usd: lines.slice(1).reduce((n, l) => n + (Number(l.split(',')[col]) || 0), 0) };
  const tot = [...t.matchAll(/^.*total.*?\$\s?([\d,]+(?:\.\d+)?)/gim)].pop();
  return { file: rel, usd: tot ? Number(tot[1].replace(/,/g, '')) : null, why: tot ? null : 'no total found' };
}
const git = new Map(); // name -> ISO date of the last commit (refreshed every minute, one `git log` at a time)
let gitBusy = false;
async function refreshGit(names) {
  if (gitBusy) return; gitBusy = true;
  try {
    for (const n of names) await new Promise((ok) => execFile('git', ['-C', `${ROOT}/${n}`, 'log', '-1', '--format=%cI'],
      { timeout: 10000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CEILING_DIRECTORIES: ROOT, GIT_TERMINAL_PROMPT: '0' } },
      (err, so) => { const t = !err && Date.parse(so.trim()); t ? git.set(n, t) : git.delete(n); ok(); }));
  } finally { gitBusy = false; }
}
// agent kind of a process: Claude Code, Codex (native binary or its node launcher), Pi (renames itself 'pi'), OpenCode
function agentKind(comm, pid) {
  if (comm === 'claude' || comm === 'codex' || comm === 'pi') return comm;
  if (/^\.?opencode/.test(comm)) return 'opencode';
  if (comm !== 'node' && comm !== 'bun' && comm !== 'MainThread') return null;
  let a = []; try { a = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); } catch {}
  const bin = path.basename(a[1] || '');
  return bin === 'codex' || bin === 'codex.js' ? 'codex' : bin === 'opencode' ? 'opencode' : /pi-coding-agent/.test(a[1] || '') ? 'pi' : bin === 'claude' || /claude-code\/cli/.test(a[1] || '') ? 'claude' : null;
}
// processes whose cwd is inside a project (not this server or its children); agents: one per agent process,
// skipping a process whose parent is an agent of the same kind (the Codex node launcher and its native binary)
function running() {
  const out = new Map(), agents = new Map(), seen = new Map();
  let pids = []; try { pids = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)); } catch {}
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    let cwd; try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { continue; }
    const p = projectOf(cwd); if (!p) continue;
    let comm = '?', ppid = 0;
    try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); comm = st.slice(st.indexOf('(') + 1, st.lastIndexOf(')')); ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]); } catch {}
    if (ppid === process.pid) continue;
    (out.get(p) || out.set(p, []).get(p)).push(comm);
    const kind = agentKind(comm, pid);
    if (kind) seen.set(Number(pid), { pid: Number(pid), ppid, kind, p, cwd });
  }
  for (const a of seen.values()) if (seen.get(a.ppid)?.kind !== a.kind) (agents.get(a.p) || agents.set(a.p, []).get(a.p)).push(a);
  return { procs: out, agents };
}

// ---------- live agent details: model and last activity, cheap reads only ----------
const mtimeOf = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
const argOf = (pid, ...names) => {
  let a = []; try { a = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); } catch {}
  for (let i = 0; i < a.length; i++) {
    for (const n of names) { if (a[i] === n && a[i + 1]) return a[i + 1]; if (a[i].startsWith(`${n}=`)) return a[i].slice(n.length + 1); }
  }
  return null;
};
// last model named in the final 64 KB of a session file (cached per file size)
const tailModel = new Map();
function lastModel(file, re) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const c = tailModel.get(file); if (c && c.size === st.size) return c.model;
  let model = c?.model || null;
  try {
    const n = Math.min(st.size, 65536), fd = fs.openSync(file, 'r'), buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, st.size - n); fs.closeSync(fd);
    const all = [...buf.toString('utf8').matchAll(re)]; if (all.length) model = all.pop()[1];
  } catch {}
  tailModel.set(file, { size: st.size, model });
  return model;
}
const claudeFile = new Map(); // session id -> transcript path
function claudeAgent(a) {
  let s = {}; try { s = JSON.parse(readText(`${CLAUDE_PIDS}/${a.pid}.json`)); } catch {}
  let file = s.sessionId ? claudeFile.get(s.sessionId) : null;
  if (s.sessionId && !file) {
    const guess = `${CLAUDE}/${dash(s.cwd || a.cwd)}/${s.sessionId}.jsonl`;
    if (fs.existsSync(guess)) file = guess;
    else { let ds = []; try { ds = fs.readdirSync(CLAUDE); } catch {} file = ds.map((d) => `${CLAUDE}/${d}/${s.sessionId}.jsonl`).find((f) => fs.existsSync(f)) || null; }
    if (file) claudeFile.set(s.sessionId, file);
  }
  const model = argOf(a.pid, '--model') || (file ? lastModel(file, /"model":"(claude-[^"]+)"/g) : null);
  return { model, last: file ? mtimeOf(file) : 0, status: s.status || null, name: s.name || null };
}
// the rollout file a Codex process holds open, else the project's newest Codex session
function openFile(pid, dir) {
  let fds = []; try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { return null; }
  for (const fd of fds) { let l; try { l = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; } if (l.startsWith(`${dir}/`) && l.endsWith('.jsonl')) return l; }
  return null;
}
function newestSession(src, p) {
  let best = null;
  for (const [f, s] of fst) if (s.src === src && s.p === p && (!best || s.mtime > best.s.mtime)) best = { f, s };
  return best;
}
function opencodeLast(cwd) {
  if (!fs.existsSync(OPENCODE_DB)) return 0;
  let db; try { db = new DatabaseSync(OPENCODE_DB, { readOnly: true }); } catch { return 0; }
  try { return db.prepare('select max(time_updated) t from session where directory = ? or directory like ?').get(cwd, `${cwd}/%`)?.t || 0; } catch { return 0; } finally { db.close(); }
}
function agentInfo(a) {
  let x = { model: null, last: 0 };
  if (a.kind === 'claude') x = claudeAgent(a);
  else if (a.kind === 'codex') {
    const f = openFile(a.pid, CODEX) || newestSession('codex', a.p)?.f;
    x = { model: argOf(a.pid, '-m', '--model') || (f && fst.get(f)?.model) || (readText(`${HOME}/.codex/config.toml`).match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? null), last: f ? mtimeOf(f) : 0 };
  } else if (a.kind === 'pi') {
    const b = newestSession('pi', a.p);
    x = { model: argOf(a.pid, '--model', '-m') || b?.s.recs.at(-1)?.model || null, last: b ? mtimeOf(b.f) : 0 };
  } else if (a.kind === 'opencode') {
    x = { model: argOf(a.pid, '--model', '-m') || zen.recs.findLast((r) => r.p === a.p)?.model || null, last: opencodeLast(a.cwd) };
  }
  const last = x.last || 0;
  return { pid: a.pid, kind: a.kind, model: x.model || null, last: last ? Math.round(last) : null, status: x.status || null, name: x.name || null,
    active: x.status === 'busy' || x.status === 'shell' || (last > 0 && Date.now() - last < ACTIVE_MS) }; // Claude Code reports busy or shell while working
}

// ---------- scan + view ----------
export function makeOthers({ rateOf, partCost, recClass, leadsUsd, trackedJobs = () => [] }) {
  let buckets = new Map(), lastSession = new Map(), scannedAt = 0, scanMs = 0, busy = false;
  function scanSessions() {
    if (busy) return; busy = true;
    const t0 = Date.now();
    try {
      const names = listProjects();
      for (const [n, fn] of [['claude', () => scanClaude(names)], ['codex', scanCodex], ['pi', scanPi], ['opencode', scanOpenCode]]) {
        try { fn(); } catch (e) { console.error(`other projects: ${n} scan failed`, e); }
      }
      const b = new Map(), last = new Map();
      const add = (r) => {
        const t = Math.floor(r.ts / BUCKET) * BUCKET, k = `${r.p}|${t}|${r.provider}|${r.model}`;
        const x = b.get(k) || b.set(k, { p: r.p, t, provider: r.provider, model: r.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 }).get(k);
        x.input += r.input; x.output += r.output; x.cacheRead += r.cacheRead; x.cacheWrite += r.cacheWrite; x.calls += 1;
        if (r.ts > (last.get(r.p) || 0)) last.set(r.p, r.ts);
      };
      for (const r of claudeMsgs.values()) add(r);
      for (const s of fst.values()) if (s.recs) for (const r of s.recs) add(r);
      for (const r of zen.recs) add(r);
      buckets = b; lastSession = last; scannedAt = Date.now(); scanMs = scannedAt - t0;
      refreshGit(names);
    } finally { busy = false; }
  }
  // Test sub-rows: a project may write <project>/.observatory-tasks.json
  // Format: data/progress/TASKS-FORMAT.md (models -> tests with status and optional score; model-level scores).
  // ai-local's scripts/bench/assess.py writes it every 2 min while its model tests run. Read-only here.
  function tasksOf(name) {
    try {
      const f = `${ROOT}/${name}/.observatory-tasks.json`, j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!Array.isArray(j.models)) return null;
      const mtime = fs.statSync(f).mtimeMs, items = j.models.flatMap((m) => (m.tests || []).map((t) => ({ ...t, updated: t.updated || j.updated || new Date(mtime).toISOString().slice(0, 10) })));
      const display = liveStatus(items, name, trackedJobs(name));
      let at = 0;
      const models = j.models.map((m) => ({ ...m, tests: (m.tests || []).map(() => display[at++]) }));
      const counts = { done: 0, running: 0, 'in progress': 0, queued: 0, skipped: 0 };
      for (const t of display) counts[t.status] = (counts[t.status] || 0) + 1;
      return { ...j, models, counts, page: j.page ? `_projects/${name}/${j.page}` : null, mtime };
    } catch { return null; }
  }
  // f: the page's filter (from/to/excluded providers), as in server.mjs view()
  function view(f) {
    const cfg = config(), { procs: runs, agents } = running();
    const agg = () => ({ tokens: 0, est: 0, paid: 0, freeTokens: 0, calls: 0, byProv: {} });
    const range = new Map(), all = new Map();
    for (const x of buckets.values()) {
      const cls = recClass(x), usd = cls === 'free' || cls === 'local' ? 0 : partCost(x, rateOf(x));
      const tok = x.input + x.output + x.cacheRead + x.cacheWrite;
      const put = (m) => {
        const a = m.get(x.p) || m.set(x.p, agg()).get(x.p);
        a.tokens += tok; a.calls += x.calls;
        if (cls === 'subscription') a.est += usd; else if (cls === 'free' || cls === 'local') a.freeTokens += tok; else a.paid += usd;
        const pk = x.provider === 'anthropic' ? 'claude' : x.provider;
        const bp = (a.byProv[pk] ||= { tokens: 0, usd: 0, cls });
        bp.tokens += tok; bp.usd += usd;
      };
      put(all);
      if (f.inRange(x.t) && !f.excl.has(x.provider)) put(range);
    }
    const rows = listProjects().filter((n) => !cfg.exclude.includes(n) && !repoPlans()[n]).map((name) => {
      const prog = progressOf(name);
      const real = name === 'leads' ? { file: 'campaign.json (sum of chunk spend_usd)', usd: leadsUsd() } : prog?.ledger ? ledgerSpend(name, prog.ledger) : null;
      const lastCommit = git.get(name) || null, lastSess = lastSession.get(name) || null;
      return { name, kind: cfg.kinds[name] || null, label: cfg.rename[name] || name, approvals: fs.existsSync(`${ROOT}/${name}/approvals.html`) ? `_projects/${name}/approvals.html` : null,
        progress: prog, running: runs.get(name) || [], agents: (agents.get(name) || []).map(agentInfo).sort((a, b) => a.kind.localeCompare(b.kind) || a.pid - b.pid), lastCommit, lastSession: lastSess, last: Math.max(lastCommit || 0, lastSess || 0) || null,
        range: range.get(name) || agg(), all: all.get(name) || agg(), real, tasks: tasksOf(name) };
    }).sort((a, b) => (b.last || 0) - (a.last || 0) || a.name.localeCompare(b.name));
    return { rows, scannedAt, scanMs, excluded: cfg.exclude };
  }
  return { scanSessions, view };
}
