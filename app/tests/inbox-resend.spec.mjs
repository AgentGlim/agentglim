// Playwright check for the SuperAgent inbox resend line on the Status card: pending count, resend count,
// last resend time, and no horizontal overflow at 390 px. Temp HOME and fake inbox only; never the live
// dashboard, never port 18990.
// Run: node app/tests/inbox-resend.spec.mjs
import { loadPlaywright } from '../../dev/playwright.mjs';
import { fixtureServer } from './helpers/fixture-server.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { chromium } = loadPlaywright();
const PW = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.HOME, '.cache', 'ms-playwright');
const chrome = fs.readdirSync(PW).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1])
  .map((d) => path.join(PW, d, 'chrome-linux64', 'chrome')).find((p) => fs.existsSync(p));
const OUT = path.join(import.meta.dirname, 'out', 'inbox-resend');
fs.mkdirSync(OUT, { recursive: true });

function planFixture(prefix) {
  const fx = fixtureServer(prefix);
  fx.write('plans/01-fixture/PLAN.md', '# Fixture project\n\nA synthetic plan for browser checks.\n');
  fx.write('plans/_run/state.json', JSON.stringify({ projects: { '01-fixture': { stage: 'v1-r1', history: [] } } }));
  return fx;
}
const iso = (ms) => new Date(ms).toISOString();
const inboxFile = (fx, id, at) => `plans/_run/chat_inbox/${id}.json`;
const writeMessage = (fx, id, at) => fx.write(inboxFile(fx, id, at), JSON.stringify({ at: iso(at), from: 'control', text: 'Fixture message' }) + '\n');
const writeResent = (fx, id, at, count, reason) => fx.write(`${inboxFile(fx, id, at)}.resent`, JSON.stringify({ at: iso(at), count, reason: reason || `auto-resent: unanswered after ${Math.round((at - (at - 3 * 60e3)) / 1000)}s`, via: 'wake', delivered: true }) + '\n');

const now = Date.now();
const pendingId = now - 4 * 60e3;
const empty = planFixture('ag-inbox-ui-empty-');
writeMessage(empty, pendingId, now - 20e3); // less than the 120 s threshold: 0 resends yet

const busy = planFixture('ag-inbox-ui-busy-');
writeMessage(busy, pendingId, now - 4 * 60e3);
writeResent(busy, pendingId, now - 2 * 60e3, 3);

let browser;
const servers = [];
try {
  browser = await chromium.launch(chrome ? { executablePath: chrome } : {});
  for (const [fx, check] of [
    [empty, async (page) => {
      await page.waitForSelector('#stInbox:not([hidden])', { timeout: 20000 });
      const text = await page.locator('#stInbox').innerText();
      const data = await page.locator('#stInbox').evaluate((el) => ({ ...el.dataset }));
      assert.match(text, /1 unanswered/);
      assert.match(text, /0 resends/);
      assert.match(text, /last resend never/);
      assert.equal(data.pending, '1');
      assert.equal(data.resends, '0');
      assert.equal(data.lastAt, '');
    }],
    [busy, async (page) => {
      await page.waitForSelector('#stInbox:not([hidden])', { timeout: 20000 });
      const text = await page.locator('#stInbox').innerText();
      const data = await page.locator('#stInbox').evaluate((el) => ({ ...el.dataset }));
      assert.match(text, /1 unanswered/);
      assert.match(text, /3 resends/);
      assert.match(text, /last resend \d+m ago/);
      assert.equal(data.pending, '1');
      assert.equal(data.resends, '3');
      assert.ok(Number(data.lastAt) > 0);
    }],
  ]) {
    const base = await fx.start();
    servers.push(fx);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    await ctx.addInitScript(() => { try { localStorage.setItem('agTourSeen', '1'); } catch {} });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#statusCard:not([hidden])', { timeout: 20000 });
    await check(page);
    await page.locator('#stInbox').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/status-inbox-1280-${path.basename(fx.home)}.png`, fullPage: false });

    // phone width: the strip wraps and never pushes the page sideways
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    const geo = await page.evaluate(() => {
      const el = document.querySelector('#stInbox'), r = el.getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, left: r.left, right: r.right, vw: innerWidth };
    });
    assert.equal(geo.overflow, 0, '390 px page has no horizontal overflow');
    assert.ok(geo.left >= 0 && geo.right <= geo.vw + 0.5, `strip stays inside 390 px (${geo.left}-${geo.right})`);
    await page.screenshot({ path: `${OUT}/status-inbox-390-${path.basename(fx.home)}.png` });

    const tourErrors = errors.filter((e) => /walkthrough|AgentglimTour|wt-/i.test(e));
    assert.deepEqual(tourErrors, []);
    await ctx.close();
  }
  console.log(`inbox resend status display: PASS (${servers.length} fixture servers) -> ${OUT}`);
} finally {
  await browser?.close().catch(() => {});
  for (const fx of servers) await fx.close().catch(() => {});
}
