// Playwright check for the bundled Skill Editor: the dashboard's Skills link opens /skills and the editor
// lists the fixture skills and opens a file. Run: node app/tests/skills-editor.spec.mjs
// Uses dev/playwright.mjs (installed package, PLAYWRIGHT_MODULE or the private integrations path), like the tour.
import { loadPlaywright } from '../../dev/playwright.mjs';
import { waitForServerReady } from './helpers/server-ready.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const { chromium } = loadPlaywright();
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright');
const chrome = fs.existsSync(browsers)
  ? fs.readdirSync(browsers).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1])
    .map((d) => path.join(browsers, d, 'chrome-linux64', 'chrome')).find((p) => fs.existsSync(p))
  : null;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-skills-editor-ui-'));
const write = (rel, text) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
write('env', ''); write('harness.json', '{}');
write('data/setup.json', JSON.stringify({ setupComplete: true }));
write('.agents/skills/fixture-skill/SKILL.md', '---\nname: fixture-skill\ndescription: Fixture skill for the editor UI check.\n---\n\n# Fixture body\n\nThe editor should show this text.\n');
write('.agents/skills/other-skill/SKILL.md', '---\nname: other-skill\ndescription: Second fixture skill.\n---\n\n# Other\n');

const server = spawn(process.execPath, ['app/server.mjs', '0'], {
  cwd: path.resolve(import.meta.dirname, '../..'),
  env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
    AGENTGLIM_DATA: path.join(home, 'data'), AGENTGLIM_ENV_FILE: path.join(home, 'env'),
    AGENTGLIM_CONFIG: path.join(home, 'harness.json'), AGENTGLIM_PLANS: path.join(home, 'plans'), AGENTGLIM_DEV: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const clean = async () => {
  server.kill(); if (server.exitCode === null) await once(server, 'exit').catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
};

let browser;
try {
  const base = `http://127.0.0.1:${await waitForServerReady(server)}`;
  browser = await chromium.launch(chrome ? { executablePath: chrome } : {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await ctx.addInitScript(() => { try { localStorage.setItem('agTourSeen', '1'); } catch {} });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#skillsLink', { state: 'attached', timeout: 20000 });
  // Skills is its own top-level header button now, not a Pages menu item: no menu needed, visible at once.
  assert.equal(await page.$$eval('#pgMenu #skillsLink', (els) => els.length), 0, 'the Skills link left the Pages menu');
  assert.equal(await page.$$eval('header .hdr-r > a#skillsLink', (els) => els.length), 1, 'Skills is a top-level header button');
  assert.ok(await page.locator('#skillsLink').isVisible(), 'the header Skills button is visible without opening anything');
  const popupP = ctx.waitForEvent('page');
  await page.click('#skillsLink');
  const editor = await popupP;
  const editorErrors = [];
  editor.on('pageerror', (e) => editorErrors.push(e.message));
  await editor.waitForLoadState('domcontentloaded');
  assert.match(editor.url(), /\/skills$/, 'the Skills link opens /skills');
  await editor.waitForSelector('#tm .tile', { timeout: 20000 });
  const ids = await editor.$$eval('#tm .tile', (els) => els.map((e) => e.dataset.id));
  assert.ok(ids.includes('fixture-skill'), `editor lists fixture skills (${ids.join(', ')})`);
  assert.match(await editor.textContent('#count'), /skills/);

  await editor.click('#tm .tile[data-id="fixture-skill"]');
  await editor.waitForSelector('#focus:not([hidden])');
  await editor.click('button[data-open="SKILL.md"]');
  await editor.waitForFunction(() => { const t = document.querySelector('#ed .se-ta'); return t && !t.hidden && /Fixture body/.test(t.value); }, null, { timeout: 15000 });
  assert.ok(fs.existsSync(path.join(home, '.agents/skills/fixture-skill/SKILL.md')), 'reading a file never moves it');
  assert.deepEqual(editorErrors, [], 'no page errors in the editor');

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await mobile.addInitScript(() => { try { localStorage.setItem('agTourSeen', '1'); } catch {} });
  const mpage = await mobile.newPage();
  await mpage.goto(base + '/skills', { waitUntil: 'domcontentloaded' });
  await mpage.waitForSelector('#tm .tile', { timeout: 20000 });
  const overflow = await mpage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `no horizontal overflow at 390 px (${overflow})`);
  await mobile.close();
  console.log(`PASS: Skills -> /skills lists ${ids.length} skills, opens SKILL.md; 390 px overflow ${overflow}`);
} finally {
  if (browser) await browser.close();
  await clean();
}
