// The Jev router has to run from the release export, not only from a full checkout: harness/bin/jev-route.mjs
// imports free-models.mjs and model-cooldown.mjs from its own folder. When those were not committed (or not in
// public.txt), two unit tests failed with ERR_MODULE_NOT_FOUND and jev-gate silently allowed every launch.
// These tests stage an export in a temp dir and run the router there, then check jev-gate fails CLOSED.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { scratch } from './helpers/weekly-scratch.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const BIN = path.join(ROOT, 'harness', 'bin');
// every module jev-route.mjs imports besides the app code the export already carries
const ROUTER_MODULES = ['jev-route.mjs', 'free-models.mjs', 'model-cooldown.mjs'];
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
// bwrap with an empty /proc makes Node report process.execPath as bare 'node' (no /proc/self/exe).
const NODE = path.isAbsolute(process.execPath) ? process.execPath
  : (process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, process.execPath))
    .find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || process.execPath;

const NOISE = /(^|\/)(node_modules|target|tests\/out)\/|\.bak|\.log$|(^|\/)\.env(?:\.(?!example$)[^/]*)?$|(^|\/)dev-skills\.mjs$|(^|\/)\.wtest/;
function copyTree(from, to, rel = '') {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name), r = path.posix.join(rel, entry.name), dst = path.join(to, entry.name);
    if (NOISE.test(`${r}/`)) continue;
    if (entry.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); copyTree(src, dst, r); }
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}
// public.txt is machine-local (gitignored), so this mirrors its four line forms.
function allowlist() {
  const keep = [], drop = [];
  for (const raw of fs.readFileSync(path.join(ROOT, 'public.txt'), 'utf8').split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('!')) { drop.push(line.slice(1).trim()); continue; }
    const [src, to] = line.split(/\s*=>\s*/);
    keep.push([src, to || src]);
  }
  return { keep, drop };
}
const glob = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');

function stageAllowlist(dest) {
  const { keep, drop } = allowlist(), dropped = drop.map(glob);
  const copy = (abs, rel, to) => {
    const st = fs.statSync(abs);
    if (st.isDirectory()) { for (const n of fs.readdirSync(abs)) copy(path.join(abs, n), `${rel}/${n}`, `${to}/${n}`); return; }
    if (NOISE.test(rel) || dropped.some((re) => re.test(rel))) return;
    fs.mkdirSync(path.dirname(path.join(dest, to)), { recursive: true });
    fs.copyFileSync(abs, path.join(dest, to));
  };
  for (const [src, to] of keep) if (fs.existsSync(path.join(ROOT, src))) copy(path.join(ROOT, src), src, to);
}

