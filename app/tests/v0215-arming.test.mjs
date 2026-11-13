// v0.2.15: fresh-install journey (setup -> refresh -> status_ask queued), optional modes.json, honest setup
// (saved vs ready), restart notice when the plans path changes, and update refresh of managed scripts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shellQuote } from '../paths.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import crypto from 'node:crypto';
const require_sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
import { waitForServerReady } from './helpers/server-ready.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const mk = (extra = {}) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v0215-'));
  fs.writeFileSync(path.join(home, 'env'), '');
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    AGENTGLIM_DATA: path.join(home, 'data'), AGENTGLIM_PLANS: path.join(home, 'plans'), AGENTGLIM_ENV_FILE: path.join(home, 'env'),
    AGENTGLIM_CONFIG: path.join(home, 'harness.json'), AGENTGLIM_DEV: '1', AGENTGLIM_DEV_WRITES: '1', ...extra };
  return { home, env, run: extra.AGENTGLIM_RUN || path.join(home, 'plans', '_run') };
};
const cli = (env, ...args) => spawnSync(process.execPath, [path.join(REPO, 'tools/first-run.mjs'), ...args], { env, encoding: 'utf8', cwd: REPO });
const answers = (home) => { const f = path.join(home, 'answers.json'); fs.writeFileSync(f, JSON.stringify({ harnesses: ['codex'], jev: false, apiDailyUsd: 5, goals: [{ title: 'Ship the demo', next_action: 'Write the list' }] })); return f; };
const start = async (t, home, env) => {
  const srv = spawn(process.execPath, ['app/server.mjs', '0'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; srv.stderr.on('data', (c) => { errors += c; });
  t.after(async () => { srv.kill(); if (srv.exitCode === null) await once(srv, 'exit'); fs.rmSync(home, { recursive: true, force: true }); });
  const port = await waitForServerReady(srv);
  return { base: `http://127.0.0.1:${port}`, errors: () => errors };
};

test('fresh install smoke: first-run apply -> Refresh status -> status_ask queued, no modes.json needed', async (t) => {
  const { home, env, run } = mk();
  const r = cli(env, 'apply', answers(home)); assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout); assert.equal(out.ready, true); assert.equal(out.setupComplete, true);
  assert.equal(fs.existsSync(path.join(run, 'modes.json')), false, 'a fresh scaffold has no modes.json');
  const { base, errors } = await start(t, home, env);
  const refresh = await fetch(base + '/api/status-refresh', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(refresh.status, 200, await refresh.clone().text() + errors());
  const asks = fs.readdirSync(path.join(run, 'status_ask')).filter((f) => /^\d+\.json$/.test(f));
  assert.equal(asks.length, 1, 'one status_ask is queued for the SuperAgent');
  assert.equal(JSON.parse(fs.readFileSync(path.join(run, 'status_ask', asks[0]), 'utf8')).source, 'status-refresh');
  const status = JSON.parse(fs.readFileSync(path.join(env.AGENTGLIM_DATA, 'status.json'), 'utf8'));
  assert.equal(status.source, 'live'); assert.match(status.lines.running, /Codex mode: unknown/);
  // listener installed but never started: the snapshot carries the exact command and prompt for the Copy button
  const snap = await (await fetch(base + '/api/snapshot')).json();
  assert.equal(snap.watchers.queue.ok, false);
  assert.equal(snap.driverInstalled, false, 'no driver files, so the page must not say "Driver is off"');
  assert.equal(snap.watchers.startup.command, `bash ${shellQuote(path.join(run, 'bin', 'auditq-wait.sh'))}`);
  assert.match(snap.watchers.startup.prompt, /Refresh/); assert.ok(snap.watchers.startup.prompt.includes(snap.watchers.startup.heartbeat));
  assert.equal(snap.watchers.startup.heartbeat, path.join(env.AGENTGLIM_DATA, 'heartbeats', 'superagent'));
  // the page: plain notice text, Copy button, driver line only with a driver installed
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /Dashboard listener not running\. Ask your agent to start it\./);
  assert.match(html, /Copy startup prompt/); assert.match(html, /driverInstalled/);
});

test('Refresh status tolerates a missing, empty or broken modes.json', async (t) => {
  const { home, env, run } = mk();
  assert.equal(cli(env, 'apply', answers(home)).status, 0);
  const { base } = await start(t, home, env);
  const post = () => fetch(base + '/api/status-refresh', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await post()).status, 200);
  fs.writeFileSync(path.join(run, 'modes.json'), '');
  assert.equal((await post()).status, 200);
  fs.writeFileSync(path.join(run, 'modes.json'), '{not json');
  assert.equal((await post()).status, 200);
  fs.writeFileSync(path.join(run, 'modes.json'), JSON.stringify({ harness: 'normal', subs: { codex: { mode: 'fast' } } }));
  assert.equal((await post()).status, 200);
  assert.match(JSON.parse(fs.readFileSync(path.join(env.AGENTGLIM_DATA, 'status.json'), 'utf8')).lines.running, /Codex mode: fast/);
});

