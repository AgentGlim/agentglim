// Central Host-header guard (DNS rebinding): the dashboard binds loopback, but a page on the internet can
// point a name it controls at 127.0.0.1 and read private data through the browser. Every page and API route
// must refuse a Host it does not own, while the hosts the app really uses keep working:
// 127.0.0.1 / localhost / [::1] / an alias the owner configured on the real port, the phone's loopback forward,
// and a tailnet name the owner configured. Temp HOME and a random port (spawn arg 0); never :18990, never ~/.agentglim.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { waitForServerReady } from './helpers/server-ready.mjs';
import { hostAllowed, parseHost } from '../host-guard.mjs';

const SKILL = '---\nname: alpha-skill\ndescription: Fixture skill that hands work to beta.\n---\n\n# Alpha\n\nprivate fixture text\n';

// One route per family: dashboard page and static assets, Skill Editor page and API, dashboard APIs,
// settings/modes, the bundled sub-apps, and the Control API.
const GET_ROUTES = [
  '/', '/index.html', '/theme.js', '/portable-ui.js', '/shortcuts.js',
  '/skills', '/skills/inventory', '/skills/retire',
  '/api/prefs', '/api/snapshot', '/api/build', '/api/version', '/api/modes', '/api/fleet', '/api/local',
  '/api/skills/list', '/api/skills/file?skill=alpha-skill&path=SKILL.md', '/api/skills/file?skill=alpha-skill&path=notes%2Fextra.md',
  '/api/skills/groups', '/api/skills/groups/state', '/api/skills/retire',
  '/api/control/sessions', '/api/control/config', '/api/control/audit',
];

function fixture(control = null) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-host-guard-'));
  const write = (rel, text) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
  write('env', '');
  write('harness.json', '{}');
  write('data/setup.json', JSON.stringify({ setupComplete: true, hostAliases: ['observatory'] }));
  write('.agents/skills/alpha-skill/SKILL.md', SKILL);
  write('.agents/skills/alpha-skill/notes/extra.md', 'extra notes\n');
  if (control) write('data/control.json', JSON.stringify(control));
  return home;
}

async function server(t, home, extraEnv = {}) {
  const child = spawn(process.execPath, ['app/server.mjs', '0'], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
      AGENTGLIM_DATA: path.join(home, 'data'), AGENTGLIM_ENV_FILE: path.join(home, 'env'),
      AGENTGLIM_CONFIG: path.join(home, 'harness.json'), AGENTGLIM_PLANS: path.join(home, 'plans'),
      AGENTGLIM_DEV: '1', ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, 'exit'); fs.rmSync(home, { recursive: true, force: true }); });
  const port = await waitForServerReady(child);
  return { port, url: `http://127.0.0.1:${port}` };
}

// A request whose Host header the test sets itself (fetch refuses to send a foreign Host).
const raw = (port, route, host, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { host, ...headers } }, (r) => {
    let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => resolve({ status: r.statusCode, body: b }));
  });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});

test('the guard reads a Host header strictly and pins loopback names to the real port', () => {
  assert.deepEqual(parseHost('127.0.0.1:18990'), { name: '127.0.0.1', port: 18990 });
  assert.deepEqual(parseHost('[::1]:18990'), { name: '[::1]', port: 18990 });
  assert.equal(parseHost(''), null);
  assert.equal(parseHost('evil.example/path'), null);

  assert.ok(hostAllowed('127.0.0.1:8090', { port: 8090 }));
  assert.ok(hostAllowed('LOCALHOST:8090', { port: 8090 }));
  assert.ok(hostAllowed('[::1]:8090', { port: 8090 }));
  assert.ok(hostAllowed('observatory:8090', { port: 8090, extraNames: ['observatory'] }), 'a configured alias is allowed');
  assert.ok(!hostAllowed('observatory:8090', { port: 8090 }), 'an unconfigured name is refused');
  assert.ok(!hostAllowed('127.0.0.1', { port: 8090 }), 'a portless loopback Host is port 80, not this listener');
  assert.ok(!hostAllowed('127.0.0.1:8091', { port: 8090 }), 'another local port is not this listener');
  assert.ok(!hostAllowed('evil.example:8090', { port: 8090 }));
  assert.ok(!hostAllowed('evil.example', { port: 8090 }));
  assert.ok(!hostAllowed(undefined, { port: 8090 }), 'HTTP/1.0 clients send no Host at all');
  assert.ok(hostAllowed('pc.tailnet-name.ts.net', { port: 8090, extraNames: ['pc.tailnet-name.ts.net'] }), 'a configured tailnet name is allowed');
  assert.ok(!hostAllowed('other.tailnet-name.ts.net', { port: 8090, extraNames: ['pc.tailnet-name.ts.net'] }));
});

