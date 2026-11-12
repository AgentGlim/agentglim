// Phone UI core (/m/ on the remote listener). Order on every load: register the service worker, ask /api/remote/me
// (device cookie only), and show the unlock screen before any data is requested. Only after the unlock does it load
// the model icons, the shared thread renderer and the tabs. Hash routes: #/dashboard (default), #/card/<name>,
// #/sessions, #/thread/<id>, #/watcher, #/approvals, #/settings. Any /api/* network failure shows the offline view.
// All text from the server goes in with textContent (tabs/*.js, ../chat.js); there is no innerHTML anywhere.
const $ = (id) => document.getElementById(id);
const VIEWS = ['vBoot', 'vOffline', 'vPair', 'vUnlock', 'vApp'];
const REASONS = { pin_wrong: 'Wrong PIN.', pin_wrong_locked: 'Wrong PIN. Locked for 15 minutes.', pin_locked: 'PIN locked. Try again later or use the passkey.', device_disabled: 'This phone is disabled. Pair it again at the PC.', rate_limited: 'Too many tries. Wait a moment.', live_send_off: 'Live sends are off. Turn them on at the desktop Control page.', step_up: 'Unlock again first.', desktop_only: 'Only on the PC.' };

// ---- the version this app was started with (TWA start URL /m/?src=twa&v=<versionCode>)
const qs = new URLSearchParams(location.search);
if (/^\d{1,9}$/.test(qs.get('v') || '')) { try { localStorage.setItem('obs.v', qs.get('v')); } catch {} }
if (qs.get('src')) { try { localStorage.setItem('obs.src', qs.get('src').slice(0, 10)); } catch {} }
export const appVersion = () => { try { return Number(localStorage.getItem('obs.v')) || null; } catch { return null; } };

// ---- small DOM helpers (textContent only)
export function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
export function card(id, title) { const c = el('section', 'card'); c.id = id; const h = el('h2', null, title); c.appendChild(h); return c; }
let toastT = null;
export function toast(msg, bad = false) {
  const t = $('toast'); t.textContent = String(msg?.message || msg || ''); t.className = `toast on${bad || msg instanceof Error ? ' bad' : ''}`;
  clearTimeout(toastT); toastT = setTimeout(() => { t.className = 'toast'; }, 4000);
}
export const ago = (t) => { if (!t) return '–'; const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };

// ---- views
function show(id) { for (const v of VIEWS) $(v).hidden = v !== id; const app = id === 'vApp'; $('tabs').hidden = !app; $('toSettings').hidden = !app; $('lockBtn').hidden = !app; $('toDesktop').hidden = !app; }
function offline() { show('vOffline'); $('live').className = 'live off'; }

// ---- API: network failure -> offline view; 401 unlock/pair -> the gate again
export class ApiError extends Error {}
export async function api(method, p, body) {
  let r;
  try { r = await fetch(p, { method, credentials: 'same-origin', cache: 'no-store', headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined }); }
  catch (e) { offline(); throw new ApiError('Not connected to your tailnet'); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && (j.error === 'unlock' || j.error === 'pair' || j.error === 'device_disabled')) { gate(); throw new ApiError('locked'); }
  if (!r.ok) { const e = new ApiError(REASONS[j.error] || j.error || `HTTP ${r.status}`); e.status = r.status; e.body = j; throw e; }
  $('live').className = 'live';
  return j;
}
export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);

