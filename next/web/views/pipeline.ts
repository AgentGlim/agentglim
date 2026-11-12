import { esc, type Data } from './util.ts';
export interface PlanRow { id: string; title: string; state: string; rounds: { id: string; state: string; workers: { id: string; state: string }[] }[] }
export function model(d: Data): PlanRow[] {
  const by = (k: string) => d.events.filter((e) => e.kind === k);
  return by('plan').map((p) => ({
    id: p.data.id, title: p.data.title, state: p.data.state,
    rounds: by('round').filter((r) => r.data.plan === p.data.id).map((r) => ({
      id: r.data.id, state: r.data.state,
      workers: by('worker').filter((w) => w.data.plan === p.data.id && w.data.round === r.data.id)
        .map((w) => ({ id: w.data.id, state: w.data.state })),
    })),
  }));
}
export function render(d: Data): string {
  const rows = model(d);
  if (!rows.length) return '<p class="empty">No plans.</p>';
  return rows.map((p) => `<div class="card"><h2>${esc(p.title)} <span class="pill ${esc(p.state)}">${esc(p.state)}</span></h2>` +
    p.rounds.map((r) => `<div class="round"><b>${esc(r.id)}</b> <span class="pill ${esc(r.state)}">${esc(r.state)}</span><ul>` +
      r.workers.map((w) => `<li>${esc(w.id)} <span class="pill ${esc(w.state)}">${esc(w.state)}</span></li>`).join('') +
      '</ul></div>').join('') + '</div>').join('');
}
