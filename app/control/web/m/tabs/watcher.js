// Watcher tab (#/watcher): 01's pinned Watcher thread on the phone. My messages go to the watcher inbox
// (POST /api/remote/watcher {text}); its replies and structured asks render with textContent; an ask's buttons
// answer it ({action: 'answer', qid, choice}).
const POLL_MS = 5000;

export async function render(root, r, { get, post, el, card, toast }) {
  const { appendRich } = await import('/lib/chat.js');
  const c = card('c-watcher', 'Watcher'); root.appendChild(c);
  const box = el('div', 'thread'); box.setAttribute('aria-live', 'polite'); c.appendChild(box);
  const f = el('form'); f.className = 'pinform';
  const lab = el('label', null, 'Message to the watcher'); lab.htmlFor = 'wText';
  const ta = el('textarea'); ta.id = 'wText'; ta.maxLength = 8000; ta.rows = 3;
  const b = el('button', 'btn primary', 'Send'); b.type = 'submit';
  f.append(lab, ta, b); c.appendChild(f);
  let lastAt = -1;
  function draw(thread) {
    box.replaceChildren();
    if (!thread.length) box.appendChild(el('p', 'meta', 'No messages yet.'));
    for (const m of thread) {
      const d = el('div', `bubble ${m.kind === 'out' ? 'out' : 'assistant'}`);
      d.appendChild(el('span', 'who', m.kind === 'out' ? `you · ${m.state || ''}` : 'watcher'));
      appendRich(d, m.kind === 'out' ? (m.action ? `${m.action}${m.plan ? ` ${m.plan}` : ''}` : m.text || '') : m.text || '');
      if (m.ask) {
        d.appendChild(el('div', 'pq', m.ask.question));
        const row = el('div', 'ask');
        for (const o of m.ask.options || []) {
          const x = el('button', 'btn', o); x.type = 'button'; x.disabled = !!m.ask.answered || !m.ask.qid;
          x.addEventListener('click', async () => { try { await post('/api/remote/watcher', { action: 'answer', qid: m.ask.qid, choice: o }); toast(`answered: ${o}`); load(true); } catch (e) { toast(e, true); } });
          row.appendChild(x);
        }
        d.appendChild(row);
      }
      box.appendChild(d);
    }
    box.scrollTop = box.scrollHeight;
  }
  async function load(force) { const w = await get('/api/remote/watcher'); if (!force && w.at === lastAt) return; lastAt = w.at; draw(w.thread || []); }
  f.addEventListener('submit', async (e) => {
    e.preventDefault(); if (!ta.value.trim()) return;
    try { await post('/api/remote/watcher', { text: ta.value }); ta.value = ''; toast('sent to the watcher inbox'); load(true); } catch (err) { toast(err, true); }
  });
  await load(true);
  const t = setInterval(() => { if (!document.hidden) load().catch(() => {}); }, POLL_MS);
  return () => clearInterval(t);
}