// ---- unlock (02's endpoints)
const b2u = (b) => { const s = String.fromCharCode(...new Uint8Array(b)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const u2b = (s) => { const t = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(t, (c) => c.charCodeAt(0)).buffer; };
async function passkeyUnlock() {
  const { publicKey: o } = await post('/api/remote/webauthn/auth/options');
  o.challenge = u2b(o.challenge); o.allowCredentials = (o.allowCredentials || []).map((c) => ({ ...c, id: u2b(c.id) }));
  const c = await navigator.credentials.get({ publicKey: o });
  await post('/api/remote/webauthn/auth/verify', { credential: { id: c.id, rawId: b2u(c.rawId), type: c.type, response: { clientDataJSON: b2u(c.response.clientDataJSON), authenticatorData: b2u(c.response.authenticatorData), signature: b2u(c.response.signature), userHandle: c.response.userHandle ? b2u(c.response.userHandle) : null } } });
}

let me = null, started = false;
async function gate() {
  started = false; stopTab();
  try { me = await get('/api/remote/me'); } catch { return; }
  if (!me.paired) return show('vPair');
  if (!me.unlocked) {
    $('unlockWho').textContent = `${me.device?.name || 'This phone'} is locked.`;
    $('unlockPasskey').hidden = !me.methods?.passkeys || !window.PublicKeyCredential;
    $('pinForm').hidden = !me.methods?.pin;
    $('unlockSetup').hidden = !!(me.methods?.passkeys || me.methods?.pin);
    show('vUnlock');
    if (!$('pinForm').hidden) $('pin').focus({ preventScroll: true });
    return;
  }
  return start();
}

// ---- after the unlock: icons, tabs, update check
let iconsLoaded = null;
function loadIcons() {
  return iconsLoaded ||= new Promise((ok) => { const s = document.createElement('script'); s.src = '/model-icons.js'; s.onload = () => ok(true); s.onerror = () => ok(false); document.head.appendChild(s); });
}
const SVG_OK = new Set(['svg', 'g', 'path', 'circle', 'rect', 'ellipse', 'line', 'polygon', 'polyline', 'text', 'tspan', 'defs', 'clipPath', 'linearGradient', 'radialGradient', 'stop', 'title']);
export const iconState = { store: null };
// trusted markup from /model-icons.js, parsed as SVG and filtered (never innerHTML); a harness dot when unknown
export function icon(model, provider) {
  const MI = globalThis.ModelIcons;
  if (model && MI?.parse?.(model)) {
    let inner = ''; try { inner = MI.svg(model, iconState.store || undefined); } catch { inner = ''; }
    const doc = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${inner}</svg>`, 'image/svg+xml');
    const root = doc.documentElement;
    if (inner && root && root.nodeName === 'svg') {
      for (const n of [...root.querySelectorAll('*')]) { if (!SVG_OK.has(n.nodeName)) { n.remove(); continue; } for (const a of [...n.attributes]) if (/^on|href$|^style$/i.test(a.name)) n.removeAttribute(a.name); }
      const w = el('span', 'ico'); w.appendChild(document.importNode(root, true)); return w;
    }
  }
  const h = String(provider || '').replace(/[^a-z-]/g, '');
  return el('span', `hdot ${h === 'anthropic' ? 'claude' : h}`);
}

async function checkUpdate() {
  let v; try { v = await get('/app/version.json'); } catch { return; }
  const mine = appVersion();
  if (!v || !mine || !(v.versionCode > mine)) return;
  $('updateText').textContent = `Update available: ${v.versionName} (sha256 ${String(v.sha256).slice(0, 12)}…)`;
  const a = $('updateLink'); a.href = `/app/observatory-${v.versionCode}.apk`; a.setAttribute('download', `observatory-${v.versionCode}.apk`);
  $('update').hidden = false;
}

const TABS = { dashboard: './tabs/dashboard.js', sessions: './tabs/sessions.js', thread: './tabs/sessions.js', watcher: './tabs/watcher.js', approvals: './tabs/approvals.js', settings: './tabs/settings.js' };
let cleanup = null, routeN = 0;
function stopTab() { if (cleanup) { try { cleanup(); } catch {} cleanup = null; } }
export function parseRoute(hash) {
  const h = String(hash || '').replace(/^#\/?/, '');
  let m;
  if (!h || h === 'dashboard') return { tab: 'dashboard' };
  if ((m = h.match(/^card\/([\w-]{1,30})$/))) return { tab: 'dashboard', card: m[1] };
  if ((m = h.match(/^thread\/([\w:.%-]{1,120})$/))) { let id = m[1]; try { id = decodeURIComponent(id); } catch {} return /^[\w:.-]{1,80}$/.test(id) ? { tab: 'thread', id } : { tab: 'sessions' }; }
  if (['sessions', 'watcher', 'approvals', 'settings'].includes(h)) return { tab: h };
  return { tab: 'dashboard' };
}
async function route() {
  if (!started) return;
  const n = ++routeN, r = parseRoute(location.hash);
  stopTab();
  const navTab = r.tab === 'thread' ? 'sessions' : r.tab;
  for (const a of document.querySelectorAll('.tab')) { if (a.dataset.tab === navTab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
  const root = $('vApp'); root.replaceChildren();
  let mod; try { mod = await import(TABS[r.tab]); } catch (e) { root.appendChild(el('p', 'meta', 'Could not load this tab.')); return; }
  if (n !== routeN) return;
  try { cleanup = await mod.render(root, r, ctx) || null; } catch (e) { if (!(e instanceof ApiError)) { console.warn('tab', e); root.appendChild(el('p', 'meta', 'Could not load this tab.')); } }
  if (n !== routeN && cleanup) { stopTab(); }
}
export const ctx = { api, get, post, el, card, toast, ago, icon, iconState, me: () => me, appVersion };
async function start() {
  if (started) return;
  started = true;
  show('vApp');
  await loadIcons();
  try { await import('/lib/chat.js'); } catch {}
  route();
  checkUpdate();
  get('/api/remote/approvals').then((a) => { const n = a.items?.length || 0; $('apCount').textContent = String(n); $('apCount').hidden = !n; }).catch(() => {});
}

// ---- wiring
window.addEventListener('hashchange', route);
$('retry').addEventListener('click', () => { show('vBoot'); gate(); });
$('lockBtn').addEventListener('click', async () => { try { await post('/api/remote/lock'); } catch {} gate(); });
$('unlockPasskey').addEventListener('click', async () => { try { await passkeyUnlock(); toast('Unlocked'); } catch (e) { if (!(e instanceof ApiError && e.message === 'locked')) toast(e.name === 'NotAllowedError' ? 'Cancelled.' : e, true); } gate(); });
$('pinForm').addEventListener('submit', async (ev) => {
  ev.preventDefault(); const v = $('pin').value; $('pin').value = '';
  try { await post('/api/remote/pin/unlock', { pin: v }); toast('Unlocked'); } catch (e) { const t = e.body?.triesBeforeLock ? ` ${e.body.triesBeforeLock} tries before a 15-minute lock.` : ''; toast(`${e.message}${t}`, true); }
  gate();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && started) get('/api/remote/me').then((x) => { if (!x.unlocked) gate(); }).catch(() => {}); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
// a notification tap while the app is open (sw.js posts {type:'navigate', url})
navigator.serviceWorker?.addEventListener('message', (e) => { const u = e.data?.url; if (e.data?.type === 'navigate' && typeof u === 'string' && u.startsWith('/m/')) { const h = u.indexOf('#'); if (h >= 0) location.hash = u.slice(h); } });
gate();
