// Control module: mountControl(deps) -> { handle(req, res, route, opts), listenRemote(), close(), ... }
// Mounted by the Observatory (lazy, guarded import; see observatory-patch/) and by scripts/dev.mjs.
// Desktop listener: loopback, no auth (the Observatory's own rule). The remote listener (sub-item 02,
// auth/remote-mw.mjs) runs these same handlers with listener "remote" after its auth middleware; audit rows then
// carry the device, client ip and Tailscale login from an AsyncLocalStorage context.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { makeConfig } from './config.mjs';
import { hostAliases } from '../user-config.mjs';
import { openStore } from './store.mjs';
import { makeAudit } from './audit.mjs';
import { makeRateLimit } from './ratelimit.mjs';
import { json, readBody, sendStatic, sse, SEC_HEADERS } from './http-util.mjs';
import { makeProc } from './sessions/procscan.mjs';
import { makeTmux } from './sessions/tmux.mjs';
import { makeRegistry } from './sessions/registry.mjs';
import { makePrompts } from './sessions/prompts.mjs';
import { makeSignals } from './sessions/signals.mjs';
import { makeDelivery, Refusal, REASONS } from './sessions/deliver.mjs';
import { makeLauncher, listFolders, HARNESSES, CLAUDE_MODES } from './sessions/launch.mjs';
import { makeClaudeAdapter } from './sessions/claude.mjs';
import { makeCodexAdapter } from './sessions/codex.mjs';
import { makePiAdapter } from './sessions/pi.mjs';
import { makeOpencodeAdapter } from './sessions/opencode.mjs';
import { after } from './sessions/transcript.mjs';
import { makeChat, MAX_CHAT } from './watcher/chat.mjs';
import { makeActions } from './watcher/actions.mjs';
import { makeRemote } from './auth/remote-mw.mjs';
import { mountPhone } from './push/phone.mjs'; // sub-item 03: phone snapshot, push, APK routes

const NULL_TMUX = { listPanes: async () => [], capture: async () => { throw new Error('no tmux'); }, paste: async () => { throw new Error('no tmux'); }, sendKeys: async () => { throw new Error('no tmux'); }, hasSession: async () => false, newSession: async () => { throw new Error('no tmux'); }, newWindow: async () => { throw new Error('no tmux'); } };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, 'web');
const CONFIRM_MS = 60e3;
const SESSIONS_MS = 3000, PANE_MS = 1000;