test('a rebound Host is refused on every route family, before any private data is read', async (t) => {
  const { port } = await server(t, fixture());
  for (const route of GET_ROUTES) {
    const r = await raw(port, route, 'attacker.example');
    assert.equal(r.status, 403, `${route} must refuse a foreign Host (got ${r.status})`);
    assert.match(r.body, /bad host/, route);
    assert.ok(!r.body.includes('private fixture text'), `${route} leaked skill contents`);
    assert.ok(!r.body.includes('extra notes'), `${route} leaked a skill note`);
  }
  // writes are refused too, and nothing is written
  const home = fixture();
  const s = await server(t, home);
  const before = fs.readFileSync(path.join(home, '.agents/skills/alpha-skill/SKILL.md'), 'utf8');
  const w = await raw(s.port, '/api/skills/file?skill=alpha-skill&path=SKILL.md', 'attacker.example', {
    method: 'PUT', headers: { origin: 'http://attacker.example', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'overwritten\n', force: true }),
  });
  assert.equal(w.status, 403);
  assert.equal(fs.readFileSync(path.join(home, '.agents/skills/alpha-skill/SKILL.md'), 'utf8'), before, 'the skill file is untouched');
});

test('the hosts the app uses still answer normally', async (t) => {
  const { port, url } = await server(t, fixture());
  const ok = [
    { host: `127.0.0.1:${port}` }, { host: `localhost:${port}` }, { host: `[::1]:${port}` }, { host: `observatory:${port}` },
  ];
  for (const { host } of ok) {
    for (const route of ['/', '/skills', '/api/snapshot', '/api/build', '/api/skills/list', '/api/skills/file?skill=alpha-skill&path=SKILL.md', '/api/skills/groups', '/api/control/sessions']) {
      const r = await raw(port, route, host);
      assert.equal(r.status, 200, `${host} ${route} answered ${r.status}`);
    }
  }
  // the page and the API keep working through the plain fetch path the browser uses
  assert.equal((await fetch(`${url}/api/build`)).status, 200);
  const list = await (await fetch(`${url}/api/skills/list`)).json();
  assert.ok(list.skills.some((s) => s.name === 'alpha-skill'));

  // the phone reaches the dashboard through the remote listener's loopback forward (remote-mw.mjs):
  // same Host the proxy sends, plus its user-agent; the read-only GET it forwards must still work.
  const fwd = await raw(port, '/api/snapshot', `127.0.0.1:${port}`, { headers: { accept: 'text/html', 'user-agent': 'observatory-remote' } });
  assert.equal(fwd.status, 200);
  assert.equal((await raw(port, '/api/build', `127.0.0.1:${port}`, { headers: { 'user-agent': 'observatory-remote' } })).status, 200);
});

test('a tailnet name the owner configured for phone access is allowed, and only that name', async (t) => {
  // remote.host in control.json (what the Control panel's remote settings write)
  const configured = await server(t, fixture({ remote: { enabled: true, host: 'pc.tailnet-name.ts.net', allowLogins: [], requireTailscaleLogin: true } }));
  assert.equal((await raw(configured.port, '/api/build', 'pc.tailnet-name.ts.net')).status, 200);
  assert.equal((await raw(configured.port, '/api/skills/list', 'pc.tailnet-name.ts.net')).status, 200);
  assert.equal((await raw(configured.port, '/api/build', 'other.tailnet-name.ts.net')).status, 403);
  assert.equal((await raw(configured.port, '/api/build', 'attacker.example')).status, 403);

  // AGENTGLIM_ALLOWED_HOSTS for a reverse proxy the owner set up in front of the dashboard
  const envHost = await server(t, fixture(), { AGENTGLIM_ALLOWED_HOSTS: 'glim.lan,http-proxy.example' });
  assert.equal((await raw(envHost.port, '/api/build', 'glim.lan')).status, 200);
  assert.equal((await raw(envHost.port, '/api/build', 'http-proxy.example:443')).status, 200);
  assert.equal((await raw(envHost.port, '/api/build', 'glim.lan.evil.example')).status, 403);
});
