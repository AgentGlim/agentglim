// send-to-agent-install.mjs: wires "Send to agent" into the agent CLIs.
//   node app/send-to-agent.mjs install-hooks   [--claude] [--codex] [--dry-run] [--settings FILE]
//   node app/send-to-agent.mjs uninstall-hooks [--claude] [--codex] [--dry-run] [--settings FILE]
// No --claude/--codex flag means both.
//
// Claude Code: adds the inbox hook (UserPromptSubmit + Stop) to settings.json ($CLAUDE_CONFIG_DIR or ~/.claude).
//   Idempotent (an entry whose command already runs this file is left alone), backs the file up to
//   settings.json.bak-agentglim-<stamp> before the first change, and uninstall removes only its own entries.
// Codex: nothing is written. Codex hooks only run after the user trusts each one (an untrusted hook in
//   config.toml is skipped, tested with codex-cli 0.167), so the reliable path is `codex exec resume <id> -`,
//   which needs no setup. install/uninstall check that the installed codex supports it and say so.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'send-to-agent.mjs');
export const hookCommand = (file = HOOK_FILE) => `node ${JSON.stringify(file)} hook`;
const EVENTS = ['UserPromptSubmit', 'Stop'];
const ours = (h) => typeof h?.command === 'string' && /send-to-agent\.mjs"? hook\b/.test(h.command);

export function claudeSettingsPath(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(env.HOME || env.USERPROFILE || '', '.claude'), 'settings.json');
}

// pure: returns {settings, changed}
export function addClaudeHooks(settings, cmd = hookCommand()) {
  const s = structuredClone(settings || {}); s.hooks ||= {}; let changed = false;
  for (const ev of EVENTS) {
    const groups = (s.hooks[ev] ||= []);
    if (groups.some((g) => (g.hooks || []).some(ours))) continue;
    groups.push({ hooks: [{ type: 'command', command: cmd, timeout: 10 }] }); changed = true;
  }
  return { settings: s, changed };
}
export function removeClaudeHooks(settings) {
  const s = structuredClone(settings || {}); let changed = false;
  for (const ev of EVENTS) {
    const groups = s.hooks?.[ev]; if (!Array.isArray(groups)) continue;
    const kept = groups.map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !ours(h)) })).filter((g) => g.hooks.length);
    if (kept.length !== groups.length || kept.some((g, i) => g.hooks.length !== groups[i].hooks.length)) changed = true;
    if (kept.length) s.hooks[ev] = kept; else delete s.hooks[ev];
  }
  if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
  return { settings: s, changed };
}

function editClaude(file, fn, dryRun) {
  let cur = {};
  if (fs.existsSync(file)) { try { cur = JSON.parse(fs.readFileSync(file, 'utf8') || '{}'); } catch (e) { return { ok: false, msg: `${file} is not valid JSON, left as is (${e.message})` }; } }
  const { settings, changed } = fn(cur);
  if (!changed) return { ok: true, changed: false, msg: `Claude Code: ${file} already up to date` };
  if (dryRun) return { ok: true, changed: true, msg: `Claude Code: would update ${file}`, preview: settings };
  let backup = null;
  if (fs.existsSync(file)) { backup = `${file}.bak-agentglim-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 18)}`; fs.copyFileSync(file, backup); }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const t = `${file}.tmp${process.pid}`; fs.writeFileSync(t, JSON.stringify(settings, null, 2) + '\n'); fs.renameSync(t, file);
  return { ok: true, changed: true, backup, msg: `Claude Code: updated ${file}${backup ? ` (backup ${path.basename(backup)})` : ''}` };
}

export function checkCodex(bin = 'codex') {
  const v = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (v.error || v.status !== 0) return { ok: false, msg: 'Codex: codex is not installed; Send to agent falls back to Copy for Codex sessions' };
  const h = spawnSync(bin, ['exec', 'resume', '--help'], { encoding: 'utf8' });
  const ok = h.status === 0 && /SESSION_ID/.test(h.stdout);
  return { ok, changed: false, msg: ok ? `Codex: ${v.stdout.trim()} supports \`codex exec resume <id> -\`; nothing to install`
    : `Codex: ${v.stdout.trim()} has no \`codex exec resume\`; update Codex (npm i -g @openai/codex)` };
}

export function runInstall(argv, env = process.env) {
  const uninstall = argv[0] === 'uninstall-hooks';
  const flags = new Set(argv.slice(1)); const dryRun = flags.has('--dry-run');
  const si = argv.indexOf('--settings'); const file = si > 0 ? path.resolve(argv[si + 1]) : claudeSettingsPath(env);
  const both = !flags.has('--claude') && !flags.has('--codex');
  const out = [];
  if (both || flags.has('--claude')) out.push(editClaude(file, uninstall ? removeClaudeHooks : addClaudeHooks, dryRun));
  if (both || flags.has('--codex')) out.push(checkCodex(env.AGENTGLIM_CODEX_BIN || 'codex'));
  return out;
}
