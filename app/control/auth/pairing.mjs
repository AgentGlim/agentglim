// Pairing and devices. A pairing token is 32 random bytes (base64url), valid 5 min, single use, stored as sha256
// and bound to the remote listener it was minted for (`host|port`). Exchanging it on /api/remote/pair creates a
// device and its `obs_dev` cookie value (32 random bytes, stored as sha256 only). Revoke deletes the device, its
// passkeys, push subscriptions, unlock sessions and challenges.
import crypto from 'node:crypto';
import { sha256, b64u } from './unlock.mjs';

export const PAIR_TTL_MS = 5 * 60e3;
export const REGISTER_WINDOW_MS = 10 * 60e3; // a new device may add its first passkey or PIN without an unlock

export const AUTH_SCHEMA = `
create table if not exists devices (id text primary key, name text, token_sha256 text unique, created integer, last_seen integer, user_agent text, disabled integer default 0, pin_hash text, pin_salt text, pin_fails integer default 0, pin_locked_until integer default 0);
create table if not exists passkeys (cred_id text primary key, device_id text, public_key_jwk text, alg integer, sign_count integer, created integer, last_used integer, flagged integer default 0);
create table if not exists pair_tokens (token_sha256 text primary key, created integer, expires integer, used_at integer, listener text);
create table if not exists unlocks (id_sha256 text primary key, device_id text, created integer, last_used integer, uv_at integer, method text);
create table if not exists challenges (id text primary key, kind text, device_id text, value text, expires integer);
create table if not exists push_subs (id text primary key, device_id text, endpoint text, p256dh text, auth text, created integer, last_ok integer, fails integer default 0);
`;

export class AuthError extends Error {
  constructor(code, reason, extra = {}) { super(reason); this.code = code; this.reason = reason; Object.assign(this, extra); }
}

export function cleanName(s) {
  const n = String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return n || null;
}

export function makePairing(db, { now = () => Date.now() } = {}) {
  db.exec(AUTH_SCHEMA);
  const q = (s) => db.prepare(s);
  function mint(listener) {
    const t = now();
    q('delete from pair_tokens where expires < ?').run(t - 24 * 3600e3);
    const token = b64u(crypto.randomBytes(32));
    q('insert into pair_tokens (token_sha256, created, expires, used_at, listener) values (?,?,?,?,?)').run(sha256(token), t, t + PAIR_TTL_MS, null, listener);
    return { token, expiresAt: t + PAIR_TTL_MS };
  }
  // throws AuthError(401) on an unknown, used, expired or foreign-listener token
  function exchange(token, listener, { name, userAgent }) {
    if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) throw new AuthError(401, 'pair_token_invalid');
    const r = q('select * from pair_tokens where token_sha256 = ?').get(sha256(token));
    const t = now();
    if (!r) throw new AuthError(401, 'pair_token_invalid');
    if (r.used_at) throw new AuthError(401, 'pair_token_used');
    if (r.expires < t) throw new AuthError(401, 'pair_token_expired');
    if (r.listener !== listener) throw new AuthError(401, 'pair_token_other_listener');
    const nm = cleanName(name);
    if (!nm) throw new AuthError(422, 'name required (1-40 characters)');
    const used = q('update pair_tokens set used_at = ? where token_sha256 = ? and used_at is null').run(t, r.token_sha256);
    if (!used.changes) throw new AuthError(401, 'pair_token_used');
    const id = crypto.randomBytes(8).toString('hex');
    const cookie = b64u(crypto.randomBytes(32));
    q('insert into devices (id, name, token_sha256, created, last_seen, user_agent, disabled, pin_fails, pin_locked_until) values (?,?,?,?,?,?,0,0,0)')
      .run(id, nm, sha256(cookie), t, t, String(userAgent || '').slice(0, 200));
    return { device: { id, name: nm, created: t }, cookie };
  }
  function byCookie(value) {
    if (typeof value !== 'string' || !/^[\w-]{43}$/.test(value)) return null;
    return q('select * from devices where token_sha256 = ?').get(sha256(value)) || null;
  }
  const get = (id) => q('select * from devices where id = ?').get(String(id)) || null;
  function touch(id) { const t = now(); q('update devices set last_seen = ? where id = ? and last_seen < ?').run(t, id, t - 30e3); }
  function list() {
    return q('select id, name, created, last_seen, user_agent, disabled, pin_hash is not null as has_pin, pin_locked_until from devices order by created').all().map((d) => ({
      id: d.id, name: d.name, created: d.created, lastSeen: d.last_seen, userAgent: d.user_agent, disabled: !!d.disabled, hasPin: !!d.has_pin,
      pinLockedUntil: d.pin_locked_until > now() ? d.pin_locked_until : null,
      passkeys: q('select count(*) as n from passkeys where device_id = ?').get(d.id).n,
      pushSubs: q('select count(*) as n from push_subs where device_id = ?').get(d.id).n,
    }));
  }
  function revoke(id) {
    const d = get(id); if (!d) return false;
    for (const t of ['passkeys', 'push_subs', 'unlocks', 'challenges']) q(`delete from ${t} where device_id = ?`).run(d.id);
    try { q('delete from push_prefs where device_id = ?').run(d.id); } catch {} // 03's table, when present
    q('delete from devices where id = ?').run(d.id);
    return true;
  }
  return { mint, exchange, byCookie, get, touch, list, revoke };
}
