import { signal, computed, effect } from './signal.ts';
import type { Data } from './views/util.ts';
import * as pipeline from './views/pipeline.ts';
import * as fleet from './views/fleet.ts';
import * as blockers from './views/blockers.ts';
import * as approvals from './views/approvals.ts';
import * as costs from './views/costs.ts';

const views = { pipeline, fleet, blockers, approvals, costs } as const;
type Name = keyof typeof views;
const names = Object.keys(views) as Name[];

const data = signal<Data | null>(null);
const tab = signal<Name>(names.includes(location.hash.slice(1) as Name) ? (location.hash.slice(1) as Name) : 'pipeline');
const loading = signal<boolean>(false);
const source = signal<string>('');
const html = computed(() => { const d = data(); return d ? views[tab()].render(d) : '<p class="empty">Loading…</p>'; });

async function load(): Promise<void> {
  loading.set(true);
  const base = new URLSearchParams(location.search).get('api');
  const get = async (p: string) => (await fetch(p)).json();
  const usingFixtures = !base;
  source.set(usingFixtures ? 'fixtures' : 'api');
  const [status, ev] = base
    ? [await get(`${base}/api/v1/status`), await get(`${base}/api/v1/events`)]
    : [await get('fixtures/status.json'), await get('fixtures/events.json')];
  data.set({ status, events: ev.events, now: ev.now ?? Date.now() });
  loading.set(false);
}

const nav = document.getElementById('tabs')!;
const main = document.getElementById('view')!;
nav.innerHTML = names.map((n) => `<button data-t="${n}">${n}</button>`).join('');
nav.addEventListener('click', (e) => { const t = (e.target as HTMLElement).dataset.t as Name | undefined; if (t) { tab.set(t); location.hash = t; } });
effect(() => {
  const cur = tab();
  nav.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String((b as HTMLElement).dataset.t === cur)));
});
effect(() => { main.innerHTML = html(); });
const badge = document.getElementById('needs')!;
effect(() => { const d = data(); badge.textContent = d ? `${d.status.needs_you} need you` : ''; });
const stateEl = document.getElementById('datastate')!;
effect(() => {
  if (loading()) { stateEl.textContent = 'Refreshing…'; return; }
  stateEl.textContent = source() === 'fixtures' ? 'Fixture data' : (source() ? 'Live data' : '');
});
load().catch((e) => {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = `Load failed: ${String(e)}`;
  main.replaceChildren(p);
});