// Remote listener (sub-item 02): a second http server on 127.0.0.1 (remote.port, 19100 live) that `tailscale serve`
// proxies HTTPS to. Every request passes, in order: method, Host == remote.host (421), Tailscale-User-Login allowlist
// (403), path allowlist (404), the device cookie (401 pair), POST CSRF rules (403/415), rate limits (429), the unlock
// cookie (401 unlock), step-up for kill / stop / new session (403 step_up). Remote API calls then run 01's own
// handlers (control.handle with listener "remote"); the read-only desktop routes are forwarded to the desktop
// listener over loopback. Desktop-only management (pairing, devices, remote settings) lives in `desktop()`.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { json, sendStatic, CSP } from '../http-util.mjs';
import { makePairing, AuthError, REGISTER_WINDOW_MS, cleanName } from './pairing.mjs';
import { makeUnlocks, STEP_UP_MS, sha256 } from './unlock.mjs';
import { makeWebAuthn } from './webauthn.mjs';
import { pinProblem, hashPin, verifyPin, PIN_LOCK_AFTER, PIN_LOCK_MS, PIN_DISABLE_AFTER } from './pin.mjs';
import { makeBuckets } from './buckets.mjs';

export const REMOTE_CSP = `${CSP}; manifest-src 'self'; worker-src 'self'; form-action 'self'`;
export const FORWARD_GET = Object.freeze(['/api/stream', '/api/snapshot', '/api/history', '/api/approvals', '/api/other-projects', '/api/fleet', '/api/modes', '/api/status-ask', '/model-icons.js']);
const DEV_COOKIE = 'obs_dev', UNLOCK_COOKIE = 'obs_unlock';
const DEV_MAX_AGE = 400 * 86400, UNLOCK_MAX_AGE = 12 * 3600;
const BODY_LIMIT = 24 * 1024;
// 01 routes the phone may call as /api/remote/<route> (same handlers, listener "remote")
const API_GET = [/^sessions$/, /^stream$/, /^config$/, /^thread\/[\w:.-]{1,80}$/, /^pane\/[\w:.-]{1,80}\/stream$/, /^launch\/options$/, /^watcher$/];
const API_POST = [/^send$/, /^prompt$/, /^signal$/, /^launch$/, /^watcher$/, /^pane\/[\w:.-]{1,80}\/keys$/];
const DESKTOP_ONLY = [/^config$/, /^audit$/, /^remote(\/.*)?$/, /^devices(\/.*)?$/, /^pair(\/.*)?$/];
const AUTH_RE = /^(me|pair|lock|webauthn\/(register|auth)\/(options|verify)|pin\/(set|unlock))$/;
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?$/;
export const validHost = (h) => typeof h === 'string' && h.length <= 253 && HOST_RE.test(h.toLowerCase());

export function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) { const i = part.indexOf('='); if (i > 0) { const k = part.slice(0, i).trim(); if (!(k in out)) out[k] = part.slice(i + 1).trim(); } }
  return out;
}

