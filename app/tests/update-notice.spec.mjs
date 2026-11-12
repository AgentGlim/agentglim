// Playwright check for the newer-release notice: banner in the dashboard and /skills header, dismiss survives a
// reload, dismissal is per version, and 390 px stays free of horizontal overflow.
// Run: node app/tests/update-notice.spec.mjs
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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-update-ui-'));
fs.writeFileSync(path.join(home, 'env'), '');
fs.writeFileSync(path.join(home, 'harness.json'), '{}');
fs.mkdirSync(path.join(home, 'data'), { recursive: true });
fs.writeFileSync(path.join(home, 'data/setup.json'), JSON.stringify({ setupComplete: true }));

const version = (v) => ({
  current: 'v0.2.8', latest: v, updateAvailable: true,
  checkedAt: new Date().toISOString(),
  url: `https://github.com/AgentGlim/agentglim/releases/tag/${v}`,
  howTo: {
    git: 'git pull',
    tarball: `curl -L https://github.com/AgentGlim/agentglim/archive/refs/tags/${v}.tar.gz -o agentglim-${v}.tar.gz && tar -xzf agentglim-${v}.tar.gz`,
    restart: 'Restart AgentGlim after updating.',
  },
  enabled: true,
});

const server = spawn(process.execPath, ['app/server.mjs', '0'], {
  cwd: path.resolve(import.meta.dirname, '../..'),
  env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
    AGENTGLIM_DATA: path.join(home, 'data'), AGENTGLIM_ENV_FILE: path.join(home, 'env'),
    AGENTGLIM_CONFIG: path.join(home, 'harness.json'), AGENTGLIM_PLANS: path.join(home, 'plans'),
    AGENTGLIM_PROJECTS: home, AGENTGLIM_DEV: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let browser;
const clean = async () => {
  if (browser) await browser.close().catch(() => {});
  server.kill(); if (server.exitCode === null) await once(server, 'exit').catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
};

async function newPage(ctx, ver, width = 1280) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/api/version', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(ver),
  }));
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
  return { page, errors };
}

try {
  const base = `http://127.0.0.1:${await waitForServerReady(server)}`;
  browser = await chromium.launch(chrome ? { executablePath: chrome } : {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await ctx.addInitScript(() => { try { localStorage.setItem('agTourSeen', '1'); } catch {} });

  const { page, errors } = await newPage(ctx, version('v0.2.9'));
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  const banner = page.locator('#updateNotice .ag-update');
  await banner.waitFor({ state: 'visible', timeout: 20000 });
  assert.match(await banner.textContent(), /Update available: v0\.2\.9/);
  assert.equal(await page.locator('#updateNotice .ag-update-link').getAttribute('href'),
    'https://github.com/AgentGlim/agentglim/releases/tag/v0.2.9');

  await page.locator('#updateNotice .ag-update-how > summary').click();
  const commands = await page.locator('#updateNotice .ag-update-cmd-line code').allTextContents();
  assert.deepEqual(commands, [
    'git pull',
    'curl -L https://github.com/AgentGlim/agentglim/archive/refs/tags/v0.2.9.tar.gz -o agentglim-v0.2.9.tar.gz && tar -xzf agentglim-v0.2.9.tar.gz',
  ]);

  await page.locator('#updateNotice .ag-update-x').click();
  assert.equal(await page.locator('#updateNotice .ag-update').count(), 0, 'dismiss removes the pill');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#updateNotice .ag-update').count(), 0, 'dismiss persists after reload');
  assert.equal(await page.evaluate(() => localStorage.getItem('agUpdateDismissed')), 'v0.2.9');

  await page.unroute('**/api/version');
  await page.route('**/api/version', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(version('v0.3.0')),
  }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#updateNotice .ag-update').waitFor({ state: 'visible', timeout: 20000 });
  assert.match(await page.locator('#updateNotice .ag-update').textContent(), /v0\.3\.0/);
  assert.equal(errors.filter((e) => /update-notice|api\/version/i.test(e)).length, 0, errors.join('\n'));

  const narrowCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await narrowCtx.addInitScript(() => { try { localStorage.setItem('agTourSeen', '1'); } catch {} });
  const narrow = await newPage(narrowCtx, version('v0.2.9'), 390);
  await narrow.page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await narrow.page.locator('#updateNotice .ag-update').waitFor({ state: 'visible', timeout: 20000 });
  const sizes = await narrow.page.evaluate(() => ({
    doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, view: window.innerWidth,
  }));
  assert.ok(sizes.doc <= sizes.view + 1, `no horizontal overflow at 390 px (${JSON.stringify(sizes)})`);
  assert.ok(sizes.body <= sizes.view + 1, `body does not overflow at 390 px (${JSON.stringify(sizes)})`);
  await narrow.page.locator('#updateNotice .ag-update-how > summary').click();
  const after = await narrow.page.evaluate(() => ({
    doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, view: window.innerWidth,
  }));
  assert.ok(after.doc <= after.view + 1, `open commands do not overflow at 390 px (${JSON.stringify(after)})`);
  await narrowCtx.close();

  await page.goto(base + '/skills', { waitUntil: 'domcontentloaded' });
  await page.locator('header #updateNotice .ag-update').waitFor({ state: 'visible', timeout: 20000 });
  assert.match(await page.locator('header #updateNotice .ag-update').textContent(), /Update available: v0\.3\.0/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const skillsSizes = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, view: window.innerWidth,
  }));
  assert.ok(skillsSizes.doc <= skillsSizes.view + 1, `/skills has no horizontal overflow at 390 px (${JSON.stringify(skillsSizes)})`);

  console.log('update-notice: dashboard banner, commands, per-version dismissal, 390 px and /skills all pass');
} finally {
  await clean();
}
