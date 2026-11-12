// WebAuthn (passkeys) with node:crypto only. Registration: attestation "none", residentKey "preferred",
// userVerification "required", ES256 (-7, P-256) and RS256 (-257). Assertion: clientDataJSON type, single-use
// challenge (2 min), exact origin, rpIdHash, UP and UV flags, signature over authData || sha256(clientDataJSON),
// COSE key -> JWK, sign-count regression -> refused and the passkey flagged.
import crypto from 'node:crypto';
import { decode } from './cbor.mjs';
import { AuthError } from './pairing.mjs';
import { b64u } from './unlock.mjs';

export const CHALLENGE_MS = 120e3;
export const ALGS = Object.freeze({ ES256: -7, RS256: -257 });
const F = { UP: 0x01, UV: 0x04, AT: 0x40, ED: 0x80 };
const unb64u = (s) => { if (typeof s !== 'string' || !/^[\w-]*={0,2}$/.test(s) || s.length > 16384) throw new AuthError(400, 'bad base64url'); return Buffer.from(s, 'base64url'); };

export function coseToJwk(cose) {
  if (!(cose instanceof Map)) throw new AuthError(400, 'cose key is not a map');
  const kty = cose.get(1), alg = cose.get(3);
  if (kty === 2 && alg === ALGS.ES256) {
    const crv = cose.get(-1), x = cose.get(-2), y = cose.get(-3);
    if (crv !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) throw new AuthError(400, 'unsupported EC key');
    return { alg, jwk: { kty: 'EC', crv: 'P-256', x: b64u(x), y: b64u(y) } };
  }
  if (kty === 3 && alg === ALGS.RS256) {
    const n = cose.get(-1), e = cose.get(-2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e) || n.length < 256) throw new AuthError(400, 'unsupported RSA key (2048 bits or more)');
    return { alg, jwk: { kty: 'RSA', n: b64u(n), e: b64u(e) } };
  }
  throw new AuthError(400, `unsupported key type ${kty} / alg ${alg}`);
}

export function parseAuthData(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 37) throw new AuthError(400, 'authenticatorData too short');
  const out = { rpIdHash: buf.subarray(0, 32), flags: buf[32], signCount: buf.readUInt32BE(33) };
  if (out.flags & F.AT) {
    if (buf.length < 55) throw new AuthError(400, 'attested credential data too short');
    const len = buf.readUInt16BE(53);
    if (buf.length < 55 + len) throw new AuthError(400, 'credential id truncated');
    out.credId = buf.subarray(55, 55 + len);
    const { value } = decode(buf.subarray(55 + len), { allowTrailing: true });
    out.cose = value;
  }
  return out;
}

export function verifySignature(alg, jwk, data, sig) {
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  if (alg === ALGS.ES256) return crypto.verify('sha256', data, { key, dsaEncoding: 'der' }, sig);
  if (alg === ALGS.RS256) return crypto.verify('sha256', data, { key, padding: crypto.constants.RSA_PKCS1_PADDING }, sig);
  return false;
}

