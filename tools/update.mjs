#!/usr/bin/env node
// update.mjs: the one documented update path. Runs `git pull --ff-only` on main, then re-links the run folder's
// SuperAgent tools and refreshes the global note and skill copies setup wrote (only where they already exist, and
// custom run-folder tools are kept). Managed skill replacements are backed up; goals and settings are kept. Restart AgentGlim afterwards.
//   npm run update [-- --dry-run]
// A release-tag checkout or a tarball is not an update path: a tag needs `git checkout main` once, a tarball needs a
// fresh clone (same data folder). See SETUP.md, Update.
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const dry = process.argv.includes('--dry-run');
const git = (...args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
const say = (s) => console.log(s);
const fail = (s) => { console.error(`update: ${s}`); process.exit(1); };

const checkout = git('rev-parse', '--show-toplevel');
let ownsCheckout = false;
try { ownsCheckout = checkout.status === 0 && fs.realpathSync(checkout.stdout.trim()) === fs.realpathSync(ROOT); } catch {}

if (dry) {
  say('dry run: not pulling; only the refresh below is previewed.');
} else if (!ownsCheckout) {
  fail('not a git checkout (a tarball or an export). Clone https://github.com/AgentGlim/agentglim.git and keep the same data folder.');
} else {
  const branch = (git('rev-parse', '--abbrev-ref', 'HEAD').stdout || '').trim();
  if (branch !== 'main') fail(`on "${branch || 'a detached HEAD'}", not main. Run \`git checkout main\` once, then \`npm run update\`.`);
  const pull = git('pull', '--ff-only');
  if (pull.status !== 0) fail(`git pull --ff-only failed. Keep your local changes (stash or commit them) and try again.\n${(pull.stderr || pull.stdout || '').trim()}`);
  say(`git pull --ff-only: ${((pull.stdout || '').trim().split('\n')[0] || 'already up to date.')}`);
}

const refresh = spawnSync(process.execPath, [path.join(HERE, 'refresh-integrations.mjs'), ...(dry ? ['--dry-run'] : [])], { cwd: ROOT, env: { ...process.env, AGENTGLIM_UPDATE_STEP: '1' }, encoding: 'utf8', timeout: 60000 });
process.stdout.write(refresh.stdout || '');
process.stderr.write(refresh.stderr || '');
if (refresh.status !== 0) fail('the refresh step failed; see above. The pull is done, so a second run only retries the refresh.');

// Upgrade cleanup: archive (move, never delete) unanswered goals-app scheduled chats whose skill is not installed.
if (dry) say('dry run: stale scheduled chats are not archived.');
else {
  try {
    const { archiveStaleScheduledChats } = await import('../app/goals-report.mjs');
    const a = archiveStaleScheduledChats();
    if (a.archived.length) say(`archived ${a.archived.length} stale scheduled chat(s) (skill not installed) to ${a.dir}`);
    if (a.error) console.error(`update: chat cleanup: ${a.error}`);
  } catch (e) { console.error(`update: chat cleanup skipped: ${e.message}`); }
}
say('Restart AgentGlim to run the new version. Your goals and settings were kept; only stale scheduled chats (listed above, if any) were moved to the archive.');
