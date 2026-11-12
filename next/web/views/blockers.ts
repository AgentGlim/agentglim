import { esc, type Data } from './util.ts';
export interface Blocker { id: string; plan: string; title: string; days: number }
export function model(d: Data): Blocker[] {
  return d.events.filter((e) => e.kind === 'blocker')
    .map((e) => ({ id: e.data.id, plan: e.data.plan, title: e.data.title, days: Math.floor((d.now - e.data.since) / 86400000) }))
    .sort((a, b) => b.days - a.days);
}
export function render(d: Data): string {
  const m = model(d);
  if (!m.length) return '<p class="empty">No blockers.</p>';
  return '<div class="card"><h2>Blockers</h2><ul>' +
    m.map((b) => `<li><b>${esc(b.title)}</b> <small>${esc(b.plan)} · ${b.days}d</small></li>`).join('') + '</ul></div>';
}
