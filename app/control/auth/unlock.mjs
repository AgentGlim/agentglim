// Unlock sessions: `obs_unlock` cookie = 32 random bytes (base64url), stored as sha256 only. Valid 15 min idle and
// 12 h at most. `uv_at` is the time of the last passkey (UV) or PIN check; step-up needs it within 120 s.
import crypto from 'node:crypto';

export const UNLOCK_IDLE_MS = 15 * 60e3, UNLOCK_MAX_MS = 12 * 3600e3, STEP_UP_MS = 120e3;
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const b64u = (b) => Buffer.from(b).toString('base64url');

export function makeUnlocks(db, { now = () => Date.now() } = {}) {
  const q = (s) => db.prepare(s);
  function create(deviceId, method) {
    const v = b64u(crypto.randomBytes(32)); const t = now();
    q('delete from unlocks where device_id = ? and created < ?').run(deviceId, t - UNLOCK_MAX_MS);
    q('insert into unlocks (id_sha256, device_id, created, last_used, uv_at, method) values (?,?,?,?,?,?)').run(sha256(v), deviceId, t, t, t, method);
    return v;
  }
  // the unlock row for a cookie value and device, touched; null when unknown, idle, too old or for another device
  function check(value, deviceId) {
    if (typeof value !== 'string' || !/^[\w-]{43}$/.test(value)) return null;
    const r = q('select * from unlocks where id_sha256 = ?').get(sha256(value));
    const t = now();
    if (!r || r.device_id !== deviceId) return null;
    if (t - r.last_used > UNLOCK_IDLE_MS || t - r.created > UNLOCK_MAX_MS) { q('delete from unlocks where id_sha256 = ?').run(r.id_sha256); return null; }
    if (t - r.last_used > 5000) q('update unlocks set last_used = ? where id_sha256 = ?').run(t, r.id_sha256);
    return { idSha: r.id_sha256, deviceId: r.device_id, created: r.created, lastUsed: t, uvAt: r.uv_at, method: r.method, expiresIn: Math.round(Math.min(UNLOCK_IDLE_MS, r.created + UNLOCK_MAX_MS - t) / 1000) };
  }
  // read-only validity check by row id (no touch): used to end open streams whose unlock expired
  function alive(idSha, deviceId) {
    const r = q('select device_id, created, last_used from unlocks where id_sha256 = ?').get(String(idSha));
    const t = now();
    return !!r && r.device_id === deviceId && t - r.last_used <= UNLOCK_IDLE_MS && t - r.created <= UNLOCK_MAX_MS;
  }
  const fresh = (u) => !!u && now() - u.uvAt <= STEP_UP_MS;
  function stepUp(idSha, method) { q('update unlocks set uv_at = ?, last_used = ?, method = ? where id_sha256 = ?').run(now(), now(), method, idSha); }
  function drop(value) { if (typeof value === 'string') q('delete from unlocks where id_sha256 = ?').run(sha256(value)); }
  function dropDevice(deviceId) { q('delete from unlocks where device_id = ?').run(deviceId); }
  return { create, check, alive, fresh, stepUp, drop, dropDevice };
}
