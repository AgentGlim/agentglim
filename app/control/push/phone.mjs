// Sub-item 03: the phone's server side. Mounted by control.mjs after 02's remote listener exists.
//   Remote routes (02's addRoute: device cookie + unlock + Origin/JSON + rate limits already passed):
//     GET  /api/remote/phone-snapshot           reduced snapshot for the Dashboard cards
//     GET  /api/remote/approvals                open approval items        POST /api/remote/approvals {id, done, note}
//     GET  /api/remote/push                     VAPID public key, per-type switches, subscription count, last test
//     POST /api/remote/push/subscribe {subscription} | push/unsubscribe {endpoint} | push/prefs {types} | push/test
//     GET  /app/version.json, GET /app/observatory-<versionCode>.apk (the signed TWA, data/control/app/)
//     GET  /lib/chat.js, /lib/ansi.js            01's thread renderer, shared with the Control page
//     POST /api/<anything not remote>           403 desktop_only (the forwarded /m/desktop page's own buttons)
//   Desktop routes (/api/control/push..., /api/control/app; loopback only): defaults, test push, version + sha256.
//   Push: notify(event) sends to every subscription whose device has that type on (device switch, else default).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { json, sendStatic, SEC_HEADERS } from '../http-util.mjs';
import { loadVapid } from './vapid.mjs';
import { makeSender, endpointProblem, MAX_PLAINTEXT } from './webpush.mjs';
import { makePushStore, TYPES, TYPE_LABELS } from './store.mjs';
import { makeEvents } from './events.mjs';
import { phoneSnapshot } from './phone-snapshot.mjs';

const APK_RE = /^observatory-(\d{1,9})\.apk$/;
export const DESKTOP_POSTS = /^\/api\/(approvals|status-refresh|mode|speed|owner-claim|classes|prices|review-reject|agy-override|model-icons)$/;
const TTL = { needs_input: 3600, watcher_reply: 6 * 3600, watcher_ask: 24 * 3600, test: 600 };

export function readVersion(appDir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(appDir, 'version.json'), 'utf8'));
    if (!Number.isInteger(v.versionCode) || !/^[a-f0-9]{64}$/.test(String(v.sha256))) return null;
    return { versionCode: v.versionCode, versionName: String(v.versionName || v.versionCode).slice(0, 40), sha256: v.sha256, size: Number(v.size) || 0, builtAt: v.builtAt || null };
  } catch { return null; }
}

