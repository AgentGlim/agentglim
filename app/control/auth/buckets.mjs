// Persistent token buckets in control.db (table `rate`, created by store.mjs): counters survive a restart.
// A bucket of capacity `cap` refills `cap` tokens per `windowMs`, continuously. Over the limit: retryAfter seconds.
export const LIMITS = Object.freeze({
  read: [120, 60e3], //   per device: GET requests
  write: [30, 60e3], //   per device: POST requests
  send: [6, 60e3], //     per device: session sends (send, keys, prompt answers)
  kill: [3, 600e3], //    per device: executed kills
  pair: [10, 3600e3], //  global: pairing attempts
  pin: [5, 900e3], //     per device: PIN tries (a correct PIN gives its token back)
});

export function makeBuckets(db, { now = () => Date.now(), limits = LIMITS } = {}) {
  const get = db.prepare('select tokens, updated from rate where bucket = ? and key = ?');
  const put = db.prepare('insert or replace into rate (bucket, key, tokens, updated) values (?,?,?,?)');
  function level(name, key) {
    const [cap, win] = limits[name]; const t = now();
    const r = get.get(`remote:${name}`, String(key));
    const tokens = r ? Math.min(cap, r.tokens + ((t - r.updated) / win) * cap) : cap;
    return { tokens, t, cap, win };
  }
  function take(name, key) {
    const { tokens, t, cap, win } = level(name, key);
    if (tokens < 1) { put.run(`remote:${name}`, String(key), tokens, t); return { ok: false, retryAfter: Math.max(1, Math.ceil(((1 - tokens) * win) / cap / 1000)) }; }
    put.run(`remote:${name}`, String(key), tokens - 1, t);
    return { ok: true, left: Math.floor(tokens - 1) };
  }
  function refund(name, key) { const { tokens, t, cap } = level(name, key); put.run(`remote:${name}`, String(key), Math.min(cap, tokens + 1), t); }
  return { take, refund, level: (n, k) => level(n, k).tokens, limits };
}