test('/api/setup separates Saved from Ready and shows the scaffold error', async (t) => {
  const blocker = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v0215-block-')); // a FILE where the run folder must go
  fs.writeFileSync(path.join(blocker, 'file'), 'x');
  const { home, env } = mk({ AGENTGLIM_RUN: path.join(blocker, 'file', 'run') });
  t.after(() => fs.rmSync(blocker, { recursive: true, force: true }));
  const { base } = await start(t, home, env);
  fs.writeFileSync(path.join(env.AGENTGLIM_DATA, 'setup-complete'), 'earlier successful setup');
  const cfg = (await (await fetch(base + '/api/setup')).json()).config;
  const res = await fetch(base + '/api/setup', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ ...cfg, budget: { apiDailyUsd: 4 } }) });
  const j = await res.json();
  assert.equal(j.saved, true); assert.equal(j.ready, false); assert.equal(j.ok, false); assert.equal(j.scaffold.ok, false);
  assert.match(j.error, /Settings saved, but linking the SuperAgent tools failed/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.AGENTGLIM_DATA, 'setup.json'), 'utf8')).budget.apiDailyUsd, 4, 'the choices are saved');
  assert.equal(JSON.parse(cli(env, 'status').stdout).setupDone, false, 'an old marker cannot hide the failed scaffold');
  const html = await (await fetch(base + '/setup')).text();
  assert.match(html, /Saved, but not ready/); assert.match(html, /Saved and ready/);
});

test('first-run apply records completion only after the tools are linked, and retries', () => {
  const blocker = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v0215-block-'));
  fs.writeFileSync(path.join(blocker, 'file'), 'x');
  const { home, env } = mk({ AGENTGLIM_RUN: path.join(blocker, 'file', 'run') });
  try {
    const ans = answers(home);
    const r = cli(env, 'apply', ans);
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false); assert.equal(out.ready, false); assert.equal(out.setupComplete, false); assert.match(out.error, /not complete/);
    assert.equal(fs.existsSync(path.join(env.AGENTGLIM_DATA, 'setup-complete')), false, 'no marker after a failed scaffold');
    assert.equal(JSON.parse(fs.readFileSync(path.join(env.AGENTGLIM_DATA, 'setup.json'), 'utf8')).setupComplete, false);
    const st = JSON.parse(cli(env, 'status').stdout);
    assert.equal(st.setupDone, false); assert.ok(st.questions.includes('harnesses'), 'the next SuperAgent start retries setup');
    // fixed: same answers, now with a usable run folder
    const ok = cli({ ...env, AGENTGLIM_RUN: path.join(home, 'run') }, 'apply', ans);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).setupComplete, true);
    assert.ok(fs.existsSync(path.join(env.AGENTGLIM_DATA, 'setup-complete')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(env.AGENTGLIM_DATA, 'setup.json'), 'utf8')).setupComplete, true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(blocker, { recursive: true, force: true }); }
});

test('first-run paths is the one resolved source; a changed plans path needs a restart', async (t) => {
  const { home, env, run } = mk();
  const p = JSON.parse(cli(env, 'paths').stdout);
  assert.equal(p.data, env.AGENTGLIM_DATA); assert.equal(p.run, run);
  assert.equal(p.heartbeat, path.join(env.AGENTGLIM_DATA, 'heartbeats', 'superagent'));
  assert.equal(p.waitCommand, `bash ${shellQuote(path.join(run, 'bin', 'auditq-wait.sh'))}`);
  assert.equal(p.restartNeeded, false);
  // with no env override for plans, the saved Setup path is what a restart would use
  const free = { ...env }; delete free.AGENTGLIM_PLANS;
  assert.equal(JSON.parse(cli(free, 'paths').stdout).plans, path.join(env.AGENTGLIM_DATA, 'plans'));
  const { base } = await start(t, home, free);
  const cfg = (await (await fetch(base + '/api/setup')).json()).config;
  assert.equal((await (await fetch(base + '/api/setup')).json()).paths.restartNeeded, false);
  const elsewhere = path.join(home, 'elsewhere');
  const j = await (await fetch(base + '/api/setup', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ ...cfg, plans: { path: elsewhere } }) })).json();
  assert.equal(j.restartNeeded, true); assert.equal(j.paths.configuredPlans, elsewhere);
  assert.equal((await (await fetch(base + '/api/setup')).json()).paths.restartNeeded, true, 'still flagged after a page reload');
  const html = await (await fetch(base + '/setup')).text(); assert.match(html, /Restart AgentGlim/);
});

