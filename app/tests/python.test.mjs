// Cross-platform Python launch: the app's own add-ons must not require `python3` on Windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PYTHON_CANDIDATES, resetPythonCache, resolvePython } from '../python.mjs';

const probe = (available) => {
  const calls = [];
  const spawn = (name, args) => { calls.push([name, ...args]); return available.includes(name); };
  return { calls, spawn };
};

test('python launcher tries python3, then python, then the Windows py -3 launcher', () => {
  assert.deepEqual(PYTHON_CANDIDATES.map(([name, args]) => [name, args.join(' ')]), [
    ['python3', ''], ['python', ''], ['py', '-3'],
  ]);
  const all = probe(['python3', 'python', 'py']);
  assert.deepEqual(resolvePython({ spawn: all.spawn }), ['python3', []]);
  assert.deepEqual(all.calls, [['python3']], 'a working python3 is probed first and wins');
  // A Windows runner usually has `python` but no `python3`.
  const win = probe(['python', 'py']);
  assert.deepEqual(resolvePython({ spawn: win.spawn }), ['python', []]);
  assert.deepEqual(win.calls, [['python3'], ['python']]);
  // Only the launcher: `py -3`.
  const launcher = probe(['py']);
  assert.deepEqual(resolvePython({ spawn: launcher.spawn }), ['py', ['-3']]);
  assert.deepEqual(launcher.calls.at(-1), ['py', '-3']);
  // Nothing starts: python3 is returned so the caller's error names the common case.
  const none = probe([]);
  assert.deepEqual(resolvePython({ spawn: none.spawn }), ['python3', []]);
  assert.deepEqual(none.calls.map((c) => c[0]), ['python3', 'python', 'py']);
  resetPythonCache();
});
