// v0.2.15b follow-up: armed means a fresh SuperAgent heartbeat (the listener is extra information), the shipped
// listener runs and only names shipped tools, one update path (`npm run update`), and CI/syntax coverage for the
// harness and tools folders. Each test uses a throwaway HOME so nothing private is read or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shellQuote } from '../paths.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { waitForServerReady } from './helpers/server-ready.mjs';
import { statusFrom } from '../update-check.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const LISTENER = path.join(REPO, 'harness', 'bin', 'auditq-wait.sh');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
// public-docs/ is published as docs/ in the export, so a release test reads whichever exists
const readDoc = (f) => { const local = path.join(REPO, f); return fs.readFileSync(fs.existsSync(local) ? local : path.join(REPO, f.replace(/^public-docs\//, 'docs/')), 'utf8'); };
const have = (cmd) => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;

const mk = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ag-v0215b- space ' $()-"));
  fs.writeFileSync(path.join(home, 'env'), '');
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'), AGENTGLIM_DATA: path.join(home, 'data'),
    AGENTGLIM_PLANS: path.join(home, 'plans'), AGENTGLIM_ENV_FILE: path.join(home, 'env'),
    AGENTGLIM_CONFIG: path.join(home, 'harness.json'), AGENTGLIM_DEV: '1', AGENTGLIM_DEV_WRITES: '1',
  };
  return { home, env, run: path.join(home, 'plans', '_run') };
};

const firstRun = (env, home) => {
  const answers = path.join(home, 'answers.json');
  fs.writeFileSync(answers, JSON.stringify({ harnesses: ['codex'], jev: false, apiDailyUsd: 5, goals: [{ title: 'Ship the demo', next_action: 'Write the list' }] }));
  return spawnSync(process.execPath, [path.join(REPO, 'tools/first-run.mjs'), 'apply', answers], { env, encoding: 'utf8', cwd: REPO });
};

const start = async (t, home, env) => {
  const srv = spawn(process.execPath, ['app/server.mjs', '0'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { srv.kill(); if (srv.exitCode === null) await once(srv, 'exit'); fs.rmSync(home, { recursive: true, force: true }); });
  return `http://127.0.0.1:${await waitForServerReady(srv)}`;
};

// The reported bug: after setup (which links auditq-wait.sh) the dot stayed "not armed" whatever the documented
// SuperAgent heartbeat did, because only the listener's own beat counted.
test('setup -> heartbeat -> armed: the SuperAgent heartbeat arms the header while the listener never ran', async (t) => {
  const { home, env, run } = mk();
  const r = firstRun(env, home);
  assert.equal(r.status, 0, r.stderr);
  const base = await start(t, home, env);
  const snap = async () => (await (await fetch(base + '/api/snapshot')).json()).watchers;
  let w = await snap();
  assert.equal(w.armed, false, 'setup alone is not armed');
  assert.equal(w.queue.ok, false, 'the listener is linked but not running yet');
  const heartbeat = path.join(env.AGENTGLIM_DATA, 'heartbeats', 'superagent'); // what AGENTS.md/SETUP.md tell the agent
  fs.mkdirSync(path.dirname(heartbeat), { recursive: true });
  fs.writeFileSync(heartbeat, '');
  w = await snap();
  assert.equal(w.armed, true, 'a fresh SuperAgent heartbeat is armed');
  assert.equal(w.superagent.ok, true);
  assert.equal(w.queue.ok, false, 'the listener is extra information, not the arming signal');
  assert.equal(w.startup.heartbeat, heartbeat);
  assert.equal(w.startup.command, `bash ${shellQuote(path.join(run, 'bin', 'auditq-wait.sh'))}`);
  assert.ok(fs.existsSync(path.join(run, 'bin', 'auditq-wait.sh')), 'setup linked the listener the snapshot names');
});

test('startup command -> Refresh -> listener -> status writer -> SuperAgent reply', async (t) => {
  const { home, env, run } = mk();
  assert.equal(firstRun(env, home).status, 0);
  env.AGENTGLIM_DEV = '0'; // Exercise the fresh install's automatic Goals jobs too.
  const base = await start(t, home, env);
  const goals = await (await fetch(base + '/api/goals/status')).json();
  assert.equal(goals.scheduler.enabled, true);
  assert.ok(goals.scheduler.jobs.find((j) => j.name === 'goals-weekly').lastRun, 'startup catch-up completed');
  assert.equal(goals.weekly.pending, null, 'the missing skill must not leave a scheduled chat');
  const startup = (await (await fetch(base + '/api/snapshot')).json()).watchers.startup;
  assert.doesNotMatch(startup.prompt, /\bMODE\b/);
  fs.mkdirSync(path.dirname(startup.heartbeat), { recursive: true });
  fs.writeFileSync(startup.heartbeat, '');
  // Use the exact copied command, including an apostrophe and shell metacharacters in this fixture's path.
  const listener = spawn('bash', ['-c', startup.command], {
    env: { ...env, AGENTGLIM_WAIT_POLL: '0.01', AGENTGLIM_WAIT_ROUNDS: '500' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => listener.kill());
  let output = '', errors = '';
  listener.stdout.on('data', (chunk) => { output += chunk; });
  listener.stderr.on('data', (chunk) => { errors += chunk; });
  const exited = once(listener, 'close');
  const response = await fetch(base + '/api/status-refresh', {
    method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(response.status, 200, await response.text());
  const [code] = await exited;
  assert.equal(code, 0, errors);
  assert.match(output, /^STATUS:/);
  fs.writeFileSync(env.AGENTGLIM_CONFIG, JSON.stringify({ status: { appUrl: base } }));
  const reply = spawnSync(process.execPath, [path.join(run, 'bin', 'status-write.mjs'), '--done', 'Refresh verified', '--next', 'Keep supervising'], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(reply.status, 0, reply.stderr);
  const poll = await (await fetch(base + '/api/status-ask')).json();
  assert.equal(poll.ask.state, 'answered');
  const answered = fs.readdirSync(path.join(run, 'status_ask')).find((f) => f.endsWith('.answered'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(run, 'status_ask', answered), 'utf8')).answeredBy, 'superagent');
  assert.ok(poll.ask.answeredAt);
  assert.equal(fs.readdirSync(path.join(run, 'status_ask')).filter((f) => f.endsWith('.json')).length, 0);
  const status = JSON.parse(fs.readFileSync(path.join(env.AGENTGLIM_DATA, 'status.json'), 'utf8'));
  assert.equal(status.source, 'asked');
  assert.equal(status.lines.done, 'Refresh verified');
  assert.equal((await (await fetch(base + '/api/snapshot')).json()).watchers.armed, true);
});

test('scaffold fallback wrappers execute guarded CLIs and remain current on a second refresh', (t) => {
  const { home, env, run } = mk();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const preload = path.join(home, 'no-symlinks.mjs');
  fs.writeFileSync(preload, "import fs from 'node:fs'; fs.symlinkSync = () => { throw Object.assign(new Error('no links'), { code: 'EPERM' }); };\n");
  const scaffold = () => spawnSync(process.execPath, ['--import', preload, path.join(REPO, 'tools/scaffold-harness.mjs')], { env, encoding: 'utf8' });
  const result = scaffold();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.lstatSync(path.join(run, 'bin', 'harness-set.mjs')).isSymbolicLink(), false);
  const keys = spawnSync(process.execPath, [path.join(run, 'bin', 'harness-set.mjs'), 'keys'], { env, encoding: 'utf8' });
  assert.equal(keys.status, 0, keys.stderr);
  assert.ok(JSON.parse(keys.stdout).values, 'the guarded CLI actually ran');
  assert.match(scaffold().stdout, /0 created, 0 refreshed/);
  const dest = path.join(run, 'bin', 'harness-set.mjs');
  const oldSource = path.join(home, 'old-checkout', 'harness', 'bin', 'harness-set.mjs');
  fs.writeFileSync(dest, `// Generated by scaffold-harness: run the packaged tool in place.\nimport { pathToFileURL } from 'node:url';\nawait import(pathToFileURL(${JSON.stringify(oldSource)}).href);\n`);
  assert.match(scaffold().stdout, /1 refreshed/);
  const upgraded = spawnSync(process.execPath, [dest, 'keys'], { env, encoding: 'utf8' });
  assert.equal(upgraded.status, 0, upgraded.stderr);
  assert.ok(JSON.parse(upgraded.stdout).values, 'pre-manifest Windows wrappers upgrade too');
});

// The listener must not name scripts that are not shipped, and its hints must use the run folder it resolved.
test('the shipped listener runs: STATUS and PENDING use the resolved run folder, mode_queue names no unshipped script', (t) => {
  const bash = spawnSync('bash', ['-c', 'true'], { encoding: 'utf8' });
  if (bash.status !== 0) return t.skip('bash is not available here');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag listen-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = (name) => {
    const run = path.join(root, name);
    for (const d of ['audit_queue', 'status_ask', 'chat_inbox', 'owner_check', 'watchdog_queue', 'mode_queue', 'heartbeats']) fs.mkdirSync(path.join(run, d), { recursive: true });
    return run;
  };
  const wait = (run) => spawnSync('bash', [LISTENER], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, AGENTGLIM_RUN: run, AGENTGLIM_PLANS: path.join(root, 'plans'), AGENTGLIM_WAIT_ROUNDS: '2', AGENTGLIM_WAIT_POLL: '0' },
  });

  const modes = dir('modes');
  fs.writeFileSync(path.join(modes, 'mode_queue', '7.json'), '{}');
  let r = wait(modes);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /NONE \(re-arm\)/, 'a mode click does not wake the listener: there is no mode handler to run');
  assert.doesNotMatch(r.stdout, /MODE:/);
  assert.doesNotMatch(r.stdout, /modes\.mjs/);
  assert.ok(fs.existsSync(path.join(modes, 'heartbeats', 'auditq-wait')), 'the listener leaves its own beat');

  const asks = dir('asks');
  const staleChat = path.join(asks, 'chat_inbox', '1600000000000.json');
  fs.writeFileSync(staleChat, JSON.stringify({ from: 'goals-app', text: 'Run the weekly goals review (scheduled).' }));
  fs.writeFileSync(path.join(asks, 'status_ask', '1700000000000.json'), '{}');
  r = wait(asks);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^STATUS: 1700000000000\.json/);
  assert.doesNotMatch(r.stdout, /^CHAT:/m, 'Refresh takes precedence over a stale scheduled chat');
  assert.ok(fs.existsSync(staleChat), 'prioritizing Refresh preserves the unanswered chat');
  assert.ok(r.stdout.includes(`node ${path.join(asks, 'bin', 'status-write.mjs').replaceAll(' ', '\\ ')}`), 'the hint names this run folder');
  assert.doesNotMatch(r.stdout, /_run\/bin/);
  assert.doesNotMatch(r.stdout, /modes\.mjs/);

  const pending = dir('pending');
  fs.writeFileSync(path.join(pending, 'audit_queue', '01-demo__job.req'), 'role=worker\n');
  r = wait(pending);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^PENDING: 01-demo__job/);
  assert.match(r.stdout, /Claude 5h/);
  assert.doesNotMatch(r.stdout, /modes\.mjs/, 'the PENDING hint must not call a decline helper that is not shipped');
  assert.doesNotMatch(r.stdout, /_run\/bin/);
});

test('CI syntax-checks the harness scripts and the tools too', () => {
  const ci = read('.github/workflows/ci.yml');
  const step = ci.slice(ci.indexOf('- name: syntax check'), ci.indexOf('- name: unit tests'));
  assert.match(step, /harness\/\*\.mjs/);
  assert.match(step, /harness\/bin\/\*\.mjs/);
  assert.match(step, /tools\/\*\.mjs/);
  assert.match(step, /bash -n/, 'the shipped shell scripts are parsed as well');
  const script = step.split('run: |')[1].split('\n').map((line) => line.trim()).join('\n');
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], { cwd: REPO, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

// One update path: pull main with --ff-only, then re-link the tools and refresh the copied hints.
test('npm run update pulls main (fast-forward only) and re-links the run folder tools', (t) => {
  if (!have('git')) return t.skip('git is not available here');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const g = (cwd, ...args) => {
    const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=test', '-c', 'commit.gpgsign=false', ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-global') }, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  // a checkout with the update tools, an app folder scaffold needs, and a tag-free history: base -> v1
  const src = path.join(root, 'src');
  for (const d of ['tools', 'harness/bin', 'skills/agentglim-setup', 'app']) fs.mkdirSync(path.join(src, d), { recursive: true });
  for (const f of ['update.mjs', 'refresh-integrations.mjs', 'install-agent-hints.mjs', 'scaffold-harness.mjs']) fs.copyFileSync(path.join(REPO, 'tools', f), path.join(src, 'tools', f));
  fs.copyFileSync(path.join(REPO, 'skills', 'agentglim-setup', 'SKILL.md'), path.join(src, 'skills', 'agentglim-setup', 'SKILL.md'));
  for (const f of ['paths.mjs', 'settings.mjs', 'settings.defaults.json']) fs.copyFileSync(path.join(REPO, 'app', f), path.join(src, 'app', f));
  for (const f of ['status-write.mjs', 'chat-write.mjs', 'owner-check.mjs', 'harness-set.mjs', 'io-guard.sh', 'auditq-wait.sh', 'jev-route.mjs']) fs.copyFileSync(path.join(REPO, 'harness', 'bin', f), path.join(src, 'harness', 'bin', f));
  fs.writeFileSync(path.join(src, 'version.txt'), 'v0\n');
  g(src, 'init', '-q', '-b', 'main'); g(src, 'add', '-A'); g(src, 'commit', '-qm', 'base');
  const clone = path.join(root, 'clone');
  g(root, 'clone', '-q', '--branch', 'main', src, clone);
  fs.writeFileSync(path.join(src, 'version.txt'), 'v1\n');
  g(src, 'commit', '-qam', 'the new release');
  assert.equal(fs.readFileSync(path.join(clone, 'version.txt'), 'utf8').trim(), 'v0');

  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const run = path.join(root, 'run');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-global'), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), AGENTGLIM_DATA: path.join(home, 'data'), AGENTGLIM_PLANS: path.join(home, 'plans'), AGENTGLIM_RUN: run, AGENTGLIM_CONFIG: path.join(home, 'harness.json'), AGENTGLIM_ENV_FILE: path.join(home, 'env') };
  fs.writeFileSync(env.AGENTGLIM_CONFIG, '{}'); fs.writeFileSync(env.AGENTGLIM_ENV_FILE, '');
  const skill = path.join(home, '.agents', 'skills', 'agentglim-setup', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true }); fs.writeFileSync(skill, 'old skill');
  const hints = path.join(home, '.codex', 'AGENTS.md');
  fs.mkdirSync(path.dirname(hints), { recursive: true });
  fs.writeFileSync(hints, 'My own instructions\n<!-- agentglim:start -->\nold note\n<!-- agentglim:end -->\n');
  fs.mkdirSync(env.AGENTGLIM_DATA, { recursive: true });
  const privateFile = path.join(env.AGENTGLIM_DATA, 'keep.json'); fs.writeFileSync(privateFile, '{"keep":true}');
  let r = spawnSync(process.execPath, [path.join(clone, 'tools', 'update.mjs')], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(fs.readFileSync(path.join(clone, 'version.txt'), 'utf8').trim(), 'v1', 'the checkout was updated');
  assert.match(r.stdout, /git pull --ff-only/);
  assert.ok(fs.existsSync(path.join(run, 'bin', 'auditq-wait.sh')), 'the run folder tools were re-linked');
  assert.match(r.stdout, /Restart AgentGlim/);
  assert.equal(fs.readFileSync(skill, 'utf8'), read('skills/agentglim-setup/SKILL.md'));
  assert.match(fs.readFileSync(hints, 'utf8'), /^My own instructions/);
  assert.doesNotMatch(fs.readFileSync(hints, 'utf8'), /old note/);
  assert.equal(fs.readFileSync(privateFile, 'utf8'), '{"keep":true}');

  // not on main: the one supported update path says so instead of pulling something else
  g(clone, 'checkout', '-q', '-b', 'feature');
  r = spawnSync(process.execPath, [path.join(clone, 'tools', 'update.mjs')], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /git checkout main/);

  // a dry run previews and pulls nothing
  g(clone, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(src, 'version.txt'), 'v2\n');
  g(src, 'commit', '-qam', 'v2');
  r = spawnSync(process.execPath, [path.join(clone, 'tools', 'update.mjs'), '--dry-run'], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /dry run/);
  assert.equal(fs.readFileSync(path.join(clone, 'version.txt'), 'utf8').trim(), 'v1', 'a dry run does not pull');

  fs.writeFileSync(path.join(clone, 'version.txt'), 'my local edit\n');
  fs.writeFileSync(skill, 'my local skill edit');
  r = spawnSync(process.execPath, [path.join(clone, 'tools', 'update.mjs')], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /git pull --ff-only failed/);
  assert.equal(fs.readFileSync(path.join(clone, 'version.txt'), 'utf8'), 'my local edit\n');
  assert.equal(fs.readFileSync(skill, 'utf8'), 'my local skill edit', 'failed pull does not refresh integrations');

  // An archive nested inside another checkout must not accidentally update the parent repository.
  const nested = path.join(clone, 'archive', 'tools'); fs.mkdirSync(nested, { recursive: true });
  fs.copyFileSync(path.join(REPO, 'tools', 'update.mjs'), path.join(nested, 'update.mjs'));
  r = spawnSync(process.execPath, [path.join(nested, 'update.mjs')], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not a git checkout/);
  assert.equal(fs.readFileSync(skill, 'utf8'), 'my local skill edit');
});

test('one update method in the docs, no placeholder clone URL, no owner notes in the public AGENTS.md', () => {
  const install = readDoc('public-docs/install.md'), readme = read('README.md'), setup = read('SETUP.md'), agents = read('AGENTS.md');
  assert.match(install, /git clone https:\/\/github\.com\/AgentGlim\/agentglim\.git/);
  assert.doesNotMatch(install, /<you>/, 'no placeholder clone URL');
  assert.match(install, /Linux, macOS and Windows/, 'the platforms it actually runs on');
  assert.match(install, /npm run update/);
  assert.doesNotMatch(install, /git checkout vX\.Y\.Z/, 'no second update method');
  assert.doesNotMatch(readme, /Known gaps before this goes public/);
  assert.match(readme, /npm run update/);
  assert.doesNotMatch(readme, /Release-tag checkouts and tarballs need different steps/);
  assert.match(setup, /^## Update$/m); assert.match(setup, /npm run update/); assert.match(setup, /git pull --ff-only/);
  for (const doc of [readme, setup]) assert.match(doc, /On v0\.2\.14 or older, run `git pull --ff-only` first, then `npm run update`, then restart AgentGlim\./);
  assert.equal(JSON.parse(read('package.json')).scripts.update, 'node tools/update.mjs');
  assert.equal(statusFrom({ current: 'v0.2.14', cache: { latest: 'v0.2.15', url: 'https://github.com/AgentGlim/agentglim/releases/tag/v0.2.15' } }).howTo.git, 'git pull --ff-only && npm run update');
  assert.doesNotMatch(agents, /## Applied learning/, 'owner learnings stay out of the public note');
  assert.doesNotMatch(agents, /agent\.sh/);
  assert.doesNotMatch(agents, /plans\/_run\/bin/);
  // public.txt is a private allowlist: present in the owner's checkout, absent from a public export
  if (fs.existsSync(path.join(REPO, 'public.txt'))) assert.doesNotMatch(read('public.txt'), /OWNER-LEARNINGS/);
});
