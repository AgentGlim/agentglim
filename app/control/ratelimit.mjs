// Token buckets in memory: `perMin` tokens per minute per key (sends: 6/min per session).
export function makeRateLimit({ perMin = 6, now = () => Date.now() } = {}) {
  const b = new Map();
  return {
    take(key) {
      const t = now(), x = b.get(key) || { tokens: perMin, at: t };
      x.tokens = Math.min(perMin, x.tokens + ((t - x.at) / 60000) * perMin); x.at = t;
      if (x.tokens < 1) { b.set(key, x); return false; }
      x.tokens -= 1; b.set(key, x); return true;
    },
    reset() { b.clear(); },
  };
}