export function mountControl(deps = {}) {
  const env = process.env;
  const dataDir = deps.controlDir || path.join(deps.dataDir || path.join(HERE, '..', 'data'), 'control');
  const plansDir = deps.plansDir || env.PLANS_DIR || path.join(os.homedir(), 'projects', 'dev', 'plans');
  const runDir = deps.runDir || path.join(plansDir, '_run');
  const cfg = makeConfig(dataDir);
  cfg.load(); // creates control.json with liveSend false on first mount
  const store = openStore(dataDir);
  const als = new AsyncLocalStorage();
  const auditRaw = makeAudit(store, dataDir);
  const audit = (row) => auditRaw({ ...(als.getStore() || {}), ...row }); // remote: device, ip, Tailscale login
  const rate = makeRateLimit({ perMin: 6 });
  const proc = deps.proc || makeProc(deps.procIO || deps.procRoot || env.PROC_ROOT || '/proc');
  // deps.tmux === null: no tmux at all (never falls back to the default server)
  const tmux = deps.tmux === null ? NULL_TMUX : deps.tmux || makeTmux(deps.tmuxOpts || {});
  const prompts = makePrompts({ notifyLog: deps.notifyLog || env.AGENT_NOTIFY_LOG || `${env.HOME}/.local/state/agent-notify/log.jsonl` });
  const adapters = {
    claude: makeClaudeAdapter({ claudeHome: deps.claudeHome || env.CLAUDE_HOME || `${env.HOME}/.claude` }),
    codex: makeCodexAdapter({ codexHome: deps.codexHome || env.CODEX_HOME || `${env.HOME}/.codex`, proc }),
    pi: makePiAdapter({ piHome: deps.piHome || env.PI_HOME || `${env.HOME}/.pi` }),
    opencode: makeOpencodeAdapter({ dbPath: deps.opencodeDb || env.OPENCODE_DB || `${env.HOME}/.local/share/opencode/opencode.db` }),
  };
  const registry = makeRegistry({ proc, tmux, cfg, adapters, prompts, claudeHome: deps.claudeHome || env.CLAUDE_HOME || `${env.HOME}/.claude`, plansDir,
    projectsRoots: deps.projectsRoots || [path.join(os.homedir(), 'dev', 'projects'), path.join(os.homedir(), 'projects', 'dev')], snapshot: deps.snapshot || null, selfPid: process.pid });
  const signals = makeSignals({ proc, kill: deps.kill || ((pid, sig) => process.kill(pid, sig)), killGraceMs: deps.killGraceMs ?? 5000 });
  const delivery = makeDelivery({ cfg, proc, tmux, prompts, rate, dataDir });
  const launcher = makeLauncher({ cfg, tmux, proc });
  const chat = makeChat({ dataDir, runDir });
  const statusRefresh = deps.statusRefresh || (deps.desktopPort ? () => loopbackPost(deps.desktopPort, '/api/status-refresh') : null);
  const actions = makeActions({ chat, plansDir, statusRefresh, modeRequest: deps.modeRequest, markDone: deps.markDone });

  // ---- sessions cache: built on demand and every 3 s while a stream client is connected (no client, no scan)
  let rows = [], builtAt = 0, building = null;
  async function sessions(maxAge = SESSIONS_MS) {
    if (Date.now() - builtAt < maxAge && rows.length) return rows;
    if (!building) building = registry.build().then((r) => { rows = r; builtAt = Date.now(); return r; }).finally(() => { building = null; });
    return building;
  }
  async function session(id) {
    if (typeof id !== 'string' || id.length > 80) return null;
    let s = (await sessions()).find((r) => r.id === id);
    if (!s) s = (await sessions(0)).find((r) => r.id === id);
    return s || null;
  }
  const publicRow = (r) => { const { transcript, socket, folded, runDir: _rd, ...rest } = r; return { ...rest, hasTranscript: !!transcript, hasSocket: !!socket }; };

  const streams = new Set();
  let timer = null;
  function tick() {
    sessions(0).then((r) => { const data = { at: Date.now(), liveSend: cfg.liveSend(), sessions: r.map(publicRow), watcherAt: chat.mtime() }; for (const s of streams) s.send('sessions', data); })
      .catch((e) => console.error('control sessions failed', e.message));
  }
  function startTimer() { if (!timer) { timer = setInterval(tick, SESSIONS_MS); timer.unref?.(); } }
  function stopTimer() { if (timer && !streams.size) { clearInterval(timer); timer = null; } }

  // ---- helpers
  const isDry = () => !cfg.liveSend();
  function refuse(res, e, action, target, bytes, listener) {
    const reason = e instanceof Refusal ? e.reason : e.code && e.code < 500 ? e.message : 'error';
    const code = e instanceof Refusal ? e.code : e.code && e.code < 600 ? e.code : 500;
    // a refused request's target is client input: log it only when it names a known session (sub-item 02 R7)
    const known = typeof target === 'string' && (target === 'watcher' || HARNESSES.includes(target) || rows.some((x) => x.id === target));
    audit({ listener, action, target: known ? target : 'unknown', result: `refused:${reason}`, bytes, dryRun: reason === REASONS.liveSendOff });
    if (code >= 500) console.error('control', action, e.message);
    return json(res, code, { error: reason === REASONS.liveSendOff ? 'live_send_off' : reason, reason });
  }
  function newConfirm(action, target, pids) {
    store.confirmGc(Date.now());
    const token = crypto.randomBytes(16).toString('hex');
    store.confirmPut({ token, action, target, pids, created: Date.now(), expires: Date.now() + CONFIRM_MS });
    return token;
  }
  function takeConfirm(token, action, target) {
    if (typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token)) return null;
    const c = store.confirmTake(token);
    if (!c || c.action !== action || c.target !== target || c.expires < Date.now()) return null;
    return c;
  }
  // DNS-rebinding guard (audit r1 M1): on the desktop listener the Control routes answer only a loopback Host
  // (127.0.0.1, localhost, [::1]) or an alias the owner configured (setup.json hostAliases, or deps.hostNames),
  // with the mount port when one was passed.
  const HOST_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]', ...hostAliases(deps.dataDir), ...(deps.hostNames || [])]);
  function hostOk(req) {
    const m = String(req.headers.host || '').toLowerCase().match(/^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/);
    if (!m || !HOST_NAMES.has(m[1])) return false;
    return !deps.desktopPort || Number(m[2] || 80) === Number(deps.desktopPort);
  }
  function postGuard(req, res) {
    if (req.method !== 'POST') return true;
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) { json(res, 403, { error: 'cross-origin' }); return false; }
    if (!/^application\/json\b/.test(String(req.headers['content-type'] || ''))) { json(res, 415, { error: 'json only' }); return false; }
    return true;
  }

  // ---- route handlers
  async function onSignal(req, res, b, listener) {
    const act = b.action, s = await session(b.id);
    if (!['interrupt', 'ctrlc', 'kill', 'pause', 'resume'].includes(act)) return json(res, 422, { error: 'unknown action' });
    try {
      delivery.liveGuard();
      if (!s || !s.pid || s.role === 'remote-note') throw new Refusal('unknown session', 404);
      delivery.identity(s);
      if (act === 'interrupt') {
        if (!s.pane) throw new Refusal(s.headless || s.source === 'run' ? REASONS.headless : REASONS.noPane);
        const r = await delivery.paneKey(s, 'Escape');
        audit({ listener, action: 'interrupt', target: s.id, result: 'ok' });
        return json(res, 200, { ok: true, ...r });
      }
      if (act === 'ctrlc') {
        if (s.pane) { const r = await delivery.paneKey(s, 'C-c'); audit({ listener, action: 'ctrlc', target: s.id, result: 'ok' }); return json(res, 200, { ok: true, ...r }); }
        const r = signals.interruptPid({ pid: s.pid, procStart: s.procStart });
        audit({ listener, action: 'ctrlc', target: s.id, result: r.sent.length ? 'ok:sigint' : 'dropped' });
        return json(res, 200, { ok: r.sent.length > 0, via: 'SIGINT', ...r });
      }
      if (act === 'resume') {
        const recorded = store.pausedGet(s.id);
        if (!recorded.length) throw new Refusal('nothing recorded as paused', 409);
        const r = signals.resume(recorded);
        store.pausedDrop(s.id);
        audit({ listener, action: 'resume', target: s.id, result: `ok:${r.sent.length}` });
        return json(res, 200, { ok: true, ...r });
      }
      // kill and pause (stop) need a confirm token from a first POST
      if (!b.confirm) {
        const tree = signals.snapshotTree(s.pid);
        if (!tree.length) throw new Refusal(REASONS.stopped);
        const token = newConfirm(act, s.id, tree);
        audit({ listener, action: `${act}:confirm`, target: s.id, result: `asked:${tree.length}` });
        return json(res, 200, { confirm: token, expiresIn: CONFIRM_MS / 1000, summary: { action: act, session: s.id, pids: tree.map((t) => t.pid), commands: tree.map((t) => `${t.pid} ${t.cmd || t.comm}`) } });
      }
      const c = takeConfirm(b.confirm, act, s.id);
      if (!c) throw new Refusal('confirm token unknown, used or expired', 409);
      if (act === 'pause') {
        const r = signals.pause(c.pids);
        store.pausedPut(s.id, c.pids.filter((p) => r.sent.includes(p.pid)), Date.now());
        audit({ listener, action: 'pause', target: s.id, result: `ok:${r.sent.length}` });
        return json(res, 200, { ok: true, ...r });
      }
      const k = signals.kill(c.pids);
      k.done.then((d) => audit({ listener, action: 'kill:sigkill', target: s.id, result: `ok:${d.kill.sent.length}` }));
      audit({ listener, action: 'kill', target: s.id, result: `ok:${k.term.sent.length}` });
      return json(res, 200, { ok: true, ...k.term, graceMs: deps.killGraceMs ?? 5000 });
    } catch (e) { return refuse(res, e, act, b.id, null, listener); }
  }

  async function onLaunch(req, res, b, listener) {
    try {
      delivery.liveGuard();
      if (!b.confirm) {
        const p = launcher.plan(b);
        const token = newConfirm('launch', `launch:${p.name}`, p);
        audit({ listener, action: 'launch:confirm', target: p.name, result: 'asked' });
        return json(res, 200, { confirm: token, name: p.name, expiresIn: CONFIRM_MS / 1000, summary: { window: `${p.session}:${p.name}`, dir: p.dir, argv: p.argv } });
      }
      const c = takeConfirm(b.confirm, 'launch', `launch:${b.name}`);
      if (!c) throw new Refusal('confirm token unknown, used or expired', 409);
      const r = await launcher.launch(c.pids);
      builtAt = 0;
      audit({ listener, action: 'launch', target: c.pids.name, result: 'ok' });
      return json(res, 200, { ok: true, ...r, id: r.pid ? `${c.pids.harness}:${r.pid}` : null });
    } catch (e) { return refuse(res, e, 'launch', b.harness, null, listener); }
  }

  async function handle(req, res, route, opts = {}) {
    const listener = opts.listener || 'desktop';
    try {
      if (listener === 'desktop' && !hostOk(req)) {
        audit({ listener, action: 'host-refused', target: 'host', result: 'refused:bad host' });
        return json(res, 421, { error: 'bad host' });
      }
      if (route === '/control' || route === '/control/') return sendStatic(res, WEB, 'control.html');
      if (route.startsWith('/control/')) {
        let rel; try { rel = decodeURIComponent(route.slice('/control/'.length)); } catch { res.writeHead(400, SEC_HEADERS); return res.end('bad path'); }
        if (rel.includes('..') || rel.startsWith('/') || /(^|\/)\./.test(rel)) { res.writeHead(404, SEC_HEADERS); return res.end('not found'); }
        return sendStatic(res, WEB, rel);
      }
      if (!route.startsWith('/api/control/')) { res.writeHead(404, SEC_HEADERS); return res.end('not found'); }
      if (listener === 'desktop' && !postGuard(req, res)) return; // the remote listener checked Origin and JSON itself
      let r; try { r = decodeURIComponent(route.slice('/api/control/'.length)); } catch { return json(res, 400, { error: 'bad path' }); }
      const GET = req.method === 'GET', POST = req.method === 'POST';

      if (GET && r === 'sessions') return json(res, 200, { at: Date.now(), liveSend: cfg.liveSend(), sessions: (await sessions()).map(publicRow) });
      if (GET && r === 'stream') {
        const send = sse(res);
        const client = { send }; streams.add(client); startTimer();
        req.on('close', () => { streams.delete(client); stopTimer(); });
        sessions(0).then((x) => send('sessions', { at: Date.now(), liveSend: cfg.liveSend(), sessions: x.map(publicRow), watcherAt: chat.mtime() })).catch(() => {});
        return;
      }
      if (GET && r === 'config') { const c = cfg.load(); return json(res, 200, { liveSend: c.liveSend, peer: { enabled: c.peer.enabled }, listener, canToggle: listener === 'desktop', xterm: fs.existsSync(path.join(WEB, 'vendor', 'xterm', 'xterm.js')) }); }
      if (POST && r === 'config') {
        if (listener !== 'desktop') return json(res, 403, { error: 'desktop only' });
        const b = await readBody(req, 1024);
        if (typeof b.liveSend !== 'boolean') return json(res, 422, { error: 'liveSend must be true or false' });
        const before = cfg.liveSend();
        cfg.save({ liveSend: b.liveSend });
        audit({ listener, action: 'liveSend', target: 'control.json', result: `${before}->${b.liveSend}` });
        tick();
        return json(res, 200, { liveSend: cfg.liveSend() });
      }
      if (GET && r === 'audit') { const n = Number(new URL(req.url, 'http://x').searchParams.get('limit')) || 50; return json(res, 200, { rows: store.auditList(Math.min(200, Math.max(1, n))) }); }
      if (r === 'push' || r.startsWith('push/') || r === 'app') { if (listener !== 'desktop') return json(res, 403, { error: 'desktop only' }); return phone.desktop(req, res, r, readBody); } // sub-item 03
      if (r.startsWith('remote/')) { if (listener !== 'desktop') return json(res, 403, { error: 'desktop only' }); return remote.desktop(req, res, r.slice('remote/'.length), readBody); }
      let m;
      if (GET && (m = r.match(/^thread\/([\w:.-]{1,80})$/))) {
        const s = await session(m[1]);
        if (!s) return json(res, 404, { error: 'unknown session' });
        const ad = adapters[s.harness];
        const out = ad ? after(ad.read(s), new URL(req.url, 'http://x').searchParams.get('after')) : { bubbles: [], cursor: 0 };
        return json(res, 200, { id: s.id, harness: s.harness, ...out });
      }
      if (GET && (m = r.match(/^pane\/([\w:.-]{1,80})\/stream$/))) {
        const s = await session(m[1]);
        if (!s || !s.pane) return json(res, 404, { error: s ? REASONS.noPane : 'unknown session' });
        const send = sse(res); let last = null, busy = false;
        const pull = async () => {
          if (busy) return; busy = true;
          try { const text = await tmux.capture(s.pane, { lines: 200 }); if (text !== last) { last = text; send('frame', { text, at: Date.now() }); } }
          catch { send('gone', { reason: REASONS.paneChanged }); clearInterval(t); }
          finally { busy = false; }
        };
        const t = setInterval(pull, PANE_MS); pull();
        req.on('close', () => clearInterval(t));
        return;
      }
      if (POST && (m = r.match(/^pane\/([\w:.-]{1,80})\/keys$/))) {
        const b = await readBody(req, 8192); const s = await session(m[1]);
        try { if (!s) throw new Refusal('unknown session', 404); const x = await delivery.keys(s, b.keys); audit({ listener, action: 'keys', target: s.id, result: 'ok', bytes: x.count }); return json(res, 200, { ok: true, ...x }); }
        catch (e) { return refuse(res, e, 'keys', m[1], Array.isArray(b.keys) ? b.keys.length : 0, listener); }
      }
      if (POST && r === 'send') {
        const b = await readBody(req, 20 * 1024); const s = await session(b.id);
        const bytes = typeof b.text === 'string' ? Buffer.byteLength(b.text) : 0;
        try { if (!s) throw new Refusal('unknown session', 404); const x = await delivery.deliver(s, b.text); audit({ listener, action: 'send', target: s.id, result: `ok:${x.via}`, bytes }); builtAt = 0; return json(res, 200, { ok: true, ...x }); }
        catch (e) { return refuse(res, e, 'send', b.id, bytes, listener); }
      }
      if (POST && r === 'prompt') {
        const b = await readBody(req, 2048); const s = await session(b.id);
        try { if (!s) throw new Refusal('unknown session', 404); const x = await delivery.answer(s, b.hash, b.option); audit({ listener, action: 'prompt', target: s.id, result: 'ok' }); builtAt = 0; return json(res, 200, { ok: true, ...x }); }
        catch (e) { return refuse(res, e, 'prompt', b.id, null, listener); }
      }
      if (POST && r === 'signal') return onSignal(req, res, await readBody(req, 2048), listener);
      if (GET && r === 'launch/options') {
        const c = cfg.load().launch;
        const opt = Object.fromEntries(HARNESSES.map((h) => [h, { models: c[h]?.models || [], efforts: (h === 'pi' ? c[h]?.thinking : c[h]?.efforts) || [], modes: h === 'claude' ? (c[h]?.modes || []).filter((x) => CLAUDE_MODES.includes(x)) : [] }]));
        return json(res, 200, { harnesses: HARNESSES, options: opt, folders: listFolders(c.roots || []), tmuxSession: c.tmuxSession || 'obs' });
      }
      if (POST && r === 'launch') return onLaunch(req, res, await readBody(req, 4096), listener);
      if (GET && r === 'watcher') {
        let plans = []; try { plans = fs.readdirSync(plansDir).filter((d) => /^\d\d-[\w.-]+$/.test(d)).sort(); } catch {}
        let gates = []; try { gates = deps.approvals ? (deps.approvals(0)?.items || []).filter((i) => i.kind === 'gate' && !i.done).slice(0, 50).map((i) => ({ id: i.id, title: String(i.title || i.id).slice(0, 160) })) : []; } catch {}
        return json(res, 200, { thread: chat.thread(), at: chat.mtime(), plans, gates });
      }
      if (POST && r === 'watcher') {
        const b = await readBody(req, 16 * 1024);
        try {
          if (b.action) { const x = await actions.run(b); audit({ listener, action: `watcher:${actName(b.action)}`, target: String(b.plan || b.key || b.id || b.qid || 'watcher').slice(0, 80), result: 'ok' }); return json(res, 200, { ok: true, ...x }); }
          if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > MAX_CHAT) return json(res, 422, { error: 'text required (max 8000 chars)' });
          const msg = chat.post({ text: b.text });
          let peer = null;
          // optional copy to the watcher's peer socket: only when enabled, recorded, and liveSend is on
          const w = rows.find((x) => x.role === 'watcher' && x.alive);
          if (w && cfg.load().peer?.enabled && cfg.liveSend()) { try { peer = (await delivery.deliver(w, b.text)).via; } catch (e) { peer = `refused: ${e.reason || e.message}`; } }
          audit({ listener, action: 'watcher:chat', target: 'watcher', result: 'ok', bytes: Buffer.byteLength(b.text) });
          return json(res, 200, { ok: true, ms: msg.ms, peer });
        } catch (e) { return refuse(res, e, `watcher:${b.action ? actName(b.action) : 'chat'}`, 'watcher', null, listener); }
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) return json(res, e.code && e.code < 500 ? e.code : 500, { error: e.code && e.code < 500 ? e.message : 'internal error' });
      try { res.end(); } catch {}
    }
  }

  // remote listener (sub-item 02): auth middleware in auth/remote-mw.mjs, then the same handlers as above
  const remote = makeRemote({ cfg, store, audit, als, handle, dataDir, webDir: WEB, desktopPort: deps.desktopPort || null });
  // sub-item 03: phone routes on the remote listener (02's addRoute) and push; the poller runs while the remote listener does
  const phone = mountPhone({ cfg, store, remote, audit, dataDir, plansDir, runDir, webDir: WEB, snapshot: deps.snapshot || null, approvals: deps.approvals || null,
    markDone: deps.markDone || null, sessions: () => sessions(), pushTransport: deps.pushTransport, allowLoopbackHttp: deps.pushAllowLoopback === true,
    notifyLog: deps.notifyLog || env.AGENT_NOTIFY_LOG || null, watcherAsks: deps.watcherAsks || null });
  function listenRemote(opts = {}) { const srv = remote.listen(opts); if (srv && deps.pushPoll !== false) phone.maybeStart(); return srv; }

  function close() {
    for (const s of streams) { try { s.send('bye', {}); } catch {} }
    streams.clear(); if (timer) clearInterval(timer); timer = null;
    phone.stop();
    const done = remote.close();
    store.close();
    return done;
  }

  return { handle, listenRemote, remote, phone, close, cfg, store, registry, sessions, delivery, signals, launcher, chat, actions, proc, tmux, dataDir, audit };
}

// audit rows carry only a known action name, never client text (audit r1 L4)
const actName = (a) => (typeof a === 'string' && /^[a-z][a-z-]{0,23}$/.test(a) ? a : 'other');

function loopbackPost(port, route) {
  return new Promise((ok, fail) => {
    const r = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { ok(JSON.parse(b)); } catch { ok({ status: res.statusCode }); } });
    });
    r.on('error', fail); r.setTimeout(30000, () => r.destroy(new Error('timeout'))); r.end('{}');
  });
}
