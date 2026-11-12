// Agentglim walkthrough tests: tour end to end at 1440 and 390, then a swarm click test.
// Run: node ~/dev/projects/agentglim/app/tests/walkthrough.spec.mjs [--iters 300] [--url http://127.0.0.1:18992/]
// Writes screenshots and results.json to app/tests/out/<stamp>/. Exit code 1 on any failure.
// Safety: every non-GET request is answered with a stub, and navigation away from the page is blocked,
// so random clicks never hold plans, change modes, answer approvals or open browser tabs.
import { loadPlaywright } from '../../dev/playwright.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Playwright: PLAYWRIGHT_MODULE, private integration settings, or an installed playwright package.
const { chromium } = loadPlaywright();
const PW = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright');
const chrome = fs.readdirSync(PW).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1])
  .map((d) => `${PW}/${d}/chrome-linux64/chrome`).find((p) => fs.existsSync(p));

const arg = (k, d) => { const j = process.argv.indexOf(k); return j > 0 ? process.argv[j + 1] : d; };
const URL0 = arg('--url', process.env.AGENTGLIM_URL || 'http://127.0.0.1:18992/'); // the dev copy (agentglim-dev), never production
const ITERS = +arg('--iters', 300);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(HERE, 'out', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
fs.mkdirSync(OUT, { recursive: true });
const results = { url: URL0, out: OUT, tours: [], swarm: [], failures: [] };
const fail = (m) => { results.failures.push(m); console.log('FAIL', m); };

// Errors the app throws without the tour (for example a flaky live API) are reported, not failed,
// unless they mention the walkthrough.
const isTourError = (t) => /walkthrough|AgentglimTour|wt-/i.test(t);

// The service is restarted by other agents now and then; wait for it instead of failing.
async function gotoApp(page) {
  for (let k = 0; k < 60; k++) {
    try { const r = await page.goto(URL0, { waitUntil: 'domcontentloaded' }); if (r && r.ok()) return; } catch {}
    await new Promise((f) => setTimeout(f, 3000));
  }
  throw new Error('agentglim did not answer for 3 minutes');
}
async function newPage(browser, width, { seen = true, allowNav = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  if (seen) await ctx.addInitScript(() => { try { localStorage.setItem('agTourSeen', '1'); } catch {} });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  if (!allowNav) ctx.on('page', (p) => { if (p !== page) p.close().catch(() => {}); });
  await page.route('**/*', (route) => {
    const r = route.request(), u = new URL(r.url());
    if (r.method() !== 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"stub":true}' });
    if (!allowNav && r.isNavigationRequest() && r.frame() === page.mainFrame() && (u.pathname !== '/' || u.host !== new URL(URL0).host)) return route.abort();
    return route.continue();
  });
  await gotoApp(page);
  await page.waitForSelector('#tourBtn', { state: 'attached' });
  await page.waitForFunction(() => document.querySelector('#pipe')?.children.length > 0, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return { ctx, page, errors };
}
const hScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function tour(browser, width) {
  const { ctx, page, errors } = await newPage(browser, width);
  const rec = { width, steps: [], skipped: [], hscroll: [] };
  const all = await page.evaluate(async () => (await (await fetch('/walkthrough-steps.json')).json()).steps.map((s) => s.id));
  await page.click('#tourBtn');
  await page.waitForSelector('.wt-tip');
  const count = await page.evaluate(() => AgentglimTour.count);
  for (let n = 0; n < count; n++) {
    await page.waitForTimeout(150);
    const st = await page.evaluate(() => {
      const t = document.querySelector('.wt-tip').getBoundingClientRect(), vw = document.documentElement.clientWidth;
      return { id: AgentglimTour.step, counter: document.querySelector('.wt-count').textContent, title: document.querySelector('#wtTitle').textContent,
        tipIn: t.left >= 0 && t.right <= vw && t.top >= 0 && t.bottom <= innerHeight };
    });
    rec.steps.push(st);
    if (!st.tipIn) fail(`${width}: tooltip off screen at ${st.id}`);
    if (st.counter !== `${n + 1} of ${count}`) fail(`${width}: counter "${st.counter}" at step ${n + 1}`);
    const hs = await hScroll(page); rec.hscroll.push(hs); if (hs > 0) fail(`${width}: horizontal scroll ${hs}px at ${st.id}`);
    await page.screenshot({ path: `${OUT}/tour-${width}-${String(n + 1).padStart(2, '0')}-${st.id}.png` });
    if (n === 1) { // keyboard: back then forward
      await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(100);
      if ((await page.evaluate(() => AgentglimTour.step)) !== rec.steps[0].id) fail(`${width}: ArrowLeft did not go back`);
      await page.keyboard.press('ArrowRight'); await page.waitForTimeout(100);
    }
    await page.keyboard.press(n % 2 ? 'ArrowRight' : 'Enter'); // Enter hits the focused Next button
  }
  await page.waitForTimeout(200);
  if (await page.evaluate(() => AgentglimTour.open)) fail(`${width}: tour still open after the last step`);
  rec.skipped = all.filter((id) => !rec.steps.some((s) => s.id === id));
  // Esc and Skip close it
  await page.click('#tourBtn'); await page.waitForSelector('.wt-tip'); await page.keyboard.press('Escape');
  if (await page.$('.wt-tip')) fail(`${width}: Esc did not close`);
  await page.click('#tourBtn'); await page.waitForSelector('.wt-tip'); await page.click('.wt-skip');
  if (await page.$('.wt-tip')) fail(`${width}: Skip did not close`);
  rec.errors = errors; for (const e of errors) (isTourError(e) ? fail : (m) => console.log('app error (not tour):', m))(`${width}: console ${e}`);
  results.tours.push(rec);
  await ctx.close();
}

async function firstRun(browser) {
  const { ctx, page } = await newPage(browser, 1440, { seen: false });
  await page.waitForTimeout(2500);
  if (!(await page.$('.wt-tip'))) fail('first visit: tour did not start by itself');
  await page.keyboard.press('Escape');
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(4500);
  if (await page.$('.wt-tip')) fail('second visit: tour started again');
  await ctx.close();
}

// Missing targets are skipped: remove a target and check the tour still runs with one step fewer.
async function missingTarget(browser) {
  const { ctx, page } = await newPage(browser, 1440);
  await page.click('#tourBtn'); await page.waitForSelector('.wt-tip');
  const full = await page.evaluate(() => AgentglimTour.count); await page.keyboard.press('Escape');
  await page.evaluate(() => document.querySelector('#kpis')?.setAttribute('hidden', ''));
  await page.click('#tourBtn'); await page.waitForSelector('.wt-tip');
  const less = await page.evaluate(() => AgentglimTour.count);
  if (less !== full - 1) fail(`missing target: expected ${full - 1} steps, got ${less}`);
  await ctx.close();
}

async function swarm(browser, width, withTour, seed) {
  const { ctx, page, errors } = await newPage(browser, width);
  let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const rec = { width, withTour, clicks: 0, byKind: {}, hscrollMax: 0, errors };
  if (withTour) { await page.click('#tourBtn'); await page.waitForSelector('.wt-tip'); }
  for (let n = 0; n < ITERS; n++) {
    if (withTour && !(await page.$('.wt-tip')) && rnd() < 0.5) await page.click('#tourBtn').catch(() => {});
    const els = await page.$$('button, a[href], select, input, summary, [role=button], h2.tg, h2.stg, .chip, [data-r], [data-m], [data-s], .wt-tip button, .wt-shade');
    if (!els.length) break;
    const el = els[Math.floor(rnd() * els.length)];
    const kind = await el.evaluate((e) => e.className && typeof e.className === 'string' && e.className.startsWith('wt-') ? e.className.split(' ')[0] : (e.id || e.tagName.toLowerCase())).catch(() => 'gone');
    try {
      const tag = await el.evaluate((e) => e.tagName);
      if (tag === 'SELECT') { const opts = await el.evaluate((e) => [...e.options].map((o) => o.value)); if (opts.length) await el.selectOption(opts[Math.floor(rnd() * opts.length)], { timeout: 800 }); }
      else if (tag === 'INPUT' && (await el.getAttribute('type')) === 'date') await el.fill('2026-11-0' + (1 + Math.floor(rnd() * 6)), { timeout: 800 });
      else await el.click({ timeout: 800, force: withTour && rnd() < 0.3 });
      rec.clicks++; rec.byKind[kind] = (rec.byKind[kind] || 0) + 1;
    } catch { rec.byKind['(not clickable)'] = (rec.byKind['(not clickable)'] || 0) + 1; }
    if (rnd() < 0.08) await page.keyboard.press(['ArrowRight', 'ArrowLeft', 'Escape', 'Tab'][Math.floor(rnd() * 4)]);
    if (n % 25 === 0) { const hs = await hScroll(page); rec.hscrollMax = Math.max(rec.hscrollMax, hs); }
    // a same-tab link (Goals, Control) is blocked by the router and leaves a chrome-error page: count it and reload
    if (!page.url().startsWith(new URL(URL0).origin) || new URL(page.url()).pathname !== '/') {
      rec.blockedNav = (rec.blockedNav || 0) + 1;
      await gotoApp(page); await page.waitForSelector('#tourBtn');
      if (withTour) await page.click('#tourBtn').catch(() => {});
    }
  }
  // the page must still render and the tour must still work after the storm
  if (await page.$('.wt-tip')) await page.keyboard.press('Escape');
  const diag = await page.evaluate(() => { const b = document.getElementById('tourBtn'); if (!b) return 'no #tourBtn'; b.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = b.getBoundingClientRect(), top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return top === b ? '' : `covered by ${top?.tagName}#${top?.id}.${top?.className}`; }).catch((e) => 'eval: ' + e.message);
  if (diag) { fail(`swarm ${width} tour=${withTour}: ${diag} at ${page.url()}`); await page.screenshot({ path: `${OUT}/swarm-${width}-${withTour ? 'tour' : 'plain'}-broken.png` }); }
  await page.click('#tourBtn', { timeout: 5000 }).catch(() => {}); const ok = await page.waitForSelector('.wt-tip', { timeout: 3000 }).then(() => true, () => false);
  if (!ok) fail(`swarm ${width} tour=${withTour}: tour does not open after swarm`);
  await page.screenshot({ path: `${OUT}/swarm-${width}-${withTour ? 'tour' : 'plain'}.png` });
  for (const e of errors) (isTourError(e) ? fail : (m) => console.log('app error (not tour):', m))(`swarm ${width} tour=${withTour}: ${e}`);
  rec.appErrors = errors.filter((e) => !isTourError(e)).length;
  results.swarm.push(rec);
  await ctx.close();
}


// Link-click test: every Pages menu link and one approvals page link must really navigate,
// both on a first visit (the tour auto-starts) and with the tour already dismissed.
// Current menu: Goals, Routing, Process guard, Skills (href comes from user config, so match by id). The dev-only closed "Archived" section (Harness/Control/Reaper) is stripped in production and not tested.
const MENU = ['/goals', '/routing', '/process-guard', '#skillsLink'];
async function clickNav(page, ctx, loc) {
  const popup = ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null);
  const nav = page.waitForNavigation({ timeout: 8000, waitUntil: 'commit' }).catch(() => null);
  await loc.click({ timeout: 5000 });
  const [p, n] = await Promise.all([popup, nav]);
  if (p) { await p.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {}); const u = p.url(); const st = /^https?:/.test(u) ? ((await ctx.request.get(u, { timeout: 15000 }).catch(() => null)) || (await ctx.request.get(u, { timeout: 15000 }).catch(() => null)))?.status() : undefined; await p.close(); return { url: u, status: st }; }
  if (n) { const r = { url: page.url(), status: n.status() }; await gotoApp(page); await page.waitForSelector('#tourBtn', { state: 'attached' }); return r; }
  return null;
}
async function links(browser, width, seen) {
  const label = `links ${width} ${seen ? 'dismissed' : 'unseen'}`;
  const { ctx, page, errors } = await newPage(browser, width, { seen, allowNav: true });
  const rec = { width, seen, clicked: [] };
  if (!seen) { await page.waitForSelector('.wt-tip', { timeout: 6000 }).catch(() => fail(`${label}: tour did not auto-start`)); }
  for (const href of MENU) {
    if (!(await page.$('#pgMenu[open]'))) await page.click('#pgMenu > summary', { timeout: 5000 }).catch((e) => fail(`${label}: menu: ${e.message.split('\n')[0]}`));
    if (!seen && href === MENU[0] && await page.$('.wt-tip')) fail(`${label}: tour still open after an outside click`);
    if (href === '/goals') { // in-page anchor now (#goals), no navigation
      await page.locator('#pgMenu a.pgm-i[href="#goals"]').first().click({ timeout: 5000 }).catch((e) => fail(`${label}: goals anchor: ${e.message.split('\n')[0]}`));
      rec.clicked.push({ href: '#goals', status: 200 });
      await page.evaluate(() => { window.scrollTo({ top: 0, behavior: 'instant' }); document.querySelector('#pgMenu')?.removeAttribute('open'); });
      continue;
    }
    const loc = href === '#skillsLink' ? page.locator('#pgMenu a#skillsLink') : page.locator(`#pgMenu a.pgm-i[href*="${href.replace(/^\//, '')}"], #pgMenu a.pgm-i[onclick*="${href}"]`).first();
    const r = await clickNav(page, ctx, loc).catch((e) => ({ err: e.message.split('\n')[0] }));
    rec.clicked.push({ href, ...r });
    if (!r || r.err || r.status !== 200) fail(`${label}: ${href} did not navigate (${JSON.stringify(r)})`);
  }
  if (await page.$('.wt-tip, .wt-spot, .wt-shade')) fail(`${label}: tour layer left behind`);
  const blocker = await page.evaluate(() => { const b = document.querySelector('#pgMenu > summary'); const r = b.getBoundingClientRect(); const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return b.contains(t) ? '' : `${t?.tagName}#${t?.id}.${t?.className}`; });
  if (blocker) fail(`${label}: menu covered by ${blocker}`);
  const ap = page.locator(`a[href*=":${new URL(URL0).port * 1 + 1}/"]`).filter({ visible: true }).first();
  if (await ap.count()) {
    await ap.scrollIntoViewIfNeeded();
    const r = await clickNav(page, ctx, ap).catch((e) => ({ err: e.message.split('\n')[0] }));
    rec.clicked.push({ href: 'approvals page', ...r });
    if (!r || r.err || r.status !== 200) fail(`${label}: approvals page link did not navigate (${JSON.stringify(r)})`);
  } else fail(`${label}: no visible plan page link found`);
  await page.screenshot({ path: `${OUT}/links-${width}-${seen ? 'dismissed' : 'unseen'}.png` });
  for (const e of errors) if (isTourError(e)) fail(`${label}: ${e}`);
  (results.links ||= []).push(rec);
  await ctx.close();
}

const browser = await chromium.launch({ executablePath: chrome });
try {
  const only = arg('--only', '');
  if (only === 'links') { for (const w of [1440, 390]) for (const seen of [false, true]) await links(browser, w, seen); throw 'only'; }
  for (const w of [1440, 390]) await tour(browser, w);
  for (const w of [1440, 390]) for (const seen of [false, true]) await links(browser, w, seen);
  await firstRun(browser);
  await missingTarget(browser);
  let seed = 7;
  for (const w of [1440, 390]) for (const t of [false, true]) await swarm(browser, w, t, seed++);
} catch (e) { if (e !== 'only') fail('crash: ' + (e.stack || e)); }
await browser.close();
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
for (const t of results.tours) console.log(`tour ${t.width}: ${t.steps.length} steps, skipped [${t.skipped.join(', ')}], max hscroll ${Math.max(...t.hscroll)}`);
for (const l of results.links || []) console.log(`links ${l.width} ${l.seen ? 'dismissed' : 'unseen'}: ${l.clicked.map((c) => `${c.href}=${c.status ?? c.err ?? 'none'}`).join(' ')}`);
for (const s of results.swarm) console.log(`swarm ${s.width} tour=${s.withTour}: ${s.clicks} clicks, max hscroll ${s.hscrollMax}, app errors ${s.appErrors}, blocked link navigations ${s.blockedNav || 0}`);
console.log(results.failures.length ? `FAILED ${results.failures.length}` : 'ALL PASS', '->', OUT);
process.exit(results.failures.length ? 1 : 0);