test('scaffold refreshes managed links, unedited copies and the old note; keeps your own files', () => {
  const { home, env } = mk();
  try {
    const run = path.join(home, 'run'), scaffold = () => spawnSync(process.execPath, [path.join(REPO, 'tools/scaffold-harness.mjs'), '--run', run], { env, encoding: 'utf8' });
    assert.equal(scaffold().status, 0);
    const bin = path.join(run, 'bin');
    // 1) a link into an older checkout location
    const old = path.join(home, 'old-checkout', 'harness', 'bin'); fs.mkdirSync(old, { recursive: true }); fs.writeFileSync(path.join(old, 'status-write.mjs'), 'old');
    fs.rmSync(path.join(bin, 'status-write.mjs')); fs.symlinkSync(path.join(old, 'status-write.mjs'), path.join(bin, 'status-write.mjs'));
    // 2) an unedited copy we made earlier (recorded in the manifest) and 3) a file of your own
    fs.rmSync(path.join(bin, 'io-guard.sh')); fs.writeFileSync(path.join(bin, 'io-guard.sh'), 'older shipped copy');
    fs.writeFileSync(path.join(bin, '.agentglim-managed.json'), JSON.stringify({ 'io-guard.sh': require_sha(Buffer.from('older shipped copy')) }));
    fs.rmSync(path.join(bin, 'chat-write.mjs')); fs.writeFileSync(path.join(bin, 'chat-write.mjs'), 'my own version');
    // 4) the note an earlier version wrote, without the managed marker
    fs.writeFileSync(path.join(run, 'AGENTGLIM-HARNESS.md'), '# AgentGlim run folder\n\nThis folder is optional. Old text.\n');
    const r = scaffold(); assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /3 refreshed/);
    assert.equal(path.basename(fs.readlinkSync(path.join(bin, 'status-write.mjs'))), 'status-write.mjs');
    assert.ok(path.resolve(bin, fs.readlinkSync(path.join(bin, 'status-write.mjs'))).startsWith(REPO), 'link points at this checkout');
    assert.notEqual(fs.readFileSync(path.join(bin, 'io-guard.sh'), 'utf8'), 'older shipped copy');
    assert.equal(fs.readFileSync(path.join(bin, 'chat-write.mjs'), 'utf8'), 'my own version');
    const note = fs.readFileSync(path.join(run, 'AGENTGLIM-HARNESS.md'), 'utf8');
    assert.match(note, /agentglim-managed/); assert.match(note, /re-run it again after every exit|run it again after every exit/i); assert.match(note, /first-run\.mjs.* paths/);
    assert.ok(fs.readdirSync(run).some((f) => f.startsWith('AGENTGLIM-HARNESS.md.bak-')), 'the old note is kept as a backup');
    assert.match(scaffold().stdout, /0 created, 0 refreshed/, 'a second run changes nothing');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('refresh-integrations updates existing copies only and never creates new ones', () => {
  const { home, env } = mk();
  try {
    const run = path.join(home, 'run'), e = { ...env, AGENTGLIM_RUN: run };
    // nothing installed yet: nothing is created in the harness folders
    let r = spawnSync(process.execPath, [path.join(REPO, 'tools/refresh-integrations.mjs')], { env: e, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); assert.equal(fs.existsSync(path.join(home, '.codex')), false); assert.equal(fs.existsSync(path.join(home, '.agents')), false);
    // an old install: stale skill copy and stale marked note
    const skill = path.join(home, '.agents', 'skills', 'agentglim-setup', 'SKILL.md'); fs.mkdirSync(path.dirname(skill), { recursive: true }); fs.writeFileSync(skill, 'stale skill');
    const codex = path.join(home, '.codex', 'AGENTS.md'); fs.mkdirSync(path.dirname(codex), { recursive: true });
    fs.writeFileSync(codex, 'mine\n\n<!-- agentglim:start -->\nold note\n<!-- agentglim:end -->\n');
    r = spawnSync(process.execPath, [path.join(REPO, 'tools/refresh-integrations.mjs')], { env: e, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(skill, 'utf8'), fs.readFileSync(path.join(REPO, 'skills/agentglim-setup/SKILL.md'), 'utf8'));
    const note = fs.readFileSync(codex, 'utf8');
    assert.ok(note.startsWith('mine\n')); assert.doesNotMatch(note, /old note/); assert.match(note, /first-run\.mjs paths/);
    assert.equal(fs.existsSync(path.join(home, '.claude')), false, 'Claude Code was not installed here: nothing created');
    assert.ok(fs.existsSync(path.join(run, 'bin', 'auditq-wait.sh')));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('SuperAgent instructions: resolved paths, own session, re-arm, verified Refresh; no unbound $AGENTGLIM_DATA', () => {
  const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
  for (const f of ['AGENTS.md', 'skills/agentglim-setup/SKILL.md']) {
    const t = read(f);
    assert.match(t, /first-run\.mjs paths/, f); assert.match(t, /auditq-wait\.sh/, f); assert.match(t, /re-run/i, f); assert.match(t, /Refresh/, f);
  }
  const skill = read('skills/agentglim-setup/SKILL.md');
  assert.doesNotMatch(skill, /\$AGENTGLIM_DATA\/heartbeats/, 'the unbound variable form wrote to /heartbeats');
  assert.match(skill, /session whose output you read/);
  assert.match(read('tools/scaffold-harness.mjs'), /Arming the SuperAgent/);
  assert.match(read('README.md'), /`~\/\.agentglim`/); assert.doesNotMatch(read('README.md'), /\.local\/share\/agentglim/);
  assert.match(read('SETUP.md'), /^## Update$/m); assert.match(read('SETUP.md'), /git pull --ff-only/);
});
