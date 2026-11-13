// Playwright regression: a model-supplied category label must render as text, never as markup.
// Run: node app/tests/skills-editor-xss.spec.mjs
// The auto-grouping job parses a model response and accepts HTML characters in labels, so an accepted
// label used to be injected into the atlas block heading with innerHTML and ran script with dashboard
// privileges. This test drives the real Accept chip with a payload label and asserts nothing executes.
import { loadPlaywright } from '../../dev/playwright.mjs';
import { fixtureServer } from './helpers/fixture-server.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { chromium } = loadPlaywright();
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright');
const chrome = fs.existsSync(browsers)
  ? fs.readdirSync(browsers).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1])
    .map((d) => path.join(browsers, d, 'chrome-linux64', 'chrome')).find((p) => fs.existsSync(p))
  : null;

// 37 characters, inside the 40-character cap the model parser applies to a suggested label.
const PAYLOAD = '<img src=x onerror=window.__xss=1>';

const fixture = fixtureServer('ag-skills-xss-');
const { write } = fixture;
write('.agents/skills/fixture-skill/SKILL.md', '---\nname: fixture-skill\ndescription: Fixture skill for the XSS check.\n---\n\n# Body\n');
write('.agents/skills/other-skill/SKILL.md', '---\nname: other-skill\ndescription: Second fixture skill.\n---\n\n# Other\n');
write('data/skill-groups.json', JSON.stringify({
  version: 1, categories: {}, assignments: {}, hashes: {}, attempts: {}, rejected: {}, history: [],
  suggestions: [{ id: 'new-xss', categoryId: 'xss-cat', label: PAYLOAD, skills: ['fixture-skill'], reason: 'fixture', source: 'model', at: '2026-11-13T00:00:00.000Z' }],
}, null, 2));

let browser;
try {
  const base = await fixture.start();
  browser = await chromium.launch(chrome ? { executablePath: chrome } : {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await ctx.addInitScript(() => { try { localStorage.setItem('agTourSeen', '1'); } catch {} });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/skills', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#gbarList .gchip', { timeout: 20000 });

  // The chip itself is escaped already; this is only the pre-condition, not the finding.
  assert.equal(await page.locator('#gbarList img').count(), 0, 'the suggestion chip renders the label as text');

  const blocksBefore = await page.locator('#tm .blk').count();
  const acceptSaved = page.waitForResponse((r) => r.url().endsWith('/api/skills/groups/accept') && r.request().method() === 'POST');
  await page.click('button[data-group-act="accept"][data-id="new-xss"]');
  assert.equal((await acceptSaved).status(), 200, 'Accept saves the new category');
  // The atlas rebuilds with the accepted category as a block heading (do not match on its text: if the label
  // is parsed as markup the heading text is empty, which is exactly the failure this test has to report).
  await page.waitForFunction((n) => document.querySelectorAll('#tm .blk').length > n, blocksBefore, { timeout: 15000 });

  const state = await page.evaluate(() => ({
    xss: window.__xss ?? null,
    imgs: document.querySelectorAll('#tm img').length,
    blocks: [...document.querySelectorAll('#tm .blk h2')].map((h) => h.textContent),
  }));
  assert.equal(state.xss, null, 'the accepted category label does not run script');
  assert.equal(state.imgs, 0, 'no element from the label is created inside the atlas');
  assert.ok(state.blocks.some((t) => t.includes(PAYLOAD)), `the heading shows the label as literal text (${state.blocks.join(' | ')})`);

  // The focus view's category line renders the same label: textContent, no markup.
  await page.click('#tm .tile[data-id="fixture-skill"]');
  await page.waitForSelector('#egoin .center .cat', { timeout: 15000 });
  const focus = await page.evaluate(() => ({
    xss: window.__xss ?? null,
    imgs: document.querySelectorAll('#egoin .center .cat img').length,
    text: document.querySelector('#egoin .center .cat')?.textContent || '',
  }));
  assert.equal(focus.xss, null, 'the focus view does not run the label either');
  assert.equal(focus.imgs, 0, 'the focus view category line builds no element from the label');
  assert.ok(focus.text.includes(PAYLOAD), 'the focus view category line keeps the label as literal text');
  assert.deepEqual(errors, [], 'no page errors');
  console.log('PASS: an accepted model-supplied category label renders as text in the atlas and the focus view; no script runs');
} finally {
  if (browser) await browser.close();
  await fixture.close();
}
