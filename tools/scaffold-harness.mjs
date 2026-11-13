#!/usr/bin/env node
// scaffold-harness.mjs: create the optional run folder that the dashboard's SuperAgent controls use,
// and link the tools AgentGlim ships into <run>/bin. It never writes the plans driver, worker routing,
// model limits or any owner state: those stay in your own automation. Existing files are preserved.
//   npm run scaffold-harness
//   node tools/scaffold-harness.mjs --dry-run
//   node tools/scaffold-harness.mjs --run /path/to/plans/_run
// The run folder defaults to $AGENTGLIM_RUN, else $AGENTGLIM_PLANS/_run (see app/paths.mjs).
// Re-running it after an update refreshes what it manages (links into this checkout, copies it made and you did not
// edit, the AGENTGLIM-HARNESS.md note) and leaves anything you changed or created yourself alone.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTGLIM_ROOT } from '../app/settings.mjs';
import { RUN, PLANS, shellQuote } from '../app/paths.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const dry = args.includes('--dry-run');
const run = path.resolve(opt('--run') || process.env.AGENTGLIM_RUN || RUN);
const tools = ['status-write.mjs', 'chat-write.mjs', 'owner-check.mjs', 'harness-set.mjs', 'io-guard.sh', 'auditq-wait.sh', 'jev-route.mjs'];
const dirs = ['bin', 'flags', 'heartbeats', 'audit_queue', 'status_ask', 'chat_inbox', 'mode_queue', 'owner_check', 'logs'];
const MARK = '<!-- agentglim-managed: written by scaffold-harness and refreshed on update; keep your own notes in another file -->';
const readme = `${MARK}
# AgentGlim run folder

This folder is optional. AgentGlim shows your plans without it; it holds the queues and tools that let a
SuperAgent answer the dashboard's controls.

- \`bin/\` links the tools AgentGlim ships (status-write, chat-write, owner-check, harness-set, io-guard,
  auditq-wait, jev-route). They are symlinks to the AgentGlim checkout, so an update is picked up at once.
- \`audit_queue/\`, \`status_ask/\`, \`chat_inbox/\` and \`owner_check/\` are requests for the SuperAgent.
  \`mode_queue/\` is left for your own automation; AgentGlim ships no mode handler.

## Arming the SuperAgent (do this, in this order)

1. Resolve the paths from the app, not from memory: \`node ${path.join(AGENTGLIM_ROOT, 'tools', 'first-run.mjs')} paths\`
   prints \`data\`, \`run\`, \`heartbeat\` and \`waitCommand\`. This folder is \`${run}\`.
2. Touch the heartbeat file (\`heartbeat\` above) now and every five minutes while you supervise.
3. Start the listener in a session whose output you read: \`${'bash ' + shellQuote(path.join(run, 'bin', 'auditq-wait.sh'))}\`.
   It prints \`STATUS:\`, \`CHAT:\`, \`CHECK:\` or \`PENDING:\` when the dashboard needs you, then exits (also after about
   50 minutes). Handle the request, then **run it again after every exit**. A listener nobody reads answers nothing.
4. Answer with the tools below. The listener's own heartbeat is extra information for the header dot; the heartbeat
   you touch in step 2 is what arms it.
5. Before you say you are ready, click Refresh in the dashboard and confirm your reply (a \`status_ask\` request
   handled, \`status-write.mjs\` run) arrives. A heartbeat alone proves nothing.

This scaffold does **not** include a plans driver, worker lanes, model routing, budget polling or a local
model supervisor. AgentGlim does not ship those, and no tool here spawns or routes build agents. If you have
your own automation, point \`AGENTGLIM_RUN\` at its run folder instead.

Commands:

    bash bin/auditq-wait.sh
    node bin/status-write.mjs --done "..." --running "..." --blocked "..." --next "..." --optimize "..."
    node bin/chat-write.mjs --reply "..." --to <ms>
    node bin/owner-check.mjs list

Tool help lives at the top of each file. See SETUP.md (Plans harness and SuperAgent tools).
`;
const label = (p) => p.startsWith(process.env.HOME || '\0') ? '~' + p.slice((process.env.HOME || '').length) : p;
const made = [], kept = [], failed = [], refreshed = [];
const mkdir = (d) => {
  if (fs.existsSync(d)) { kept.push(label(d)); return; }
  made.push(label(d));
  if (!dry) fs.mkdirSync(d, { recursive: true });
};
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return null; } };
// copies this tool made (Windows without links) are recorded with their hash, so an unedited copy can be refreshed
const MANIFEST = path.join(run, 'bin', '.agentglim-managed.json');
let managed = {}; try { managed = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch {}
const stamp = () => new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const isShippedLink = (dest, name) => { try { return fs.lstatSync(dest).isSymbolicLink() && /(^|[\\/])harness[\\/]bin[\\/]/.test(fs.readlinkSync(dest)) && path.basename(fs.readlinkSync(dest)) === name; } catch { return false; } };
// Older Windows installs generated this exact wrapper before copy hashes were recorded.
// Recognize only the unedited template, so custom scripts remain untouched.
const isLegacyWrapper = (dest, name) => {
  try {
    const text = fs.readFileSync(dest, 'utf8');
    const target = text.match(/await import\(pathToFileURL\(("(?:[^"\\]|\\.)*")\)\.href\);/);
    if (!target) return false;
    const src = JSON.parse(target[1]);
    const legacy = `// Generated by scaffold-harness: run the packaged tool in place.\nimport { pathToFileURL } from 'node:url';\nawait import(pathToFileURL(${JSON.stringify(src)}).href);\n`;
    return text === legacy && /[\\/]harness[\\/]bin[\\/]/.test(src) && path.basename(src) === name;
  } catch { return false; }
};
const write = (f, text, { old } = {}) => {
  if (fs.existsSync(f)) {
    const cur = fs.readFileSync(f, 'utf8');
    if (cur === text) { kept.push(label(f)); return; }
    // only a file this tool wrote (marker, or the unmarked text of older versions) is refreshed; a backup is kept
    if (!(cur.includes('agentglim-managed') || (old && old.test(cur)))) { kept.push(label(f)); return; }
    refreshed.push(label(f));
    if (!dry) { fs.copyFileSync(f, `${f}.bak-${stamp()}`); fs.writeFileSync(f, text, { mode: 0o644 }); }
    return;
  }
  made.push(label(f));
  if (!dry) fs.writeFileSync(f, text, { mode: 0o644 });
};
mkdir(run);
for (const d of dirs) mkdir(path.join(run, d));
const wrapper = (src) => `// Generated by scaffold-harness: run the packaged tool in place.
import { spawnSync } from 'node:child_process';
const child = spawnSync(process.execPath, [${JSON.stringify(src)}, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
if (child.error) console.error(child.error.message);
process.exit(child.status ?? 1);
`;
const linkTool = (src, dest) => {
  try {
    fs.symlinkSync(path.relative(path.dirname(dest), src), dest, 'file');
  } catch (e) {
    // Windows without Developer Mode cannot create links. A generated wrapper keeps the tool's own relative
    // imports working (a plain copy would look for config.mjs and app/ next to the run folder instead).
    try {
      if (dest.endsWith('.mjs')) fs.writeFileSync(dest, wrapper(src), { mode: 0o644 });
      else fs.copyFileSync(src, dest);
      managed[path.basename(dest)] = sha(dest);
    } catch (e2) { failed.push(`${label(dest)} (${e.code || e.message}; ${e2.code || e2.message})`); }
  }
};
for (const name of tools) {
  const src = path.join(AGENTGLIM_ROOT, 'harness', 'bin', name), dest = path.join(run, 'bin', name);
  let exists = false; try { fs.lstatSync(dest); exists = true; } catch {}
  if (exists) {
    // a link into some AgentGlim checkout (maybe the old location) is ours: point it at this one
    if (isShippedLink(dest, name)) {
      if (path.resolve(path.dirname(dest), fs.readlinkSync(dest)) === src && fs.existsSync(dest)) { kept.push(label(dest)); continue; }
      refreshed.push(label(dest)); if (!dry) { fs.unlinkSync(dest); linkTool(src, dest); } continue;
    }
    // an unedited copy we made earlier is ours too; anything else is yours
    if (!fs.lstatSync(dest).isSymbolicLink() && ((managed[name] && sha(dest) === managed[name]) || isLegacyWrapper(dest, name))) {
      if (sha(dest) === sha(src) || (dest.endsWith('.mjs') && fs.readFileSync(dest, 'utf8') === wrapper(src))) { kept.push(label(dest)); continue; }
      refreshed.push(label(dest)); if (!dry) { fs.unlinkSync(dest); linkTool(src, dest); } continue;
    }
    kept.push(label(dest)); continue;
  }
  made.push(label(dest));
  if (dry) continue;
  linkTool(src, dest);
}
if (!dry && Object.keys(managed).length && fs.existsSync(path.join(run, 'bin'))) { try { fs.writeFileSync(MANIFEST, JSON.stringify(managed, null, 2) + '\n'); } catch {} }
// A short note identifies this as a scaffold, so a later run does not replace your own run book.
const note = path.join(run, 'AGENTGLIM-HARNESS.md');
write(note, readme, { old: /^# AgentGlim run folder\n\nThis folder is optional\./ });
if (dry) console.log(`scaffold-harness: dry run for ${label(run)} (${made.length} to create, ${kept.length} already there)`);
else if (failed.length) { console.error(`scaffold-harness: ${failed.length} tool(s) not linked:\n  ${failed.join('\n  ')}`); process.exitCode = 1; }
else console.log(`scaffold-harness: ready at ${label(run)} (${made.length} created, ${refreshed.length} refreshed, ${kept.length} preserved)`);
if (made.length) console.log(made.map((x) => `  + ${x}`).join('\n'));
if (refreshed.length) console.log(refreshed.map((x) => `  ~ ${x}`).join('\n'));
if (kept.length && args.includes('--verbose')) console.log(kept.map((x) => `  = ${x}`).join('\n'));
if (!fs.existsSync(path.join(PLANS, '_run')) && path.resolve(PLANS, '_run') !== run) console.log(`note: the dashboard reads ${label(path.join(PLANS, '_run'))}; set AGENTGLIM_RUN to this folder or pass --run at setup.`);
