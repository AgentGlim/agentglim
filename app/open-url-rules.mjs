// URL rules for POST /api/open-url (shared by server.mjs and tests/open-url.test.mjs)
const LOCAL = new Set(['observatory', 'localhost', '127.0.0.1', '[::1]']);
export const hostOf = (h) => String(h || '').toLowerCase().replace(/:\d+$/, '');
export const isLocalHost = (h) => LOCAL.has(hostOf(h));

// Returns the URL to open, or null when it must be refused. http becomes https except for local hosts.
export function normalizeOpenUrl(raw) {
  if (typeof raw !== 'string' || !/^https?:\/\/[^\s]+$/i.test(raw)) return null;
  let u; try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password) return null;
  if (u.protocol === 'http:' && !isLocalHost(u.host)) u.protocol = 'https:';
  return u.href;
}

// The request must come from the app itself: Host is a local name and Origin (always sent by browsers on POST) matches it.
export function sameAppRequest(headers) {
  const host = headers.host; if (!host || !isLocalHost(host)) return false;
  const o = headers.origin; if (!o) return false;
  try { return new URL(o).host.toLowerCase() === String(host).toLowerCase(); } catch { return false; }
}
