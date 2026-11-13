// Plan folders, fold-note merges and auto plan icons: a new plan shows up with its own icon, a plan marked
// "Folded into NN" nests under its parent, and nothing is ever drawn with a blank or the default "i".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planDirs, planTitle, foldNote, foldNotes, foldEntries, planCategory, planIconsFor } from '../plan-meta.mjs';

const mk = (plans) => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-plans-')); for (const [d, md] of Object.entries(plans)) { fs.mkdirSync(path.join(root, d)); if (md != null) fs.writeFileSync(path.join(root, d, 'PLAN.md'), md); } return root; };

test('every NN-slug folder with a PLAN.md is a plan; title comes from its heading', () => {
  const root = mk({ '90-zz-new-thing': '# Plan 90: New thing\n', '91-no-plan-md': null, '_run': null, 'notes': '# x' });
  assert.deepEqual(planDirs(root, 1), ['90-zz-new-thing']);
  assert.equal(planTitle(root, '90-zz-new-thing'), 'New thing');
});

test('fold notes: "Folded into NN" / "Folded into NN-slug" at the top nests the plan; a mention further down does not', () => {
  assert.equal(foldNote('> **Folded into 12-demo-app** (2026-11-11): see plan 12.').slug, '12-demo-app');
  assert.equal(foldNote('> **Folded into 33** — owner-confirmed 2026-11-11.').num, '33');
  assert.equal(foldNote('# Plan\n\nWe never folded into anything.'), null);
  const root = mk({ '92-zz-parent': '# Plan 92: Parent\n', '93-zz-child': '> **Folded into 92** (2026-11-11): phase 2 of plan 92.\n\n# Plan 93: Child\n', '94-zz-other': '# Plan 94: Other\n\nSome text\n'.repeat(1) + 'later: folded into 92\n' });
  const f = foldNotes(root, 2);
  assert.deepEqual(Object.keys(f), ['93-zz-child']); assert.equal(f['93-zz-child'].parent, '92-zz-parent'); assert.equal(f['93-zz-child'].date, '2026-11-11');
  const e = foldEntries(root, 3)['92-zz-parent'];
  assert.equal(e.length, 1); assert.equal(e[0].plan, '93-zz-child'); assert.equal(e[0].name, 'Child'); assert.equal(e[0].fold, true);
});

test('a new plan folder gets its own fitting icon from the pool, kept across restarts; hand-picked plans keep theirs', () => {
  const root = mk({ '01-zz-hand': '# Plan 01: Hand\n', '95-zz-leads-engine': '# Plan 95: Leads engine\n', '96-zz-dashboard-thing': '# Plan 96: Dashboard\n', '97-zz-qwerty': '# Plan 97: Qwerty\n' });
  const file = path.join(root, 'plan-icons.json');
  const icons = planIconsFor(root, file, 4);
  for (const d of planDirs(root, 4)) assert.ok(typeof icons[d] === 'string' && icons[d].length > 10, `${d} has an icon`);
  const P = globalThis.PlanIcons;
  assert.equal(icons['01-zz-hand'], P.HAND['01']);
  assert.equal(icons['95-zz-leads-engine'], P.POOL.magnet[0]);
  assert.equal(icons['96-zz-dashboard-thing'], P.POOL.dashboard[0]);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).picks;
  assert.ok(saved['97-zz-qwerty'] && !['magnet', 'dashboard'].includes(saved['97-zz-qwerty'])); // unused glyph, never a duplicate
  // a later plan never steals an earlier plan's saved icon
  const again = P.pick([{ dir: '95-zz-leads-engine' }, { dir: '98-zz-more-leads', title: 'More leads' }], saved);
  assert.equal(again.icons['95-zz-leads-engine'].key, 'magnet'); assert.notEqual(again.icons['98-zz-more-leads'].key, 'magnet');
});

test('a new plan gets a category: categories.json, else its folded plans, else keywords', () => {
  const cats = { plans: { '05': 'Business', '07': 'Business', '39': 'Content' } };
  assert.equal(planCategory('05-x', cats), 'Business');
  assert.equal(planCategory('12-demo-app', cats, { '05-x': { parent: '12-demo-app' }, '07-y': { parent: '12-demo-app' } }), 'Business');
  assert.equal(planCategory('99-zz-video-lab', cats, {}), 'Content');
  assert.equal(planCategory('98-zz-misc', cats, {}), 'Ops');
});