// temp HOME, no key, no machine paths: a staged export looks like a fresh install
function env(home) {
  fs.mkdirSync(path.join(home, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(home, 'harness.json'), '{}');
  fs.writeFileSync(path.join(home, 'env'), '');
  return { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
    AGENTGLIM_ENV_FILE: path.join(home, 'env'), AGENTGLIM_CONFIG: path.join(home, 'harness.json'),
    AGENTGLIM_WORK: home, AGENTGLIM_DATA: home, AGENTGLIM_PLANS: path.join(home, 'plans'),
    AGENTGLIM_PROJECTS: home, AGENTGLIM_DEV: '1', XDG_CACHE_HOME: path.join(home, 'cache'),
    MODEL_COOLDOWN_FILE: path.join(home, 'model-cooldown.ndjson') };
}
const run = (file, args, opts) => spawnSync(NODE, [file, ...args], { encoding: 'utf8', ...opts });

test('the Jev router and the two modules it imports are committed and staged', (t) => {
  const home = scratch(t, 'jev-export-files-'), dest = path.join(home, 'export');
  for (const file of ROUTER_MODULES)
    assert.ok(fs.existsSync(path.join(BIN, file)), `harness/bin/${file} must be committed: jev-route.mjs imports it`);
  fs.mkdirSync(path.join(dest, 'harness', 'bin'), { recursive: true });
  copyTree(path.join(ROOT, 'app'), path.join(dest, 'app'));
  fs.copyFileSync(path.join(ROOT, 'harness', 'config.mjs'), path.join(dest, 'harness', 'config.mjs'));
  for (const file of ROUTER_MODULES) fs.copyFileSync(path.join(BIN, file), path.join(dest, 'harness', 'bin', file));
  const router = path.join(dest, 'harness', 'bin', 'jev-route.mjs'), e = env(path.join(home, 'data'));
  const rules = run(router, ['--rules'], { cwd: dest, env: e });
  assert.equal(rules.status, 0, rules.stderr);
  const parsed = JSON.parse(rules.stdout);
  assert.ok(parsed.options['claude-sonnet'], 'the router reads its rules from the staged export');
  // the stage-0 gate runs offline too: free-models and model-cooldown load, the keywords rule answers
  const gate = run(router, ['--local-ok', 'rename a variable'], { cwd: dest, env: e });
  assert.equal(gate.status, 0, gate.stderr);
  const out = JSON.parse(gate.stdout.trim().split('\n').at(-1));
  assert.equal(out.localOk, true);
  assert.match(String(out.jevError), /JEV_API_KEY/, 'no key in the staged export, so the gate falls back to keywords');
});

test('the release allowlist carries everything the router imports', (t) => {
  if (!fs.existsSync(path.join(ROOT, 'public.txt')))
    return t.skip('no public.txt here (machine-local release allowlist, gitignored): the other tests cover the export');
  const home = scratch(t, 'jev-export-release-'), dest = path.join(home, 'export');
  stageAllowlist(dest);
  for (const file of ROUTER_MODULES)
    assert.ok(fs.existsSync(path.join(dest, 'harness', 'bin', file)), `public.txt must list harness/bin/${file}`);
  const router = path.join(dest, 'harness', 'bin', 'jev-route.mjs');
  const rules = run(router, ['--rules'], { cwd: dest, env: env(path.join(home, 'data')) });
  assert.equal(rules.status, 0, rules.stderr);
  assert.ok(JSON.parse(rules.stdout).options['claude-sonnet']);
  // the staged export itself is publishable: leak-scan finds nothing to hide
  const leak = run(path.join(dest, 'dev', 'leak-scan.mjs'), [dest, '--public', path.join(ROOT, 'public.txt'), '--env', path.join(home, 'env'), '--quiet'], { cwd: dest });
  assert.equal(leak.status, 0, `${leak.stdout}${leak.stderr}`);
});

test('jev-gate refuses a launch when the router cannot run', (t) => {
  const home = scratch(t, 'jev-gate-closed-'), dest = path.join(home, 'export');
  fs.mkdirSync(path.join(dest, 'tools', 'addons'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tools', 'addons', 'jev-gate'), path.join(dest, 'tools', 'addons', 'jev-gate'));
  // no harness/bin in this export: the router cannot start, which used to count as "Jev unavailable" -> allow
  const gate = path.join(dest, 'tools', 'addons', 'jev-gate'), e = env(path.join(home, 'data'));
  const check = spawnSync(PYTHON, [gate, 'check', 'rename a variable'], { cwd: dest, env: e, encoding: 'utf8' });
  assert.equal(check.status, 2, 'a routing failure must not be an allow (exit 0)');
  assert.match(check.stdout, /routing could not run/);
  assert.match(check.stdout, /jev-override/, 'the refusal names the escape hatch');
  const hook = (prompt) => spawnSync(PYTHON, [gate, 'claude'], { cwd: dest, env: e, encoding: 'utf8',
    input: JSON.stringify({ tool_input: { prompt, description: 'rename a variable' } }) });
  const denied = hook('rename a variable');
  assert.equal(denied.status, 0);
  const decision = JSON.parse(denied.stdout).hookSpecificOutput;
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /routing could not run/);
  const tagged = hook('[jev: claude-sonnet medium] rename a variable'); // explicit override still launches
  assert.equal(tagged.status, 0);
  assert.equal(tagged.stdout.trim(), '');
});

test('jev-gate allows the router fallback when Jev itself errors', (t) => {
  const home = scratch(t, 'jev-gate-fallback-'), dest = path.join(home, 'export');
  fs.mkdirSync(path.join(dest, 'tools', 'addons'), { recursive: true });
  fs.mkdirSync(path.join(dest, 'harness', 'bin'), { recursive: true });
  copyTree(path.join(ROOT, 'app'), path.join(dest, 'app'));
  fs.copyFileSync(path.join(ROOT, 'harness', 'config.mjs'), path.join(dest, 'harness', 'config.mjs'));
  for (const file of ROUTER_MODULES) fs.copyFileSync(path.join(BIN, file), path.join(dest, 'harness', 'bin', file));
  const gate = path.join(dest, 'tools', 'addons', 'jev-gate');
  fs.copyFileSync(path.join(ROOT, 'tools', 'addons', 'jev-gate'), gate);
  // the router answers with its fallback pick and "error" (no key), so the launch is routed, not refused
  const check = spawnSync(PYTHON, [gate, 'check', 'rename a variable'], { cwd: dest, env: env(path.join(home, 'data')), encoding: 'utf8' });
  assert.equal(check.status, 2, check.stderr);
  assert.match(check.stdout, /Jev picked/);
  assert.doesNotMatch(check.stdout, /routing could not run/);
});
