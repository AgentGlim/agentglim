// Central Host-header guard (DNS-rebinding defence for the dashboard listener).
//
// The dashboard binds 127.0.0.1, but a page on the public internet can point a name it controls at
// 127.0.0.1 (DNS rebinding) and then read this app's private data through the browser, because the
// browser thinks it is talking to its own origin. The Host header is the only thing that separates the
// two, so every page and API route passes one check before dispatch, instead of each route family
// remembering its own (the Control routes had one; the Skill Editor routes did not).
import fs from 'node:fs';
import path from 'node:path';

// Names the app is reached by on this machine: the loopback forms, and the `observatory` alias the
// install docs and the console banner use.
export const LOOPBACK_NAMES = Object.freeze(['127.0.0.1', 'localhost', '[::1]', 'observatory']);
const HOST_RE = /^(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?$/;

export function parseHost(raw) {
  const m = HOST_RE.exec(String(raw ?? '').trim().toLowerCase());
  if (!m) return null;
  return { name: m[1], port: m[2] ? Number(m[2]) : null };
}

// Loopback names must carry the port this listener actually bound (a Host with no port means port 80),
// so a rebound request aimed at another local service's port is refused as well. Names the owner
// configured (a tailnet MagicDNS name, or a proxy in AGENTGLIM_ALLOWED_HOSTS) may arrive on any external
// port: the proxy in front of them terminates TLS on 443 and forwards the name alone.
export function hostAllowed(raw, { port = 0, extraNames = [] } = {}) {
  const h = parseHost(raw);
  if (!h) return false;
  if (!LOOPBACK_NAMES.includes(h.name)) {
    return extraNames.map((n) => String(n || '').trim().toLowerCase().replace(/:\d+$/, '')).includes(h.name);
  }
  const actual = Number(port) || 0;
  if (!actual) return true;
  return (h.port ?? 80) === actual;
}

// The extra names the owner already configured for remote access: `remote.host` in control.json (written by
// the Control panel's remote settings, the MagicDNS name `tailscale serve` proxies to the phone listener)
// and AGENTGLIM_ALLOWED_HOSTS for a proxy the owner runs in front of the dashboard. Read lazily: control.json
// is written at runtime, and a fresh check per request costs one small stat/read.
export function fileExtraHosts(dataDir, file = path.join(dataDir || '', 'control.json')) {
  let cache = { m: -1, names: [] };
  return () => {
    let st; try { st = fs.statSync(file); } catch { return []; }
    if (st.mtimeMs !== cache.m) {
      let names = [];
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const h = raw?.remote?.host;
        if (typeof h === 'string' && h.trim()) names = [h.trim()];
        else if (Array.isArray(h)) names = h.filter((x) => typeof x === 'string' && x.trim());
      } catch { names = []; }
      cache = { m: st.mtimeMs, names };
    }
    return cache.names;
  };
}

export const envExtraHosts = () => String(process.env.AGENTGLIM_ALLOWED_HOSTS || '').split(/[,\s]+/).filter(Boolean);

// Returns true when the request may proceed; otherwise answers 403 { error: "bad host" } itself.
// 403 (not 421) keeps the refusal the same-origin endpoints already return for a bad Host — tests/setup-jev
// asserts it — and reads the same in a browser. No private data is touched before this check.
export function makeHostGuard({ port = () => 0, extraNames = () => [] } = {}) {
  const actualPort = () => (typeof port === 'function' ? Number(port()) || 0 : Number(port) || 0);
  const names = () => (typeof extraNames === 'function' ? extraNames() : extraNames);
  return function guardHost(req, res) {
    if (hostAllowed(req.headers?.host, { port: actualPort(), extraNames: names() })) return true;
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end('{"error":"bad host"}');
    return false;
  };
}
