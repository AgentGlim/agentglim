import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { waitForServerReady } from './helpers/server-ready.mjs';
const APP = path.resolve(import.meta.dirname, '..');
// bwrap with an empty /proc makes Node report process.execPath as bare 'node' (no /proc/self/exe).
// Resolve it on PATH once, so a child with a deliberately narrow PATH can still be spawned.
const NODE = path.isAbsolute(process.execPath) ? process.execPath
  : (process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, process.execPath))
    .find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || process.execPath;
const fixtureKey = 'fixture-jev-credential-do-not-expose';
function fixture(withKey) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-jev-'));
  fs.mkdirSync(`${tmp}/plans`);
  fs.writeFileSync(`${tmp}/env`, withKey ? `JEV_API_KEY=${fixtureKey}\n` : '');
  fs.writeFileSync(`${tmp}/harness.json`, '{}');
  // Allowlist excludes real credentials, .env and ~/.bashrc from each child.
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: tmp, USERPROFILE: tmp, AGENTGLIM_ENV_FILE: `${tmp}/env`,
    AGENTGLIM_CONFIG: `${tmp}/harness.json`, AGENTGLIM_WORK: tmp, AGENTGLIM_PLANS: `${tmp}/plans`,
    AGENTGLIM_PROJECTS: tmp, AGENTGLIM_DEV: '1' };
  return { tmp, env };
}
for (const withKey of [false, true]) {
  test(`Jev status endpoint ${withKey ? 'with temporary key' : 'without key'}`, async (t) => {
    const { tmp, env } = fixture(withKey);
    const srv = spawn(NODE, ['server.mjs', '0'], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(async () => { if (srv.exitCode === null && srv.signalCode === null) { srv.kill(); await once(srv, 'exit'); } fs.rmSync(tmp, { recursive: true, force: true }); });
    const port = await waitForServerReady(srv);
    const base = `http://127.0.0.1:${port}`, headers = { origin: base };
    const r = await fetch(`${base}/api/setup/jev`, { headers });
    assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
    const text = await r.text(), j = JSON.parse(text);
    assert.equal(j.keySet, withKey); assert.equal(j.source, withKey ? '.env' : null);
    assert.equal(j.on, true); assert.equal(j.routingUrl, '/routing');
    // the private repo has harness/jev-routes.json; the public export falls back to app/jev-routes.example.json
    assert.ok(/[\\/](harness[\\/]jev-routes|app[\\/]jev-routes\.example)\.json$/.test(j.routes), j.routes);
    assert.ok(!text.includes(fixtureKey));
    const setup = await (await fetch(`${base}/api/setup`)).json();
    assert.equal(setup.detected.jev.keySet, withKey);
    assert.ok(!JSON.stringify(setup).includes(fixtureKey));
    assert.equal((await fetch(`${base}/api/setup/jev`, { headers: { referer: `${base}/setup` } })).status, 200);
    for (const route of ['/api/setup/jev', '/api/setup/jev/test']) {
      for (const bad of [{ origin: 'https://evil.example' }, {}, { origin: base, 'sec-fetch-site': 'cross-site' }])
        assert.equal((await fetch(base + route, { headers: bad })).status, 403, JSON.stringify(bad));
      const hostileHost = await new Promise((resolve, reject) => {
        http.get(base + route, { headers: { host: 'evil.example', origin: 'http://evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
      });
      assert.equal(hostileHost, 403);
      assert.equal((await fetch(base + route, { method: 'POST', headers })).status, 405);
    }
    if (!withKey) {
      const result = await fetch(`${base}/api/setup/jev/test`, { headers });
      assert.equal(result.status, 400); assert.match((await result.json()).error, /No JEV_API_KEY/);
    }
    const custom = path.join(tmp, 'custom-routes.json'); fs.writeFileSync(custom, '{}');
    fs.writeFileSync(`${tmp}/harness.json`, JSON.stringify({ jev: { routes: custom } }));
    assert.equal((await (await fetch(`${base}/api/setup/jev`, { headers })).json()).routes, '~' + path.sep + 'custom-routes.json');
    fs.mkdirSync(`${tmp}/data`, { recursive: true });
    fs.writeFileSync(`${tmp}/data/setup.json`, JSON.stringify({ jev: { on: false } }));
    assert.equal((await (await fetch(`${base}/api/setup/jev`, { headers })).json()).on, false);
    const fallback = JSON.parse(execFileSync(NODE, ['../harness/bin/jev-route.mjs', 'rename a variable'], { cwd: APP, env, encoding: 'utf8' }));
    assert.equal(fallback.pick, 'claude-sonnet'); assert.equal(fallback.disabled, true);
  });
}
test('routing runner: fixed task, timeout, safe output, toggle persistence and env override', (t) => {
  const { env, tmp } = fixture(true);
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const binDir = path.join(tmp, 'fixture-bin'); fs.mkdirSync(binDir);
  const binary = path.join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  fs.writeFileSync(binary, '', { mode: 0o755 });
  const routes = path.join(tmp, 'override.json'); fs.writeFileSync(routes, '{}');
  execFileSync(NODE, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import path from 'node:path';
    import { testJevRouting, saveSetup, loadSetup, jevStatus, detect } from './setup.mjs';
    assert.equal(detect().harnesses.find(h => h.id === 'claude').bin, path.join('~', 'fixture-bin', process.platform === 'win32' ? 'claude.CMD' : 'claude'));
    const success = await testJevRouting((bin, args, opts, cb) => {
      assert.equal(bin, process.execPath);
      assert.ok(args[0].endsWith(path.join('harness', 'bin', 'jev-route.mjs')));
      assert.equal(args[1], 'rename a variable'); assert.equal(opts.timeout, 60000);
      cb(null, JSON.stringify({pick:'sonnet',p:0.8,effort:'medium'}));
    });
    assert.deepEqual(success, {pick:'sonnet',p:0.8,effort:'medium'});
    assert.match((await testJevRouting((b,a,o,cb) => cb({killed:true}, ''))).error, /60 seconds/);
    const failed = await testJevRouting((b,a,o,cb) => cb(new Error('failed'), JSON.stringify({error:o.env.JEV_API_KEY})));
    assert.ok(!JSON.stringify(failed).includes(process.env.JEV_API_KEY));
    assert.match((await testJevRouting((b,a,o,cb) => cb(null, 'invalid'))).error, /no usable/);
    saveSetup({jev:{on:false}}); assert.equal(loadSetup().jev.on, false);
    saveSetup({jev:{on:true}}); assert.equal(loadSetup().jev.on, true);
    assert.equal(jevStatus().routes, '~' + path.sep + 'override.json');
  `], { cwd: APP, env: { ...env, PATHEXT: '.EXE;.CMD;.BAT;.COM', PATH: [path.join(tmp, 'empty-bin'), binDir].join(path.delimiter), AGENTGLIM_JEV_ROUTES: routes }, stdio: 'pipe' });
});
