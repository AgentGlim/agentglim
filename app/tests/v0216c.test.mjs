// v0.2.16 review fixes: Windows imports and npm shims, process-tree timeouts, dotfile-proof heartbeats, the header dot
// for turn-based SuperAgents, degraded worker tracking, doctor's permission and tracking checks, the SECURITY note.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { cliCommand, findBinary } from '../cli-spawn.mjs';
import { runProcess, codexTurnArgs, claudeTurnArgs } from '../send-to-agent.mjs';
import { superagentBeat } from '../watchers.mjs';
import { watcherSnapshot } from '../heartbeats.mjs';
import { register } from '../turn-delivery.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v0216c-'));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const posixOnly = process.platform === 'win32' && 'POSIX process groups';

test('first-run imports app modules by file URL, never a bare (Windows drive) path', () => {
  const src = fs.readFileSync(path.join(REPO, 'tools/first-run.mjs'), 'utf8');
  assert.doesNotMatch(src, /import\(`\$\{/, 'no template-path dynamic imports');
  assert.match(src, /pathToFileURL\(path\.join\(APP, name\)\)\.href/);
  for (const f of ['tools', 'app', 'harness/bin'].flatMap((d) => fs.readdirSync(path.join(REPO, d)).filter((n) => n.endsWith('.mjs')).map((n) => path.join(REPO, d, n))))
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /await import\(`\$\{(APP|HERE|ROOT)/, f);
});

test('Windows npm shims run through cmd.exe /d /s /c with quoted args; cmd-expandable args are refused', () => {
  const resolve = (b) => `C:\\npm-global\\${b}.cmd`;
  const c = cliCommand('codex', ['exec', '-C', 'C:\\work dir', 'resume', 'abc-123', '-'], { platform: 'win32', env: {}, resolve });
  assert.equal(c.cmd, 'cmd.exe'); assert.deepEqual(c.args.slice(0, 3), ['/d', '/s', '/c']); assert.equal(c.verbatim, true);
  assert.equal(c.args[3], '""C:\\npm-global\\codex.cmd" "exec" "-C" "C:\\work dir" "resume" "abc-123" "-""');
  assert.throws(() => cliCommand('pi', ['-p', '100% sure'], { platform: 'win32', env: {}, resolve }), /no %, " or newlines/);
  assert.throws(() => cliCommand('pi', ['a\nb'], { platform: 'win32', env: {}, resolve }), /put it in a file/);
  assert.equal(cliCommand('codex', ['x'], { platform: 'win32', env: {}, resolve: () => 'C:\\bin\\codex.exe' }).cmd, 'C:\\bin\\codex.exe');
  assert.deepEqual(cliCommand('codex', ['x'], { platform: 'linux' }), { cmd: 'codex', args: ['x'], shim: false });
  // the deps.mjs resolver is this one (PATHEXT), including absolute paths without an extension
  assert.equal(findBinary('C:\\tools\\pi', { platform: 'win32', env: { PATHEXT: '.EXE;.CMD' }, exists: (f) => f === 'C:\\tools\\pi.CMD' }), 'C:\\tools\\pi.CMD');
  for (const f of ['app/send-to-agent.mjs', 'harness/bin/worker-launch.mjs']) assert.match(fs.readFileSync(path.join(REPO, f), 'utf8'), /spawnCli\(/, f);
  assert.match(fs.readFileSync(path.join(REPO, 'app/deps.mjs'), 'utf8'), /from '\.\/cli-spawn\.mjs'/);
});

// a CLI that starts a grandchild and hangs; both pids are printed first
function treeBin(dir) {
  const f = path.join(dir, 'tree.js');
  fs.writeFileSync(f, `const { spawn } = require('child_process');
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e3)'], { stdio: 'ignore' });
require('fs').writeFileSync(process.argv[2], JSON.stringify({ child: process.pid, grandchild: g.pid }));
setInterval(() => {}, 1e3);`);
  return f;
}

test('send-to-agent timeout kills and awaits the whole process tree before it returns', { skip: posixOnly }, async () => {
  const dir = tmp(), pids = path.join(dir, 'pids.json');
  const r = await runProcess(process.execPath, [treeBin(dir), pids], '', { timeoutMs: 800, graceMs: 500 });
  assert.equal(r.code, -1); assert.equal(r.timedOut, true); assert.match(r.out, /timed out/);
  const p = JSON.parse(fs.readFileSync(pids, 'utf8'));
  for (let i = 0; i < 20 && alive(p.grandchild); i++) await new Promise((res) => setTimeout(res, 50));
  assert.equal(alive(p.child), false, 'child still running'); assert.equal(alive(p.grandchild), false, 'grandchild still running');
});

test('worker-launch timeout kills the grandchild too; pi/opencode prompts are a file reference after --', { skip: posixOnly }, () => {
  const dir = tmp(), pids = path.join(dir, 'pids.json'), out = path.join(dir, 'out'), pf = path.join(dir, 'p.md');
  fs.writeFileSync(pf, '--- front matter that looks like an option\n' + 'y'.repeat(200000));
  const bin = path.join(dir, 'fake-claude'); fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${treeBin(dir)}" "${pids}"\n`, { mode: 0o755 });
  const env = { PATH: process.env.PATH, HOME: dir, AGENTGLIM_CLAUDE_BIN: bin, AGENTGLIM_JOBS_TRACK: 'none' };
  // 3 s, not 1: on a loaded macOS runner node took over a second to start the fake and write pids.json (local CI)
  const r = spawnSync(process.execPath, [path.join(REPO, 'harness/bin/worker-launch.mjs'), 'claude', dir, pf, out, '3', 'low'], { env, encoding: 'utf8', timeout: 30e3 });
  assert.equal(r.status, 124, r.stderr);
  const p = JSON.parse(fs.readFileSync(pids, 'utf8'));
  assert.equal(alive(p.grandchild), false, 'grandchild survived the timeout');
  const dry = spawnSync(process.execPath, [path.join(REPO, 'harness/bin/worker-launch.mjs'), 'pi', dir, pf, path.join(dir, 'o2'), '5', 'low', '--dry-run'], { env, encoding: 'utf8' });
  const cmd = JSON.parse(dry.stdout).cmd; assert.equal(cmd.at(-2), '--'); assert.ok(cmd.at(-1).length < 8000); assert.match(cmd.at(-1), /^Read the file .*p\.md/);
});

test('worker tracking failure is reported as degraded, never silent', () => {
  const dir = tmp(), out = path.join(dir, 'out'), pf = path.join(dir, 'p.md'); fs.writeFileSync(pf, 'job');
  // Windows starts neither extensionless script: the CLI is a .cmd shim (found through PATHEXT), and node itself is
  // a jobs-track that exits non-zero there (`node start ...` finds no module named start)
  const win = process.platform === 'win32', bin = path.join(dir, 'fake-codex');
  if (win) fs.writeFileSync(`${bin}.cmd`, '@echo done\r\n'); else fs.writeFileSync(bin, '#!/bin/sh\ncat >/dev/null\necho done\n', { mode: 0o755 });
  const failing = win ? process.execPath : path.join(dir, 'jt-fail'); if (!win) fs.writeFileSync(failing, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  const r = spawnSync(process.execPath, [path.join(REPO, 'harness/bin/worker-launch.mjs'), 'codex', dir, pf, out, '20', 'low'],
    { env: { PATH: process.env.PATH, HOME: dir, AGENTGLIM_CODEX_BIN: bin, AGENTGLIM_JOBS_TRACK: failing }, encoding: 'utf8', timeout: 30e3 });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stderr, /tracking degraded: jobs-track start failed/);
  assert.match(JSON.parse(r.stdout.trim().split('\n').pop()).tracking, /degraded/);
  assert.match(JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8')).tracking, /will not show in the dashboard/);
  const skill = fs.readFileSync(path.join(REPO, 'skills/agentglim-setup/SKILL.md'), 'utf8');
  assert.doesNotMatch(skill, /needs only bash and node/); assert.match(skill, /Python 3/); assert.match(skill, /node <run>\/bin\/worker-launch\.mjs/);
});

test('heartbeat readers skip dotfiles, so doctor never arms the dashboard', () => {
  const home = tmp(), data = path.join(home, 'data'), plans = path.join(home, 'plans'), run = path.join(plans, '_run');
  fs.mkdirSync(path.join(run, 'heartbeats'), { recursive: true }); fs.mkdirSync(path.join(data, 'heartbeats'), { recursive: true });
  fs.writeFileSync(path.join(data, 'heartbeats', '.doctor-last'), 'ok'); fs.writeFileSync(path.join(run, 'heartbeats', '.doctor-last'), 'ok');
  assert.equal(superagentBeat({ data, run }), null);
  const r = spawnSync(process.execPath, [path.join(REPO, 'tools/first-run.mjs'), 'doctor', '--json'],
    { env: { PATH: process.env.PATH, HOME: home, AGENTGLIM_DATA: data, AGENTGLIM_PLANS: plans, AGENTGLIM_URL: 'http://127.0.0.1:9', AGENTGLIM_JOBS_TRACK: 'none' }, encoding: 'utf8', timeout: 60e3 });
  const j = JSON.parse(r.stdout); const by = Object.fromEntries(j.checks.map((c) => [c.id, c]));
  assert.equal(by['heartbeat-write'].ok, true); assert.equal(by['run-write'].ok, true);
  assert.equal(superagentBeat({ data, run }), null, 'doctor left a file a heartbeat reader counts');
  assert.equal(watcherSnapshot({ data, run }).armed, false);
  assert.equal(by['worker-tracking'].ok, false); assert.equal(by['worker-tracking'].warn, true); assert.match(by['worker-tracking'].detail, /no Python 3/);
});

test('doctor: turn session is not healthy until answered, and checks the resume sandbox arguments', () => {
  const home = tmp(), data = path.join(home, 'data'), plans = path.join(home, 'plans');
  register({ data, harness: 'codex', session: 'cdx-session-1', cwd: home });
  const run = (extra = {}) => { const r = spawnSync(process.execPath, [path.join(REPO, 'tools/first-run.mjs'), 'doctor', '--json'],
    { env: { PATH: process.env.PATH, HOME: home, AGENTGLIM_DATA: data, AGENTGLIM_PLANS: plans, AGENTGLIM_URL: 'http://127.0.0.1:9', AGENTGLIM_JOBS_TRACK: 'none', ...extra }, encoding: 'utf8', timeout: 60e3 });
    return Object.fromEntries(JSON.parse(r.stdout).checks.map((c) => [c.id, c])); };
  let by = run();
  assert.equal(by.listener.ok, false); assert.match(by.listener.detail, /no answered request yet/); assert.match(by.listener.fix, /click Refresh/);
  assert.equal(by['superagent-heartbeat'].ok, false);
  assert.equal(by['turn-permissions'].ok, true); assert.match(by['turn-permissions'].detail, /workspace-write/);
  by = run({ AGENTGLIM_SEND_CODEX_ARGS: '["--model","o5"]' });
  assert.equal(by['turn-permissions'].ok, false); assert.match(by['turn-permissions'].fix, /workspace-write/);
  // the defaults themselves
  const a = codexTurnArgs({ data: '/d', runDir: '/r' }); for (const x of ['-s', 'workspace-write', '--add-dir', '/d', '/r']) assert.ok(a.includes(x), x);
  assert.deepEqual(codexTurnArgs({ data: '/d', codexArgs: ['--x'] }), ['--x'], 'AGENTGLIM_SEND_CODEX_ARGS replaces the defaults');
  const c = claudeTurnArgs({ data: '/d', runDir: '/r' }), tool = path.join('/r', 'bin', 'status-write.mjs').replace(/[\\/.]/g, '\\$&');
  assert.match(c[c.indexOf('--allowedTools') + 1], new RegExp(`Bash\\(node ${tool}:\\*\\),.*chat-write.*owner-check`));
  const setup = fs.readFileSync(path.join(REPO, 'SETUP.md'), 'utf8'); assert.match(setup, /AGENTGLIM_SEND_CODEX_ARGS/); assert.match(setup, /Git\s+Bash/); // \r\n in a Windows checkout
});

// page level: run the real flagsAndLog from index.html against a fake DOM
function headerDot(watchers) {
  const html = fs.readFileSync(path.join(REPO, 'app/index.html'), 'utf8').replace(/\r\n/g, '\n'); // CRLF in a Windows checkout
  const start = html.indexOf('function flagsAndLog(s)'), end = html.indexOf('\n}\n', start) + 3;
  const els = {};
  const el = (id) => els[id] ||= { id, className: '', title: '', textContent: '', innerHTML: '', parentNode: { append: (c) => { els[c.id] = c; } }, remove() { delete els[this.id]; }, style: {}, firstChild: {}, querySelector: () => ({ dataset: {} }) };
  const document = { createElement: () => { const e = el('_new'); delete els._new; return e; } };
  vm.runInNewContext(`${html.slice(start, end)}\nflagsAndLog(s)`, { s: { watchers, now: Date.now(), log: [], driverAlive: true }, $: (id) => (id === 'armCopy' ? els.armCopy || null : el(id)), document, foldMini: () => {}, esc: String, Date, Math, navigator: {}, setTimeout });
  return { live: els.live, copy: els.armCopy || null };
}

test('page: the header dot follows a verified turn session and hides the listener notice; red when it fails', () => {
  const home = tmp(), data = path.join(home, 'data'), run = path.join(home, 'run');
  fs.mkdirSync(path.join(run, 'bin'), { recursive: true }); fs.writeFileSync(path.join(run, 'bin', 'auditq-wait.sh'), '');
  register({ data, harness: 'codex', session: 'cdx-session-2', cwd: home });
  const st = path.join(data, 'turn-delivery', 'state.json'), s0 = JSON.parse(fs.readFileSync(st, 'utf8'));
  // registered, nothing answered: red, and the listener notice is not shown (the turn session replaces it)
  let w = watcherSnapshot({ data, run }); assert.equal(w.armed, false); assert.ok(w.turn);
  let d = headerDot(w); assert.match(d.live.className, /off/); assert.match(d.live.title, /no answered request yet/); assert.equal(d.copy, null);
  fs.writeFileSync(st, JSON.stringify({ ...s0, lastAnsweredAt: new Date().toISOString() }));
  w = watcherSnapshot({ data, run }); assert.equal(w.armed, true, 'snapshot carries the turn arming'); assert.equal(w.superagent.ok, false);
  d = headerDot(w); assert.equal(d.live.className, 'live'); assert.match(d.live.title, /^Armed\. turn-based delivery to codex/); assert.equal(d.copy, null);
  fs.writeFileSync(st, JSON.stringify({ ...s0, lastAnsweredAt: new Date().toISOString(), fails: 1, last: { at: new Date().toISOString(), state: 'failed', reason: 'codex exec resume failed: boom' } }));
  d = headerDot(watcherSnapshot({ data, run })); assert.match(d.live.className, /off/); assert.match(d.live.title, /boom/);
  // no turn session and a silent listener: the notice still appears
  const home2 = tmp(), run2 = path.join(home2, 'run'); fs.mkdirSync(path.join(run2, 'bin'), { recursive: true }); fs.writeFileSync(path.join(run2, 'bin', 'auditq-wait.sh'), '');
  d = headerDot(watcherSnapshot({ data: path.join(home2, 'data'), run: run2 })); assert.ok(d.copy, 'listener notice shown without a turn session');
});

test('SECURITY note: dashboard chat now reaches a headless agent', () => {
  const s = fs.readFileSync(path.join(REPO, 'SECURITY.md'), 'utf8');
  assert.match(s, /headless/); assert.match(s, /turn-delivery/); assert.match(s, /unregister/);
});
