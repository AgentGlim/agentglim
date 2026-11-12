// Approvals tab (#/approvals): open items (GET /api/remote/approvals) with a "Mark done" button and an optional
// note, posted as markDone (POST /api/remote/approvals {id, done: true, note}); writes need the unlock.
export async function render(root, r, { get, post, el, card, toast }) {
  const c = card('c-approvals-list', 'Approvals'); root.appendChild(c);
  const box = el('div', 'list'); c.appendChild(box);
  async function load() {
    const d = await get('/api/remote/approvals');
    const items = d.items || [];
    const n = document.getElementById('apCount'); if (n) { n.textContent = String(items.length); n.hidden = !items.length; }
    box.replaceChildren();
    if (!items.length) { box.appendChild(el('p', 'meta', 'Nothing open. Well done.')); return; }
    for (const it of items) {
      const d2 = el('div', 'row'); d2.style.flexWrap = 'wrap'; d2.style.cursor = 'default';
      const g = el('span', 'grow'); g.appendChild(el('span', 'nm', it.title)); g.appendChild(el('span', 'sub', `${it.project} · ${it.kind}`)); d2.appendChild(g);
      const det = el('details'); det.style.width = '100%';
      const sum = el('summary', 'btn', 'Mark done'); det.appendChild(sum);
      const f = el('form', 'pinform');
      const lab = el('label', null, 'Note (optional)'); const ta = el('textarea'); ta.maxLength = 2000; ta.rows = 2;
      const id = `n-${Math.random().toString(36).slice(2)}`; ta.id = id; lab.htmlFor = id;
      const b = el('button', 'btn primary', 'Confirm: mark done'); b.type = 'submit';
      f.append(lab, ta, b); det.appendChild(f); d2.appendChild(det);
      f.addEventListener('submit', async (e) => {
        e.preventDefault(); b.disabled = true;
        try { await post('/api/remote/approvals', { id: it.id, done: true, note: ta.value }); toast('marked done'); await load(); } catch (err) { toast(err, true); b.disabled = false; }
      });
      box.appendChild(d2);
    }
  }
  await load();
  const t = setInterval(() => { if (!document.hidden) load().catch(() => {}); }, 30e3);
  return () => clearInterval(t);
}