export function makeRemote({ cfg, store, audit, als, handle, dataDir, webDir, desktopPort = null, now = () => Date.now(), log = console }) {
  const db = store.db;
  const pairing = makePairing(db, { now });
  const unlocks = makeUnlocks(db, { now });
  const buckets = makeBuckets(db, { now });
  let L = null; // the running listener's {port, host}
  let server = null;
  const extra = []; // routes added by later sub-items: {method, re, auth, fn}

  // ---- effective settings for a listener
  function settings(over = L) {
    const c = cfg.load().remote || {};
    const port = Number(over?.port ?? c.port) || 19100;
    const host = String(over?.host ?? c.host ?? '').toLowerCase() || null;
    const devInsecure = c.devInsecure === true && port !== 19100;
    const allowLogins = (Array.isArray(c.allowLogins) ? c.allowLogins : []).map((x) => String(x).toLowerCase()).filter(Boolean);
    const requireLogin = allowLogins.length > 0 && c.requireTailscaleLogin !== false;
    const scheme = devInsecure ? 'http' : 'https';
    return { enabled: c.enabled === true, port, host, devInsecure, allowLogins, requireLogin, scheme, origin: host ? `${scheme}://${host}` : null, rpId: host ? host.replace(/:\d+$/, '') : null, listenerId: `${host}|${port}` };
  }
  const webauthn = makeWebAuthn(db, { now, rp: () => { const s = settings(); return { id: s.rpId, origin: s.origin, name: 'Run Observatory' }; } });

  // ---- one async job per key at a time (PIN checks per device)
  const chains = new Map();
  function serial(key, fn) {
    const run = (chains.get(key) || Promise.resolve()).then(fn);
    const tail = run.then(() => {}, () => {});
    chains.set(key, tail);
    tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
    return run;
  }

  // ---- open responses that passed the unlock (SSE streams above all). Auth is checked once per request, so a
  // stream would outlive a revoke, a lock, a PIN disable or the unlock's 15 min idle / 12 h limit (audit r1 M1).
  // Each is registered here and ended at once by those events, and by a sweep every SWEEP_MS that re-checks the
  // device row and the unlock row (without touching the unlock: a stream is not user activity).
  const SWEEP_MS = 15e3;
  const open = new Set(); // {res, deviceId, unlockSha}
  let sweepTimer = null;
  function track(res, deviceId, unlockSha) {
    const x = { res, deviceId, unlockSha };
    open.add(x);
    res.on('close', () => open.delete(x));
    return x;
  }
  function endStreams(pred, why) {
    let n = 0;
    for (const x of [...open]) {
      if (!pred(x)) continue;
      open.delete(x); n++;
      try { if (!x.res.writableEnded) x.res.end(); } catch {}
      try { x.res.socket?.destroy(); } catch {}
    }
    if (n) audit({ listener: 'remote', action: 'auth:stream-ended', target: null, result: `ok:${why}:${n}` });
    return n;
  }
  function sweep() {
    const devs = new Map();
    return endStreams((x) => {
      if (!devs.has(x.deviceId)) { const d = pairing.get(x.deviceId); devs.set(x.deviceId, !!d && !d.disabled); }
      return !devs.get(x.deviceId) || !unlocks.alive(x.unlockSha, x.deviceId);
    }, 'expired');
  }

  // ---- response helpers
  function cookie(name, value, maxAge, s) { return `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${s.devInsecure ? '' : '; Secure'}`; }
  function harden(res, route) {
    const ow = res.writeHead;
    res.writeHead = function (code, a, b) {
      const reason = typeof a === 'string' ? a : undefined;
      const src = (reason ? b : a) || {};
      const h = {};
      for (const [k, v] of Object.entries(src)) { const lk = k.toLowerCase(); if (!lk.startsWith('access-control-')) h[lk] = v; }
      for (const k of res.getHeaderNames()) if (k.startsWith('access-control-')) res.removeHeader(k);
      h['content-security-policy'] = res.obsCsp || REMOTE_CSP;
      h['x-content-type-options'] = 'nosniff';
      h['referrer-policy'] = 'no-referrer';
      h['x-frame-options'] = 'DENY';
      h['x-obs-remote'] = '1';
      if (route.startsWith('/api/remote/') || route.startsWith('/api/')) h['cache-control'] = 'no-store';
      return reason ? ow.call(this, code, reason, h) : ow.call(this, code, h);
    };
  }
  const notFound = (res) => { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found'); };

  function clientIp(req) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return (xff && /^[\d.:a-fA-F]{2,45}$/.test(xff) ? xff : req.socket?.remoteAddress || '') || null;
  }
  // the audit target of a refused request: a known route or its pattern, never client-chosen path text (audit r1 L1)
  function routeLabel(route) {
    if (typeof route !== 'string') return null;
    if (route.startsWith('/api/remote/')) {
      const a = route.slice('/api/remote/'.length);
      if (/^thread\/[\w:.-]{1,80}$/.test(a)) return '/api/remote/thread/:id';
      if (/^pane\/[\w:.-]{1,80}\/(stream|keys)$/.test(a)) return `/api/remote/pane/:id/${a.split('/').pop()}`;
      if (AUTH_RE.test(a) || [...API_GET, ...API_POST].some((re) => re.test(a)) || /^(config|audit|remote|devices|pair)$/.test(a)) return route;
      return '/api/remote/:other';
    }
    if (FORWARD_GET.includes(route) || route === '/m/desktop' || route === '/' || route === '/pair') return route;
    if (route.startsWith('/app/')) return '/app/:file';
    if (route.startsWith('/m/')) return '/m/:file';
    if (route.startsWith('/icons/')) return '/icons/:file';
    return ':other';
  }
  function deny(res, ctx, code, error, action, extraBody = {}, headers = {}) {
    audit({ listener: 'remote', ...ctx, action, target: routeLabel(ctx.route), result: `refused:${error}` });
    if (code === 429 && headers['retry-after']) res.setHeader('retry-after', headers['retry-after']);
    return json(res, code, { error, ...extraBody });
  }

  function readJson(req, limit = BODY_LIMIT) {
    return new Promise((ok, fail) => {
      let size = 0; const parts = []; let over = false;
      req.on('data', (c) => { if (over) return; size += c.length; if (size > limit) { over = true; parts.length = 0; fail(Object.assign(new Error('body too large'), { code: 413 })); setTimeout(() => { try { req.destroy(); } catch {} }, 1000).unref?.(); return; } parts.push(c); });
      req.on('end', () => {
        if (over) return;
        const s = Buffer.concat(parts).toString('utf8');
        if (!s) return ok({ body: {}, size: 0 });
        try { const v = JSON.parse(s); ok({ body: v && typeof v === 'object' && !Array.isArray(v) ? v : {}, size }); } catch { fail(Object.assign(new Error('bad json'), { code: 400 })); }
      });
      req.on('error', fail);
    });
  }

  // ---- static files the phone may load before the unlock
  function publicStatic(route) {
    if (route === '/pair' || route === '/pair/') return [webDir, 'pair.html'];
    if (route === '/pair/pair.js') return [webDir, 'pair.js'];
    if (route === '/pair/pair.css') return [webDir, 'pair.css'];
    if (route === '/pair/qr.js') return null;
    if (route === '/sw.js') return [webDir, 'sw.js'];
    if (route === '/manifest.webmanifest') return [webDir, 'manifest.webmanifest'];
    if (route === '/.well-known/assetlinks.json') return [path.join(dataDir, 'app'), 'assetlinks.json'];
    let m;
    if ((m = route.match(/^\/icons\/([\w.-]{1,80})$/))) return [path.join(webDir, 'icons'), m[1]];
    if (route === '/m' || route === '/m/') return [path.join(webDir, 'm'), 'index.html'];
    if (route !== '/m/desktop' && (m = route.match(/^\/m\/((?:[\w-]{1,40}\/){0,3}[\w.-]{1,80})$/)) && !m[1].includes('..')) return [path.join(webDir, 'm'), m[1]];
    return null;
  }

  // ---- forward a read-only GET to the desktop listener (loopback); /m/desktop is the dashboard page itself
  function forward(req, res, upstreamPath, ctx, isPage) {
    if (!desktopPort) return json(res, 503, { error: 'desktop listener unknown' });
    const up = http.request({ host: '127.0.0.1', port: desktopPort, path: upstreamPath, method: 'GET', agent: false,
      headers: { host: `127.0.0.1:${desktopPort}`, accept: String(req.headers.accept || '*/*').slice(0, 200), 'user-agent': 'observatory-remote' } }, (u) => {
      const h = {};
      for (const [k, v] of Object.entries(u.headers)) if (!['set-cookie', 'content-security-policy', 'x-frame-options', 'connection', 'keep-alive', 'transfer-encoding'].includes(k) && !k.startsWith('access-control-')) h[k] = v;
      if (!isPage) { res.writeHead(u.statusCode, h); u.pipe(res); return; }
      const parts = []; let size = 0;
      u.on('data', (c) => { size += c.length; if (size <= 8 * 1024 * 1024) parts.push(c); });
      u.on('end', () => {
        const html = Buffer.concat(parts).toString('utf8');
        // inline <script> blocks of the dashboard are allowed by their hashes; nothing else inline runs
        const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => `'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
        res.obsCsp = `default-src 'self'; script-src 'self' ${hashes.join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; manifest-src 'self'; worker-src 'self'`;
        delete h['content-length'];
        res.writeHead(u.statusCode, { ...h, 'cache-control': 'no-store' });
        res.end(html);
      });
    });
    up.on('error', (e) => { if (!res.headersSent) json(res, 502, { error: 'desktop listener unreachable' }); else try { res.end(); } catch {} void e; });
    up.setTimeout(60e3, () => up.destroy(new Error('timeout')));
    req.on('close', () => { if (!res.writableFinished) up.destroy(); });
    res.on('close', () => { if (!up.destroyed) up.destroy(); });
    up.end();
    void ctx;
  }

  // ---- the device behind a request (null when none / revoked)
  function deviceOf(req) { const c = parseCookies(req.headers.cookie); const d = pairing.byCookie(c[DEV_COOKIE]); return d && !d.disabled ? d : d ? { ...d, disabledRow: true } : null; }
  function unlockOf(req, dev) { const c = parseCookies(req.headers.cookie); return dev ? unlocks.check(c[UNLOCK_COOKIE], dev.id) : null; }
  function setUnlock(res, s, dev, method) { const v = unlocks.create(dev.id, method); res.setHeader('set-cookie', cookie(UNLOCK_COOKIE, v, UNLOCK_MAX_AGE, s)); }
  const canRegister = (dev, u) => (now() - dev.created < REGISTER_WINDOW_MS && webauthn.count(dev.id) === 0 && !dev.pin_hash) || unlocks.fresh(u);

  function rate(res, ctx, name, key) {
    const r = buckets.take(name, key);
    if (r.ok) return true;
    deny(res, ctx, 429, 'rate_limited', `rate:${name}`, { bucket: name, retryAfter: r.retryAfter }, { 'retry-after': String(r.retryAfter) });
    return false;
  }

  // ---- auth endpoints (device cookie, no unlock needed)
  async function authApi(req, res, r, body, ctx, s, dev, u) {
    const who = { listener: 'remote', ...ctx };
    if (r === 'me' && req.method === 'GET') {
      return json(res, 200, { paired: !!dev, device: dev ? { id: dev.id, name: dev.name } : null, unlocked: !!u, unlockExpiresIn: u?.expiresIn || 0,
        stepUpFresh: unlocks.fresh(u), stepUpMs: STEP_UP_MS, methods: dev ? { passkeys: webauthn.count(dev.id), pin: !!dev.pin_hash } : null,
        canRegister: dev ? canRegister(dev, u) : false, pinLockedUntil: dev && dev.pin_locked_until > now() ? dev.pin_locked_until : null, liveSend: cfg.liveSend() });
    }
    if (req.method !== 'POST') return null;
    if (r === 'pair') {
      if (!rate(res, ctx, 'pair', 'global')) return true;
      try {
        const x = pairing.exchange(body.token, s.listenerId, { name: body.name, userAgent: req.headers['user-agent'] });
        res.setHeader('set-cookie', cookie(DEV_COOKIE, x.cookie, DEV_MAX_AGE, s));
        audit({ ...who, deviceId: x.device.id, deviceName: x.device.name, action: 'auth:pair', target: x.device.id, result: 'ok' });
        return json(res, 200, { ok: true, device: { id: x.device.id, name: x.device.name }, next: 'register' });
      } catch (e) { return authFail(res, who, 'auth:pair', e); }
    }
    if (!dev) return deny(res, ctx, 401, 'pair', 'auth:no-device');
    if (r === 'lock') { const lc = parseCookies(req.headers.cookie)[UNLOCK_COOKIE]; unlocks.drop(lc); if (typeof lc === 'string') { const sh = sha256(lc); endStreams((x) => x.unlockSha === sh, 'lock'); } res.setHeader('set-cookie', cookie(UNLOCK_COOKIE, '', 0, s)); audit({ ...who, action: 'auth:lock', target: dev.id, result: 'ok' }); return json(res, 200, { ok: true }); }
    try {
      if (r === 'webauthn/register/options') {
        if (!canRegister(dev, u)) throw new AuthError(403, 'step_up');
        return json(res, 200, { publicKey: webauthn.registrationOptions(dev) });
      }
      if (r === 'webauthn/register/verify') {
        if (!canRegister(dev, u)) throw new AuthError(403, 'step_up');
        const x = webauthn.verifyRegistration(dev, body.credential);
        if (u) unlocks.stepUp(u.idSha, 'passkey'); else setUnlock(res, s, dev, 'passkey');
        audit({ ...who, action: 'auth:passkey-register', target: dev.id, result: `ok:alg${x.alg}` });
        return json(res, 200, { ok: true, unlocked: true });
      }
      if (r === 'webauthn/auth/options') {
        if (!webauthn.count(dev.id)) throw new AuthError(409, 'no passkey on this device');
        return json(res, 200, { publicKey: webauthn.assertionOptions(dev) });
      }
      if (r === 'webauthn/auth/verify') {
        webauthn.verifyAssertion(dev, body.credential);
        db.prepare('update devices set pin_fails = 0 where id = ?').run(dev.id);
        if (u) unlocks.stepUp(u.idSha, 'passkey'); else setUnlock(res, s, dev, 'passkey');
        audit({ ...who, action: u ? 'auth:step-up' : 'auth:unlock', target: dev.id, result: 'ok:passkey' });
        return json(res, 200, { ok: true, unlocked: true });
      }
      if (r === 'pin/set') {
        if (!canRegister(dev, u)) throw new AuthError(403, 'step_up');
        const p = pinProblem(body.pin); if (p) throw new AuthError(422, p);
        const h = await hashPin(body.pin);
        db.prepare('update devices set pin_hash = ?, pin_salt = ?, pin_fails = 0, pin_locked_until = 0 where id = ?').run(h.hash, h.salt, dev.id);
        if (u) unlocks.stepUp(u.idSha, 'pin'); else setUnlock(res, s, dev, 'pin');
        audit({ ...who, action: 'auth:pin-set', target: dev.id, result: 'ok' });
        return json(res, 200, { ok: true, unlocked: true });
      }
      if (r === 'pin/unlock') {
        // one PIN check per device at a time, and the failure counter goes up before scrypt runs: parallel guesses
        // cannot all read the same count (audit r1 H1). The lock / disable state is re-read inside the critical section.
        return await serial(`pin:${dev.id}`, async () => {
          const d = pairing.get(dev.id);
          if (!d) throw new AuthError(401, 'pair');
          if (d.disabled) throw new AuthError(401, 'device_disabled');
          if (!d.pin_hash) throw new AuthError(409, 'no PIN on this device');
          if (d.pin_locked_until > now()) { const ra = Math.ceil((d.pin_locked_until - now()) / 1000); res.setHeader('retry-after', String(ra)); throw new AuthError(429, 'pin_locked', { retryAfter: ra }); }
          if (!rate(res, ctx, 'pin', dev.id)) return true;
          const fails = db.prepare('update devices set pin_fails = pin_fails + 1 where id = ? returning pin_fails').get(dev.id).pin_fails;
          if (await verifyPin(body.pin, d.pin_hash, d.pin_salt)) {
            buckets.refund('pin', dev.id);
            db.prepare('update devices set pin_fails = 0, pin_locked_until = 0 where id = ?').run(dev.id);
            if (u) unlocks.stepUp(u.idSha, 'pin'); else setUnlock(res, s, dev, 'pin');
            audit({ ...who, action: u ? 'auth:step-up' : 'auth:unlock', target: dev.id, result: 'ok:pin' });
            return json(res, 200, { ok: true, unlocked: true });
          }
          if (fails >= PIN_DISABLE_AFTER) {
            db.prepare('update devices set disabled = 1 where id = ?').run(dev.id);
            unlocks.dropDevice(dev.id);
            endStreams((x) => x.deviceId === dev.id, 'device_disabled');
            throw new AuthError(401, 'device_disabled', { fails });
          }
          const lock = fails % PIN_LOCK_AFTER === 0 ? now() + PIN_LOCK_MS : 0;
          if (lock) db.prepare('update devices set pin_locked_until = ? where id = ?').run(lock, dev.id);
          throw new AuthError(401, lock ? 'pin_wrong_locked' : 'pin_wrong', { triesBeforeLock: lock ? 0 : PIN_LOCK_AFTER - (fails % PIN_LOCK_AFTER), lockedUntil: lock || null });
        });
      }
    } catch (e) { return authFail(res, who, `auth:${r.replace(/\//g, '-')}`, e); }
    return null;
  }
  function authFail(res, who, action, e) {
    if (!(e instanceof AuthError)) { log.error('remote auth', action, e.message); e = new AuthError(500, 'internal error'); }
    audit({ ...who, action, target: who.deviceId || null, result: `refused:${e.reason}` });
    const { code, reason, ...rest } = e; void code; void reason;
    const body = { error: e.reason }; for (const k of ['triesBeforeLock', 'lockedUntil', 'retryAfter', 'flagged']) if (rest[k] != null) body[k] = rest[k];
    return json(res, e.code, body);
  }

  // ---- the request pipeline
  async function onRequest(req, res) {
    const s = settings();
    let route; try { route = new URL(req.url, 'http://x').pathname; } catch { route = '/'; }
    harden(res, route);
    const ctx = { ip: clientIp(req), tsLogin: req.headers['tailscale-user-login'] ? String(req.headers['tailscale-user-login']).slice(0, 120) : null, route };
    const actx = () => ({ ip: ctx.ip, tsLogin: ctx.tsLogin, deviceId: ctx.deviceId, deviceName: ctx.deviceName, route });
    try {
      if (req.method !== 'GET' && req.method !== 'POST') { res.setHeader('allow', 'GET, POST'); return deny(res, actx(), 405, 'method not allowed', 'remote:method'); }
      const host = String(req.headers.host || '').toLowerCase();
      if (!s.host || host !== s.host) return deny(res, actx(), 421, 'bad host', 'remote:host-refused');
      if (s.requireLogin && !(ctx.tsLogin && s.allowLogins.includes(ctx.tsLogin.toLowerCase()))) return deny(res, actx(), 403, 'tailscale_login', 'remote:login-refused');
      if (route.includes('..') || route.includes('//') || route.includes('\\')) return notFound(res);

      // 1. public static shell
      const pub = req.method === 'GET' ? publicStatic(route) : null;
      if (pub) return sendStatic(res, pub[0], pub[1]);
      let api = null;
      if (route.startsWith('/api/remote/')) { try { api = decodeURIComponent(route.slice('/api/remote/'.length)); } catch { return notFound(res); } }
      const apiRaw = api === null ? null : route.slice('/api/remote/'.length);
      const fwd = req.method === 'GET' && (FORWARD_GET.includes(route) || route === '/m/desktop');
      const app = route.startsWith('/app/') && req.method === 'GET';
      const ext = extra.find((x) => x.method === req.method && x.re.test(route));
      if (api === null && !fwd && !app && !ext) return notFound(res);
      // unknown API routes are 404 before any auth (only known routes ask for the device or the unlock)
      if (api !== null && !ext && !AUTH_RE.test(api) && !DESKTOP_ONLY.some((re) => re.test(api)) && ![...API_GET, ...API_POST].some((re) => re.test(api))) return notFound(res);

      // 2. device
      const dev = deviceOf(req);
      if (dev?.disabledRow) return deny(res, actx(), 401, 'device_disabled', 'auth:disabled');
      if (dev) { ctx.deviceId = dev.id; ctx.deviceName = dev.name; pairing.touch(dev.id); }

      // 3. CSRF for state changes: exact Origin (missing refused), JSON only
      let body = {}, bodySize = 0;
      if (req.method === 'POST') {
        if (req.headers.origin !== s.origin) return deny(res, actx(), 403, 'bad_origin', 'remote:csrf-refused');
        if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) return deny(res, actx(), 415, 'json only', 'remote:csrf-refused');
        try { ({ body, size: bodySize } = await readJson(req)); } catch (e) { return deny(res, actx(), e.code || 400, e.message, 'remote:bad-body'); }
        req.obsBody = body; req.obsBodySize = bodySize;
      }

      // 4. rate limits per device (reads / writes)
      if (dev && !rate(res, actx(), req.method === 'GET' ? 'read' : 'write', dev.id)) return;
      const u = unlockOf(req, dev);

      // 5. auth endpoints
      if (api !== null && AUTH_RE.test(api)) {
        const done = await authApi(req, res, api, body, actx(), s, dev, u);
        if (done !== null) return;
        return notFound(res);
      }

      // 6. everything else needs the device and the unlock
      if (!dev) return deny(res, actx(), 401, 'pair', 'auth:no-device');
      if (!u) return deny(res, actx(), 401, 'unlock', 'auth:locked');
      track(res, dev.id, u.idSha);

      if (fwd) { const q = new URL(req.url, 'http://x').search; return forward(req, res, route === '/m/desktop' ? '/' : route + q, actx(), route === '/m/desktop'); }
      if (ext) return als.run(actx(), () => ext.fn(req, res, { device: dev, unlock: u, body, settings: s, route }));
      if (app) {
        const m = route.match(/^\/app\/([\w.-]{1,80})$/);
        if (!m) return notFound(res);
        return sendStatic(res, path.join(dataDir, 'app'), m[1]);
      }

      // 7. 01's handlers
      if (DESKTOP_ONLY.some((re) => re.test(api)) && !(req.method === 'GET' && api === 'config')) return deny(res, actx(), 403, 'desktop_only', 'remote:desktop-only');
      const allowed = (req.method === 'GET' ? API_GET : API_POST).some((re) => re.test(api));
      if (!allowed) return notFound(res);
      if (req.method === 'POST') {
        const sendish = api === 'send' || api === 'prompt' || /\/keys$/.test(api);
        const stepAct = (api === 'signal' && (body.action === 'kill' || body.action === 'pause')) || api === 'launch';
        if (stepAct && body.confirm && !unlocks.fresh(u)) {
          return deny(res, actx(), 403, 'step_up', 'auth:step-up-needed', { stepUpMs: STEP_UP_MS, confirm: 'kept' });
        }
        if (sendish && !rate(res, actx(), 'send', dev.id)) return;
        if (api === 'signal' && body.action === 'kill' && body.confirm && !rate(res, actx(), 'kill', dev.id)) return;
      }
      return als.run(actx(), () => handle(req, res, `/api/control/${apiRaw}`, { listener: 'remote' }));
    } catch (e) {
      log.error('remote listener', e.message);
      if (!res.headersSent) return json(res, 500, { error: 'internal error' });
      try { res.end(); } catch {}
    }
  }

  // ---- lifecycle
  function listen(opts = {}) {
    if (server) return server;
    const c = cfg.load().remote || {};
    const over = { port: opts.port ?? c.port, host: opts.host ?? c.host };
    const s = settings(over);
    if (!s.enabled && !opts.force) return null;
    if (!s.host || !validHost(s.host)) { log.error('control remote listener: remote.host is not set; not listening'); return null; }
    if (c.devInsecure === true && s.port === 19100) { log.error('control remote listener: devInsecure is refused on port 19100; not listening'); return null; }
    L = over;
    const srv = http.createServer((req, res) => { onRequest(req, res); });
    srv.on('error', (e) => { log.error('control remote listener', e.message); if (server === srv) { server = null; L = null; } });
    srv.listen(s.port, '127.0.0.1');
    server = srv;
    if (!sweepTimer) { sweepTimer = setInterval(sweep, SWEEP_MS); sweepTimer.unref?.(); }
    return srv;
  }
  function close() {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    open.clear();
    if (!server) return Promise.resolve();
    const srv = server; server = null; L = null;
    return new Promise((r) => { try { srv.closeAllConnections?.(); srv.close(() => r()); } catch { r(); } });
  }

  // ---- desktop-only management: /api/control/remote/<sub> on the desktop listener
  async function desktop(req, res, sub, readBody) {
    const GET = req.method === 'GET', POST = req.method === 'POST';
    const s = settings(L || undefined);
    if (GET && sub === 'state') {
      return json(res, 200, { enabled: s.enabled, host: s.host, port: s.port, allowLogins: s.allowLogins, requireTailscaleLogin: cfg.load().remote?.requireTailscaleLogin !== false,
        effectiveRequireLogin: s.requireLogin, devInsecure: s.devInsecure, listening: !!server?.listening, origin: s.origin, devices: pairing.list() });
    }
    if (POST && sub === 'pair') {
      if (!s.host) return json(res, 409, { error: 'set remote.host first' });
      const t = pairing.mint(s.listenerId);
      audit({ listener: 'desktop', action: 'pair:mint', target: s.host, result: 'ok' });
      return json(res, 200, { url: `${s.origin}/pair#t=${t.token}`, expiresAt: t.expiresAt, ttl: 300 });
    }
    if (POST && sub === 'revoke') {
      const b = await readBody(req, 1024);
      const d = pairing.get(b.id);
      if (!d) return json(res, 404, { error: 'unknown device' });
      pairing.revoke(d.id);
      endStreams((x) => x.deviceId === d.id, 'revoke');
      audit({ listener: 'desktop', action: 'device:revoke', target: d.id, deviceId: d.id, deviceName: d.name, result: 'ok' });
      return json(res, 200, { ok: true });
    }
    if (POST && sub === 'config') {
      const b = await readBody(req, 4096);
      const patch = {};
      if (b.enabled !== undefined) { if (typeof b.enabled !== 'boolean') return json(res, 422, { error: 'enabled must be true or false' }); patch.enabled = b.enabled; }
      if (b.host !== undefined) { const h = b.host === null || b.host === '' ? null : String(b.host).trim().toLowerCase(); if (h && !validHost(h)) return json(res, 422, { error: 'host must be a DNS name like pc.tailnet.ts.net' }); patch.host = h; }
      if (b.allowLogins !== undefined) {
        const list = (Array.isArray(b.allowLogins) ? b.allowLogins : String(b.allowLogins).split(/[\s,]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
        if (list.length > 20 || list.some((x) => !/^[^\s@]{1,64}@[^\s@]{1,190}$|^[\w.-]{1,64}@github$/.test(x))) return json(res, 422, { error: 'allowLogins: up to 20 Tailscale login names (user@example.com)' });
        patch.allowLogins = list;
      }
      if (b.requireTailscaleLogin !== undefined) { if (typeof b.requireTailscaleLogin !== 'boolean') return json(res, 422, { error: 'requireTailscaleLogin must be true or false' }); patch.requireTailscaleLogin = b.requireTailscaleLogin; }
      cfg.save({ remote: patch });
      audit({ listener: 'desktop', action: 'remote:config', target: 'control.json', result: `ok:${Object.keys(patch).join(',') || 'none'}` });
      // apply at once: restart the listener with the new settings (the Observatory restart does the same)
      await close();
      const srv = listen();
      return json(res, 200, { ok: true, listening: !!srv, ...settingsPublic() });
    }
    return json(res, 404, { error: 'not found' });
  }
  const settingsPublic = () => { const s = settings(); return { enabled: s.enabled, host: s.host, port: s.port, allowLogins: s.allowLogins }; };

  // later sub-items (03: phone snapshot, push) add remote routes here; auth: 'unlock' (default) is the only mode
  function addRoute(method, re, fn) { extra.push({ method, re, fn }); }

  function setDesktopPort(p) { desktopPort = Number(p) || null; }

  return { listen, close, desktop, addRoute, setDesktopPort, server: () => server, settings, pairing, unlocks, webauthn, buckets, onRequest, cleanName, sweep, endStreams, openCount: () => open.size };
}
