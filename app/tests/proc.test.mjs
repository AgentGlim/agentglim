import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { listProcesses, parsePs, parseCim } from '../proc.mjs';

test('ps parser reads state, parent, terminal and quoted arguments', () => {
  const text = `  42 1 S+ ttys001 /usr/bin/node /usr/bin/node "two words" '' --flag
  43 42 Ss ?? /bin/sh /bin/sh -c 'echo hello'
  44 1 Z ? dead
invalid row
`;
  assert.deepEqual(parsePs(text), [
    { pid: 42, ppid: 1, comm: '/usr/bin/node', args: ['/usr/bin/node', 'two words', '', '--flag'], cwd: null, tty: 'ttys001', state: 'S+' },
    { pid: 43, ppid: 42, comm: '/bin/sh', args: ['/bin/sh', '-c', 'echo hello'], cwd: null, tty: 0, state: 'Ss' },
    { pid: 44, ppid: 1, comm: 'dead', args: [], cwd: null, tty: 0, state: 'Z' },
  ]);
});

test('CIM parser reads arrays, Windows paths, quoting and inaccessible command lines', () => {
  const text = String.raw`[
    {"ProcessId":42,"ParentProcessId":1,"Name":"node.exe","CommandLine":"\"C:\\Program Files\\node.exe\" app.mjs \"two words\" \"\" C:\\work\\"},
    {"ProcessId":0,"ParentProcessId":0,"Name":"Idle","CommandLine":null}
  ]`;
  assert.deepEqual(parseCim(text), [
    { pid: 42, ppid: 1, comm: 'node.exe', args: ['C:\\Program Files\\node.exe', 'app.mjs', 'two words', '', 'C:\\work\\'], cwd: null, tty: 0, state: '' },
    { pid: 0, ppid: 0, comm: 'Idle', args: [], cwd: null, tty: 0, state: '' },
  ]);
  assert.deepEqual(parseCim('\uFEFF{"ProcessId":7,"ParentProcessId":1,"Name":"worker.exe"}'), [
    { pid: 7, ppid: 1, comm: 'worker.exe', args: [], cwd: null, tty: 0, state: '' },
  ]);
});

test('parsers tolerate empty, malformed and invalid input', () => {
  for (const input of ['', null, undefined, 42, {}, 'garbage']) {
    assert.deepEqual(parsePs(input), []);
    assert.deepEqual(parseCim(input), []);
  }
  for (const input of ['null', '[]', '{}', '[null,{}, {"ProcessId":"bad"}]']) {
    assert.deepEqual(parseCim(input), []);
  }
});

// The live scan needs this machine's real procfs: not on macOS/Windows, not with a fixture
// root (AGENTGLIM_PROC) and not inside an empty bwrap $TMPDIR /proc. The fixture-tree test
// below covers the same parsing on every platform.
const liveProc = process.platform === 'linux' && !process.env.AGENTGLIM_PROC && fs.existsSync('/proc/self/stat');
test('Linux process scan finds this process with native argv and cwd', { skip: !liveProc && 'live procfs scan (fixture test: a proc fixture tree yields pids, stat, cmdline and environ)' }, () => {
  const self = listProcesses().find(row => row.pid === process.pid);
  assert.ok(self);
  assert.equal(self.ppid, process.ppid);
  assert.equal(self.args[0], process.execPath);
  assert.equal(path.resolve(self.args.at(-1)), process.argv[1]);
  assert.equal(self.cwd, process.cwd());
  assert.equal(typeof self.tty, 'number');
  assert.match(self.state, /^[A-Z]$/);
  assert.ok(self.comm);
});


test('Windows CIM refresh is nonblocking, shared, refreshed and cleared on failure', async () => {
  const { createWindowsProcessLister } = await import('../proc.mjs');
  let time = 0, calls = 0, complete;
  const list = createWindowsProcessLister({ now: () => time, run(command, args, options, callback) {
    assert.equal(command, 'powershell.exe');
    assert.ok(args.includes('-NoProfile'));
    assert.equal(options.timeout, 10000);
    calls++;
    complete = callback; // Simulate PowerShell still running while HTTP starts.
  } });
  assert.deepEqual(list(), []);
  assert.deepEqual(list(), []);
  assert.equal(calls, 1, 'one query in flight across all readers');
  complete(null, '{"ProcessId":7,"ParentProcessId":1,"Name":"node.exe"}');
  assert.equal(list()[0].pid, 7, 'completed CIM data becomes visible');
  assert.equal(calls, 1);
  time = 5000;
  assert.equal(list()[0].pid, 7);
  assert.equal(calls, 2, 'expired snapshots refresh asynchronously');
  complete(new Error('PowerShell unavailable'));
  assert.deepEqual(list(), [], 'failed refresh cannot retain dead processes');
  assert.equal(calls, 2, 'failed queries also have a retry delay');
  time = 10000;
  list();
  assert.equal(calls, 3);
  complete(null, '[]');
});

