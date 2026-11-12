// Desktop Control page: "Remote access" card (sub-item 02). Remote settings form, "Pair a phone" (one-time token as
// a QR from the in-house encoder qr.js, drawn as SVG rects), devices with last seen and Revoke, the last 200 audit
// rows. Desktop listener only; text goes in with textContent.
import { encodeText } from './qr.js';

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
async function call(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : { accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const when = (t) => (t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–');
function msg(t, bad) { const m = $('rmMsg'); m.textContent = t || ''; m.className = `meta${bad ? ' bad' : ''}`; }

export function drawQr(svg, text) {
  const q = encodeText(text);
  const n = q.size + 8; // 4-module quiet zone
  while (svg.firstChild) svg.firstChild.remove();
  svg.setAttribute('viewBox', `0 0 ${n} ${n}`);
  const bg = document.createElementNS(SVGNS, 'rect'); bg.setAttribute('width', n); bg.setAttribute('height', n); bg.setAttribute('fill', '#fff'); svg.appendChild(bg);
  let d = '';
  q.modules.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x + 4} ${y + 4}h1v1h-1z`; }));
  const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', d); p.setAttribute('fill', '#000'); svg.appendChild(p);
  svg.dataset.version = String(q.version); svg.dataset.mask = String(q.mask);
  return q;
}

let pairTimer = null;
async function load() {
  let s; try { s = await call('GET', '/api/control/remote/state'); } catch (e) { msg(e.message, true); return; }
  $('rmEnabled').checked = s.enabled; $('rmHost').value = s.host || ''; $('rmLogins').value = (s.allowLogins || []).join(', '); $('rmReqLogin').checked = s.requireTailscaleLogin;
  $('rmStatus').textContent = s.listening ? `listening on 127.0.0.1:${s.port} for ${s.origin}${s.effectiveRequireLogin ? ', Tailscale login required' : ''}` : s.enabled ? (s.host ? `not listening (port ${s.port})` : 'enabled, but remote.host is not set') : 'off';
  $('rmPair').disabled = !s.host;
  const tb = $('rmDevices').tBodies[0];
  tb.replaceChildren(...(s.devices.length ? s.devices.map((d) => {
    const tr = el('tr');
    tr.appendChild(el('td', null, d.name));
    tr.appendChild(el('td', null, when(d.lastSeen)));
    tr.appendChild(el('td', null, `${d.passkeys} passkey${d.passkeys === 1 ? '' : 's'}${d.hasPin ? ', PIN' : ''}${d.disabled ? ' (disabled)' : d.pinLockedUntil ? ' (PIN locked)' : ''}`));
    const td = el('td'); const b = el('button', 'btn danger', 'Revoke'); b.type = 'button';
    b.setAttribute('aria-label', `Revoke ${d.name}`);
    // two clicks: the first arms the button for 5 s (no browser dialog)
    b.addEventListener('click', async () => { if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Confirm revoke'; setTimeout(() => { delete b.dataset.armed; b.textContent = 'Revoke'; }, 5000); return; } try { await call('POST', '/api/control/remote/revoke', { id: d.id }); msg(`${d.name} revoked`); } catch (e) { msg(e.message, true); } load(); });
    td.appendChild(b); tr.appendChild(td); return tr;
  }) : [(() => { const tr = el('tr'); const td = el('td', 'meta', 'No paired devices.'); td.colSpan = 4; tr.appendChild(td); return tr; })()]));
}
async function loadAudit() {
  let r; try { r = await call('GET', '/api/control/audit?limit=200'); } catch (e) { msg(e.message, true); return; }
  const tb = $('rmAudit').tBodies[0];
  tb.replaceChildren(...r.rows.map((a) => {
    const tr = el('tr');
    for (const v of [when(a.ts), a.listener, a.device_name || a.device_id || '', a.ts_login || a.ip || '', a.action, a.target || '', a.result, a.bytes ?? '']) tr.appendChild(el('td', null, v));
    return tr;
  }));
  $('rmAuditN').textContent = `(${r.rows.length})`;
}

$('rmForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    const r = await call('POST', '/api/control/remote/config', { enabled: $('rmEnabled').checked, host: $('rmHost').value.trim() || null, allowLogins: $('rmLogins').value, requireTailscaleLogin: $('rmReqLogin').checked });
    msg(r.listening ? 'saved; remote listener running' : 'saved; remote listener off');
  } catch (e) { msg(e.message, true); }
  load();
});
$('rmPair').addEventListener('click', async () => {
  try {
    const p = await call('POST', '/api/control/remote/pair', {});
    drawQr($('rmQr'), p.url);
    $('rmPairBox').hidden = false; $('rmUrl').textContent = p.url;
    clearInterval(pairTimer);
    const tick = () => { const s = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000)); $('rmLeft').textContent = s ? `valid ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}, once` : 'expired: make a new one'; if (!s) { clearInterval(pairTimer); $('rmQr').classList.add('dead'); } };
    $('rmQr').classList.remove('dead'); tick(); pairTimer = setInterval(tick, 1000);
  } catch (e) { msg(e.message, true); }
});
$('rmPairDone').addEventListener('click', () => { $('rmPairBox').hidden = true; clearInterval(pairTimer); while ($('rmQr').firstChild) $('rmQr').firstChild.remove(); load(); });
$('rmAuditBox').addEventListener('toggle', () => { if ($('rmAuditBox').open) loadAudit(); });
$('rmAuditRefresh').addEventListener('click', loadAudit);
load(); setInterval(load, 15000);
