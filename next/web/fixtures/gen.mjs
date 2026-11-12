// Regenerates fixtures/events.json deterministically. Run: node fixtures/gen.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const NOW = 1767225600000, DAY = 86400000;
const ev = []; let seq = 0;
const add = (kind, source, ts, data) => ev.push({ seq: ++seq, kind, source, ts, data });
for (let i = 99; i >= 0; i--) {
  const ts = NOW - i * DAY - 3600000;
  if (i % 2 === 0) add('spend', 'claude-code', ts, { model: 'opus', cost_usd: 1.0, tokens: 1000 });
  else add('spend', 'codex', ts, { model: 'gpt', cost_usd: 0.5, tokens: 400 });
  if (i % 10 === 0) add('spend', 'strata', ts, { model: 'qwen-local', cost_usd: 0, tokens: 100 });
}
const t = NOW - 3600000;
add('plan', 'plans-harness', t, { id: '68-observatory-app', title: 'Observatory app', state: 'active' });
add('plan', 'plans-harness', t, { id: '67-signals', title: 'Signals', state: 'done' });
add('round', 'plans-harness', t, { plan: '68-observatory-app', id: 'v1-r3', state: 'running' });
add('round', 'plans-harness', t, { plan: '68-observatory-app', id: 'v1-r2', state: 'done' });
add('worker', 'plans-harness', t, { plan: '68-observatory-app', round: 'v1-r3', id: 'web-views', state: 'running' });
add('worker', 'plans-harness', t, { plan: '68-observatory-app', round: 'v1-r3', id: 'core', state: 'done' });
add('worker', 'plans-harness', t, { plan: '68-observatory-app', round: 'v1-r2', id: 'adapters', state: 'done' });
add('blocker', 'plans-harness', t, { id: 'b1', plan: '68-observatory-app', title: 'Owner signing key needed', since: NOW - 3 * DAY });
add('blocker', 'plans-harness', t, { id: 'b2', plan: '67-signals', title: 'Waiting on review', since: NOW - DAY });
add('approval', 'plans-harness', t, { id: 'a1', title: 'Publish public repo', state: 'pending' });
add('approval', 'plans-harness', t, { id: 'a2', title: 'Install service', state: 'approved' });
const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, 'events.json'), JSON.stringify({ now: NOW, events: ev }, null, 1) + '\n');
