#!/usr/bin/env node
// leak-scan.mjs: checks a release export before anything can be published. No dependencies.
//   node dev/leak-scan.mjs DIR [--public public.txt] [--env FILE] [--quiet]
// Fails (exit 1) on any of:
//   home     a home-folder path: /home/<name>/..., /Users/<name>/..., C:\Users\<name>\...
//   name     a private name, from AGENTGLIM_PRIVATE_NAMES (comma-separated) and the lines of
//            $AGENTGLIM_PRIVATE_NAMES_FILE, else ~/.config/agentglim/private-names.txt. Names are never printed.
//   key      a key-shaped string (sk-, ghp_, AKIA, Slack and Google keys, private key blocks, long secret
//            assignments) or any value from the private .env (default: the .env next to dev/). Values are masked.
//   file     a file that must never ship: .env, *.bak*, *.log, *.pem, *.key, tests/out/, node_modules/, target/
//   extra    a file the allowlist (public.txt) does not cover
// A line holding "leak-allow" or "scrub-allow" may keep a home path (redactor test fixtures); names and keys still count.
// Exit 0 when clean, 1 on findings, 2 on bad usage. One line per finding, then a count per kind.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DIR = args.find((a, i) => !a.startsWith('--') && !['--public', '--env'].includes(args[i - 1]));
if (!DIR || !fs.existsSync(DIR)) { console.error('usage: leak-scan.mjs DIR [--public public.txt] [--env FILE] [--quiet]'); process.exit(2); }
const PUBLIC = opt('--public', path.join(HERE, '..', 'public.txt'));
const ENVF = opt('--env', path.join(HERE, '..', '.env'));
const QUIET = args.includes('--quiet');

// ---- the allowlist, as published paths
export function readPublic(file) {
  const keep = [], drop = [];
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const l = raw.replace(/\s+#.*$/, '').trim();
    if (!l || l.startsWith('#')) continue;
    if (l.startsWith('!')) { drop.push(l.slice(1).trim()); continue; }
    const [src, dest] = l.split(/\s*=>\s*/);
    keep.push({ src, dest: dest || src });
  }
  return { keep, drop };
}
const glob = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
export const NEVER = [/(^|\/)\.env$/, /(^|\/)\.env\.(?!example$)[^/]+$/, /\.bak/, /\.log$/, /\.pem$/, /\.key$/, /(^|\/)tests\/out\//, /(^|\/)node_modules\//, /(^|\/)target\//];

// ---- what counts as a leak
const HOME = /(?:\/home\/|\/Users\/)[A-Za-z0-9._-]+(?=[/'"`\s:]|$)|[A-Za-z]:\\{1,2}Users\\{1,2}[A-Za-z0-9._-]+/g;
const KEYS = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g, /sk-[A-Za-z0-9_-]{20,}/g, /gh[pousr]_[A-Za-z0-9]{30,}/g, /github_pat_[A-Za-z0-9_]{30,}/g,
  /AKIA[0-9A-Z]{16}/g, /xox[abpr]-[A-Za-z0-9-]{10,}/g, /AIza[0-9A-Za-z_-]{35}/g, /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /(?:api[_-]?key|secret|token|passw(?:or)?d)["' ]*[:=][ "']*[A-Za-z0-9_\-+/=]{24,}/gi,
];
function privateNames() {
  const out = (process.env.AGENTGLIM_PRIVATE_NAMES || '').split(',');
  const f = process.env.AGENTGLIM_PRIVATE_NAMES_FILE || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'agentglim', 'private-names.txt');
  try { out.push(...fs.readFileSync(f, 'utf8').split('\n')); } catch {}
  return [...new Set(out.map((s) => s.trim()).filter((s) => s.length >= 3 && !s.startsWith('#')))];
}
function envValues(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*["']?([^"'\s#]+)/)?.[1]).filter((v) => v && v.length >= 12);
  } catch { return []; }
}
const mask = (s) => (s.length <= 6 ? '****' : s.slice(0, 4) + '****');

function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (!base && (e.name === '.git' || e.name === '.release-files')) continue;
    if (e.isDirectory()) out.push(...walk(dir, rel)); else out.push(rel);
  }
  return out;
}

export function scan(dir, { publicFile = PUBLIC, envFile = ENVF } = {}) {
  const findings = [], add = (kind, file, line, text) => findings.push({ kind, file, line, text });
  const { keep, drop } = readPublic(publicFile), dropRe = drop.map(glob);
  const covered = (rel) => !dropRe.some((r) => r.test(rel)) && keep.some(({ dest }) => (dest.endsWith('/') ? rel.startsWith(dest) : rel === dest));
  // a name matches as a whole word; one of 5 letters or more also matches inside a word (a domain, a package id)
  const esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = privateNames(), nameRe = names.map((n) => new RegExp(n.length >= 5 ? esc(n) : `\\b${esc(n)}\\b`, 'i'));
  const secrets = envValues(envFile);
  const files = walk(dir);
  for (const rel of files) {
    if (NEVER.some((r) => r.test(rel))) add('file', rel, 0, 'must never ship');
    if (!covered(rel)) add('extra', rel, 0, 'not in public.txt');
    if (nameRe.some((r) => r.test(rel))) add('name', rel, 0, 'file name holds [private name]');
    // a symlink (git stores its target path as the blob): scan the target text, never follow it (it may be a folder)
    const full = path.join(dir, rel);
    const buf = fs.lstatSync(full).isSymbolicLink() ? Buffer.from(fs.readlinkSync(full)) : fs.readFileSync(full);
    if (buf.subarray(0, 8000).includes(0)) { // binary: only the raw bytes for exact secrets
      for (const v of secrets) if (buf.includes(v)) add('key', rel, 0, `binary file holds a .env value ${mask(v)}`);
      continue;
    }
    const lines = buf.toString('utf8').split('\n');
    lines.forEach((l, i) => {
      if (!/(?:scrub|leak)-allow/.test(l)) for (const m of l.matchAll(HOME)) add('home', rel, i + 1, m[0]); // test fixtures for redactors may mark a line
      if (nameRe.some((r) => r.test(l))) add('name', rel, i + 1, '[private name]');
      for (const re of KEYS) for (const m of l.matchAll(re)) add('key', rel, i + 1, mask(m[0]));
      for (const v of secrets) if (l.includes(v)) add('key', rel, i + 1, `.env value ${mask(v)}`);
    });
  }
  return { files: files.length, names: names.length, envValues: secrets.length, findings };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = scan(DIR);
  const counts = {};
  for (const f of r.findings) { counts[f.kind] = (counts[f.kind] || 0) + 1; if (!QUIET) console.log(`${f.kind}\t${f.file}${f.line ? ':' + f.line : ''}\t${f.text}`); }
  console.log(`leak scan: ${r.files} files, ${r.findings.length} findings ${JSON.stringify(counts)}; checked ${r.names} private names and ${r.envValues} .env values`);
  if (!r.names) console.log('note: no private names set (AGENTGLIM_PRIVATE_NAMES or ~/.config/agentglim/private-names.txt), so names were not checked');
  process.exit(r.findings.length ? 1 : 0);
}