// rp(): { id, origin, name } for the listener in use
export function makeWebAuthn(db, { rp, now = () => Date.now() } = {}) {
  const q = (s) => db.prepare(s);
  function challenge(kind, deviceId) {
    const t = now(); q('delete from challenges where expires < ?').run(t);
    const value = b64u(crypto.randomBytes(32));
    q('insert into challenges (id, kind, device_id, value, expires) values (?,?,?,?,?)').run(crypto.randomBytes(8).toString('hex'), kind, deviceId, value, t + CHALLENGE_MS);
    return value;
  }
  function takeChallenge(kind, deviceId, value) {
    const r = q('select * from challenges where value = ? and kind = ? and device_id = ?').get(String(value), kind, deviceId);
    if (!r) throw new AuthError(401, 'challenge_unknown_or_used');
    q('delete from challenges where id = ?').run(r.id);
    if (r.expires < now()) throw new AuthError(401, 'challenge_expired');
  }
  function clientData(b64, type, kind, deviceId) {
    const raw = unb64u(b64);
    let c; try { c = JSON.parse(raw.toString('utf8')); } catch { throw new AuthError(400, 'clientDataJSON is not JSON'); }
    if (c.type !== type) throw new AuthError(401, 'wrong_type');
    const R = rp();
    if (c.origin !== R.origin) throw new AuthError(401, 'wrong_origin');
    if (c.crossOrigin === true) throw new AuthError(401, 'cross_origin');
    takeChallenge(kind, deviceId, c.challenge);
    return raw;
  }
  function checkFlags(ad) {
    const R = rp();
    if (!crypto.timingSafeEqual(ad.rpIdHash, crypto.createHash('sha256').update(R.id).digest())) throw new AuthError(401, 'wrong_rp_id');
    if (!(ad.flags & F.UP)) throw new AuthError(401, 'user_not_present');
    if (!(ad.flags & F.UV)) throw new AuthError(401, 'user_not_verified');
  }
  const creds = (deviceId) => q('select cred_id from passkeys where device_id = ?').all(deviceId).map((r) => ({ type: 'public-key', id: r.cred_id }));

  function registrationOptions(device) {
    const R = rp();
    return {
      challenge: challenge('reg', device.id), rp: { id: R.id, name: R.name || 'Run Observatory' },
      user: { id: b64u(Buffer.from(device.id)), name: device.name, displayName: device.name },
      pubKeyCredParams: [{ type: 'public-key', alg: ALGS.ES256 }, { type: 'public-key', alg: ALGS.RS256 }],
      timeout: CHALLENGE_MS, attestation: 'none',
      authenticatorSelection: { residentKey: 'preferred', requireResidentKey: false, userVerification: 'required' },
      excludeCredentials: creds(device.id),
    };
  }
  function verifyRegistration(device, cred) {
    const r = cred?.response || {};
    clientData(r.clientDataJSON, 'webauthn.create', 'reg', device.id);
    let att; try { att = decode(unb64u(r.attestationObject)); } catch (e) { throw e instanceof AuthError ? e : new AuthError(400, 'attestationObject is not CBOR'); }
    if (!(att instanceof Map) || !Buffer.isBuffer(att.get('authData'))) throw new AuthError(400, 'attestationObject has no authData');
    const ad = parseAuthData(att.get('authData'));
    checkFlags(ad);
    if (!ad.credId || !ad.cose) throw new AuthError(400, 'no attested credential');
    const credId = b64u(ad.credId);
    if (cred.id && cred.id !== credId) throw new AuthError(400, 'credential id mismatch');
    const { alg, jwk } = coseToJwk(ad.cose);
    crypto.createPublicKey({ key: jwk, format: 'jwk' }); // must import
    if (q('select 1 from passkeys where cred_id = ?').get(credId)) throw new AuthError(409, 'credential already registered');
    q('insert into passkeys (cred_id, device_id, public_key_jwk, alg, sign_count, created, last_used, flagged) values (?,?,?,?,?,?,?,0)').run(credId, device.id, JSON.stringify(jwk), alg, ad.signCount, now(), now());
    return { credId, alg, signCount: ad.signCount, fmt: att.get('fmt') };
  }

  function assertionOptions(device, kind = 'auth') {
    const R = rp();
    return { challenge: challenge(kind, device.id), rpId: R.id, timeout: CHALLENGE_MS, userVerification: 'required', allowCredentials: creds(device.id) };
  }
  function verifyAssertion(device, cred, kind = 'auth') {
    const r = cred?.response || {};
    const credId = typeof cred?.id === 'string' ? cred.id : typeof cred?.rawId === 'string' ? cred.rawId : null;
    const pk = credId ? q('select * from passkeys where cred_id = ?').get(credId) : null;
    // the challenge is consumed first, so a replay with a wrong credential still burns it
    const cdRaw = clientData(r.clientDataJSON, 'webauthn.get', kind, device.id);
    if (!pk || pk.device_id !== device.id) throw new AuthError(401, 'unknown_credential');
    if (pk.flagged) throw new AuthError(401, 'credential_flagged');
    const adRaw = unb64u(r.authenticatorData);
    const ad = parseAuthData(adRaw);
    checkFlags(ad);
    const sig = unb64u(r.signature);
    const data = Buffer.concat([adRaw, crypto.createHash('sha256').update(cdRaw).digest()]);
    let ok = false; try { ok = verifySignature(pk.alg, JSON.parse(pk.public_key_jwk), data, sig); } catch { ok = false; }
    if (!ok) throw new AuthError(401, 'bad_signature');
    if ((ad.signCount !== 0 || pk.sign_count !== 0) && ad.signCount <= pk.sign_count) {
      q('update passkeys set flagged = 1 where cred_id = ?').run(pk.cred_id);
      throw new AuthError(401, 'sign_count_regression', { flagged: true });
    }
    q('update passkeys set sign_count = ?, last_used = ? where cred_id = ?').run(ad.signCount, now(), pk.cred_id);
    return { credId: pk.cred_id, signCount: ad.signCount };
  }
  const count = (deviceId) => q('select count(*) as n from passkeys where device_id = ?').get(deviceId).n;
  return { registrationOptions, verifyRegistration, assertionOptions, verifyAssertion, count };
}
