import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitForServerReady } from './helpers/server-ready.mjs';

function child(t, script, options = {}) {
  const server = spawn(process.execPath, ['--input-type=module', '-e', script], {
    ...options, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill();
      await once(server, 'exit');
    }
  });
  return server;
}

test('server readiness waits past the old ten-second budget for delayed listen', async t => {
  const server = child(t, `
    import http from 'node:http';
    // Startup chatter must not count as readiness; split the real CRLF line.
    console.log('initializing server');
    setTimeout(() => {
      const listener = http.createServer((req, res) => res.end('ready')).listen(0, '127.0.0.1', () => {
        process.stdout.write('observatory on http://observatory:');
        setTimeout(() => console.log(listener.address().port + ' (127.0.0.1)\\r'), 20);
      });
    }, 11_000);
  `);
  const started = performance.now();
  const port = await waitForServerReady(server);
  assert.ok(performance.now() - started >= 11_000);
  // No retry: the first request after the listening signal must succeed.
  const response = await fetch(`http://127.0.0.1:${port}`);
  assert.equal(await response.text(), 'ready');
});

test('server readiness reports early exit with startup diagnostics', async t => {
  const server = child(t, "console.error('fixture startup failure'); process.exit(7)");
  await assert.rejects(waitForServerReady(server, 19360), /exited before ready \(code 7, signal null\)[\s\S]*fixture startup failure/);
});

test('server readiness caps a hung startup without accepting an unrelated port', async t => {
  const server = child(t, `
    console.log('observatory on http://observatory:19361 (127.0.0.1)');
    setInterval(() => {}, 1000);
  `);
  await assert.rejects(waitForServerReady(server, 19360, { timeoutMs: 500 }), /did not become ready within 500ms/);
});

test('parallel app servers report distinct bound dashboard and page ports', async t => {
  const fixtures = await Promise.all([false, true].map(async useEnv => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-port-zero-'));
    fs.writeFileSync(path.join(home, 'env'), '');
    const server = child(t, `process.argv[2] = ${useEnv ? 'undefined' : "'0'"}; await import(${JSON.stringify(new URL('../server.mjs', import.meta.url).href)});`, {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
        AGENTGLIM_ENV_FILE: path.join(home, 'env'), AGENTGLIM_DEV: '1', PORT: '0' },
    });
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const port = await waitForServerReady(server);
    const snapshot = await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json();
    assert.ok(snapshot.pagesPort > 0);
    // The first request to the separate page listener must succeed too.
    assert.equal((await fetch(`http://127.0.0.1:${snapshot.pagesPort}/`)).status, 404);
    const base = `http://127.0.0.1:${port}`, origin = `http://127.0.0.1:${snapshot.pagesPort}`;
    assert.equal((await fetch(base + '/api/approval-choice', { headers: { origin } })).status, 405);
    assert.equal((await fetch(base + '/api/approval-choice', { headers: { origin: base } })).status, 403);
    const read = await fetch(base + '/api/page-read', { headers: { origin } });
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('access-control-allow-origin'), origin);
    return [port, snapshot.pagesPort];
  }));
  assert.equal(new Set(fixtures.flat()).size, 4);
});
