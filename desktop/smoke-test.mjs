// Linux smoke test in an isolated Xvfb session; no npm dependencies.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import assert from 'node:assert/strict';

const desktop = path.dirname(fileURLToPath(import.meta.url));
const binary = path.resolve(process.argv[2] || path.join(desktop, 'target/release/agentglim'));
const url = 'http://127.0.0.1:18990';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function listening() {
  return new Promise((resolve) => {
    const socket = net.connect(18990, '127.0.0.1');
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}
async function ready() {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.status === 200 && (await response.text()).includes('<title>AgentGlim</title>');
  } catch { return false; }
}
async function until(check, label, timeout = 35000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(200);
  }
  throw new Error(`Timed out: ${label}`);
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await until(() => child.exitCode !== null || child.signalCode !== null, `pid ${child.pid} exit`, 10000);
}

assert.equal(await listening(), false, 'Port 18990 is occupied; leave that server untouched and test later.');
await mkdir(path.join(desktop, 'target'), { recursive: true });
const scratch = await mkdtemp(path.join(desktop, 'target/smoke-'));
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('AGENTGLIM_')) delete env[key];
Object.assign(env, {
  HOME: path.join(scratch, 'home'),
  PATH: '/usr/bin:/bin',
  XDG_CONFIG_HOME: path.join(scratch, 'config'),
  XDG_CACHE_HOME: path.join(scratch, 'cache'),
  XDG_DATA_HOME: path.join(scratch, 'share'),
  AGENTGLIM_DEV: '1',
  AGENTGLIM_DATA: path.join(scratch, 'data'),
  AGENTGLIM_WORK: path.join(scratch, 'work'),
  AGENTGLIM_PLANS: path.join(scratch, 'plans'),
  AGENTGLIM_RUN: path.join(scratch, 'plans/_run'),
  AGENTGLIM_PROJECTS: path.join(scratch, 'projects'),
  AGENTGLIM_ENV_FILE: path.join(scratch, 'empty.env'),
  GDK_BACKEND: 'x11',
  GSETTINGS_BACKEND: 'memory',
  NO_AT_BRIDGE: '1',
  LIBGL_ALWAYS_SOFTWARE: '1',
  __EGL_VENDOR_LIBRARY_FILENAMES: '/usr/share/glvnd/egl_vendor.d/50_mesa.json',
});
for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'AGENTGLIM_DATA', 'AGENTGLIM_WORK', 'AGENTGLIM_PROJECTS']) {
  await mkdir(env[key], { recursive: true });
}
// Simulate a desktop launcher with system Node 20 on PATH and user Node 22+ outside PATH.
await mkdir(path.join(env.HOME, '.local/bin'), { recursive: true });
await symlink(process.execPath, path.join(env.HOME, '.local/bin/node'));
const log = await open(path.join(scratch, 'desktop.log'), 'a');
const processes = [];
const launch = (program, args = [], extra = {}) => {
  const child = spawn(program, args, { env, stdio: ['ignore', log.fd, log.fd], ...extra });
  processes.push(child);
  child.on('error', (error) => console.error(error.message));
  return child;
};
let ownedPid;
try {
  const xvfb = launch('Xvfb', ['-displayfd', '3', '-screen', '0', '1600x1100x24', '-nolisten', 'tcp', '-extension', 'GLX'], {
    stdio: ['ignore', log.fd, log.fd, 'pipe'],
  });
  let display = '';
  xvfb.stdio[3].on('data', (chunk) => { display += chunk; });
  await until(() => display.includes('\n'), 'Xvfb display', 10000);
  env.DISPLAY = `:${display.trim()}`;
  const windowExists = () => {
    try { return execFileSync('xwininfo', ['-root', '-tree'], { env, encoding: 'utf8' }).includes('"AgentGlim"'); }
    catch { return false; }
  };
  const app = launch(binary);
  await until(ready, 'AgentGlim HTTP 200');
  await until(windowExists, 'AgentGlim native window');
  const logs = await readFile(path.join(scratch, 'desktop.log'), 'utf8');
  ownedPid = Number(logs.match(/AgentGlim started server pid (\d+)/)?.[1]);
  assert.ok(ownedPid, 'Launcher must report its owned server pid.');
  await delay(10000);
  assert.equal(app.exitCode, null);
  assert.equal(app.signalCode, null);
  assert.ok(await ready());
  assert.ok(windowExists());
  await stop(app);
  await until(async () => !(await listening()), 'owned server stopped', 10000);
  assert.throws(() => process.kill(ownedPid, 0), { code: 'ESRCH' });
  console.log('PASS: minimal PATH discovered user Node; native AgentGlim window and HTTP 200 for 10 seconds; SIGTERM by launcher pid reaped its server.');

  const external = launch(process.execPath, ['--experimental-sqlite', path.join(desktop, 'resources/app/server.mjs'), '18990']);
  await until(ready, 'independent server ready');
  const reused = launch(binary);
  await until(windowExists, 'window using independent server');
  await delay(1000);
  await stop(reused);
  assert.equal(external.exitCode, null);
  assert.ok(await ready());
  assert.match(await readFile(path.join(scratch, 'desktop.log'), 'utf8'), /using the existing server/);
  await stop(external);
  console.log('PASS: closing the app preserved the independently started server.');
  await writeFile(path.join(scratch, 'result.json'), JSON.stringify({ passed: true, aliveSeconds: 10, ownedCleanup: true, existingServerPreserved: true }, null, 2) + '\n');
  console.log(`Smoke-test evidence: ${path.relative(desktop, scratch)}`);
} finally {
  for (const child of processes.reverse()) await stop(child);
  // Emergency cleanup is restricted to the exact child pid recorded by our own launcher.
  if (ownedPid) {
    try { process.kill(ownedPid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  await log.close();
}
