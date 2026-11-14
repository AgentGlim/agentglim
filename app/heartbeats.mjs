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
import { AGENTGLIM_ROOT } from './settings.mjs';
import { shellQuote } from './paths.mjs';

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

// What the dashboard header dot and the Harness page read. `armed` is the SuperAgent's own heartbeat only: the
// queue watcher and the 30-minute check are extra information when a plans harness is present, and are never
// demanded from an install that has none.
export function watchersView({ data, run, now = Date.now() } = {}) {
  const inRun = (name) => (run ? [path.join(run, 'heartbeats', name)] : []);
  const queue = run ? [...inRun('auditq-wait'), path.join(run, 'audit_queue', '.alive')] : [];
  const superagent = superagentView({ data, run, now });
  return {
    superagent,
    armed: superagent.ok,
    queue: beat(newest(queue), 10, now),
    check: beat(newest(inRun('superagent-check')), 45, now),
    harness: !!run && fs.existsSync(run),
  };
}

// What /api/snapshot sends as `watchers` (the header dot, and the phone/app views). The watchers fix decides
// which harness watchers are actually installed; this adds the generic SuperAgent heartbeat and whether a
// plans harness exists at all, so neither a fresh install nor a harness install loses a beat it really has.
export function startupInfo({ data, run, root = AGENTGLIM_ROOT } = {}) {
  const command = process.platform === 'win32' ? `node "${path.join(run || '', 'bin', 'auditq-wait.mjs')}"` : `bash ${shellQuote(path.join(run || '', 'bin', 'auditq-wait.sh'))}`;
  const heartbeat = path.join(data || '', 'heartbeats', 'superagent');
  const prompt = `Act as this AgentGlim instance's SuperAgent. Read ${path.join(root, 'AGENTS.md')} and ${path.join(root, 'skills', 'agentglim-setup', 'SKILL.md')}. `
    + `Create the heartbeat folder if needed and touch ${shellQuote(heartbeat)} now and every five minutes. Run ${command} in a session whose output you read. `
    + `For each STATUS, CHAT or CHECK line it prints, answer with the matching tool in ${path.join(run || '', 'bin')} (status-write.mjs, chat-write.mjs, owner-check.mjs), then run it again; it exits after each request and after about 50 minutes. `
    + `Before saying you are ready, click Refresh in the dashboard and confirm your reply arrives. Tell me plainly about any permission or session limit. Starting build workers is separate; do not claim it.`;
  return { command, heartbeat, prompt };
}

export function watcherSnapshot({ data, run, now = Date.now(), exists = fs.existsSync } = {}) {
  const superagent = superagentView({ data, run, now });
  const ws = watcherState({ data, run, now, exists });
  return {
    startup: startupInfo({ data, run }),
    ...ws,
    superagent,
    // the header dot: a fresh SuperAgent heartbeat, or a turn-based session (turn-delivery.mjs) with a verified,
    // non-failing round trip. `turn` rides along so the page can name it and skip the listener notice.
    armed: superagent.ok || !!ws.turn?.ok,
    ...(ws.turn ? { turn: ws.turn } : {}),
    harness: !!run && exists(run),
  };
}
