import { esc, type Data } from './util.ts';
export interface FleetModel {
  sources: { id: string; kind: string; detected: boolean; note: string; sessions: number }[];
  runtimes: { id: string; state: string; detail: string }[];
  sessions: { total: number; active: number };
}
export function model(d: Data): FleetModel {
  return {
    sources: d.status.sources.map((s) => ({ id: s.id, kind: s.kind, detected: s.detected, note: s.reason ?? 'detected', sessions: s.sessions ?? 0 })),
    runtimes: d.status.runtimes.map((r) => ({
      id: r.id, state: r.state.state,
      detail: r.state.state === 'up'
        ? `${(r.state.models ?? []).join(', ')} · ${r.state.tps} tok/s · ${((r.state.vram_bytes ?? 0) / 1e9).toFixed(1)} GB VRAM`
        : r.state.state === 'owner_off' ? 'turned off by owner' : 'not running',
    })),
    sessions: d.status.sessions,
  };
}
export function render(d: Data): string {
  const m = model(d);
  return `<div class="card"><h2>Sources <small>${m.sessions.active}/${m.sessions.total} sessions active</small></h2><table>` +
    m.sources.map((s) => `<tr><td>${esc(s.id)}</td><td>${esc(s.kind)}</td><td><span class="pill ${s.detected ? 'up' : 'down'}">${esc(s.note)}</span></td><td>${s.sessions}</td></tr>`).join('') +
    `</table></div><div class="card"><h2>Local runtimes</h2><table>` +
    m.runtimes.map((r) => `<tr><td>${esc(r.id)}</td><td><span class="pill ${esc(r.state)}">${esc(r.state)}</span></td><td>${esc(r.detail)}</td></tr>`).join('') +
    '</table></div>';
}
