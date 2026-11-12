#!/usr/bin/env node
// record-prompt.mjs: save a real pane capture of a harness dialog, to refine the prompt pattern packs (read-only).
//   node control/tools/record-prompt.mjs --pane %5 --harness claude --name permission [--default-server | -L NAME] [--out DIR]
// Runs only `tmux capture-pane -p -e -J -S -60` (no keys, no paste). The default tmux server holds the owner's real
// sessions, so it must be named explicitly with --default-server. Writes <out>/<harness>-<name>-<stamp>.txt (default
// tests/fixtures/panes/real/) and prints what the current pack makes of it.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parsePane } from '../sessions/prompts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const a = process.argv.slice(2);
const opt = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : null; };
const pane = opt('--pane'), harness = opt('--harness'), name = opt('--name') || 'prompt', sock = opt('-L');
if (!pane || !/^%\d+$/.test(pane) || !['claude', 'codex', 'pi', 'opencode'].includes(harness || '')) { console.error('usage: record-prompt.mjs --pane %N --harness claude|codex|pi|opencode [--name X] (--default-server | -L NAME)'); process.exit(2); }
if (!sock && !a.includes('--default-server')) { console.error('refusing: name the server with --default-server (real sessions) or -L NAME'); process.exit(2); }
if (!/^[\w-]{1,40}$/.test(name)) { console.error('--name: letters, digits, - and _ only'); process.exit(2); }
const env = { ...process.env }; delete env.TMUX;
const text = execFileSync(process.env.TMUX_BIN || 'tmux', [...(sock ? ['-L', sock] : []), 'capture-pane', '-p', '-e', '-J', '-S', '-60', '-t', pane], { encoding: 'utf8', env });
const out = path.resolve(opt('--out') || path.join(HERE, '..', '..', 'tests', 'fixtures', 'panes', 'real'));
fs.mkdirSync(out, { recursive: true });
const file = path.join(out, `${harness}-${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
fs.writeFileSync(file, text);
console.log(JSON.stringify({ saved: file, parsed: parsePane(text, harness) }, null, 2));