// a payload within the 3,000-byte cap: {type, title, body, url, tag}, names only (built by events.mjs)
export function payloadOf(e) {
  const p = { type: String(e.type), title: String(e.title || '').slice(0, 80), body: String(e.body || '').slice(0, 240), url: /^\/m\/[\w#/?=&%:.-]*$/.test(e.url || '') ? e.url : '/m/', tag: String(e.tag || e.type).slice(0, 120) };
  while (Buffer.byteLength(JSON.stringify(p)) > MAX_PLAINTEXT) p.body = p.body.slice(0, -16);
  return p;
}

export function mountPhone({ cfg, store, remote, audit, dataDir, plansDir, runDir, webDir, snapshot = null, approvals = null, markDone = null, sessions = null,
  pushTransport = undefined, allowLoopbackHttp = false, notifyLog = null, watcherAsks = null, now = () => Date.now(), log = console }) {
  const db = store.db;
  const pstore = makePushStore(db, { now, configTypes: () => cfg.load().push?.types });
  let vapid = null;
  const keys = () => (vapid ||= loadVapid(dataDir));
  const appDir = path.join(dataDir, 'app');
  const devInsecure = () => cfg.load().remote?.devInsecure === true;
  const loopOk = () => allowLoopbackHttp || devInsecure();
  let sender = null;
  const getSender = () => (sender ||= makeSender({ vapid: keys(), subject: cfg.load().push?.subject || 'mailto:owner@localhost', transport: pushTransport, allowLoopbackHttp: loopOk(), now }));

  async function sendTo(subs, payload, { type, test = false }) {
    const results = [];
    for (const s of subs) {
      const r = await getSender().send({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, payload, { urgency: type === 'needs_input' ? 'high' : 'normal', topic: payload.tag, ttl: TTL[type] || 3 * 3600 });
      if (r.gone) pstore.dropSub(s.id); else if (r.ok) pstore.markOk(s.id); else if (!r.deferred) pstore.markFail(s.id);
      pstore.log({ deviceId: s.device_id, subId: s.id, type, status: r.status, test });
      results.push({ sub: s.id, status: r.status, gone: !!r.gone, retryAfter: r.retryAfter ?? null, error: r.error ? String(r.error).slice(0, 80) : null });
    }
    return results;
  }
  // one event -> every subscribed device that has the type on
  async function notify(e) {
    if (!TYPES.includes(e.type)) return [];
    const payload = payloadOf(e), all = pstore.subs(), byDev = new Map();
    for (const s of all) { if (!byDev.has(s.device_id)) byDev.set(s.device_id, pstore.prefs(s.device_id).types[e.type] === true); }
    const subs = all.filter((s) => byDev.get(s.device_id) && remote.pairing.get(s.device_id) && !remote.pairing.get(s.device_id).disabled);
    const r = await sendTo(subs, payload, { type: e.type });
    audit({ listener: 'push', action: `push:${e.type}`, target: e.type, result: `sent:${r.filter((x) => x.status >= 200 && x.status < 300).length}/${r.length}`, bytes: Buffer.byteLength(JSON.stringify(payload)) });
    return r;
  }

  const events = makeEvents({ store, pstore, notify, snapshot: () => { try { return snapshot ? snapshot() : null; } catch { return null; } }, sessions, approvals, now, log,
    paths: { notifyLog: notifyLog || `${process.env.HOME}/.local/state/agent-notify/log.jsonl`, watcherIn: path.join(dataDir, 'watcher-in.ndjson'),
      watcherAsks: watcherAsks || path.join(dataDir, '..', 'watcher-asks.json'), budget: path.join(runDir, 'budget.json'), plansDir } });

  const openItems = () => {
    let items = []; try { items = approvals ? approvals(0)?.items || [] : []; } catch {}
    return items.filter((i) => !i.done).slice(0, 200).map((i) => ({ id: String(i.id).slice(0, 200), kind: String(i.kind || 'item').slice(0, 20), project: String(i.project || String(i.id).split(':')[0] || '').slice(0, 64), title: String(i.title || i.id).slice(0, 240) }));
  };
  const pushState = (deviceId) => {
    const p = pstore.prefs(deviceId);
    return { vapidPublicKey: keys().publicKey, types: p.types, own: p.own, defaults: pstore.defaults(), labels: TYPE_LABELS, order: TYPES,
      subscriptions: deviceId ? pstore.subs(deviceId).length : pstore.subs().length, lastTest: pstore.lastTest() };
  };
  const testPayload = () => payloadOf({ type: 'test', title: 'Test notification', body: 'Push from the Run Observatory works.', url: '/m/#/settings', tag: 'test' });

  // ---- remote routes
  const R = (method, re, fn) => remote.addRoute(method, re, fn);
  R('GET', /^\/api\/remote\/phone-snapshot$/, (req, res) => {
    let snap = null; try { snap = snapshot ? snapshot() : null; } catch (e) { log.error('phone snapshot', e.message); }
    let ap = null; try { ap = approvals ? approvals(0) : null; } catch {}
    return json(res, 200, phoneSnapshot(snap, { now: now(), approvals: ap }));
  });
  R('GET', /^\/api\/remote\/approvals$/, (req, res) => json(res, 200, { items: openItems() }));
  R('POST', /^\/api\/remote\/approvals$/, (req, res, { body, device }) => {
    const id = typeof body.id === 'string' && body.id.length < 200 ? body.id : null;
    const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : '';
    if (!id || !markDone) return json(res, 422, { error: 'unknown item' });
    let r = null; try { r = markDone(id, body.done !== false, note); } catch (e) { log.error('markDone', e.message); }
    const known = openItems().some((i) => i.id === id) || !!r;
    audit({ listener: 'remote', action: 'approvals:markDone', target: known ? id.slice(0, 80) : 'unknown', result: r ? 'ok' : 'refused:unknown item', bytes: Buffer.byteLength(note), deviceId: device.id });
    return r ? json(res, 200, { id, ...r }) : json(res, 422, { error: 'unknown or closed item' });
  });
  R('GET', /^\/api\/remote\/push$/, (req, res, { device }) => json(res, 200, pushState(device.id)));
  R('POST', /^\/api\/remote\/push\/subscribe$/, (req, res, { body, device }) => {
    const s = body.subscription || {};
    const sub = { endpoint: String(s.endpoint || ''), p256dh: String(s.keys?.p256dh || ''), auth: String(s.keys?.auth || '') };
    const prob = endpointProblem(sub.endpoint, { allowLoopbackHttp: loopOk() });
    if (prob) return json(res, 422, { error: prob });
    let pk, au; try { pk = Buffer.from(sub.p256dh, 'base64url'); au = Buffer.from(sub.auth, 'base64url'); } catch { pk = au = Buffer.alloc(0); }
    if (pk.length !== 65 || pk[0] !== 4 || au.length !== 16) return json(res, 422, { error: 'subscription keys must be p256dh (65 bytes) and auth (16 bytes)' });
    try { const e = crypto.createECDH('prime256v1'); e.generateKeys(); e.computeSecret(pk); } catch { return json(res, 422, { error: 'p256dh is not a P-256 point' }); }
    pstore.subscribe(device.id, sub, crypto.randomBytes(12).toString('hex'));
    audit({ listener: 'remote', action: 'push:subscribe', target: device.id, result: `ok:${new URL(sub.endpoint).hostname.slice(0, 60)}` });
    return json(res, 200, { ok: true, ...pushState(device.id) });
  });
  R('POST', /^\/api\/remote\/push\/unsubscribe$/, (req, res, { body, device }) => {
    const n = pstore.unsubscribe(device.id, String(body.endpoint || ''));
    audit({ listener: 'remote', action: 'push:unsubscribe', target: device.id, result: `ok:${n}` });
    return json(res, 200, { ok: true, removed: n, ...pushState(device.id) });
  });
  R('POST', /^\/api\/remote\/push\/prefs$/, (req, res, { body, device }) => {
    const n = pstore.setPrefs(device.id, body.types);
    audit({ listener: 'remote', action: 'push:prefs', target: device.id, result: `ok:${n}` });
    return json(res, 200, { ok: true, ...pushState(device.id) });
  });
  R('POST', /^\/api\/remote\/push\/test$/, async (req, res, { device }) => {
    const subs = pstore.subs(device.id);
    if (!subs.length) return json(res, 409, { error: 'this phone has no push subscription: turn notifications on first' });
    const r = await sendTo(subs, testPayload(), { type: 'test', test: true });
    audit({ listener: 'remote', action: 'push:test', target: device.id, result: `sent:${r.map((x) => x.status).join(',')}` });
    return json(res, 200, { ok: r.some((x) => x.status >= 200 && x.status < 300), results: r });
  });
  R('GET', /^\/app\/version\.json$/, (req, res) => { const v = readVersion(appDir); return v ? json(res, 200, v) : json(res, 404, { error: 'no APK built yet' }); });
  R('GET', /^\/app\/observatory-\d{1,9}\.apk$/, (req, res, { route }) => {
    const name = route.slice('/app/'.length), v = readVersion(appDir), f = path.join(appDir, name);
    if (!APK_RE.test(name) || !fs.existsSync(f)) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': 'application/vnd.android.package-archive', 'content-disposition': `attachment; filename="${name}"`, 'content-length': String(fs.statSync(f).size), ...(v && Number(name.match(APK_RE)[1]) === v.versionCode ? { 'x-sha256': v.sha256 } : {}), 'cache-control': 'no-store' });
    audit({ listener: 'remote', action: 'app:download', target: name, result: 'ok' });
    fs.createReadStream(f).pipe(res);
  });
  R('GET', /^\/lib\/(chat|ansi)\.js$/, (req, res, { route }) => sendStatic(res, webDir, route.slice('/lib/'.length)));
  // the write routes of the desktop dashboard (base server.mjs); other paths keep 02's plain 404
  R('POST', DESKTOP_POSTS, (req, res) => {
    audit({ listener: 'remote', action: 'remote:desktop-post', target: 'desktop-page', result: 'refused:desktop_only' });
    return json(res, 403, { error: 'desktop_only', hint: 'the phone has its own write paths' });
  });

  // ---- desktop routes: /api/control/push, /api/control/push/defaults, /api/control/push/test, /api/control/app
  async function desktop(req, res, r, readBody) {
    const GET = req.method === 'GET', POST = req.method === 'POST';
    if (GET && r === 'push') return json(res, 200, { ...pushState(null), recent: pstore.recent(20), polling: events.running() });
    if (POST && r === 'push/defaults') {
      const b = await readBody(req, 2048);
      const n = pstore.setPrefs('default', b.types);
      audit({ listener: 'desktop', action: 'push:defaults', target: 'push_prefs', result: `ok:${n}` });
      return json(res, 200, { ok: true, ...pushState(null) });
    }
    if (POST && r === 'push/test') {
      const subs = pstore.subs();
      if (!subs.length) return json(res, 409, { error: 'no phone is subscribed yet' });
      const x = await sendTo(subs, testPayload(), { type: 'test', test: true });
      audit({ listener: 'desktop', action: 'push:test', target: 'all', result: `sent:${x.map((y) => y.status).join(',')}` });
      return json(res, 200, { ok: x.some((y) => y.status >= 200 && y.status < 300), results: x });
    }
    if (GET && r === 'app') {
      const v = readVersion(appDir);
      return json(res, 200, { version: v, apk: v ? `/app/observatory-${v.versionCode}.apk` : null, remoteOrigin: remote.settings().origin, assetlinks: fs.existsSync(path.join(appDir, 'assetlinks.json')) });
    }
    return json(res, 404, { error: 'not found' });
  }

  // the poller runs while the remote listener is on (it is what the phone is for)
  function maybeStart() { const c = cfg.load(); if (c.remote?.enabled && c.push?.enabled !== false) events.start(); }
  return { desktop, notify, events, pstore, keys, maybeStart, stop: () => events.stop(), payloadOf, phoneSnapshot: () => phoneSnapshot(snapshot ? snapshot() : null), SEC_HEADERS };
}
