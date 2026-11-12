// Dashboard tab: the six desktop cards re-laid out for 390 px, from GET /api/remote/phone-snapshot (refresh 15 s).
// #/card/<name> scrolls to and outlines one card (status, builds, pipeline, approvals, agents, providers).
export const CARDS = ['status', 'builds', 'pipeline', 'approvals', 'agents', 'providers'];
const REFRESH_MS = 15e3;

export async function render(root, r, { get, el, card, ago, icon, iconState }) {
  const wrap = el('div'); wrap.style.display = 'contents'; root.appendChild(wrap);
  const pct = (v) => (v == null ? '–' : `${Math.round(v)}%`);
  const bar = (v) => { const b = el('div', 'bar'); const i = el('i', v >= 100 ? 'full' : v >= 85 ? 'hi' : ''); i.style.width = `${Math.max(0, Math.min(100, v || 0))}%`; b.appendChild(i); return b; };
  const row = (name, sub, right, left = null, href = null) => {
    const a = el(href ? 'a' : 'div', 'row'); if (href) a.href = href;
    if (left) a.appendChild(left);
    const g = el('span', 'grow'); g.appendChild(el('span', 'nm', name)); if (sub) g.appendChild(el('span', 'sub', sub)); a.appendChild(g);
    if (right) a.appendChild(right);
    return a;
  };
  const st = (t, cls) => el('span', `st ${cls || String(t).replace(/[^a-z]/g, '')}`, t);
  function draw(s) {
    iconState.store = s.iconStore || null;
    const out = [];
    // Status
    const cS = card('c-status', 'Status');
    cS.appendChild(el('div', 'big', s.status?.line || (s.driverAlive ? 'Running' : 'Driver off')));
    const t = s.status?.tally || {};
    const tiles = el('div', 'tiles');
    for (const [k, l] of [['running', 'building'], ['gate', 'wait on you'], ['waiting', 'waiting'], ['held', 'held'], ['done24', 'done 24 h'], ['total', 'plans']]) { const x = el('div', 'tile'); x.appendChild(el('b', null, t[k] ?? '–')); x.appendChild(el('span', null, l)); tiles.appendChild(x); }
    cS.appendChild(tiles);
    for (const f of s.status?.flags || []) { const d = el('div', 'flag'); d.appendChild(st(f.level === 'critical' ? 'critical' : 'warn')); d.appendChild(el('span', null, `${f.dir ? `${f.dir}: ` : ''}${f.text || f.where || ''}`)); cS.appendChild(d); }
    cS.appendChild(el('p', 'meta', `Snapshot ${ago(s.at)}${s.driverAlive ? '' : ' · driver off'}`));
    out.push(cS);
    // Active builds
    const cB = card('c-builds', 'Active builds');
    const lb = el('div', 'list');
    if (!s.builds?.length) lb.appendChild(el('p', 'meta', 'No active build.'));
    for (const b of s.builds || []) {
      lb.appendChild(row(b.dir, [b.stage, b.round && b.pct != null ? `${b.round} audit ${pct(b.pct)}` : null, b.note].filter(Boolean).join(' · '), b.gateAt ? st('gate') : null, (b.models || [])[0] ? icon(b.models[0].model, b.models[0].provider) : null));
      for (const x of b.sub || []) lb.appendChild(row(`${x.id} ${x.title || ''}`, x.agent ? `${x.agent.step} r${x.agent.round} · ${x.agent.model || ''}` : x.pct != null ? `audit ${pct(x.pct)}` : '', st(x.status || '–')));
    }
    cB.appendChild(lb); out.push(cB);
    // Pipeline
    const cP = card('c-pipeline', 'Pipeline');
    const lp = el('div', 'list');
    for (const p of s.pipeline || []) lp.appendChild(row(p.dir, [p.stage, p.pct != null ? `audit ${pct(p.pct)}` : null, p.active ? `${p.active} active` : null].filter(Boolean).join(' · '), p.held ? st('held', 'paused') : p.stage === 'done' ? st('done', 'ok') : /gate$/.test(p.stage || '') ? st('gate') : null));
    cP.appendChild(lp); out.push(cP);
    // Approvals
    const cA = card('c-approvals', 'Approvals');
    const la = el('div', 'list');
    if (!s.approvals?.length) la.appendChild(el('p', 'meta', 'Nothing open.'));
    for (const a of s.approvals || []) la.appendChild(row(a.project, `${a.open} open`, st(String(a.open), 'warn'), null, '#/approvals'));
    cA.appendChild(la); out.push(cA);
    // Active agents
    const cG = card('c-agents', `Active agents · ${s.agents?.length || 0}`);
    const lg = el('div', 'list');
    if (!s.agents?.length) lg.appendChild(el('p', 'meta', 'No agent running.'));
    for (const a of s.agents || []) lg.appendChild(row(`${a.project} · ${a.role}`, [a.step, a.model, a.task].filter(Boolean).join(' · '), el('span', 'meta', ago(a.started)), icon(a.model, a.provider)));
    cG.appendChild(lg); out.push(cG);
    // Providers
    const cV = card('c-providers', 'Providers');
    for (const p of s.providers || []) {
      const d = el('div'); d.style.margin = '6px 0 10px';
      const h = el('div', 'row'); h.style.minHeight = '32px'; h.style.borderBottom = '0'; h.appendChild(icon(null, p.provider)); h.appendChild(el('span', 'grow', p.name || p.id)); d.appendChild(h);
      for (const w of p.windows || []) { const l = el('div', 'meta', `${w.label}: ${pct(w.pct)}${w.resetsAt ? ` · resets ${new Date(w.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`); d.appendChild(l); d.appendChild(bar(w.pct)); }
      if (p.error) d.appendChild(el('p', 'meta', p.error));
      cV.appendChild(d);
    }
    if (!s.providers?.length) cV.appendChild(el('p', 'meta', 'No limits read yet.'));
    out.push(cV);
    wrap.replaceChildren(...out);
    if (r.card && CARDS.includes(r.card)) { const c = document.getElementById(`c-${r.card}`); if (c) { c.classList.add('hl'); c.scrollIntoView({ block: 'start' }); } }
  }
  let stopped = false;
  async function load() { const s = await get('/api/remote/phone-snapshot'); if (!stopped) draw(s); }
  await load();
  const t = setInterval(() => { if (!document.hidden) load().catch(() => {}); }, REFRESH_MS);
  return () => { stopped = true; clearInterval(t); };
}
