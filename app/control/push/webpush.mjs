// Web Push sender (RFC 8030 delivery, RFC 8291 aes128gcm payload encryption, RFC 8292 VAPID), node:crypto only.
//   encrypt(): ECDH(P-256) with the subscription's p256dh, HKDF-SHA256 with the auth secret and "WebPush: info",
//   one record (rs 4096) whose plaintext ends with the 0x02 last-record delimiter, header salt|rs|idlen|keyid.
//   send(): TTL (required), Urgency (high for needs_input), Topic per thread, Authorization: vapid t=..., k=...
//   404/410 -> the subscription is gone (caller deletes it); 429 -> Retry-After is honored per push-service origin.
// Endpoints must be https on a known push service; plain http only on loopback when the caller allows it (tests).
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { b64u, unb64u, authorizationHeader } from './vapid.mjs';

export const MAX_PLAINTEXT = 3000;          // our cap (RFC 8291 maximum for one 4096-byte record is 3993)
export const RECORD_SIZE = 4096;
export const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'notify.windows.com', 'push.apple.com'];
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function hkdf(ikm, salt, info, len) { return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len)); }

// RFC 8291 section 3.4: the key material for one message
export function deriveKeys({ ecdhSecret, authSecret, uaPublic, asPublic, salt }) {
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(ecdhSecret, authSecret, keyInfo, 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  return { keyInfo, ikm, cek, nonce };
}

// encrypt one payload for a subscription {p256dh, auth} (base64url). `asPrivate` and `salt` are for the RFC vector only.
export function encrypt(plaintext, { p256dh, auth }, { asPrivate = null, salt = null } = {}) {
  const pt = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  if (pt.length > MAX_PLAINTEXT) throw Object.assign(new Error(`push payload over ${MAX_PLAINTEXT} bytes`), { code: 'too_big' });
  const uaPublic = unb64u(p256dh), authSecret = unb64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('push: bad p256dh');
  if (authSecret.length !== 16) throw new Error('push: bad auth secret');
  const ecdh = crypto.createECDH('prime256v1');
  if (asPrivate) ecdh.setPrivateKey(unb64u(asPrivate)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const s = salt ? unb64u(salt) : crypto.randomBytes(16);
  const { cek, nonce } = deriveKeys({ ecdhSecret, authSecret, uaPublic, asPublic, salt: s });
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([pt, Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const header = Buffer.alloc(21); s.copy(header, 0); header.writeUInt32BE(RECORD_SIZE, 16); header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

// the receiving side (the fake push service and tests): {uaPrivate, uaPublic, auth} base64url
export function decrypt(buf, { uaPrivate, uaPublic, auth }) {
  const b = Buffer.from(buf);
  const salt = b.subarray(0, 16), rs = b.readUInt32BE(16), idlen = b[20];
  const asPublic = b.subarray(21, 21 + idlen), ct = b.subarray(21 + idlen);
  if (idlen !== 65 || ct.length < 17 || ct.length > rs) throw new Error('push: bad record');
  const ecdh = crypto.createECDH('prime256v1'); ecdh.setPrivateKey(unb64u(uaPrivate));
  const { cek, nonce } = deriveKeys({ ecdhSecret: ecdh.computeSecret(asPublic), authSecret: unb64u(auth), uaPublic: unb64u(uaPublic), asPublic, salt });
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = pt.length - 1; while (end >= 0 && pt[end] === 0) end--; // strip padding
  if (end < 0 || pt[end] !== 2) throw new Error('push: missing last-record delimiter');
  return { plaintext: pt.subarray(0, end), rs, salt: b64u(salt), asPublic: b64u(asPublic) };
}

// a Topic header value (<= 32 chars of the base64url alphabet) for a thread / card tag
export const topicOf = (tag) => crypto.createHash('sha256').update(String(tag)).digest('base64url').slice(0, 32);

export function endpointProblem(endpoint, { allowLoopbackHttp = false, hosts = PUSH_HOSTS } = {}) {
  let u; try { u = new URL(String(endpoint)); } catch { return 'endpoint is not a URL'; }
  if (String(endpoint).length > 1024) return 'endpoint too long';
  if (u.username || u.password) return 'endpoint has credentials';
  if (u.protocol === 'http:' && allowLoopbackHttp && LOOPBACK.has(u.hostname)) return null;
  if (u.protocol !== 'https:') return 'endpoint must be https';
  const h = u.hostname.toLowerCase();
  if (!hosts.some((x) => h === x || h.endsWith(`.${x}`))) return 'endpoint is not a known push service';
  return null;
}

// default transport: one POST with node:http(s), no keep-alive, 15 s timeout
export function httpTransport(url, { headers, body }) {
  return new Promise((ok, fail) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const rq = mod.request({ protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: 'POST', agent: false, headers }, (res) => {
      let t = ''; res.setEncoding('utf8'); res.on('data', (c) => { if (t.length < 4096) t += c; });
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, text: t }));
    });
    rq.on('error', fail); rq.setTimeout(15e3, () => rq.destroy(new Error('push timeout')));
    rq.end(body);
  });
}

export function retryAfterMs(v, now = Date.now()) {
  if (v == null || v === '') return 60e3;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.min(24 * 3600e3, Math.max(1e3, n * 1000));
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? Math.min(24 * 3600e3, Math.max(1e3, t - now)) : 60e3;
}

// makeSender({vapid, subject, transport, allowLoopbackHttp}) -> {send(sub, payload, opts)}
export function makeSender({ vapid, subject, transport = httpTransport, allowLoopbackHttp = false, now = () => Date.now() }) {
  const backoff = new Map(); // push-service origin -> retry-after deadline
  async function send(sub, payload, { urgency = 'normal', topic = null, ttl = 3600 } = {}) {
    const prob = endpointProblem(sub.endpoint, { allowLoopbackHttp });
    if (prob) return { status: 0, error: prob };
    const origin = new URL(sub.endpoint).origin;
    const until = backoff.get(origin) || 0;
    if (until > now()) return { status: 429, deferred: true, retryAfter: Math.ceil((until - now()) / 1000) };
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const body = encrypt(text, sub);
    const headers = {
      'content-type': 'application/octet-stream', 'content-encoding': 'aes128gcm', 'content-length': String(body.length),
      ttl: String(Math.max(0, Math.min(28 * 86400, Math.floor(ttl)))),
      urgency: ['very-low', 'low', 'normal', 'high'].includes(urgency) ? urgency : 'normal',
      authorization: authorizationHeader({ endpoint: sub.endpoint, sub: subject, keys: vapid, now: now() }),
    };
    if (topic) headers.topic = topicOf(topic);
    let r; try { r = await transport(sub.endpoint, { headers, body }); } catch (e) { return { status: 0, error: e.message }; }
    if (r.status === 429) { const ms = retryAfterMs(r.headers?.['retry-after'], now()); backoff.set(origin, now() + ms); return { status: 429, retryAfter: Math.ceil(ms / 1000) }; }
    if (r.status === 404 || r.status === 410) return { status: r.status, gone: true };
    return { status: r.status, ok: r.status >= 200 && r.status < 300 };
  }
  return { send, backoff };
}
