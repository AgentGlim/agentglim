// PIN fallback for the unlock: 6-10 digits, a blocklist (common PINs, repeated and sequential digits), scrypt
// (N=2^15, r=8, p=1, 16-byte salt, 32-byte key). Lockout policy lives in unlock.mjs / remote-mw.mjs:
// 5 wrong tries -> 15 min lock, 10 consecutive wrong tries -> device disabled (NIST SP 800-63B-4: <= 10).
import crypto from 'node:crypto';

export const SCRYPT = Object.freeze({ N: 1 << 15, r: 8, p: 1, keylen: 32, saltBytes: 16 });
export const PIN_LOCK_AFTER = 5, PIN_LOCK_MS = 15 * 60e3, PIN_DISABLE_AFTER = 10;
const COMMON = new Set(['123456', '654321', '123123', '112233', '121212', '696969', '159753', '147258', '258369', '123321', '000000', '111111', '1234567', '12345678', '123456789', '1234567890', '0123456789', '9876543210', '102030', '131313', '789456', '456789', '987654']);

export function pinProblem(pin) {
  if (typeof pin !== 'string' || !/^\d{6,10}$/.test(pin)) return 'PIN must be 6 to 10 digits';
  if (COMMON.has(pin)) return 'that PIN is too common';
  if (/^(\d)\1+$/.test(pin)) return 'PIN cannot be one repeated digit';
  const d = [...pin].map(Number);
  const step = d[1] - d[0];
  if ((step === 1 || step === -1) && d.every((x, i) => i === 0 || x - d[i - 1] === step)) return 'PIN cannot be a run of sequential digits';
  if (/^(\d\d)\1+$/.test(pin) || /^(\d\d\d)\1+$/.test(pin)) return 'PIN cannot be a repeated pattern';
  return null;
}

const scrypt = (pin, salt) => new Promise((ok, fail) => crypto.scrypt(pin, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? fail(e) : ok(k))));

export async function hashPin(pin) {
  const salt = crypto.randomBytes(SCRYPT.saltBytes);
  const key = await scrypt(pin, salt);
  return { hash: key.toString('base64'), salt: salt.toString('base64') };
}

export async function verifyPin(pin, hash, salt) {
  if (typeof pin !== 'string' || !/^\d{1,10}$/.test(pin) || !hash || !salt) return false;
  const key = await scrypt(pin, Buffer.from(salt, 'base64'));
  const want = Buffer.from(hash, 'base64');
  return want.length === key.length && crypto.timingSafeEqual(want, key);
}
