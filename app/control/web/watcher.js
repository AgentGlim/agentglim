// Pinned Watcher thread: my messages (inbox files), the watcher's replies (chat-write.mjs), structured asks as
// buttons, and quick actions. Reply text is rendered with textContent only.
import { el, appendRich } from './chat.js';

export function makeWatcher({ get, post, toast }) {
  const box = document.getElementById('wThread');
  let lastAt = -1;
  function render(thread) {
    box.replaceChildren();
    if (!thread.length) box.appendChild(el('div', 'meta', 'No messages yet. The watcher reads them when auditq-wait.sh prints CHAT:.'));
    for (const m of thread) {
      const d = el('div', `bubble ${m.kind === 'out' ? 'out' : 'assistant'}`);
      d.appendChild(el('span', 'who', m.kind === 'out' ? `you · ${m.state}` : 'watcher'));
      appendRich(d, m.kind === 'out' ? (m.action ? `${m.action}${m.plan ? ` ${m.plan}` : ''}` : m.text || '') : m.text || '');
      if (m.ask) {
        d.appendChild(el('div', 'pq', m.ask.question));
        const row = el('div', 'ask');
        for (const o of m.ask.options) {
          const b = el('button', 'btn', o); b.type = 'button'; b.disabled = m.ask.answered || !m.ask.qid;
          b.addEventListener('click', () => post('/api/control/watcher', { action: 'answer', qid: m.ask.qid, choice: o }).then(() => { toast(`answered: ${o}`); refresh(true); }, toast));
          row.appendChild(b);
        }
        d.appendChild(row);
      }
      box.appendChild(d);
    }
    box.scrollTop = box.scrollHeight;
  }
  async function refresh(force) {
    const r = await get('/api/control/watcher');
    if (!force && r.at === lastAt) return;
    lastAt = r.at; render(r.thread);
    const plans = document.getElementById('qPlan'), gates = document.getElementById('qGate');
    if (r.plans && !plans.childElementCount) plans.replaceChildren(...r.plans.map((p) => { const o = el('option', null, p); o.value = p; return o; }));
    if (r.gates) { const cur = gates.value; gates.replaceChildren(...(r.gates.length ? r.gates : [{ id: '', title: '(no open gates)' }]).map((g) => { const o = el('option', null, g.title); o.value = g.id; return o; })); gates.value = cur; }
  }
  document.getElementById('wForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = document.getElementById('wText');
    if (!t.value.trim()) return;
    try { await post('/api/control/watcher', { text: t.value }); t.value = ''; toast('sent to the watcher inbox'); refresh(true); } catch (err) { toast(err); }
  });
  for (const b of document.querySelectorAll('[data-qa]')) b.addEventListener('click', async () => {
    const a = b.dataset.qa, body = { action: a };
    if (a.endsWith('-plan')) body.plan = document.getElementById('qPlan').value;
    if (a === 'mode') { body.key = document.getElementById('qModeKey').value; body.value = document.getElementById('qModeVal').value.trim(); }
    if (a === 'approve') { body.id = document.getElementById('qGate').value; if (!body.id) return toast('no gate selected'); }
    try { const r = await post('/api/control/watcher', body); toast(`${a}: ${r.msg || 'done'}`); refresh(true); } catch (err) { toast(err); }
  });
  return { refresh };
}
