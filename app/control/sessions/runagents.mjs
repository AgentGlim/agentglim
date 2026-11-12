// Run agents started by the plans driver: <PLANS_DIR>/NN-*/_build/**/{pid,meta}, plus the feature loop and goal
// runners (<PLANS_DIR>/NN-*/_build/features/loop-state.json, _build/goal/state.json). Read-only.
import fs from 'node:fs';
import path from 'node:path';

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

// role from the job dir under _build (same split as the Observatory's roleOf)
export function roleOfRel(rel) {
  const p = rel.split('/');
  const step = p[0] || '';
  if (step === 'p1') return { step, role: 'p1', task: 'write plan' };
  if (p[1] === 'orch') return { step, role: 'orchestrator', task: `round ${step}` };
  if (p[1] === 'audit' || /audit/.test(p.at(-1) || '')) return { step, role: 'audit', task: rel };
  if (p[1] === 'workers' || /worker/.test(p.at(-1) || '')) return { step, role: 'worker', task: p[2] || rel };
  if (step === 'goal') return { step, role: 'goal', task: rel };
  if (step === 'features') return { step, role: 'feature-loop', task: p.slice(1).join('/') };
  return { step, role: 'run-agent', task: rel };
}

export function parseMeta(text) {
  const m = { started: null, kind: null, effort: null, ended: null, cwd: null };
  for (const l of text.split('\n')) {
    let x;
    if ((x = l.match(/ start kind=(\S+)/))) { m.started = m.started || Date.parse(l.slice(0, 19).replace(' ', 'T')); m.kind = x[1]; m.effort = (l.match(/ effort=(\S+)/) || [])[1] || null; m.cwd = (l.match(/ cwd=(\S+)/) || [])[1] || null; }
    else if ((x = l.match(/ end kind=(\S+)/))) m.ended = Date.parse(l.slice(0, 19).replace(' ', 'T'));
  }
  return m;
}

export const harnessOfKind = (kind) => !kind ? 'claude' : /^(codex|luna|sol|gpt)/.test(kind) ? 'codex' : /^(pi|strata)/.test(kind) ? 'pi' : /^(zen:|go|opencode)/.test(kind) ? 'opencode' : /^agy:/.test(kind) ? 'antigravity' : 'claude';
export const modelOfKind = (kind) => ({ opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1' })[kind] || kind || null;

export function scanRunAgents(plansDir, { maxDepth = 5 } = {}) {
  const out = [];
  let plans = []; try { plans = fs.readdirSync(plansDir).filter((d) => /^\d\d-[\w.-]+$/.test(d)); } catch { return out; }
  for (const plan of plans) {
    const root = path.join(plansDir, plan, '_build');
    const walk = (dir, depth) => {
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      const names = new Set(ents.map((e) => e.name));
      if (names.has('pid') && names.has('meta')) {
        const meta = parseMeta(read(path.join(dir, 'meta')));
        const pid = Number(read(path.join(dir, 'pid')).trim());
        if (pid > 1 && !meta.ended && !names.has('rc')) {
          const rel = path.relative(root, dir);
          out.push({ source: 'run', plan, dir, rel, pid, ...roleOfRel(rel), kind: meta.kind, harness: harnessOfKind(meta.kind), model: modelOfKind(meta.kind), effort: meta.effort, started: meta.started, cwd: meta.cwd });
        }
      }
      if (depth >= maxDepth) return;
      for (const e of ents) if (e.isDirectory() && !['session', 'tasks', 'node_modules', '.git'].includes(e.name)) walk(path.join(dir, e.name), depth + 1);
    };
    walk(root, 0);
    for (const [file, role] of [[path.join(root, 'features', 'loop-state.json'), 'feature-loop'], [path.join(root, 'goal', 'state.json'), 'goal']]) {
      let s; try { s = JSON.parse(read(file)); } catch { continue; }
      if (!s || s.status !== 'running' || !(s.pid > 1)) continue;
      out.push({ source: role, plan, dir: path.dirname(file), rel: path.relative(root, path.dirname(file)), pid: Number(s.pid), pgid: Number(s.pgid) || null, step: s.step || null, role,
        task: [s.feature, s.round ? `r${s.round}` : null, s.step].filter(Boolean).join(' '), kind: s.model || null, harness: harnessOfKind(s.model), model: modelOfKind(s.model), effort: s.effort || null, started: s.started || null });
    }
  }
  return out;
}
