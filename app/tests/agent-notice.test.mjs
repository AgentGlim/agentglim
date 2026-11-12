// The "Your AI agent" popup only opens while the setup file is NOT filled out (owner rule, 2026-11-12).
// On a configured install, stale data, a lost connection or no SuperAgent heartbeat is a small banner, never the popup.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {agentNotice, STALE_MS, OFFLINE_MS} from '../agent-notice.mjs';
import {setupFilled, legacyComplete, clean} from '../setup.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ag-notice-'));
// the shape of a real configured install from before the setupComplete flag: written by the old Setup page's save
const CONFIGURED_V1 = {version:1, harnesses:{claude:true, codex:true, pi:false, opencode:false}, subs:{claude:{on:false}, codex:{on:true, plan:'Pro $100'}, go:{on:false}}, plans:{path:'~/plans'}, custom:[]};
const SERVER = [{stale:false, watcher:true}, {stale:true, watcher:true}, {stale:false, watcher:false}, {stale:true, watcher:false}];
const CLIENT = [{}, {offlineMs:5e3}, {offlineMs:OFFLINE_MS}, {offlineMs:3600e3}, {quietMs:STALE_MS + 1}, {quietMs:864e5}, {offlineMs:3600e3, quietMs:864e5}];

test('setupFilled is the one gate: filled-out files turn the popup off; missing, empty or partial ones keep it', () => {
  const data = tmp();
  assert.equal(setupFilled(CONFIGURED_V1, data), true);
  assert.equal(setupFilled(clean({harnesses:{codex:true}}), data), true); // what Setup saves today (v2 flag)
  assert.equal(setupFilled({version:1, harnesses:{}, plans:{path:'~/plans'}}, data), true);
  for (const saved of [null, {}, [], 'text', 7, {harnesses:{codex:true}}, {version:1, harnesses:{}, plans:{path:''}}, {version:1, harnesses:[true]}, {version:2, setupComplete:false, harnesses:{claude:true}}])
    assert.equal(setupFilled(saved, data), false, JSON.stringify(saved));
  assert.equal(legacyComplete([]), false);
  fs.writeFileSync(path.join(data, 'setup-complete'), new Date().toISOString());
  assert.equal(setupFilled(null, data), true); // the private marker alone is a finished setup
});

test('a configured setup never gets the popup: stale data, no heartbeat, offline, a quiet stream or an unreadable state', () => {
  for (const filled of [{setupFilled:true}, {setupComplete:true} /* a server from before setupFilled */])
    for (const s of SERVER) for (const c of CLIENT) assert.equal(agentNotice({...filled, ...s}, c).modal, null, JSON.stringify({filled, s, c}));
  for (const c of CLIENT) assert.equal(agentNotice(null, c).modal, null); // server unreachable: it cannot know, so it never blocks
  const ok = {setupFilled:true, stale:false, watcher:true};
  assert.equal(agentNotice(ok).banner, null);
  assert.equal(agentNotice({...ok, stale:true}).banner, 'stale');
  assert.equal(agentNotice({...ok, watcher:false}).banner, 'watcher');
  assert.equal(agentNotice(ok, {quietMs:STALE_MS + 1}).banner, 'stale');
  assert.equal(agentNotice(ok, {quietMs:STALE_MS - 1}).banner, null);
  assert.equal(agentNotice(ok, {offlineMs:OFFLINE_MS}).banner, 'offline');
  assert.equal(agentNotice(ok, {offlineMs:OFFLINE_MS - 1}).banner, null); // a service restart blip
  assert.equal(agentNotice(null, {offlineMs:OFFLINE_MS}).banner, 'offline');
});

test('an empty or missing setup gets the popup in every state', () => {
  for (const s of SERVER) for (const c of CLIENT) assert.deepEqual(agentNotice({setupFilled:false, ...s}, c), {modal:'setup', banner:null});
  assert.equal(agentNotice({setupComplete:false}).modal, 'setup');
});

