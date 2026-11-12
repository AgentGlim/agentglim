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

test('Linux process scan finds this process with native argv and cwd', { skip: process.platform !== 'linux' }, () => {
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