// One proc-root switch (R9.1): the readers below take a fixture tree through AGENTGLIM_PROC, so
// the same parsing test runs on Linux, macOS and Windows. None of them may throw without a root.
import fs from 'node:fs';
import os from 'node:os';
import { procRoot, readProcText, listPids, readStat, readCmdline, readCwd, readEnviron, readFdLinks, listFromProcTree, readMemoryInfo, pidAlive } from '../proc.mjs';

function fixtureTree(t, { cwdTarget } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-proc-tree-'));
  t.after(() => { if (process.env.AGENTGLIM_PROC === root) delete process.env.AGENTGLIM_PROC; fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, '42', 'fd'), { recursive: true });
  fs.writeFileSync(path.join(root, 'uptime'), '9000 1000\n');
  fs.writeFileSync(path.join(root, 'locks'), '1: POSIX  ADVISORY  WRITE 7 00:1a:2 0 EOF\n');
  const fields = Array(50).fill('0'); fields[0] = 'S'; fields[1] = '1'; fields[4] = '0'; fields[19] = '777';
  fs.writeFileSync(path.join(root, '42', 'stat'), `42 (node worker) ${fields.join(' ')}`);
  fs.writeFileSync(path.join(root, '42', 'cmdline'), 'node\0worker.js\0');
  fs.writeFileSync(path.join(root, '42', 'environ'), 'CLAUDE_CODE_X=1\0');
  if (cwdTarget) fs.symlinkSync(cwdTarget, path.join(root, '42', 'cwd'), process.platform === 'win32' ? 'junction' : 'dir');
  process.env.AGENTGLIM_PROC = root;
  return root;
}

test('a proc fixture tree yields pids, stat, cmdline and environ on every platform', (t) => {
  const root = fixtureTree(t);
  assert.equal(procRoot(), root);
  assert.deepEqual(listPids(), ['42']);
  const st = readStat(42);
  assert.equal(st.comm, 'node worker');
  assert.equal(st.state, 'S');
  assert.equal(st.ppid, 1);
  assert.equal(st.starttime, 777);
  assert.deepEqual(readCmdline(42), ['node', 'worker.js']);
  assert.deepEqual(readEnviron(42), ['CLAUDE_CODE_X=1']);
  assert.equal(readProcText('locks').includes('POSIX'), true);
  // A fixture tree wins over the platform's own lister, so this parsing test is identical everywhere.
  const row = listProcesses().find((r) => r.pid === 42);
  assert.ok(row, 'listProcesses reads the fixture tree');
  assert.equal(row.comm, 'node worker');
  assert.deepEqual(row.args, ['node', 'worker.js']);
  assert.equal(typeof listFromProcTree()[0].tty, 'number');
});

test('cwd and fd link readers return the target or null, never a live /proc read', (t) => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-proc-cwd-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  const root = fixtureTree(t, { cwdTarget: target });
  assert.equal(fs.realpathSync(readCwd(42)), fs.realpathSync(target));
  fs.writeFileSync(path.join(root, '42', 'fd', '3'), '');
  // Procfs link text cannot be created on Windows without privileges; inject it instead.
  const readlink = fs.readlinkSync;
  t.mock.method(fs, 'readlinkSync', (file, ...args) => String(file).endsWith(path.join('42', 'fd', '3')) ? '/tmp/held.jsonl' : readlink(file, ...args));
  assert.deepEqual(readFdLinks(42), ['/tmp/held.jsonl']);
  assert.equal(fs.realpathSync(readCwd(42)), fs.realpathSync(target), 'a mocked fd link does not change the cwd target');
});

test('no proc root: every reader returns empty and never throws (a machine without /proc)', () => {
  const saved = process.env.AGENTGLIM_PROC;
  process.env.AGENTGLIM_PROC = path.join(os.tmpdir(), `ag-no-proc-${process.pid}`);
  try {
    assert.deepEqual(listPids(), []);
    assert.equal(readStat(process.pid), null);
    assert.deepEqual(readCmdline(process.pid), []);
    assert.equal(readCwd(process.pid), null);
    assert.deepEqual(readEnviron(process.pid), []);
    assert.deepEqual(readFdLinks(process.pid), []);
    assert.equal(readProcText('meminfo'), null);
    assert.deepEqual(listFromProcTree(), []);
    assert.deepEqual(listProcesses(), []);
    assert.throws(() => readMemoryInfo(), /unavailable/);
  } finally {
    if (saved === undefined) delete process.env.AGENTGLIM_PROC; else process.env.AGENTGLIM_PROC = saved;
  }
});

test('liveness asks the OS, so it works without a proc root', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive('not-a-pid'), false);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(2 ** 31 - 1), false);
});
