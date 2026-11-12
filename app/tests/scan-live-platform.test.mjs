import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

for (const [platform, port] of [['darwin', 19360], ['win32', 19361]]) {
  test(`server runs its live scan on ${platform}`, async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-scan-'));
    fs.writeFileSync(path.join(home, 'env'), '');
    const script = `Object.defineProperty(process, 'platform', {value: '${platform}'}); process.argv[2] = '${port}'; await import('./app/server.mjs');`;
    const server = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: { PATH: process.env.PATH, HOME: home, AGENTGLIM_ENV_FILE: path.join(home, 'env'), AGENTGLIM_DEV: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
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
    let response;
    for (let i = 0; i < 100 && server.exitCode === null; i++) {
      try { response = await fetch(`http://127.0.0.1:${port}/api/snapshot`); if (response.ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(response?.ok, `server failed to start: ${errors}`);
    assert.ok(await response.json());
    assert.doesNotMatch(errors, /scan failed/);
  });
}
