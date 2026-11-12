// /control page: sessions table (SSE /api/control/stream), chat and terminal panel, controls, prompt buttons,
// new-session picker, pinned Watcher thread, liveSend switch. DOM is built with textContent only.
import { el, makeChat } from './chat.js';
import { makeTerminal } from './terminal.js';
import { makePicker } from './picker.js';
import { makeWatcher } from './watcher.js';
import './remote-panel.js'; // sub-item 02: Remote access card (pairing, devices, audit)

const $ = (id) => document.getElementById(id);
const state = { sessions: [], cur: null, liveSend: false, tab: 'chat', iconStore: null };

// ---- fetch helpers (JSON only; errors carry the server's reason)
async function get(url) { const r = await fetch(url, { headers: { accept: 'application/json' } }); const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.reason || j.error || r.statusText), { status: r.status, body: j }); return j; }
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error === 'live_send_off' ? 'live_send_off: real sends are off (dry run logged). Turn on Live send to act.' : j.reason || j.error || r.statusText), { status: r.status, body: j });
  return j;
}
let toastT = null;
function toast(msg) {
  const t = $('toast'); const bad = msg instanceof Error;
  t.textContent = bad ? msg.message : String(msg);
  t.className = `toast on${bad ? ' bad' : ''}`;
  clearTimeout(toastT); toastT = setTimeout(() => { t.className = 'toast'; }, 4500);
}

