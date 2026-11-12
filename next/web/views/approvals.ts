import { esc, type Data } from './util.ts';
export interface Approval { id: string; title: string; state: string }
export function model(d: Data): { pending: Approval[]; decided: Approval[] } {
  const all = d.events.filter((e) => e.kind === 'approval').map((e) => ({ id: e.data.id, title: e.data.title, state: e.data.state }));
  return { pending: all.filter((a) => a.state === 'pending'), decided: all.filter((a) => a.state !== 'pending') };
}
export function render(d: Data): string {
  const m = model(d);
  const li = (a: Approval) => `<li>${esc(a.title)} <span class="pill ${esc(a.state)}">${esc(a.state)}</span></li>`;
  return `<div class="card"><h2>Approvals</h2><h3>Waiting for you (${m.pending.length})</h3><ul>${m.pending.map(li).join('')}</ul>` +
    `<h3>Decided</h3><ul>${m.decided.map(li).join('')}</ul></div>`;
}
