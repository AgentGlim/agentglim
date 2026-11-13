// Shared by the page builder and the single-writer localhost helper.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
export function taskKey(text) {
  return String(text).replace(/, starting with:.*$/s, '').replace(/\s*\(first draft,.*\)$/, '').trim();
}
export function readProgress(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'data/task-progress.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { version: 1, tasks: {} }; throw e; }
}
export function writeProgress(root, store) {
  const file = path.join(root, 'data/task-progress.json');
  fs.writeFileSync(`${file}.next`, JSON.stringify(store, null, 2) + '\n');
  fs.renameSync(`${file}.next`, file);
}
export function setProgress(root, task, status, source = 'owner', evidence = null) {
  if (typeof task !== 'string' || !task.trim() || task.length > 2000 || !['todo', 'started', 'done'].includes(status)) throw new Error('Invalid task or status');
  execFileSync('flock', ['--exclusive', path.join(root, 'data/.task-progress.lock'), process.execPath, fileURLToPath(import.meta.url), root, task, status, source, JSON.stringify(evidence)]);
  return readProgress(root);
}
function mutate(root, task, status, source, evidence) {
  const store = readProgress(root), key = taskKey(task);
  if (source === 'evidence' && store.tasks[key]) return store;
  // Owner choices, including Undo, always override inference.
  store.tasks[key] = { status, source, evidence, updatedAt: new Date().toISOString() };
  writeProgress(root, store);
  return store;
}
export function detectEvidence(root) {
  const file = path.join(root, 'data/task-evidence.json');
  if (!fs.existsSync(file)) return [];
  const rules = JSON.parse(fs.readFileSync(file, 'utf8')).rules, found = [];
  for (const rule of rules) {
    try {
      let proof;
      if (rule.glob) {
        proof = [...fs.globSync(rule.glob, { cwd: root })].find(f => !f.includes('.bak-') && fs.statSync(path.resolve(root, f)).isFile());
      } else if (rule.condition?.type === 'approval-answered') {
        const c = rule.condition, data = JSON.parse(fs.readFileSync(path.resolve(root, c.file), 'utf8'));
        proof = Object.entries(data).find(([id, v]) => id.startsWith(c.keyPrefix) && v.done === true && v.at >= c.since)?.[0];
      } else throw new Error('Unknown evidence rule');
      if (proof) {
        const existing = readProgress(root).tasks[taskKey(rule.task)];
        const applied = !existing;
        if (applied) setProgress(root, rule.task, 'started', 'evidence', proof);
        found.push({ task: rule.task, proof, applied });
      }
    } catch (e) { console.warn(`Task evidence unavailable (${rule.task}): ${e.message}`); }
  }
  return found;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) mutate(process.argv[2], process.argv[3], process.argv[4], process.argv[5], JSON.parse(process.argv[6]));
