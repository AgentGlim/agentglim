import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { waitForServerReady } from './helpers/server-ready.mjs';
import {
  CACHE_FILE, CHECK_INTERVAL_MS, checkForUpdate, compareVersions, currentVersion,
  readCache, statusFrom, updateCheckEnabled,
} from '../update-check.mjs';
import { loadIntegrations } from '../integrations.mjs';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-update-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function github(t, handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    handler(req, res, hits.length);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}/repos/example/agentglim`, hits };
}

const release = (tag) => (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ tag_name: tag, html_url: `https://github.com/AgentGlim/agentglim/releases/tag/${tag}` }));
};

test('newer published release turns updateAvailable on, with the supported update command', async (t) => {
  const gh = await github(t, release('v0.2.9'));
  const status = await checkForUpdate({ data: temp(t), current: 'v0.2.8', apiBase: gh.base });
  assert.equal(status.current, 'v0.2.8');
  assert.equal(status.latest, 'v0.2.9');
  assert.equal(status.updateAvailable, true);
  assert.equal(status.url, 'https://github.com/AgentGlim/agentglim/releases/tag/v0.2.9');
  assert.ok(!Number.isNaN(Date.parse(status.checkedAt)));
  assert.equal(status.howTo.git, 'git pull --ff-only && npm run update');
  assert.equal(status.howTo.tarball, undefined, 'only the main-branch update command is advertised');
  assert.deepEqual(gh.hits, ['/repos/example/agentglim/releases/latest']);
});

test('the same published release does not ask for an update', async (t) => {
  const gh = await github(t, release('v0.2.9'));
  const status = await checkForUpdate({ data: temp(t), current: 'v0.2.9', apiBase: gh.base });
  assert.equal(status.updateAvailable, false);
  assert.equal(status.latest, 'v0.2.9');
});

test('v0.2.15 and newer use the installed update script, then restart', () => {
  for (const current of ['v0.2.15', 'v0.2.16', 'v0.3.0', 'dev']) {
    const status = statusFrom({ current });
    assert.equal(status.howTo.git, 'npm run update');
    assert.match(status.howTo.restart, /Restart AgentGlim after updating/);
  }
});

test('offline and rate-limited GitHub answers return false without throwing', async (t) => {
  const dir = temp(t);
  const offline = await checkForUpdate({
    data: dir, current: 'v0.2.8',
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
  });
  assert.equal(offline.updateAvailable, false);
  assert.equal(offline.latest, null);
  assert.ok(readCache(dir).checkedAt);

  const blocked = await github(t, (req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end('{"message":"API rate limit exceeded"}');
  });
  const limited = await checkForUpdate({ data: temp(t), current: 'v0.2.8', apiBase: blocked.base });
  assert.equal(limited.updateAvailable, false);
  assert.equal(limited.latest, null);
});

