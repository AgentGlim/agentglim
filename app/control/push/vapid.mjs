// VAPID (RFC 8292): one P-256 key pair per install, generated once into <data>/control/vapid.json (mode 0600), and the
// ES256 JWT the push service checks (aud = the push endpoint's origin, exp <= 12 h, sub = mailto: from control.json).
// node:crypto only. The private key never leaves this file's module (the phone gets the public key only).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const unb64u = (s) => Buffer.from(String(s), 'base64url');
export const MAX_EXP_S = 12 * 3600;

// raw keys {publicKey: 65-byte uncompressed point, privateKey: 32 bytes} -> a KeyObject for signing
export function privateKeyObject({ publicKey, privateKey }) {
  const pub = unb64u(publicKey), d = unb64u(privateKey);
  if (pub.length !== 65 || pub[0] !== 4 || d.length !== 32) throw new Error('vapid: bad key material');
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: b64u(d) }, format: 'jwk' });
}

export function generateVapid() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = privateKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), unb64u(j.x), unb64u(j.y)]);
  return { publicKey: b64u(pub), privateKey: j.d, created: Date.now() };
}

// load or create vapid.json; a file with a wider mode is tightened to 0600
export function loadVapid(dataDir) {
  const file = path.join(dataDir, 'vapid.json');
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    privateKeyObject(v); // throws on a broken file
    try { if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600); } catch {}
    return { ...v, file };
  } catch (e) {
    if (fs.existsSync(file) && e.code !== 'ENOENT') {
      // never overwrite a key the phone may already be subscribed with: move it aside
      fs.renameSync(file, `${file}.broken-${Date.now()}`);
    }
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const v = generateVapid();
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return { ...v, file };
}

// the JWT: header {typ: JWT, alg: ES256}, claims {aud, exp, sub}; signature is r||s (JOSE), not DER
export function vapidJwt({ aud, sub, keys, expSeconds = MAX_EXP_S, now = Date.now() }) {
  if (!/^https?:\/\/[^/]+$/.test(aud)) throw new Error('vapid: aud must be an origin');
  if (!/^mailto:[^\s@]+@[^\s@]+$|^https:\/\/\S+$/.test(sub || '')) throw new Error('vapid: sub must be mailto: or https:');
  const exp = Math.floor(now / 1000) + Math.min(MAX_EXP_S, Math.max(60, expSeconds));
  const enc = (o) => b64u(Buffer.from(JSON.stringify(o)));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud, exp, sub })}`;
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: privateKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${b64u(sig)}`;
}

export function authorizationHeader({ endpoint, sub, keys, now }) {
  const aud = new URL(endpoint).origin;
  return `vapid t=${vapidJwt({ aud, sub, keys, now })}, k=${keys.publicKey}`;
}

// verify a JWT against a raw public key (the fake push service and tests use this)
export function verifyVapidJwt(jwt, publicKeyB64u) {
  const [h, c, s] = String(jwt).split('.');
  if (!h || !c || !s) return null;
  const pub = unb64u(publicKeyB64u);
  if (pub.length !== 65) return null;
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, unb64u(s));
  if (!ok) return null;
  try { return { header: JSON.parse(unb64u(h)), claims: JSON.parse(unb64u(c)) }; } catch { return null; }
}