// ---- model icons (trusted markup from /model-icons.js, parsed as SVG and filtered; never innerHTML)
const SVG_OK = new Set(['svg', 'g', 'path', 'circle', 'rect', 'ellipse', 'line', 'polygon', 'polyline', 'text', 'tspan', 'defs', 'clipPath', 'linearGradient', 'radialGradient', 'stop', 'title']);
function icon(model) {
  const MI = globalThis.ModelIcons;
  if (!model || !MI?.parse?.(model)) return null;
  let inner = ''; try { inner = MI.svg(model, state.iconStore || undefined); } catch { return null; }
  const doc = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${inner}</svg>`, 'image/svg+xml');
  const root = doc.documentElement; if (!root || root.nodeName !== 'svg') return null;
  for (const n of [...root.querySelectorAll('*')]) {
    if (!SVG_OK.has(n.nodeName)) { n.remove(); continue; }
    for (const a of [...n.attributes]) if (/^on|href$|^style$/i.test(a.name)) n.removeAttribute(a.name);
  }
  const wrap = el('span', 'ico'); wrap.appendChild(document.importNode(root, true));
  return wrap;
}

// ---- sessions table
const ago = (t) => { if (!t) return '–'; const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
const fmtTok = (t) => t == null ? '–' : typeof t === 'number' ? (t > 1e6 ? `${(t / 1e6).toFixed(1)}M` : t > 1e3 ? `${Math.round(t / 1e3)}k` : String(t)) : typeof t === 'object' ? fmtTok(Object.values(t).reduce((a, b) => a + (Number(b) || 0), 0)) : String(t);
const label = (s) => s.name || (s.role === 'watcher' ? 'watcher' : s.task ? `${s.project || ''} ${s.task}`.trim() : `${s.harness} ${s.project || ''}`.trim());

function renderSessions() {
  const fh = $('fHarness').value, fr = $('fRole').value, fs = $('fState').value;
  const list = state.sessions.filter((s) => (!fh || s.harness === fh) && (!fr || s.role === fr) && (!fs || s.state === fs));
  const tb = $('sessions').tBodies[0];
  const rows = list.map((s) => {
    const tr = el('tr', s.role === 'remote-note' ? 'note' : state.cur === s.id ? 'cur' : '');
    if (s.role === 'remote-note') { const td = el('td', null, s.note); td.colSpan = 7; tr.appendChild(td); return tr; }
    const td1 = el('td');
    const b = el('button', 'srow'); b.type = 'button'; b.dataset.id = s.id;
    b.setAttribute('aria-label', `Open ${label(s)} (${s.harness}, ${s.state})`);
    b.appendChild(icon(s.model) || el('span', `hdot ${s.harness}`));
    b.appendChild(el('span', 'nm', label(s)));
    b.addEventListener('click', () => open(s.id));
    td1.appendChild(b);
    td1.appendChild(el('div', 'meta', `${s.id}${s.pane ? ` · ${s.pane}` : ''}${s.remote ? ` · ${s.remote}` : ''}`));
    tr.appendChild(td1);
    const td2 = el('td'); td2.appendChild(el('span', `st ${s.state}`, s.state)); tr.appendChild(td2);
    tr.appendChild(el('td', 'w', s.role));
    tr.appendChild(el('td', 'w', s.project || '–'));
    tr.appendChild(el('td', 'w', ago(s.lastActivity)));
    tr.appendChild(el('td', 'w', `${fmtTok(s.tokens)}${s.cost ? ` · $${Number(s.cost).toFixed(2)}` : ''}`));
    tr.appendChild(el('td', `dl ${s.delivery?.mode || ''}`, s.delivery?.reason ? `${s.delivery.mode}: ${s.delivery.reason}` : s.delivery?.mode || ''));
    return tr;
  });
  tb.replaceChildren(...rows);
  $('count').textContent = `${list.filter((s) => s.role !== 'remote-note').length} shown`;
}
for (const id of ['fHarness', 'fRole', 'fState']) $(id).addEventListener('change', renderSessions);

// ---- live stream
function connect() {
  const es = new EventSource('/api/control/stream');
  es.addEventListener('sessions', (ev) => {
    const d = JSON.parse(ev.data);
    state.sessions = d.sessions; setLive(d.liveSend);
    $('live').classList.remove('off');
    $('updated').textContent = `updated ${new Date(d.at).toLocaleTimeString()}`;
    renderSessions(); renderPanel();
    if (d.watcherAt !== state.watcherAt) { state.watcherAt = d.watcherAt; watcher.refresh().catch(() => {}); }
  });
  es.onerror = () => { $('live').classList.add('off'); $('updated').textContent = 'reconnecting...'; };
}

// ---- liveSend switch (desktop page only)
function setLive(v) { state.liveSend = !!v; $('liveSend').checked = state.liveSend; $('liveSendHint').textContent = state.liveSend ? 'ON: sends reach real sessions' : 'off: dry run only'; }
$('liveSend').addEventListener('change', async (e) => {
  const want = e.target.checked;
  try { const r = await post('/api/control/config', { liveSend: want }); setLive(r.liveSend); toast(`Live send ${r.liveSend ? 'on' : 'off'}`); } catch (err) { setLive(!want); toast(err); }
});

// ---- panel
const chat = makeChat($('thread'));
const term = makeTerminal({ pre: $('term'), keycap: $('keycap'), onError: toast, post });
let pollT = null;
function curSession() { return state.sessions.find((s) => s.id === state.cur) || null; }
function open(id) {
  state.cur = id; chat.reset(id); renderSessions(); renderPanel(); pullThread();
  if (state.tab === 'term') term.open(id);
  clearInterval(pollT); pollT = setInterval(pullThread, 2000);
  $('panelH').focus?.();
}
async function pullThread() {
  const id = state.cur; if (!id || state.tab !== 'chat') return;
  try { const r = await get(`/api/control/thread/${encodeURIComponent(id)}?after=${chat.cursor}`); if (state.cur === id) chat.add(r.bubbles, r.cursor); } catch {}
}
function renderPanel() {
  const s = curSession();
  $('panelH').textContent = s ? label(s) : 'No session open';
  $('panelMeta').textContent = s ? [s.id, s.harness, s.role, s.state, s.model, s.effort, s.cwd, s.pane ? `pane ${s.pane}` : null].filter(Boolean).join(' · ') : 'Pick a session from the list.';
  $('delivery').textContent = s ? `delivery: ${s.delivery?.mode}${s.delivery?.reason ? ` (${s.delivery.reason})` : ''}${state.liveSend ? '' : ' · live send is off: dry run only'}${s.state === 'paused' && !state.liveSend ? ' · paused: Resume needs live send on' : ''}` : '';
  for (const b of document.querySelectorAll('#controls .btn')) b.disabled = !s || !s.alive;
  const p = s?.prompt, box = $('prompt');
  if (!p || state.lastPromptKey === `${s.id}|${p.hash}|${p.question}`) { if (!p) { box.hidden = true; state.lastPromptKey = null; } return; }
  state.lastPromptKey = `${s.id}|${p.hash}|${p.question}`;
  box.hidden = false;
  $('promptQ').textContent = p.question;
  // the whole dialog (command, file or tool) as plain text, so the click is never blind
  const ctx = $('promptCtx'); ctx.textContent = (p.context || []).join('\n'); ctx.hidden = !(p.context || []).length;
  const opts = $('promptOpts'); opts.replaceChildren();
  if (!p.options?.length) opts.appendChild(el('span', 'meta', 'Open the Terminal tab to answer this one.'));
  p.options?.forEach((o, i) => {
    const b = el('button', 'btn', o.label); b.type = 'button';
    b.addEventListener('click', async () => { try { await post('/api/control/prompt', { id: s.id, hash: p.hash, option: i }); toast(`sent: ${o.label}`); } catch (err) { toast(err); } });
    opts.appendChild(b);
  });
}

// tabs (arrow keys move between them)
function setTab(t) {
  state.tab = t;
  $('tabChat').setAttribute('aria-selected', String(t === 'chat')); $('tabTerm').setAttribute('aria-selected', String(t === 'term'));
  $('tabChat').tabIndex = t === 'chat' ? 0 : -1; $('tabTerm').tabIndex = t === 'term' ? 0 : -1;
  $('chatView').hidden = t !== 'chat'; $('termView').hidden = t !== 'term';
  if (t === 'term' && state.cur) term.open(state.cur); else term.close();
  if (t === 'chat') pullThread();
}
$('tabChat').addEventListener('click', () => setTab('chat'));
$('tabTerm').addEventListener('click', () => setTab('term'));
for (const id of ['tabChat', 'tabTerm']) $(id).addEventListener('keydown', (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const t = state.tab === 'chat' ? 'term' : 'chat'; setTab(t); $(t === 'chat' ? 'tabChat' : 'tabTerm').focus(); } });

// in-page confirm (kill, pause, launch): resolves true/false
function confirmBox(title, lines, secs = 60) {
  return new Promise((ok) => {
    const box = $('confirm'); $('confirmH').textContent = title;
    $('confirmList').replaceChildren(...lines.map((l) => el('li', null, l)));
    box.hidden = false; $('confirmNo').focus();
    let left = secs; $('confirmT').textContent = `expires in ${left}s`;
    const t = setInterval(() => { left -= 1; $('confirmT').textContent = `expires in ${left}s`; if (left <= 0) done(false); }, 1000);
    function done(v) { clearInterval(t); box.hidden = true; $('confirmYes').onclick = $('confirmNo').onclick = null; ok(v); }
    $('confirmYes').onclick = () => done(true); $('confirmNo').onclick = () => done(false);
  });
}

for (const b of document.querySelectorAll('#controls .btn')) b.addEventListener('click', async () => {
  const s = curSession(); if (!s) return;
  const act = b.dataset.act;
  try {
    const r = await post('/api/control/signal', { id: s.id, action: act });
    if (r.confirm) {
      const ok = await confirmBox(`${act === 'kill' ? 'Kill' : 'Pause'} ${label(s)}? ${r.summary.pids.length} process(es)`, r.summary.commands, r.expiresIn);
      if (!ok) return toast('cancelled');
      const r2 = await post('/api/control/signal', { id: s.id, action: act, confirm: r.confirm });
      return toast(`${act}: ${r2.sent.length} signalled${r2.dropped?.length ? `, ${r2.dropped.length} dropped` : ''}`);
    }
    toast(`${act}: ${r.via || 'ok'}`);
  } catch (err) { toast(err); }
});

$('sendForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const s = curSession(), t = $('sendText'); if (!s || !t.value.trim()) return;
  try { const r = await post('/api/control/send', { id: s.id, text: t.value }); t.value = ''; toast(`sent via ${r.via}`); } catch (err) { toast(err); }
});

const watcher = makeWatcher({ get, post, toast });
makePicker({ get, post, confirm: confirmBox, toast, onStarted: (id) => setTimeout(() => open(id), 1500) });
$('panelH').tabIndex = -1;
get('/api/model-icons').then((r) => { state.iconStore = r.store; renderSessions(); }).catch(() => {});
get('/api/control/config').then((c) => { setLive(c.liveSend); if (!c.canToggle) $('liveSendWrap').hidden = true; }).catch(() => {});
watcher.refresh(true).catch(() => {});
connect();

// sub-item 03: card "Phone app & notifications" (APK link + sha256, push defaults); its own module under web/m/
import('/control/m/desktop-panel.js').catch(() => {});
