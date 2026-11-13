// watchers.mjs: the SuperAgent watcher state behind the dashboard header dot.
//
// A plans-harness install can ship two watcher scripts in `_run/bin`: the queue listener (`auditq-wait.sh`) and the
// 30-minute check (`superagent-check.sh`). A heartbeat file per script says whether that watcher is armed. Only the
// scripts actually installed are reported, so a missing script never shows up as a watcher that is off forever.
//
// Every other install (and any harness folder without those scripts) has one SuperAgent heartbeat instead: the
// private `$DATA/heartbeats/*` file (or the harness's own heartbeats folder) that SETUP.md and AGENTS.md tell any
// SuperAgent, Codex included, to touch while supervising. Reporting the two harness scripts there named things a
// new user never had and could not arm, so the dot stayed off with "last beat never" whatever the user's agent did.
import fs from 'node:fs';
import path from 'node:path';

export const STALE_MIN = { queue: 10, check: 45, superagent: 45 };
export const HEARTBEAT_MS = STALE_MIN.superagent * 60e3;
const SCRIPTS = { queue: 'auditq-wait.sh', check: 'superagent-check.sh' };

const mtime = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return null; } };
const newest = (files) => files.reduce((at, f) => { const t = mtime(f); return t && t > (at || 0) ? t : at; }, null);
const filesIn = (dir) => { try { return fs.readdirSync(dir).map((n) => path.join(dir, n)); } catch { return []; } };

export function harnessInstalled(run, exists = fs.existsSync) {
  return Object.values(SCRIPTS).some((n) => exists(path.join(run, 'bin', n)));
}

// newest SuperAgent heartbeat from any source a private install can have: the data heartbeats folder, the harness
// heartbeats folder, the audit queue's .alive (older watchers touch only that), or the Codex watcher bridge's
// health file (python writes seconds; an errored bridge does not count)
export function superagentBeat({ data, run } = {}) {
  let at = newest([...filesIn(path.join(data, 'heartbeats')), ...filesIn(path.join(run, 'heartbeats')), path.join(run, 'audit_queue', '.alive')]);
  try {
    const h = JSON.parse(fs.readFileSync(path.join(run, 'flags', 'watcher-bridge-health.json'), 'utf8'));
    let t = typeof h.at === 'number' ? h.at : Date.parse(h.heartbeat || h.at || h.updated || '');
    if (t && t < 1e12) t *= 1000;
    if (!h.error && t) at = at == null ? t : Math.max(at, t);
  } catch {}
  return at;
}

export function watcherState({ data, run, now = Date.now(), exists = fs.existsSync } = {}) {
  const entry = (at, min) => ({ at, ok: !!at && now - at < min * 60e3, maxMin: min });
  const installed = Object.entries(SCRIPTS).filter(([, n]) => exists(path.join(run, 'bin', n)));
  if (!installed.length) return { kind: 'superagent', superagent: entry(superagentBeat({ data, run }), STALE_MIN.superagent) };
  const out = { kind: 'harness' };
  for (const [name] of installed) out[name] = name === 'queue'
    ? entry(newest([path.join(run, 'heartbeats', 'auditq-wait'), path.join(run, 'audit_queue', '.alive')]), STALE_MIN.queue)
    : entry(newest([path.join(run, 'heartbeats', 'superagent-check')]), STALE_MIN.check);
  return out;
}
