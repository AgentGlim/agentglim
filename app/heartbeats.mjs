// heartbeats.mjs: one reader for SuperAgent heartbeats, shared by the dashboard header dot, the
// /api/portable banner and the Harness page, so a beat that one surface sees is never "never" on another.
//
// The documented place for a SuperAgent to touch is the private data folder: <data>/heartbeats/superagent
// (AGENTS.md step 5, SETUP.md "SuperAgent and refresh"). A plans harness that ships its watcher scripts also
// touches <run>/heartbeats/auditq-wait (every 15 s while armed), <run>/heartbeats/superagent-check (each
// 30-minute check) and <run>/audit_queue/.alive. A fresh install may have no harness at all: then only the
// private heartbeat exists and it is the signal the dashboard must show.
import fs from 'node:fs';
import path from 'node:path';
import { watcherState, superagentBeat } from './watchers.mjs'; // installed-script check and the broad beat reader

export const SUPERAGENT_MAX_MIN = 45; // same window as portable.watcherActive: the banner's "no heartbeat"
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return null; } };
const newest = (files) => files.reduce((at, f) => { const t = mtime(f); return t != null ? Math.max(at || 0, t) : at; }, null);
const beat = (at, maxMin, now) => ({ at, ok: !!at && now - at < maxMin * 60e3, maxMin });

// The SuperAgent heartbeat, from the private data folder and (for older harnesses) the run heartbeat folder.
// The broad reader (watchers.superagentBeat) is the one source of truth: it also accepts any file in a heartbeats
// folder, the audit queue's .alive and a healthy Codex bridge, so the header dot agrees with the portable banner.
export function superagentView({ data, run, now = Date.now() } = {}) {
  return beat(superagentBeat({ data, run }), SUPERAGENT_MAX_MIN, now);
}

// What the dashboard header dot and the Harness page read. `harness` says whether a plans harness is present:
// without one, the queue watcher and the 30-minute check cannot run and must not be reported as "off".
export function watchersView({ data, run, now = Date.now() } = {}) {
  const inRun = (name) => (run ? [path.join(run, 'heartbeats', name)] : []);
  const queue = run ? [...inRun('auditq-wait'), path.join(run, 'audit_queue', '.alive')] : [];
  return {
    superagent: superagentView({ data, run, now }),
    queue: beat(newest(queue), 10, now),
    check: beat(newest(inRun('superagent-check')), 45, now),
    harness: !!run && fs.existsSync(run),
  };
}

// What /api/snapshot sends as `watchers` (the header dot, and the phone/app views). The watchers fix decides
// which harness watchers are actually installed; this adds the generic SuperAgent heartbeat and whether a
// plans harness exists at all, so neither a fresh install nor a harness install loses a beat it really has.
export function watcherSnapshot({ data, run, now = Date.now(), exists = fs.existsSync } = {}) {
  return {
    ...watcherState({ data, run, now, exists }),
    superagent: superagentView({ data, run, now }),
    harness: !!run && exists(run),
  };
}
