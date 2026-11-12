// Push event sources (sub-item 03 A4). poll() runs every 5 s while the remote listener is on and a phone is
// subscribed. File tails keep their byte offsets in control.db (offsets table, source "push:<name>"); the other
// sources keep their last state in push_state. The first look at a source is a baseline: no push for old news.
// Every payload is {type, title, body, url, tag} built from project and harness NAMES only: never transcript,
// prompt, message, reply, ask or heading text (those can hold anything, including prompt injection).
// Dedupe: one push per type and target per 60 s.
import fs from 'node:fs';
import path from 'node:path';

export const POLL_MS = 5000;
export const DEDUPE_MS = 60e3;
const NAME_RE = /^[\w.@+-]{1,64}$/;
// a name for a payload: a plain identifier, or a neutral word (never free text)
export const nameOf = (v, fallback) => { const s = String(v ?? '').trim(); return NAME_RE.test(s) ? s : fallback; };
const HARNESS = new Set(['claude', 'codex', 'pi', 'opencode']);
const harnessOf = (v) => (HARNESS.has(String(v)) ? String(v) : 'agent');

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function statOf(f) { try { return fs.statSync(f); } catch { return null; } }
function lsDirs(d) { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } }

// "Estimated completion: NN%" (the last one in the file wins)
export function auditScore(text) { const all = [...String(text || '').matchAll(/Estimated completion:\s*\**\s*(\d{1,3})\s*%/gi)]; return all.length ? Math.min(100, Number(all.at(-1)[1])) : null; }

