// Pipeline filter row and Status view picker (index.html source checks; the live look is proven with Playwright).
// - category chips are pure filters; pausing lives in one "Pause categories" popover with a "Paused: N" badge
// - the audit chip reads "audit <90%" (still includes plans with no audit yet); no "v0.2 reopened" legend chip
// - the view picker text is red on Warnings and flags, amber on a per-plan view, normal on the overview
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const steps = JSON.parse(fs.readFileSync(new URL('../walkthrough-steps.json', import.meta.url), 'utf8'));

test('category chips stay pure filters; one Pause categories popover uses the category-hold routes', () => {
  assert.doesNotMatch(html, /class="cgrp"|class="cpz"/, 'no per-chip Paused / group markup');
  assert.doesNotMatch(html, /closest\('\.cpb'\)\); if \(cb\)/, 'the key no longer handles per-chip Pause pills');
  assert.match(html, /const catChip = \(k, c\) => chip\('cat', k, c\);/, 'category chip is a plain filter chip');
  assert.ok(html.includes('class="cpm-btn${nPaused ? \' on\' : \'\'}"'), 'one Pause categories button in the key');
  assert.ok(html.includes('>Pause categories${nPaused ? `<span class="cpc">Paused: ${nPaused}</span>`'), 'button with a Paused: N badge');
  assert.match(html, /\+ catBtn \+ catLines;/, 'button sits at the end of the key');
  assert.match(html, /\.catkey \.cpm-btn\{margin-left:auto/, 'button pushed to the right end of the row');
  assert.match(html, /function catMenuRender\(\)[\s\S]{0,1600}class="cpb\$\{on \? ' on' : ''\}" data-cat="\$\{esc\(h\.cat\)\}" data-pause="\$\{on \? 0 : 1\}"/, 'popover rows carry the Pause/Resume toggle');
  assert.match(html, /fetch\('\/api\/category-hold', \{ method: 'POST'/, 'toggles still post to /api/category-hold');
  assert.match(html, /fetch\('\/api\/category-holds'/, 'state still read from /api/category-holds');
  const st = steps.steps.find((s) => s.id === 'catPause');
  assert.equal(st?.target, '#pipeKey .cpm-btn', 'tour step points at the new button');
});

test('audit chip is short and the reopened legend chip is gone', () => {
  assert.match(html, /const AU_LABEL = \{ lt90: 'audit <90%', ge90: 'audit 90%\+' \}/);
  assert.doesNotMatch(html, /incl\. none yet/);
  assert.doesNotMatch(html, /v0\.2<\/span>reopened/, 'no "v0.2 reopened" chip in the key');
  assert.match(html, /lt90: 'Projects whose latest audit found under 90% of the spec built, or no audit yet\.'/, 'lt90 still covers unaudited plans');
  assert.match(html, /g === 'au' \? auKey\(p\) === k/, 'audit filter logic unchanged');
});

test('view picker is tinted by view: red flags, amber per-plan, normal overview', () => {
  assert.match(html, /#stSel\[data-view=flags\]\{color:var\(--bad\)\}#stSel\[data-view=plan\]\{color:var\(--warn\)\}/);
  const m = /const stSelTint = \(\) => \{ const s = \$\('stSel'\), v = s\.value; s\.dataset\.view = (.+?); \};/.exec(html);
  assert.ok(m, 'stSelTint present');
  const view = new Function('v', `return ${m[1]};`);
  assert.equal(view('all'), 'all'); assert.equal(view('_flags'), 'flags'); assert.equal(view('03-agent-audit'), 'plan'); assert.equal(view(''), 'all');
  assert.match(html, /new MutationObserver\(stSelTint\)\.observe\(\$\('stSel'\)/, 're-tints after every re-render, including restore on reload');
});
