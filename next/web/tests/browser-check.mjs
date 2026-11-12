import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../../../dev/playwright.mjs';
const { chromium } = loadPlaywright();

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TABS = ['pipeline', 'fleet', 'blockers', 'approvals', 'costs'];
const VIEWPORTS = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }];

function findChromium() {
  const cache = path.join(process.env.HOME || '', '.cache', 'ms-playwright');
  try {
    const dirs = fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort();
    if (dirs.length) {
      const exe = path.join(cache, dirs[dirs.length - 1], 'chrome-linux64', 'chrome');
      if (fs.existsSync(exe)) return exe;
    }
  } catch {}
  return '/usr/bin/chromium';
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function safeResolve(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = decoded === '/' ? '/index.html' : decoded;
  const full = path.resolve(ROOT, '.' + rel);
  if (!full.startsWith(ROOT + path.sep) && full !== ROOT) return null;
  const relFromRoot = path.relative(ROOT, full);
  if (relFromRoot.split(path.sep)[0] === 'tests' || relFromRoot.split(path.sep)[0] === 'node_modules') return null;
  if (relFromRoot.startsWith('.')) return null;
  return full;
}

async function startServer() {
  let server = null;
  let port = null;
  for (let p = 19360; p <= 19379; p++) {
    const s = http.createServer((req, res) => {
      const file = safeResolve(req.url || '/');
      if (!file) { res.statusCode = 403; res.end('forbidden'); return; }
      fs.readFile(file, (err, buf) => {
        if (err) { res.statusCode = 404; res.end('not found'); return; }
        const ext = path.extname(file);
        res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
        res.end(buf);
      });
    });
    try {
      await new Promise((resolve, reject) => {
        s.once('error', reject);
        s.listen(p, '127.0.0.1', () => resolve());
      });
      server = s;
      port = p;
      break;
    } catch (e) {
      s.close();
      if (p === 19379) throw new Error('no free port in 19360-19379');
    }
  }
  if (!server) throw new Error('failed to bind server');
  return { server, port };
}

async function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // force close connections
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}

async function runLayout(browser, url, viewport) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText || ''}`));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`); });

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(300);

  const H = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < H; y += 500) {
    await page.evaluate((yy) => window.scrollTo({ top: yy, behavior: 'instant' }), y);
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));

  const overflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth > window.innerWidth + 1;
  });

  if (overflow) errors.push(`horizontal overflow: scrollWidth ${await page.evaluate(() => document.documentElement.scrollWidth)} > innerWidth ${viewport.width}`);

  await context.close();
  return errors;
}

async function main() {
  const { server, port } = await startServer();
  const urlBase = `http://127.0.0.1:${port}`;
  let browser = null;
  const results = [];
  try {
    browser = await chromium.launch({ executablePath: findChromium(), headless: true });
    for (const tab of TABS) {
      for (const vp of VIEWPORTS) {
        const url = `${urlBase}/#/${tab}`; // app reads location.hash slice(1)
        // app expects hash without leading slash? names.includes(location.hash.slice(1))
        const realUrl = `${urlBase}/#${tab}`;
        const errs = await runLayout(browser, realUrl, vp);
        results.push({ tab, viewport: vp.name, errors: errs });
        if (errs.length) {
          console.error(`${tab} ${vp.name}: ${errs.join(' | ')}`);
        } else {
          console.log(`${tab} ${vp.name}: OK`);
        }
      }
    }
  } finally {
    if (browser) await browser.close();
    await closeServer(server);
  }

  // verify listener closed
  if (server.listening) throw new Error(`server still listening on ${port}`);

  const totalErrors = results.reduce((a, r) => a + r.errors.length, 0);
  const layouts = results.length;
  console.log(`layouts=${layouts} totalUnexpectedErrors=${totalErrors} port=${port}`);
  if (totalErrors > 0) {
    process.exitCode = 1;
  }
  if (layouts !== 10) {
    console.error(`expected 10 layouts, got ${layouts}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
