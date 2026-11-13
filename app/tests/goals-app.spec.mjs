// Playwright checks for the Goals sub-app: tabs, Asks dropdown, backlinks, shortcuts, print,
// the empty state and phone width. Runs against a throwaway fixture server (never :18990).
// Run: node app/tests/goals-app.spec.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPlaywright } from '../../dev/playwright.mjs';
import { fixtureServer } from './helpers/fixture-server.mjs';

const { chromium } = loadPlaywright();
const PW = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright');
const exe = fs.readdirSync(PW).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1])
  .map((d) => path.join(PW, d, 'chrome-linux64', 'chrome')).find((p) => fs.existsSync(p));
const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(HERE, 'out', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
fs.mkdirSync(OUT, { recursive: true });
const errors = [];
const fail = (message) => { errors.push(message); console.log('FAIL', message); };
const ok = (message) => console.log('ok  ', message);

const fixture = fixtureServer('ag-goals-app-');
const empty = fixtureServer('ag-goals-empty-');
empty.write('data/goals/goals.json', JSON.stringify({ version: 1, goals: [] }));
empty.write('data/goals/goal-map.json', '{}\n');

const hscroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const waitReady = (page) => page.waitForFunction(() => /Where things stand|Set up your goals/.test(document.querySelector('main h2')?.textContent || ''), null, { timeout: 30_000 });

let browser;
try {
  const url = await fixture.start();
  browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') fail(`console error: ${m.text()}`); });
  page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
  await page.goto(`${url}/goals?demo=1`, { waitUntil: 'networkidle' });
  await waitReady(page);

  assert.equal(await page.title(), 'Goals'); ok('title is Goals');
  assert.equal(await page.textContent('h1'), 'Goals'); ok('h1 is Goals');
  assert.equal(await page.isVisible('#demoNote'), true); ok('demo note is visible');
  assert.match(await page.textContent('#fresh'), /Updated/); ok('freshness line is present');
  assert.equal(await hscroll(page), 0); ok('no horizontal overflow at 1440 px');
  await page.screenshot({ path: path.join(OUT, 'goals-1440.png'), fullPage: true });

  const headings = await page.$$eval('main h2', (els) => els.map((e) => e.textContent.trim()));
  for (const wanted of ['Where things stand', 'Where each goal stands', 'Alignment by week', 'Results so far', 'What matters now', 'What comes next', 'Asks waiting on you', 'Goal by goal', 'How the numbers work']) {
    if (!headings.some((h) => h.startsWith(wanted))) fail(`missing heading: ${wanted}`);
  }
  if (!errors.length) ok(`overview sections present (${headings.length})`);

  // Asks dropdown: one entry per goal, with the open-ask count.
  await page.click('#asksMenu > summary');
  await page.waitForSelector('#asksMenu a');
  const asks = await page.$$eval('#asksMenuList a', (els) => els.map((e) => ({ text: e.textContent.replace(/\s+/g, ' ').trim(), href: e.getAttribute('href') })));
  assert.equal(asks.length, 2); ok('Asks menu lists one entry per goal');
  assert.deepEqual(asks.map((a) => a.href), ['#asks/ship', '#asks/learn']); ok('Asks menu links to each goal');
  assert.match(asks[0].text, /Ship/); assert.match(asks[0].text, /2/);

  // Backlink and browser back.
  await page.click('#asksMenuList a[href="#asks/ship"]');
  await page.waitForFunction(() => location.hash === '#asks/ship');
  await page.waitForFunction(() => /Ship asks/.test(document.querySelector('main h2')?.textContent || ''));
  assert.match(await page.textContent('main'), /Approve the example scope/); ok('Asks tab lists the open ask');
  assert.match(await page.textContent('main'), /Example feature/); ok('Asks tab groups by project');
  await page.goBack();
  await page.waitForFunction(() => location.hash === '' || location.hash === '#overview');
  await waitReady(page); ok('browser back returns to Overview');

  // Tabs and keyboard shortcuts.
  await page.click('nav.tabs a[data-tab=week]');
  await page.waitForFunction(() => /This week/.test(document.querySelector('main h2')?.textContent || ''));
  ok('This week tab opens');
  assert.match(await page.textContent('main'), /source feeds/i); ok('This week shows the news feed');
  assert.match(await page.textContent('main'), /priorities from the weekly review/i); ok('This week shows review priorities');
  await page.click('nav.tabs a[data-tab=rules]');
  await page.waitForFunction(() => /Operating policy/.test(document.querySelector('main')?.textContent || ''));
  ok('Rules tab renders the knowledge Markdown');
  await page.keyboard.press('1');
  await page.waitForFunction(() => location.hash === '#overview'); ok('shortcut 1 opens Overview');
  await page.keyboard.press('3');
  await page.waitForFunction(() => location.hash === '#week'); ok('shortcut 3 opens This week');
  await page.keyboard.press('4');
  await page.waitForFunction(() => location.hash === '#rules'); ok('shortcut 4 opens Rules');
  await page.keyboard.press('2');
  await page.waitForFunction(() => document.getElementById('asksMenu').open); ok('shortcut 2 opens the Asks menu');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('asksMenu').open); ok('Escape closes the Asks menu');
  await page.keyboard.press('1');
  await page.waitForFunction(() => location.hash === '#overview');

  // Refresh and print.
  await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
  const refresh = page.waitForResponse((r) => r.url().includes('/api/goals/refresh') && r.request().method() === 'POST');
  await page.click('#refreshBtn');
  assert.equal((await refresh).status(), 200); ok('Refresh now calls the refresh endpoint');
  await page.waitForFunction(() => /Refreshed/.test(document.getElementById('toast')?.textContent || ''));
  ok('Refresh shows a result toast');
  await page.keyboard.press('p');
  assert.equal(await page.evaluate(() => window.__printed), 1); ok('shortcut p prints');

  // Print styles: controls hidden, content not clipped.
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.$eval('nav.tabs', (el) => getComputedStyle(el).display), 'none'); ok('print hides the tabs');
  assert.equal(await page.$eval('header .ctrl', (el) => getComputedStyle(el).display), 'none'); ok('print hides the header controls');
  assert.ok(Math.abs(parseFloat(await page.$eval('main', (el) => getComputedStyle(el).paddingTop)) - 45.35) < 1); ok('print uses the audit page margins');
  await page.emulateMedia({ media: 'screen' });

  // Help overlay.
  await page.keyboard.press('?');
  await page.waitForFunction(() => document.getElementById('helpDlg').open); ok('shortcut ? opens the help overlay');
  await page.click('#helpClose');
  await page.waitForFunction(() => !document.getElementById('helpDlg').open); ok('help closes');

  // Phone width.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  assert.equal(await hscroll(page), 0); ok('no horizontal overflow at 390 px');
  await page.screenshot({ path: path.join(OUT, 'goals-390.png'), fullPage: true });

  // Empty state on a goals file with no goals.
  const emptyUrl = await empty.start();
  const emptyPage = await ctx.newPage();
  emptyPage.on('console', (m) => { if (m.type() === 'error') fail(`empty console error: ${m.text()}`); });
  await emptyPage.goto(`${emptyUrl}/goals`, { waitUntil: 'networkidle' });
  await waitReady(emptyPage);
  assert.match(await emptyPage.textContent('main'), /Set up your goals/); ok('empty goals file shows the setup card');
  assert.equal(await hscroll(emptyPage), 0); ok('empty state has no horizontal overflow');
  await emptyPage.screenshot({ path: path.join(OUT, 'goals-empty.png'), fullPage: true });
} catch (error) {
  fail(error.message);
} finally {
  await browser?.close();
  await fixture.stop();
  await empty.stop();
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ out: OUT, failures: errors }, null, 2) + '\n');
}
console.log(errors.length ? `\n${errors.length} failure(s); see ${OUT}` : `\nAll Goals app checks passed; screenshots in ${OUT}`);
process.exit(errors.length ? 1 : 0);
