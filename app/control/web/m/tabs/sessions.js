// Sessions tab (#/sessions) and one thread (#/thread/<id>): 01's thread view (/lib/chat.js bubbles, textContent
// only, links inert) over 02's auth. Sending and prompt answers go through 01's routes, which refuse with
// live_send_off until the owner turns live sends on at the desktop.
const POLL_MS = 3000;
const label = (s) => s.name || (s.role === 'watcher' ? 'watcher' : `${s.harness} ${s.project || ''}`.trim());

export async function render(root, r, ctx) {
  return r.tab === 'thread' ? thread(root, r.id, ctx) : list(root, ctx);
}

async function list(root, { get, el, card, ago, icon }) {
  const c = card('c-sessions', 'Sessions'); root.appendChild(c);
  const box = el('div', 'list'); c.appendChild(box);
  const note = el('p', 'meta'); c.appendChild(note);
  async function load() {
    const d = await get('/api/remote/sessions');
    const rows = (d.sessions || []).filter((s) => s.alive || s.state === 'stopped').sort((a, b) => (b.state === 'waiting') - (a.state === 'waiting') || (b.alive - a.alive));
    box.replaceChildren(...rows.map((s) => {
      const a = el('a', 'row'); a.href = `#/thread/${encodeURIComponent(s.id)}`;
      a.appendChild(icon(s.model, s.harness));
      const g = el('span', 'grow'); g.appendChild(el('span', 'nm', label(s))); g.appendChild(el('span', 'sub', [s.harness, s.project, s.model, ago(s.lastActivity || s.started)].filter(Boolean).join(' · '))); a.appendChild(g);
      a.appendChild(el('span', `st ${s.state || ''}`, s.state || '–'));
      return a;
    }));
    if (!rows.length) box.appendChild(el('p', 'meta', 'No live sessions.'));
    note.textContent = d.liveSend ? 'Live sends are on.' : 'Live sends are off (read-only). Turn them on at the desktop Control page.';
  }
  await load();
  const t = setInterval(() => { if (!document.hidden) load().catch(() => {}); }, POLL_MS);
  return () => clearInterval(t);
}

async function thread(root, id, { get, post, el, card, toast }) {
  const { makeChat } = await import('/lib/chat.js');
  const d = await get('/api/remote/sessions');
  const s = (d.sessions || []).find((x) => x.id === id);
  const c = card('c-thread', s ? label(s) : id); root.appendChild(c);
  const back = el('a', 'btn', '‹ Sessions'); back.href = '#/sessions'; c.insertBefore(back, c.firstChild);
  if (s) c.appendChild(el('p', 'meta', [s.harness, s.project, s.state, s.delivery?.mode ? `delivery: ${s.delivery.mode}` : null].filter(Boolean).join(' · ')));
  // an open prompt: its options as buttons (01's /prompt route, hash-checked against the live pane)
  if (s?.prompt?.options?.length) {
    const pq = el('div', 'card'); pq.appendChild(el('div', 'pq', s.prompt.question || 'The session asks:'));
    const row = el('div', 'ask');
    s.prompt.options.forEach((o, i) => { const b = el('button', 'btn', o.label || `option ${i + 1}`); b.type = 'button'; b.addEventListener('click', async () => { try { await post('/api/remote/prompt', { id, hash: s.prompt.hash, option: i }); toast(`sent: ${o.label}`); } catch (e) { toast(e, true); } }); row.appendChild(b); });
    pq.appendChild(row); c.appendChild(pq);
  }
  const box = el('div', 'thread'); box.setAttribute('aria-live', 'polite'); c.appendChild(box);
  const chat = makeChat(box); chat.reset(id);
  const f = el('form'); f.className = 'pinform';
  const lab = el('label', null, 'Message'); lab.htmlFor = 'msgText';
  const ta = el('textarea'); ta.id = 'msgText'; ta.maxLength = 20000; ta.rows = 3;
  const send = el('button', 'btn primary', 'Send'); send.type = 'submit';
  f.append(lab, ta, send); c.appendChild(f);
  f.addEventListener('submit', async (e) => {
    e.preventDefault(); if (!ta.value.trim()) return;
    try { const x = await post('/api/remote/send', { id, text: ta.value }); ta.value = ''; toast(`sent via ${x.via || 'tmux'}`); } catch (err) { toast(err, true); }
  });
  async function pull() {
    const t = await get(`/api/remote/thread/${encodeURIComponent(id)}?after=${chat.cursor}`);
    chat.add(t.bubbles || [], t.cursor);
  }
  try { await pull(); } catch (e) { if (e.status === 404) box.appendChild(el('p', 'meta', 'This session is gone.')); else throw e; }
  const t = setInterval(() => { if (!document.hidden) pull().catch(() => {}); }, POLL_MS);
  return () => clearInterval(t);
}
