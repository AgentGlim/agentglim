#!/usr/bin/env node
// privacy-check.mjs: fails (exit 1) if a file git tracks, or would track (untracked, not ignored), holds personal data.
//   npm run privacy-check [-- --tracked-only] [--quiet]
// Checks:
//   home   a home-folder path (/home/<name>, /Users/<name>, C:\Users\<name>)
//   name   a private name: AGENTGLIM_PRIVATE_NAMES (comma list) + lines of ~/.config/agentglim/private-names.txt
//          (or $AGENTGLIM_PRIVATE_NAMES_FILE). Names are never printed.
//   goals  text copied from your private goals.json / goal-map.json / latest review (titles, next actions, labels
//          of 12+ characters), read from $AGENTGLIM_DATA. Never printed.
//   key    key-shaped strings (sk-, ghp_, AKIA, private key blocks)
//   file   a private-data file: .env, integrations.json, *.bak*, *.log, goals.json, goal-map.json, *-review.json outside examples/
//   email  a real-looking email address (anything but example domains, GitHub noreply and git@ remotes)
//   deny   a pattern from the committed dev/privacy-denylist.txt (one regex per line), so a fresh clone with no
//          private name list still tests something
// Goal strings that also appear in examples/*.json are public example text and are not flagged; media/ and
// site/assets/ (rendered walkthroughs of the examples) are left out of the goals check.
// A line holding "leak-allow" or "privacy-allow" may keep a home path. Exit 0 clean, 1 findings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA, GOALS, goalsFile } from '../app/paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), QUIET = args.includes('--quiet');
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean);
const files = [...new Set([...git('ls-files', '-z'), ...(args.includes('--tracked-only') ? [] : git('ls-files', '-z', '--others', '--exclude-standard'))])]
  .filter((f) => fs.existsSync(path.join(ROOT, f)) && fs.statSync(path.join(ROOT, f)).isFile());

const HOME_RE = /(?:\/home\/|\/Users\/)[A-Za-z0-9._-]+(?=[/'"`\s:]|$)|[A-Za-z]:\\{1,2}Users\\{1,2}[A-Za-z0-9._-]+/g;
const GENERIC_HOME = /\/home\/(?:you|<[^>]+>|\$USER|name|me)\//; // documentation placeholders
const KEYS = [/sk-ant-[A-Za-z0-9_-]{20,}/, /\bsk-[A-Za-z0-9_-]{32,}/, /gh[pousr]_[A-Za-z0-9]{30,}/, /github_pat_[A-Za-z0-9_]{30,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const EMAIL_OK = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost|users\.noreply\.github\.com|noreply\.github\.com|github\.com|anthropic\.com)$|\.(png|jpe?g|svg|gif|webp|ico)$/i;
const BADFILE = [/(^|\/)\.env$/, /(^|\/)\.env\.(?!example$)[^/]+$/, /(^|\/)integrations\.json$/, /\.bak/, /\.log$/, /\.pem$/, /(^|\/)(goals|goal-map)\.json$/, /\d{4}-\d\d-\d\d-review\.json$/];

function names() {
  const out = (process.env.AGENTGLIM_PRIVATE_NAMES || '').split(',');
  const f = process.env.AGENTGLIM_PRIVATE_NAMES_FILE || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'agentglim', 'private-names.txt');
  try { out.push(...fs.readFileSync(f, 'utf8').split('\n')); } catch {}
  return [...new Set(out.map((s) => s.trim()).filter((s) => s.length >= 3 && !s.startsWith('#')))];
}
function goalStrings() {
  const out = new Set(), add = (v) => { if (typeof v === 'string' && v.trim().length >= 12) out.add(v.trim().toLowerCase()); };
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const g = goalsFile() && read(goalsFile());
  for (const x of g?.goals || []) { add(x.title); add(x.next_action); add(x.outcome); (x.acceptance || []).forEach(add); }
  for (const m of g?.metrics || []) add(m.label);
  try { const rf = fs.readdirSync(`${GOALS}/reviews`).filter((f) => /-review\.json$/.test(f)).sort().pop(); const r = rf && read(`${GOALS}/reviews/${rf}`); for (const p of r?.priorities || []) { add(p.title); add(p.next); } (r?.drift || []).forEach(add); } catch {}
  return [...out];
}
function denylist() {
  try { return fs.readFileSync(path.join(ROOT, 'dev', 'privacy-denylist.txt'), 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#')).map((s) => new RegExp(s, 'i')); } catch { return []; }
}
function exampleText() {
  let s = '';
  try { for (const f of fs.readdirSync(path.join(ROOT, 'examples'))) if (f.endsWith('.json')) s += fs.readFileSync(path.join(ROOT, 'examples', f), 'utf8').toLowerCase(); } catch {}
  return s;
}
const esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nameRe = names().map((n) => new RegExp(n.length >= 5 ? esc(n) : `\\b${esc(n)}\\b`, 'i'));
const EX = exampleText();
const gs = goalStrings().filter((s) => !EX.includes(s));
const deny = denylist();
const NO_GOALS = /^(media|site\/assets)\//;

const found = [], add = (kind, file, line, text) => found.push({ kind, file, line, text });
for (const f of files) {
  if (BADFILE.some((r) => r.test(f)) && !f.startsWith('examples/')) add('file', f, 0, '');
  const buf = fs.readFileSync(path.join(ROOT, f));
  if (buf.subarray(0, 8000).includes(0)) continue; // binary
  const lines = buf.toString('utf8').split('\n');
  lines.forEach((l, i) => {
    if (!/leak-allow|privacy-allow|scrub-allow/.test(l)) for (const m of l.match(HOME_RE) || []) if (!GENERIC_HOME.test(m + '/')) add('home', f, i + 1, m);
    if (nameRe.some((r) => r.test(l))) add('name', f, i + 1, '(name hidden)');
    if (KEYS.some((r) => r.test(l))) add('key', f, i + 1, '(key hidden)');
    if (!/privacy-allow|scrub-allow/.test(l)) for (const m of l.matchAll(EMAIL_RE)) if (!EMAIL_OK.test(m[1])) add('email', f, i + 1, '(address hidden)');
    if (deny.some((r) => r.test(l))) add('deny', f, i + 1, '(pattern hidden)');
    if (gs.length && !NO_GOALS.test(f)) { const low = l.toLowerCase(); if (gs.some((s) => low.includes(s))) add('goals', f, i + 1, '(goal text hidden)'); }
  });
}
const by = {}; for (const x of found) by[x.kind] = (by[x.kind] || 0) + 1;
if (!QUIET) for (const x of found) console.log(`${x.kind}\t${x.file}${x.line ? ':' + x.line : ''}\t${x.text}`);
console.log(`privacy-check: ${files.length} files, ${found.length} findings ${JSON.stringify(by)}; ${nameRe.length} names, ${deny.length} denylist patterns, ${gs.length} goal strings from ${DATA.replace(os.homedir(), '~')}`);
process.exit(found.length ? 1 : 0);
