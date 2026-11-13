import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const BASE = process.env.TEST_SCRATCH_ARCHIVE || path.join(os.homedir(), 'dev/projects/plans/_reports/test-scratch-archive');
export function archiveScratch(dir, state, name, error = null) {
  if (!fs.existsSync(dir)) return;
  const root = path.join(BASE, state); fs.mkdirSync(root, { recursive: true });
  const dest = path.join(root, `${path.basename(dir)}-${Date.now()}-${process.pid}`);
  const result = spawnSync('mv', ['--', dir, dest], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Scratch archive failed; original kept: ${dir}: ${result.stderr}`);
  fs.writeFileSync(path.join(dest, 'TEST-RESULT.json'), JSON.stringify({ name, state, source: dir, error: error?.stack || null }, null, 2)+'\n');
}
export function scratch(t, prefix = 'test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => archiveScratch(dir, t.passed ? 'passed' : 'failed', t.name, t.error));
  return dir;
}
