// Empty fallbacks (2026-11-10): with no plans harness (fresh install, empty AGENTGLIM_PLANS), the harness-backed
// endpoints answer 200 with an empty shape instead of a 500. The page renders these as "nothing yet".
import fs from 'node:fs';

export const has = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };

export const emptyModes = () => ({ empty: true, reason: 'no harness: modes.mjs not found', pending: [], subs: {}, canon: {} });

export const emptyAgyBench = () => ({ empty: true, reason: 'no harness: agy-bench.mjs not found', start: new Date().toISOString(),
  days: 1, day: 0, minRuns: 0, models: [], recent: [], winnersNow: {}, decided: null, override: null, next: null, slotPaused: null });
