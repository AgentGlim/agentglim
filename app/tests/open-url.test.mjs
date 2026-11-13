import { once } from 'node:events';
import { waitForServerReady } from './helpers/server-ready.mjs';
// node --test app/tests/open-url.test.mjs : URL rules of /api/open-url, plus a Playwright click on goals.html (?app=1)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { loadPlaywright } from '../../dev/playwright.mjs';
import { normalizeOpenUrl, sameAppRequest } from '../open-url-rules.mjs';

test('http upgrades to https for non-local hosts only', () => {
  assert.equal(normalizeOpenUrl('http://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(normalizeOpenUrl('https://example.com/'), 'https://example.com/');
  for (const u of ['http://observatory:8081/x', 'http://localhost:8090/', 'http://127.0.0.1:1/', 'http://[::1]:5/'])
    assert.ok(normalizeOpenUrl(u).startsWith('http://'), u);
  assert.equal(normalizeOpenUrl('http://observatory.evil.com/'), 'https://observatory.evil.com/');
});
test('bad urls refused', () => {
  for (const u of ['file:///etc/passwd', 'javascript:alert(1)', '--help', 'http://a b', 'http://u:p@example.com/', '', null, 42, 'ftp://x.com'])
    assert.equal(normalizeOpenUrl(u), null, String(u));
});
test('origin/host must be the app', () => {
  assert.ok(sameAppRequest({ host: 'observatory:8081', origin: 'http://observatory:8081' }));
  assert.ok(sameAppRequest({ host: '127.0.0.1:8090', origin: 'http://127.0.0.1:8090' }));
  assert.ok(!sameAppRequest({ host: 'observatory:8081', origin: 'https://evil.com' }));
  assert.ok(!sameAppRequest({ host: 'observatory:8081' }));
  assert.ok(!sameAppRequest({ host: 'evil.com', origin: 'http://evil.com' })); // DNS rebinding
  assert.ok(!sameAppRequest({ origin: 'http://localhost' }));
});

const APP = path.resolve(import.meta.dirname, '..');
test('goals.html with ?app=1 routes a new-tab link to /api/open-url', async (t) => {
  let chromium; try { ({ chromium } = loadPlaywright()); } catch { return t.skip('playwright missing'); }
  const exe = fs.globSync ? fs.globSync(os.homedir() + '/.cache/ms-playwright/chromium-*/chrome-linux64/chrome')[0] : undefined;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ou-')); for (const d of ['data', 'work', 'plans']) fs.mkdirSync(path.join(tmp, d));
  const srv = spawn(process.execPath, ['server.mjs', '0'], { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: tmp, USERPROFILE: tmp, AGENTGLIM_ENV_FILE: path.join(tmp, 'env'), AGENTGLIM_DEV: '1', AGENTGLIM_DATA: `${tmp}/data`, AGENTGLIM_WORK: `${tmp}/work`, AGENTGLIM_PLANS: `${tmp}/plans` } });
  let browser;
  try {
    const PORT = await waitForServerReady(srv);
    // An empty /proc (bwrap emulation) or a sandboxed host kills Chromium before it reports ready:
    // that is an environment limit like a missing browser, so skip instead of failing the suite.
    browser = await chromium.launch(exe ? { executablePath: exe } : {}).catch(() => null);
    if (!browser) { t.skip('no launchable Chromium here (missing browser or no /proc)'); return; }
    const page = await browser.newPage(); const posts = [];
    await page.route('**/api/open-url', (r) => { posts.push(r.request().postDataJSON()); r.fulfill({ status: 200, body: '{"ok":true}', contentType: 'application/json' }); });
    await page.goto(`http://127.0.0.1:${PORT}/goals?app=1`);
    await page.evaluate(() => { const a = document.createElement('a'); a.id = 'tl'; a.href = 'http://example.com/x'; a.target = '_blank'; a.textContent = 'x'; document.body.prepend(a); });
    await page.click('#tl');
    assert.deepEqual(posts, [{ url: 'http://example.com/x' }]);
    // real server: cross-origin and missing-origin posts are refused
    const bad = await fetch(`http://127.0.0.1:${PORT}/api/open-url`, { method: 'POST', headers: { origin: 'https://evil.com' }, body: '{"url":"https://example.com"}' });
    assert.equal(bad.status, 403);
  } finally { await browser?.close(); if (srv.exitCode === null && srv.signalCode === null) { srv.kill(); await once(srv, 'exit'); } }
});