test('a release API failure falls back to tags', async (t) => {
  const gh = await github(t, (req, res) => {
    if (req.url.endsWith('/releases/latest')) { res.writeHead(500); return res.end('{}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ name: 'v0.3.0' }, { name: 'v0.2.9' }]));
  });
  const status = await checkForUpdate({ data: temp(t), current: 'v0.2.8', apiBase: gh.base });
  assert.equal(status.latest, 'v0.3.0');
  assert.equal(status.updateAvailable, true);
  assert.equal(gh.hits.length, 2);
});

test('the cache is used for 12 hours, then checked again', async (t) => {
  const dir = temp(t);
  const first = await github(t, release('v0.2.9'));
  const start = Date.now();
  await checkForUpdate({ data: dir, current: 'v0.2.8', apiBase: first.base, now: start });
  assert.equal(first.hits.length, 1);

  const second = await github(t, (req, res) => { res.writeHead(403); res.end(); });
  const cached = await checkForUpdate({ data: dir, current: 'v0.2.8', apiBase: second.base, now: start + 11 * 60 * 60e3 });
  assert.equal(cached.updateAvailable, true);
  assert.equal(second.hits.length, 0, 'a request inside 12 h must not touch GitHub');

  const cacheFile = path.join(dir, CACHE_FILE);
  const old = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  old.checkedAt = new Date(start + 13 * 60 * 60e3).toISOString();
  fs.writeFileSync(cacheFile, JSON.stringify(old));
  await checkForUpdate({ data: dir, current: 'v0.2.8', apiBase: second.base, now: start + 25 * 60 * 60e3 });
  assert.equal(second.hits.length, 2, 'after 12 h the next call checks again (release, then tags fallback)');
  assert.ok(Math.abs(Date.parse(readCache(dir).checkedAt) - (start + 25 * 60 * 60e3)) < 1000);
});

test('opt-out by settings or environment never calls GitHub', async (t) => {
  assert.equal(updateCheckEnabled({ integrations: { updateCheck: false } }), false);
  assert.equal(updateCheckEnabled({ integrations: {}, env: { AGENTGLIM_NO_UPDATE_CHECK: '1' } }), false);
  assert.equal(updateCheckEnabled({ integrations: { updateCheck: true }, env: {} }), true);

  const gh = await github(t, release('v0.2.9'));
  const status = await checkForUpdate({ data: temp(t), current: 'v0.2.8', enabled: false, apiBase: gh.base });
  assert.equal(status.updateAvailable, false);
  assert.equal(status.enabled, false);
  assert.equal(gh.hits.length, 0);
});

test('the AGENTGLIM_UPDATE_API environment variable points the check at a stub', async (t) => {
  const gh = await github(t, release('v0.4.0'));
  const previous = process.env.AGENTGLIM_UPDATE_API;
  process.env.AGENTGLIM_UPDATE_API = gh.base;
  t.after(() => { if (previous === undefined) delete process.env.AGENTGLIM_UPDATE_API; else process.env.AGENTGLIM_UPDATE_API = previous; });
  const status = await checkForUpdate({ data: temp(t), current: 'v0.3.0' });
  assert.equal(status.updateAvailable, true);
  assert.equal(gh.hits.length, 1);
});

test('a dev build never checks or shows a banner', async (t) => {
  const gh = await github(t, release('v9.9.9'));
  const status = await checkForUpdate({ data: temp(t), current: 'dev', apiBase: gh.base });
  assert.equal(status.current, 'dev');
  assert.equal(status.updateAvailable, false);
  assert.equal(status.latest, null);
  assert.equal(gh.hits.length, 0);
});

test('version helpers read the file, normalize tags and compare numerically', (t) => {
  const dir = temp(t);
  const file = path.join(dir, 'version.json');
  fs.writeFileSync(file, '{"version":"v0.2.9"}');
  assert.equal(currentVersion(file), 'v0.2.9');
  fs.writeFileSync(file, '{"version":"dev"}');
  assert.equal(currentVersion(file), 'dev');
  fs.writeFileSync(file, 'not json');
  assert.equal(currentVersion(file), 'dev');
  assert.equal(currentVersion(path.join(dir, 'missing.json')), 'dev');
  assert.equal(compareVersions('v0.10.0', 'v0.9.9'), 1);
  assert.equal(compareVersions('v0.2.9', 'v0.2.9'), 0);
  assert.equal(compareVersions('v0.2.8', 'v0.2.9'), -1);
  assert.equal(statusFrom({ current: 'dev', cache: { latest: 'v1.0.0', checkedAt: new Date().toISOString() } }).updateAvailable, false);
  assert.ok(CHECK_INTERVAL_MS === 12 * 60 * 60 * 1000);
});

test('integrations.json turns the check off and defaults it on', (t) => {
  const dir = temp(t);
  const file = path.join(dir, 'integrations.json');
  fs.writeFileSync(file, JSON.stringify({ updateCheck: false }));
  assert.equal(loadIntegrations({ env: { AGENTGLIM_INTEGRATIONS: file }, home: dir, data: dir }).updateCheck, false);
  fs.writeFileSync(file, JSON.stringify({}));
  assert.equal(loadIntegrations({ env: { AGENTGLIM_INTEGRATIONS: file }, home: dir, data: dir }).updateCheck, true);
});

test('stamp-version writes the release tag into an export without touching the private repo', (t) => {
  const dir = temp(t);
  const script = path.resolve(import.meta.dirname, '../../dev/stamp-version.mjs');
  if (!fs.existsSync(script)) return t.skip('the release helper is not part of this export');
  execFileSync(process.execPath, [script, 'v1.2.3', dir], { stdio: 'pipe' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'app/version.json'), 'utf8')), { version: 'v1.2.3' });
});

async function appServer(t, env = {}) {
  const home = temp(t);
  fs.writeFileSync(path.join(home, 'env'), '');
  fs.writeFileSync(path.join(home, 'harness.json'), '{}');
  const child = spawn(process.execPath, ['app/server.mjs', '0'], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
      AGENTGLIM_DATA: path.join(home, 'data'), AGENTGLIM_ENV_FILE: path.join(home, 'env'),
      AGENTGLIM_CONFIG: path.join(home, 'harness.json'), AGENTGLIM_PLANS: path.join(home, 'plans'),
      AGENTGLIM_PROJECTS: home, AGENTGLIM_DEV: '1', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, 'exit'); });
  const port = await waitForServerReady(child);
  return `http://127.0.0.1:${port}`;
}

test('GET /api/version serves the cached shape and a dev build stays quiet', async (t) => {
  const gh = await github(t, release('v9.9.9'));
  const base = await appServer(t, { AGENTGLIM_UPDATE_API: gh.base });
  const res = await fetch(base + '/api/version');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') || '', /no-store/);
  const status = await res.json();
  assert.equal(status.current, 'dev');
  assert.equal(status.updateAvailable, false);
  assert.equal(status.enabled, true);
  assert.ok('checkedAt' in status && 'latest' in status && 'url' in status && 'howTo' in status);
  assert.equal(gh.hits.length, 0, 'a dev build never calls GitHub');
});

test('GET /api/version reports the check disabled when the environment opts out', async (t) => {
  const base = await appServer(t, { AGENTGLIM_NO_UPDATE_CHECK: '1' });
  const status = await (await fetch(base + '/api/version')).json();
  assert.equal(status.enabled, false);
  assert.equal(status.updateAvailable, false);
});
