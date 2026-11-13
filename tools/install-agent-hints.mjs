#!/usr/bin/env node
// install-agent-hints.mjs: let agents in any folder find AgentGlim. Adds one marked note to the user's global
// agent instructions (Codex ~/.codex/AGENTS.md, Claude Code ~/.claude/CLAUDE.md) and copies the setup skill into
// ~/.claude/skills and ~/.agents/skills. Idempotent: the note sits between marker lines and is replaced, never
// duplicated; the previous file is kept once as <file>.agentglim.bak. Nothing else in those files is touched.
//   node tools/install-agent-hints.mjs [--dry-run] [--refresh] [--home DIR]   (--refresh: update existing copies only)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const START = '<!-- agentglim:start -->', END = '<!-- agentglim:end -->';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const note = (root = ROOT) => `${START}
## AgentGlim

AgentGlim is a local dashboard for your coding agents' usage limits, goals and project plans. It is installed at
\`${root}\`. When the user asks you to "be the SuperAgent", "be the AgentGlim SuperAgent" or "set up AgentGlim", or opens
you in or near that folder, read \`${root}/skills/agentglim-setup/SKILL.md\` and follow it: on a first run it is a
one-question-at-a-time setup interview in chat, then the SuperAgent loop: resolve the data and run folders with
\`node ${root}/tools/first-run.mjs paths\`, touch the heartbeat file, run the printed \`waitCommand\` (auditq-wait.sh) in a
session you read, answer each request and re-run it after every exit, and confirm one dashboard Refresh reply before
saying you are ready. Personal data lives in \`~/.agentglim\`, never in that folder.
${END}`;

export function withNote(text, root) {
  const n = note(root), a = text.indexOf(START), b = text.indexOf(END);
  if (a >= 0 && b > a) return text.slice(0, a) + n + text.slice(b + END.length);
  return text + (text && !text.endsWith('\n') ? '\n' : '') + (text ? '\n' : '') + n + '\n';
}

// onlyExisting: refresh what an earlier install put there (the marked note, the skill copies) and create nothing new,
// so an update never adds files to a harness the user chose not to link.
export function install({ home = os.homedir(), root = ROOT, dry = false, onlyExisting = false } = {}) {
  const done = [];
  const targets = [[path.join(home, '.codex'), 'AGENTS.md'], [path.join(home, '.claude'), 'CLAUDE.md']];
  for (const [dir, name] of targets) {
    const f = path.join(dir, name);
    if (!fs.existsSync(dir) && !dry && !process.env.AGENTGLIM_HINTS_CREATE) { done.push(`skip ${f} (folder not found: harness not installed)`); continue; }
    const old = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    if (onlyExisting && !old.includes(START)) { done.push(`skip ${f} (no AgentGlim note to refresh)`); continue; }
    const next = withNote(old, root);
    if (next === old) { done.push(`ok   ${f} (already current)`); continue; }
    done.push(`${old ? 'edit' : 'new '} ${f}`);
    if (dry) continue;
    fs.mkdirSync(dir, { recursive: true });
    if (old && !fs.existsSync(`${f}.agentglim.bak`)) fs.copyFileSync(f, `${f}.agentglim.bak`);
    fs.writeFileSync(f, next);
  }
  const skill = fs.readFileSync(path.join(root, 'skills', 'agentglim-setup', 'SKILL.md'), 'utf8');
  for (const dir of [path.join(home, '.claude', 'skills'), path.join(home, '.agents', 'skills')]) {
    const f = path.join(dir, 'agentglim-setup', 'SKILL.md');
    if (!fs.existsSync(path.dirname(dir)) && !dry && dir.includes('.claude')) { done.push(`skip ${f} (folder not found)`); continue; }
    if (onlyExisting && !fs.existsSync(f)) { done.push(`skip ${f} (not installed)`); continue; }
    if (fs.existsSync(f) && fs.readFileSync(f, 'utf8') === skill) { done.push(`ok   ${f}`); continue; }
    done.push(`${fs.existsSync(f) ? 'edit' : 'new '} ${f}`);
    if (dry) continue;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (fs.existsSync(f)) fs.copyFileSync(f, `${f}.bak-${Date.now()}`);
    fs.writeFileSync(f, skill);
  }
  return done;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2), h = a.indexOf('--home');
  console.log(install({ dry: a.includes('--dry-run'), onlyExisting: a.includes('--refresh'), home: h >= 0 ? path.resolve(a[h + 1]) : os.homedir() }).join('\n'));
}