export function makeEvents({ store, pstore, notify, paths, snapshot = () => null, sessions = null, approvals = null, now = () => Date.now(), log = console }) {
  const P = paths;
  const recent = new Map(); // `${type}|${target}` -> last push time
  const S = (k, init) => { const v = pstore.stateGet(`ev:${k}`); return v === null ? init : v; };
  const put = (k, v) => pstore.statePut(`ev:${k}`, v);

  // new complete lines of a file since the stored offset; baseline = the current size
  function tail(source, file) {
    const st = statOf(file);
    if (!st) return [];
    const o = store.offsetGet(`push:${source}`, file);
    if (!o) { store.offsetPut(`push:${source}`, file, st.size, Math.floor(st.mtimeMs)); return []; }
    let off = o.offset;
    if (st.size < off) off = 0; // truncated or rotated
    if (st.size === off) return [];
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(st.size - off, 4 * 1024 * 1024);
      const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, off);
      const text = buf.toString('utf8'); const end = text.lastIndexOf('\n');
      if (end < 0) return [];
      store.offsetPut(`push:${source}`, file, off + Buffer.byteLength(text.slice(0, end + 1)), Math.floor(st.mtimeMs));
      return text.slice(0, end).split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } finally { fs.closeSync(fd); }
  }

  const out = [];
  function emit(type, target, title, body, url) {
    const key = `${type}|${target}`, t = now();
    if (t - (recent.get(key) || -Infinity) < DEDUPE_MS) return false;
    recent.set(key, t);
    const e = { type, title, body, url, tag: `${type}:${target}`.slice(0, 120) };
    out.push(e);
    return true;
  }

  // ---- the nine sources
  function needsInputNotify() {
    for (const l of tail('notify', P.notifyLog)) {
      if (l?.event !== 'needs_input') continue;
      const h = harnessOf(l.agent), proj = nameOf(l.project, 'a project');
      emit('needs_input', `${h}:${proj}`, 'Needs input', `${h} in ${proj} is waiting for you`, '/m/#/sessions');
    }
  }
  async function needsInputPrompts() {
    if (!sessions) return;
    let rows = []; try { rows = await sessions(); } catch { return; }
    const was = new Set(S('waiting', null) || []), first = S('waiting', null) === null;
    const now_ = rows.filter((r) => r.alive && r.state === 'waiting').map((r) => r.id);
    put('waiting', now_);
    if (first) return;
    for (const r of rows) {
      if (!r.alive || r.state !== 'waiting' || was.has(r.id)) continue;
      const h = harnessOf(r.harness), proj = nameOf(r.project || path.basename(String(r.cwd || '')), 'a project');
      emit('needs_input', `${h}:${proj}`, 'Needs input', `${h} in ${proj} is waiting for you`, `/m/#/thread/${encodeURIComponent(/^[\w:.-]{1,80}$/.test(String(r.id)) ? r.id : '')}`);
    }
  }
  function watcherReply() {
    const n = tail('watcher-in', P.watcherIn).filter((l) => typeof l.reply === 'string').length;
    if (n) emit('watcher_reply', 'watcher', 'The watcher replied', n === 1 ? 'One new reply in the Watcher thread' : `${n} new replies in the Watcher thread`, '/m/#/watcher');
  }
  function askIds(j) {
    const list = Array.isArray(j) ? j : Array.isArray(j?.asks) ? j.asks : Array.isArray(j?.items) ? j.items : j && typeof j === 'object' ? Object.entries(j).map(([id, v]) => ({ id, ...(v && typeof v === 'object' ? v : {}) })) : [];
    return list.filter((a) => a && a.id != null && !a.done && !a.answered).map((a) => String(a.id).slice(0, 80));
  }
  function watcherAsk() {
    const j = readJson(P.watcherAsks);
    if (j === null && !statOf(P.watcherAsks)) return;
    const ids = askIds(j), was = S('asks', null);
    put('asks', [...new Set([...(was || []), ...ids])].slice(-500));
    if (was === null) return;
    const fresh = ids.filter((id) => !was.includes(id));
    if (fresh.length) emit('watcher_ask', `ask:${fresh.at(-1)}`, 'The watcher asks you something', fresh.length === 1 ? 'A new ask is open in Approvals' : `${fresh.length} new asks are open in Approvals`, '/m/#/approvals');
  }
  function fromSnapshot(snap) {
    const projects = Array.isArray(snap?.projects) ? snap.projects : [];
    // plan_done
    const stages = S('stages', null), cur = Object.fromEntries(projects.map((p) => [String(p.dir), String(p.stage || '')]));
    put('stages', cur);
    if (stages) for (const [dir, st] of Object.entries(cur)) if (st === 'done' && stages[dir] && stages[dir] !== 'done') emit('plan_done', dir, 'Plan finished', `${nameOf(dir, 'A plan')} is done`, '/m/#/card/pipeline');
    // audit_score: AUDIT.md files the snapshot points at (plan rounds, feature-loop rounds)
    const files = [];
    for (const p of projects) {
      const dir = nameOf(p.dir, null); if (!dir) continue;
      const b = path.join(P.plansDir, dir, '_build');
      if (p.progress?.round && /^v\d+-r\d$/.test(p.progress.round)) files.push([dir, path.join(b, p.progress.round, 'AUDIT.md')]);
      if (Array.isArray(p.sub)) for (const f of lsDirs(path.join(b, 'features'))) for (const r of lsDirs(path.join(b, 'features', f)).filter((x) => /^r\d+$/.test(x))) files.push([dir, path.join(b, 'features', f, r, 'AUDIT.md')]);
    }
    const seen = S('audits', null), next = {};
    for (const [dir, f] of files) {
      const st = statOf(f); if (!st) continue;
      const prev = seen?.[f];
      if (prev && prev.mtime === Math.floor(st.mtimeMs)) { next[f] = prev; continue; }
      let pct = null; try { pct = auditScore(fs.readFileSync(f, 'utf8')); } catch {}
      next[f] = { mtime: Math.floor(st.mtimeMs), pct };
      if (seen && pct != null && (!prev || prev.pct !== pct)) emit('audit_score', `${dir}:${path.relative(P.plansDir, f)}`, `Audit ${pct}%`, `${dir}: new audit estimate ${pct}%`, '/m/#/card/builds');
    }
    put('audits', next);
    // gate_waiting: the open approvals count rises
    let open = null;
    try { const a = approvals ? approvals(0) : null; if (a?.items) open = a.items.filter((i) => !i.done).length; } catch {}
    if (open === null && Array.isArray(snap?.approvalCounts)) open = snap.approvalCounts.reduce((n, c) => n + (Number(c.openOwner ?? c.open) || 0), 0);
    if (open !== null) {
      const was = S('open', null); put('open', open);
      if (was !== null && open > was) emit('gate_waiting', `open:${open}`, 'Waiting for you', `${open} approval item${open === 1 ? '' : 's'} open`, '/m/#/approvals');
    }
    // driver_down: false on 2 checks in a row, once per outage
    if (typeof snap?.driverAlive === 'boolean') {
      const d = S('driver', { down: 0, sent: false });
      if (snap.driverAlive) put('driver', { down: 0, sent: false });
      else { d.down++; if (d.down >= 2 && !d.sent) { d.sent = emit('driver_down', 'driver', 'Driver is down', 'The run driver stopped. Nothing moves until it restarts.', '/m/#/card/status') || d.sent; } put('driver', d); }
    }
  }
  function blocked() {
    const keys = [];
    for (const dir of lsDirs(P.plansDir).filter((d) => /^\d\d-[\w.-]+$/.test(d))) {
      const b = path.join(P.plansDir, dir);
      if (statOf(path.join(b, 'BLOCKED'))) keys.push([dir, 'BLOCKED']);
      for (const f of lsDirs(path.join(b, '_build', 'features'))) if (statOf(path.join(b, '_build', 'features', f, 'BLOCKED'))) keys.push([dir, `features/${f}/BLOCKED`]);
      let md = ''; try { md = fs.readFileSync(path.join(b, '_build', 'DEFERRED.md'), 'utf8'); } catch {}
      for (const m of md.matchAll(/^##\s+(\S{1,40})/gm)) keys.push([dir, `deferred:${m[1]}`]);
    }
    const was = S('blocked', null), cur = keys.map(([d, k]) => `${d}|${k}`);
    put('blocked', cur);
    if (was === null) return;
    for (const [d, k] of keys) {
      if (was.includes(`${d}|${k}`)) continue;
      const isDef = k.startsWith('deferred:');
      emit('blocked', `${d}|${k}`, isDef ? 'New owner step' : 'Blocked', isDef ? `${d} added a step for you in DEFERRED.md` : `${d} is blocked`, '/m/#/card/status');
    }
  }
  function usageLimit() {
    const b = readJson(P.budget);
    if (!b) return;
    const hit = {};
    for (const l of Array.isArray(b.limits) ? b.limits : []) {
      const id = nameOf(l.id, null); if (!id) continue;
      const reached = l.reached === true || l.limited === true || (Array.isArray(l.windows) && l.windows.some((w) => Number(w.pct) >= 100));
      hit[id] = reached;
    }
    const was = S('limits', null); put('limits', hit);
    if (was === null) return;
    for (const [id, r] of Object.entries(hit)) if (r && !was[id]) emit('usage_limit', id, 'Usage limit reached', `${id} hit its usage limit; its agents pause`, '/m/#/card/providers');
  }

  let busy = false;
  async function poll() {
    if (busy) return [];
    busy = true; out.length = 0;
    try {
      const steps = [needsInputNotify, needsInputPrompts, watcherReply, watcherAsk, () => fromSnapshot(snapshot()), blocked, usageLimit];
      for (const f of steps) { try { await f(); } catch (e) { log.error('push events', f.name || 'snapshot', e.message); } }
      const evs = out.splice(0);
      for (const e of evs) { try { await notify(e); } catch (err) { log.error('push notify', e.type, err.message); } }
      return evs;
    } finally { busy = false; }
  }
  let timer = null;
  return {
    poll,
    start() { if (!timer) { timer = setInterval(() => { poll(); }, POLL_MS); timer.unref?.(); } return !!timer; },
    stop() { if (timer) clearInterval(timer); timer = null; },
    running: () => !!timer,
    _recent: recent,
  };
}
