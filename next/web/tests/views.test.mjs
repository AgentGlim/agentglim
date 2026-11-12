import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import * as pipeline from '../views/pipeline.ts';
import * as fleet from '../views/fleet.ts';
import * as blockers from '../views/blockers.ts';
import * as approvals from '../views/approvals.ts';
import * as costs from '../views/costs.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f) => JSON.parse(readFileSync(join(here, '../fixtures', f), 'utf8'));
const ev = fx('events.json');
const data = { status: fx('status.json'), events: ev.events, now: ev.now };

test('pipeline model', () => {
  const m = pipeline.model(data);
  assert.equal(m.length, 2);
  const p = m.find((x) => x.id === '68-observatory-app');
  assert.deepEqual(p.rounds.map((r) => r.id), ['v1-r3', 'v1-r2']);
  assert.deepEqual(p.rounds[0].workers.map((w) => w.id), ['web-views', 'core']);
  assert.match(pipeline.render(data), /web-views/);
});

test('fleet model', () => {
  const m = fleet.model(data);
  assert.equal(m.sources.length, 4);
  assert.equal(m.sources.filter((s) => s.detected).length, 3);
  assert.deepEqual(m.runtimes.map((r) => r.state), ['up', 'down', 'owner_off']);
  assert.match(m.runtimes[0].detail, /41.5 tok\/s/);
  assert.match(fleet.render(data), /data dir not found/);
});

test('blockers model', () => {
  const m = blockers.model(data);
  assert.deepEqual(m.map((b) => [b.id, b.days]), [['b1', 3], ['b2', 1]]);
});

test('approvals model', () => {
  const m = approvals.model(data);
  assert.equal(m.pending.length, 1);
  assert.equal(m.decided[0].id, 'a2');
});

test('costs totals equal hand-computed sums', () => {
  // Fixture: day i (0..99, 1h before midnight-of-now minus i days). Even i: claude-code/opus $1.00, 1000 tok.
  // Odd i: codex/gpt $0.50, 400 tok. Every 10th day also strata/qwen-local $0, 100 tok.
  // 7d  (i 0..6):  even 0,2,4,6 = $4.00/4000; odd 1,3,5 = $1.50/1200; local i=0 -> 100 tok. total $5.50, 5300 tok.
  // 30d (i 0..29): 15 even = $15/15000; 15 odd = $7.50/6000; local i=0,10,20 -> 300. total $22.50, 21300 tok.
  // 90d (i 0..89): 45 even = $45/45000; 45 odd = $22.50/18000; local i=0..80 (9) -> 900. total $67.50, 63900 tok.
  const [w7, w30, w90] = costs.model(data);
  assert.deepEqual(w7.total, { cost: 5.5, tokens: 5300 });
  assert.deepEqual(w30.total, { cost: 22.5, tokens: 21300 });
  assert.deepEqual(w90.total, { cost: 67.5, tokens: 63900 });
  assert.deepEqual(w7.bySource['claude-code'], { cost: 4, tokens: 4000 });
  assert.deepEqual(w7.bySource['codex'], { cost: 1.5, tokens: 1200 });
  assert.deepEqual(w30.byModel['qwen-local'], { cost: 0, tokens: 300 });
  assert.deepEqual(w90.byModel['opus'], { cost: 45, tokens: 45000 });
  assert.deepEqual(w90.byModel['gpt'], { cost: 22.5, tokens: 18000 });
});

test('check-parity: passes on the frozen baseline', () => {
  const out = execFileSync('node', [join(here, '../check-parity.mjs')], { encoding: 'utf8' });
  assert.doesNotMatch(out, /\| missing/);
});

test('check-parity: missing baseline exits nonzero with a clear error', () => {
  assert.throws(
    () => execFileSync('node', [join(here, '../check-parity.mjs'), join(here, '../fixtures/does-not-exist.html')], { encoding: 'utf8' }),
    (err) => err.status !== 0 && /required baseline not found/.test(err.stderr || err.message)
  );
});

test('views render without external roots', () => {
  for (const m of [pipeline, fleet, blockers, approvals, costs]) m.render(data);
});

test('app renders hostile error text as inert text', () => {
  const src = readFileSync(join(here, '../app.ts'), 'utf8');
  assert.doesNotMatch(src, /main\.innerHTML\s*=\s*`<p class="empty">Load failed/);
  assert.match(src, /textContent\s*=\s*`Load failed: \$\{String\(e\)\}`/);
});

test('app labels fixture data explicitly', () => {
  const src = readFileSync(join(here, '../app.ts'), 'utf8');
  assert.match(src, /Fixture data/);
  assert.match(src, /Refreshing/);
});
