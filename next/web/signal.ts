// Minimal signals: signal, computed, effect (same API as plan 67).
type Sub = { run: () => void; deps: Set<Set<Sub>> };
let active: Sub | null = null;

export interface Signal<T> { (): T; set(v: T): void; peek(): T }

function track(subs: Set<Sub>): void {
  if (active) { subs.add(active); active.deps.add(subs); }
}
function cleanup(s: Sub): void {
  for (const d of s.deps) d.delete(s);
  s.deps.clear();
}

export function signal<T>(initial: T): Signal<T> {
  let value = initial;
  const subs = new Set<Sub>();
  const read = (() => { track(subs); return value; }) as Signal<T>;
  read.peek = () => value;
  read.set = (v: T) => {
    if (Object.is(v, value)) return;
    value = v;
    for (const s of [...subs]) s.run();
  };
  return read;
}

export function effect(fn: () => void): () => void {
  const sub: Sub = {
    deps: new Set(),
    run: () => {
      cleanup(sub);
      const prev = active;
      active = sub;
      try { fn(); } finally { active = prev; }
    },
  };
  sub.run();
  return () => cleanup(sub);
}

export function computed<T>(fn: () => T): () => T {
  const s = signal<T>(undefined as T);
  effect(() => s.set(fn()));
  return () => s();
}
