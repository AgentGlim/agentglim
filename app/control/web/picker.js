// New headed session picker: harness buttons, then folder (real dirs under the project roots), model and effort
// from control.json allowlists, Claude permission mode (bypassPermissions is never offered).
import { el } from './chat.js';

export function makePicker({ get, post, confirm, toast, onStarted }) {
  const form = document.getElementById('pickForm');
  const sel = { folder: document.getElementById('pFolder'), model: document.getElementById('pModel'), effort: document.getElementById('pEffort'), mode: document.getElementById('pMode') };
  let opts = null, harness = null;
  const fill = (s, list, blank) => { s.replaceChildren(...(blank ? [el('option', null, blank)] : []), ...list.map((v) => { const o = el('option', null, v); o.value = v; return o; })); if (blank) s.firstChild.value = ''; };
  async function choose(h) {
    harness = h;
    for (const b of document.querySelectorAll('#pickHarness .btn')) { b.classList.toggle('sel', b.dataset.h === h); b.setAttribute('aria-pressed', String(b.dataset.h === h)); }
    if (!opts) opts = await get('/api/control/launch/options');
    const o = opts.options[h] || { models: [], efforts: [], modes: [] };
    fill(sel.folder, opts.folders);
    fill(sel.model, o.models, '(default)');
    fill(sel.effort, o.efforts, '(default)');
    fill(sel.mode, o.modes, '(default)');
    document.getElementById('pModeL').hidden = h !== 'claude';
    document.getElementById('pEffortL').hidden = h === 'opencode';
    document.getElementById('pHint').textContent = `attach later with: tmux attach -t ${opts.tmuxSession}`;
    form.hidden = false;
  }
  for (const b of document.querySelectorAll('#pickHarness .btn')) b.addEventListener('click', () => choose(b.dataset.h).catch(toast));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { harness, folder: sel.folder.value, model: sel.model.value || null, effort: sel.effort.value || null, mode: harness === 'claude' ? sel.mode.value || null : null };
    try {
      const first = await post('/api/control/launch', body);
      const ok = await confirm(`Start ${harness} in tmux window ${first.summary.window}?`, [`folder: ${first.summary.dir}`, `command: ${first.summary.argv.join(' ')}`], first.expiresIn);
      if (!ok) return;
      const r = await post('/api/control/launch', { ...body, confirm: first.confirm, name: first.name });
      toast(`started ${r.window}${r.pid ? ` (pid ${r.pid})` : ''}; ${r.attach}`);
      if (r.id) onStarted(r.id);
    } catch (err) { toast(err); }
  });
  return { choose };
}
