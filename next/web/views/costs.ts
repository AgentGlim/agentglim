import { esc, type Data } from './util.ts';
const DAY = 86400000;
export interface Bucket { cost: number; tokens: number }
export interface CostWindow { days: number; total: Bucket; bySource: Record<string, Bucket>; byModel: Record<string, Bucket> }
export function model(d: Data, windows = [7, 30, 90]): CostWindow[] {
  return windows.map((days) => {
    const w: CostWindow = { days, total: { cost: 0, tokens: 0 }, bySource: {}, byModel: {} };
    for (const e of d.events) {
      if (e.kind !== 'spend' || e.ts <= d.now - days * DAY || e.ts > d.now) continue;
      const c = Number(e.data.cost_usd ?? 0), t = Number(e.data.tokens ?? 0);
      for (const [map, key] of [[w.bySource, e.source], [w.byModel, String(e.data.model)]] as const) {
        const b = (map[key] ??= { cost: 0, tokens: 0 });
        b.cost += c; b.tokens += t;
      }
      w.total.cost += c; w.total.tokens += t;
    }
    // round to cents to hide float noise
    const r = (b: Bucket) => { b.cost = Math.round(b.cost * 100) / 100; };
    r(w.total); Object.values(w.bySource).forEach(r); Object.values(w.byModel).forEach(r);
    return w;
  });
}
export function render(d: Data): string {
  const rows = (m: Record<string, Bucket>) => Object.entries(m).map(([k, b]) => `<tr><td>${esc(k)}</td><td>$${b.cost.toFixed(2)}</td><td>${b.tokens}</td></tr>`).join('');
  return model(d).map((w) => `<div class="card"><h2>Last ${w.days} days <small>$${w.total.cost.toFixed(2)} · ${w.total.tokens} tokens</small></h2>` +
    `<h3>By source</h3><table>${rows(w.bySource)}</table><h3>By model</h3><table>${rows(w.byModel)}</table></div>`).join('');
}
