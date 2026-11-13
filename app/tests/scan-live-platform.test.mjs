import { waitForServerReady } from './helpers/server-ready.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

for (const platform of ['darwin', 'win32']) {
  test(`server runs its live scan on ${platform}`, async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-scan-'));
    fs.writeFileSync(path.join(home, 'env'), '');
    const script = `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const sync = cp.execFileSync, asyncRun = cp.execFile;
      cp.execFileSync = (cmd, ...args) => {
        if (cmd === 'powershell.exe') { console.error('synchronous CIM blocks startup'); throw new Error('CIM stalled'); }
        return sync(cmd, ...args);
      };
      cp.execFile = (cmd, ...args) => {
        if (cmd === 'powershell.exe') return; // CIM never finishes; HTTP must still work.
        return asyncRun(cmd, ...args);
      };
      syncBuiltinESMExports();
      Object.defineProperty(process, 'platform', {value: '${platform}'}); process.argv[2] = '0'; await import('./app/server.mjs');`;
    const server = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, AGENTGLIM_ENV_FILE: path.join(home, 'env'), AGENTGLIM_DEV: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errors = '';
    server.stderr.on('data', chunk => { errors += chunk; });
    t.after(async () => {
      if (server.exitCode === null && server.signalCode === null) {
        server.kill();
        await once(server, 'exit');
      }
      fs.rmSync(home, { recursive: true, force: true });
    });
    const port = await waitForServerReady(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/snapshot`);
    assert.ok(response?.ok, `server failed to start: ${errors}`);
    assert.ok(await response.json());
    assert.doesNotMatch(errors, /scan failed|synchronous CIM blocks startup/);
  });
}

// R9.1/C1: a machine with no procfs must still start. AGENTGLIM_PROC points at a folder that does
// not exist, so every process reader returns empty instead of raising ENOENT during startup.
test('server starts and answers with no proc root at all', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-no-proc-server-'));
  fs.writeFileSync(path.join(home, 'env'), '');
  const server = spawn(process.execPath, ['app/server.mjs', '0'], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
      AGENTGLIM_ENV_FILE: path.join(home, 'env'), AGENTGLIM_DEV: '1', AGENTGLIM_PROC: path.join(home, 'no-such-proc') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  server.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) { server.kill(); await once(server, 'exit'); }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const port = await waitForServerReady(server);
  const response = await fetch(`http://127.0.0.1:${port}/api/snapshot`);
  assert.ok(response?.ok, `server failed to start without a proc root: ${errors}`);
  assert.ok(await response.json());
  assert.doesNotMatch(errors, /ENOENT|scandir|Unhandled|scan failed/);
});
