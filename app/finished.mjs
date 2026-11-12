// "Finished in the last N days" strip on Active builds: the digest carries every plan that finished in the last
// 7 days (newest first), the page filters by the viewer's choice (1-7 days, remembered in localStorage).
export const FINISHED_MAX_DAYS = 7;
const DAY = 86400e3;

// 1..7, whole days; anything else (missing, NaN, 0, 99) falls back to 1 or the cap
export function clampDays(v, fallback = 1) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(FINISHED_MAX_DAYS, n);
}

// time of the newest "advance <plan> <stage> -> done (ok)" event of one plan (events: [{t, verb, text}], oldest first)
export function lastDoneAt(events) {
  for (let i = (events || []).length - 1; i >= 0; i--) {
    const x = events[i];
    if (x.verb === 'advance' && x.text.endsWith('-> done (ok)')) return x.t || null;
  }
  return null;
}

// rows [{dir, at, pct}] finished within `days` days of `now`, newest first
export function finishedWithin(rows, now, days) {
  const cut = now - clampDays(days) * DAY;
  return (rows || []).filter((r) => r.at && r.at >= cut && r.at <= now + 60e3).sort((a, b) => b.at - a.at);
}

export function finishedLabel(days) {
  const d = clampDays(days);
  return d === 1 ? 'finished in the last 24 h' : `finished in the last ${d} days`;
}

// The plan table under the strip follows the same window. `plans` is the server's list (live, held, pinned, and
// done/held plans that moved in the last 24 h); `older` holds done plans whose last driver event is 1-7 days old.
// Those join the table when their last event falls inside the chosen window; live and held rows never change.
const ORDER = { running: 0, gate: 1, cooldown: 2, waiting: 3, done: 4, held: 5 };
export function plansInWindow(plans, older, now, days) {
  const cut = now - clampDays(days) * DAY;
  const extra = (older || []).filter((p) => p.state === 'done' && p.last?.t && p.last.t >= cut);
  return [...(plans || []), ...extra].sort((a, b) => (ORDER[a.state] ?? 9) - (ORDER[b.state] ?? 9) || a.dir.localeCompare(b.dir));
}

export function doneLabel(days) {
  const d = clampDays(days);
  return d === 1 ? 'done today' : `done in ${d} days`;
}