// ---------- real server + real browser ----------
async function port() { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }
// a throwaway HOME: its data dir is ~/.agentglim inside it; dev mode, so nothing is polled or written into a harness
async function server(t, fill) {
  const home = tmp(), data = path.join(home, '.agentglim'), p = await port();
  fs.writeFileSync(path.join(home, 'env'), ''); fs.mkdirSync(path.join(data, 'flags'), {recursive:true}); fill(data);
  const srv = spawn(process.execPath, ['app/server.mjs', String(p)], {cwd:path.resolve(import.meta.dirname, '../..'), stdio:'ignore',
    env:{PATH:process.env.PATH, SystemRoot:process.env.SystemRoot, HOME:home, USERPROFILE:home, AGENTGLIM_ENV_FILE:path.join(home, 'env'), AGENTGLIM_DEV:'1'}});
  t.after(async () => { srv.kill(); if (srv.exitCode === null) await once(srv, 'exit'); });
  const base = `http://127.0.0.1:${p}`;
  for (let i = 0; i < 200; i++) { try { if ((await fetch(base + '/api/portable')).ok) return base; } catch {} await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('server did not start');
}
// configured like a real install, with a six-hour-old usage reading (stale) and no SuperAgent heartbeat
const configuredStale = (data) => {
  fs.writeFileSync(path.join(data, 'setup.json'), JSON.stringify(CONFIGURED_V1));
  fs.writeFileSync(path.join(data, 'flags', 'codex-usage.json'), JSON.stringify({at:Date.now() - 6 * 3600e3, windows:[{label:'7d', pct:37}]}));
};

test('server: /api/portable and every snapshot carry setupFilled; the popup script imports the one rule', async (t) => {
  const conf = await server(t, configuredStale), empty = await server(t, () => {});
  const a = await (await fetch(conf + '/api/portable')).json();
  assert.equal(a.setupFilled, true); assert.equal(a.stale, true); assert.equal(a.watcher, false);
  assert.equal((await (await fetch(conf + '/api/snapshot')).json()).portable.setupFilled, true);
  assert.equal((await (await fetch(empty + '/api/portable')).json()).setupFilled, false);
  assert.equal((await (await fetch(empty + '/api/snapshot')).json()).setupCfg.setupFilled, false);
  const ui = await fetch(conf + '/portable-ui.js'), rule = await fetch(conf + '/agent-notice.mjs');
  assert.match(ui.headers.get('content-type'), /javascript/); assert.match(rule.headers.get('content-type'), /javascript/);
  assert.match(await ui.text(), /import \{ agentNotice/); assert.match(await rule.text(), /setupFilled/);
  assert.match(await (await fetch(conf + '/')).text(), /<script type="module" src="\/portable-ui\.js">/);
});

function chromePath() {
  const PW = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright');
  try { return fs.readdirSync(PW).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1]).map((d) => `${PW}/${d}/chrome-linux64/chrome`).find((f) => fs.existsSync(f)) || null; } catch { return null; }
}
async function browser() {
  try { const {loadPlaywright} = await import('../../dev/playwright.mjs'); const exe = chromePath(); if (!exe) return null; return await loadPlaywright().chromium.launch({executablePath:exe}); } catch { return null; }
}
const B = await browser();
test.after(() => B?.close());
const isOpen = (page) => page.evaluate(() => !!document.getElementById('agentHelp')?.open);
const banner = (page) => page.evaluate(() => { const n = document.getElementById('agentNote'); return n && !n.hidden ? n.dataset.kind : ''; });
async function open(base) {
  const ctx = await B.newContext({viewport:{width:1280, height:800}}); // fresh profile, empty localStorage
  await ctx.addInitScript(() => { try { localStorage.setItem('agTourSeen', '1'); } catch {} });
  const page = await ctx.newPage(); await page.clock.install();
  await page.goto(base, {waitUntil:'domcontentloaded'}); await page.waitForFunction(() => !!document.getElementById('agentHelp'));
  await page.waitForTimeout(1500); return {ctx, page};
}

test('browser: a configured install shows a banner, never the popup (stale, no heartbeat, offline, hidden tab, reloads)', {skip:!B && 'no Chromium for Playwright'}, async (t) => {
  const base = await server(t, configuredStale), {ctx, page} = await open(base);
  assert.equal(await isOpen(page), false); assert.equal(await banner(page), 'stale');
  await page.evaluate(() => window.dispatchEvent(new Event('agentglim:offline'))); await page.clock.fastForward(OFFLINE_MS + 1000);
  assert.equal(await isOpen(page), false); assert.equal(await banner(page), 'offline');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', {configurable:true, get:() => true}); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.fastForward('20:00'); assert.equal(await isOpen(page), false);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', {configurable:true, get:() => false}); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.fastForward('16:00'); assert.equal(await isOpen(page), false);
  for (let i = 0; i < 2; i++) { await page.reload({waitUntil:'domcontentloaded'}); await page.waitForTimeout(1500); assert.equal(await isOpen(page), false); }
  await page.click('#agentNote button'); assert.equal(await banner(page), ''); // Hide works and stays hidden
  await ctx.close();
});

test('browser: an empty setup shows the popup on load', {skip:!B && 'no Chromium for Playwright'}, async (t) => {
  const base = await server(t, () => {}), {ctx, page} = await open(base);
  assert.equal(await isOpen(page), true);
  assert.match(await page.textContent('#agentHelpText'), /set up AgentGlim/);
  assert.equal(await banner(page), '');
  await page.click('#agentHelp button'); assert.equal(await isOpen(page), false);
  await page.reload({waitUntil:'domcontentloaded'}); await page.waitForTimeout(1500); assert.equal(await isOpen(page), true); // every load until setup is filled out
  await ctx.close();
});
