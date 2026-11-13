// Playwright click test for "Send to agent" in Approvals: temp HOME, fixture inbox, random port. Never the live
// dashboard (:18990), never ~/.agentglim, never a real session.
// Run: node app/tests/send-to-agent.spec.mjs
import { loadPlaywright } from '../../dev/playwright.mjs';
import { fixtureServer } from './helpers/fixture-server.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { chromium } = loadPlaywright();
const PW = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.HOME, '.cache', 'ms-playwright');
const chrome = fs.readdirSync(PW).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1])
  .map((d) => path.join(PW, d, 'chrome-linux64', 'chrome')).find((p) => fs.existsSync(p));
const OUT = path.join(import.meta.dirname, 'out', 'send-to-agent');
fs.mkdirSync(OUT, { recursive: true });

function fixture(prefix, withInbox) {
  const fx = fixtureServer(prefix);
  fx.write('plans/01-fixture/PLAN.md', '# Fixture project\n');
  fx.write('plans/_run/state.json', JSON.stringify({ projects: { '01-fixture': { stage: 'v1-r1', history: [] } } }));
  if (withInbox) fs.mkdirSync(path.join(fx.home, 'plans/_run/chat_inbox'), { recursive: true });
  fx.write('data/watcher-asks.json', JSON.stringify([{ id: 'fx-1', project: '01-fixture', title: 'Pick the fixture option' }]));
  return fx;
}

let browser; const servers = [];
try {
  browser = await chromium.launch(chrome ? { executablePath: chrome } : {});
  for (const [name, withInbox] of [['ok', true], ['fail', false]]) {
    const fx = fixture(`ag-send-ui-${name}-`, withInbox);
    const base = await fx.start(); servers.push(fx);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
    await ctx.addInitScript(() => { try { localStorage.setItem('agTourSeen', '1'); localStorage.setItem('obsAp', JSON.stringify({ sel: 'all' })); } catch {} });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    const card = page.locator('#approvals .ai', { hasText: 'Pick the fixture option' });
    await card.waitFor({ timeout: 20000 });
    await card.locator('select[data-f=c]').selectOption('Will do');
    await card.locator('input[data-f=n]').fill('fixture note');
    await card.locator('input[data-f=n]').dispatchEvent('change');
    const send = page.locator('#approvals button[data-act=send]');
    assert.equal(await send.count(), 1);
    const copy = page.locator('#approvals button[data-act=copy]');
    assert.equal(await copy.count(), 1, 'Copy stays next to Send');
    await send.click();
    await page.waitForSelector('#apSend .asr:not([data-state=sending])', { timeout: 15000 });
    const st = await page.locator('#apSend .asr').first().getAttribute('data-state');
    const txt = await page.locator('#apSend').innerText();
    if (withInbox) {
      assert.equal(st, 'delivered', txt);
      const inbox = path.join(fx.home, 'plans/_run/chat_inbox');
      let files = fs.readdirSync(inbox).filter((f) => f.endsWith('.json'));
      assert.equal(files.length, 1);
      assert.match(JSON.parse(fs.readFileSync(path.join(inbox, files[0]), 'utf8')).text, /fixture note/);
      // click again: same text, no duplicate
      await page.locator('#approvals button[data-act=send]').click();
      await page.waitForTimeout(800);
      files = fs.readdirSync(inbox).filter((f) => f.endsWith('.json'));
      assert.equal(files.length, 1, 'no duplicate on resend');
      // the agent answers: the card turns to read
      fs.renameSync(path.join(inbox, files[0]), path.join(inbox, files[0] + '.answered'));
      await page.waitForSelector('#apSend .asr[data-state=read]', { timeout: 10000 });
    } else {
      assert.equal(st, 'failed', txt);
      assert.match(txt, /no harness inbox/);
      assert.match(txt, /copied to your clipboard instead/);
      const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
      assert.match(clip, /fixture note/);
    }
    await page.screenshot({ path: `${OUT}/send-${name}-1280.png` });
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log(`send to agent click test: PASS -> ${OUT}`);
} finally {
  await browser?.close().catch(() => {});
  for (const fx of servers) await fx.close().catch(() => {});
}
