// One Python launcher for the app's own Python add-ons (jobs-track reap, the Skill Editor server).
// Windows machines often have no `python3` on PATH, so the order is python3 -> python -> the
// `py -3` launcher. Callers pass the chosen command and its leading arguments to execFile/spawn.
import { spawnSync } from 'node:child_process';

export const PYTHON_CANDIDATES = [['python3', []], ['python', []], ['py', ['-3']]];

const starts = (name, args) => {
  try { return spawnSync(name, [...args, '--version'], { stdio: 'ignore', timeout: 5000, windowsHide: true }).status === 0; } catch { return false; }
};

// First candidate that starts. When none does, python3 (the error then names the common case).
// `spawn` is injectable, so the order is unit-tested without a real Python.
export function resolvePython({ candidates = PYTHON_CANDIDATES, spawn = starts } = {}) {
  for (const [name, args] of candidates) if (spawn(name, args)) return [name, args];
  return candidates[0];
}

let chosen;
// Cached per process: the probe costs a fork, and the answer does not change while the app runs.
export function python() {
  return (chosen ||= resolvePython());
}

// Tests only: forget the cached launch command.
export function resetPythonCache() {
  chosen = undefined;
}
