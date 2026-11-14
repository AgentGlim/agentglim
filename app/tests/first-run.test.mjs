import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { waitForServerReady } from './helpers/server-ready.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
// a Windows checkout (Git for Windows and GitHub's Windows runners: core.autocrlf=true) has CRLF line ends
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\r\n/g, '\n');
const reEscape = (s) => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
const mk = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-firstrun-'));
  fs.writeFileSync(path.join(home, 'env'), '');
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    AGENTGLIM_DATA: path.join(home, 'data'), AGENTGLIM_PLANS: path.join(home, 'plans'), AGENTGLIM_ENV_FILE: path.join(home, 'env'),
    AGENTGLIM_CONFIG: path.join(home, 'harness.json'), AGENTGLIM_DEV: '1' };
  return { home, env };
};
const cli = (env, ...args) => spawnSync(process.execPath, [path.join(REPO, 'tools/first-run.mjs'), ...args], { env, encoding: 'utf8', cwd: REPO });

test('repo AGENTS.md and CLAUDE.md tell any agent what AgentGlim is and how to run the SuperAgent', () => {
  for (const f of ['AGENTS.md', 'CLAUDE.md']) {
    const t = read(f);
    assert.match(t, /SuperAgent/); assert.match(t, /skills\/agentglim-setup\/SKILL\.md/);
  }
  assert.match(read('CLAUDE.md'), /^@AGENTS\.md/);
  const a = read('AGENTS.md');
  assert.match(a, /one question at a time/); assert.match(a, /first-run\.mjs/); assert.match(a, /heartbeats\/superagent/);
  const skill = read('skills/agentglim-setup/SKILL.md');
  assert.match(skill, /^---\nname: agentglim-setup/); assert.match(skill, /be the SuperAgent/i);
  assert.match(skill, /one question at a time/i); assert.match(skill, /Codex/); assert.match(skill, /Claude Code/);
  assert.match(skill, /not the Harness page/);
  if (fs.existsSync(path.join(REPO, 'public.txt'))) for (const f of ['CLAUDE.md', 'tools/first-run.mjs', 'tools/install-agent-hints.mjs']) assert.match(read('public.txt'), new RegExp(`^${f.replace('.', '\\.')}$`, 'm'));
});

test('first-run status asks for everything on a fresh machine; apply saves setup, goals and links tools', (t) => {
  const { home, env } = mk(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const s0 = JSON.parse(cli(env, 'status').stdout);
  assert.equal(s0.needsSetup, true);
  assert.deepEqual(s0.questions, ['harnesses', 'jev', 'budget', 'goals']);
  assert.ok(s0.harnesses.some((h) => h.id === 'codex') && s0.harnesses.some((h) => h.id === 'claude'));
  const ans = path.join(home, 'answers.json');
  fs.writeFileSync(ans, JSON.stringify({ harnesses: ['codex'], jev: false, apiDailyUsd: 7, goals: [{ title: 'Ship the demo app', next_action: 'Write the list', metric: 'Users' }, 'Learn Rust'] }));
  const r = cli(env, 'apply', ans); assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true); assert.deepEqual(out.setup.harnesses, ['codex']);
  const setup = JSON.parse(fs.readFileSync(path.join(env.AGENTGLIM_DATA, 'setup.json'), 'utf8'));
  assert.equal(setup.setupComplete, true); assert.equal(setup.harnesses.codex, true); assert.equal(setup.harnesses.claude, false); assert.equal(setup.budget.apiDailyUsd, 7); assert.equal(setup.jev.on, false);
  assert.ok(fs.existsSync(path.join(env.AGENTGLIM_DATA, 'setup-complete')));
  const goals = JSON.parse(fs.readFileSync(path.join(env.AGENTGLIM_DATA, 'goals/goals.json'), 'utf8'));
  assert.deepEqual(goals.goals.map((g) => g.id), ['ship_the_demo_app', 'learn_rust']);
  assert.equal(goals.goals.reduce((n, g) => n + g.allocation, 0), 100);
  assert.equal(goals.metrics[0].goal, 'ship_the_demo_app');
  assert.ok(fs.existsSync(path.join(env.AGENTGLIM_DATA, 'goals-context.json')));
  for (const f of ['auditq-wait.sh', 'status-write.mjs', 'chat-write.mjs']) assert.ok(fs.existsSync(path.join(home, 'plans/_run/bin', f)), f);
  const s1 = JSON.parse(cli(env, 'status').stdout);
  assert.equal(s1.needsSetup, false); assert.deepEqual(s1.questions, []);
  assert.equal(cli(env, 'apply', '-').status, 1); // bad input is refused, nothing thrown
});

test('bundled example goals still count as "no goals yet"; an empty goal list is refused', (t) => {
  const { home, env } = mk(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(env.AGENTGLIM_DATA, 'goals'), { recursive: true });
  for (const n of ['goals.json', 'goal-map.json']) fs.copyFileSync(path.join(REPO, 'app/defaults/goals', n), path.join(env.AGENTGLIM_DATA, 'goals', n));
  assert.ok(JSON.parse(cli(env, 'status').stdout).questions.includes('goals'));
  const bad = path.join(home, 'bad.json'); fs.writeFileSync(bad, JSON.stringify({ goals: [] }));
  const r = cli(env, 'apply', bad); assert.equal(r.status, 1); assert.match(r.stderr, /at least one goal/);
});

test('global note installer is idempotent, keeps the user\'s own text and backs the file up once', (t) => {
  const { home } = mk(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.codex')); fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.codex/AGENTS.md'), '# mine\n- keep me\n');
  const run = () => spawnSync(process.execPath, [path.join(REPO, 'tools/install-agent-hints.mjs'), '--home', home], { encoding: 'utf8' });
  assert.equal(run().status, 0);
  const a1 = fs.readFileSync(path.join(home, '.codex/AGENTS.md'), 'utf8');
  assert.match(a1, /^# mine\n- keep me\n/); assert.match(a1, /be the SuperAgent/); assert.match(a1, new RegExp(reEscape(REPO)));
  assert.equal(fs.readFileSync(path.join(home, '.codex/AGENTS.md.agentglim.bak'), 'utf8'), '# mine\n- keep me\n');
  const c1 = fs.readFileSync(path.join(home, '.claude/CLAUDE.md'), 'utf8');
  run();
  assert.equal(fs.readFileSync(path.join(home, '.codex/AGENTS.md'), 'utf8'), a1);
  assert.equal(fs.readFileSync(path.join(home, '.claude/CLAUDE.md'), 'utf8'), c1);
  assert.equal(a1.split('agentglim:start').length, 2);
  for (const d of ['.claude/skills', '.agents/skills']) assert.ok(fs.existsSync(path.join(home, d, 'agentglim-setup/SKILL.md')));
  // a harness that is not installed is not created
  const h2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-hints2-')); t.after(() => fs.rmSync(h2, { recursive: true, force: true }));
  spawnSync(process.execPath, [path.join(REPO, 'tools/install-agent-hints.mjs'), '--home', h2]);
  assert.equal(fs.existsSync(path.join(h2, '.codex')), false);
});

test('Setup page layout: Harnesses and Jev open, five collapsed sections, no Optional add-ons', () => {
  const html = read('app/setup.html');
  assert.doesNotMatch(html, /Optional add-ons/); assert.doesNotMatch(html, /id="addonList"/);
  const order = [...html.matchAll(/<(section|details) class="card" id="(\w+)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(order.map((o) => o[1]), ['intro', 'harnesses', 'jev', 'free', 'media', 'custom', 'other', 'budget']);
  assert.deepEqual(order.filter((o) => o[0] === 'details').map((o) => o[1]), ['free', 'media', 'custom', 'other', 'budget']);
  assert.ok(order.filter((o) => o[0] === 'section').map((o) => o[1]).includes('harnesses'));
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  for (const t of ['Free APIs and accounts', 'Paid APIs', 'Custom projects', 'Local AI', 'Default budget']) assert.match(html, new RegExp(`<summary><h2>${t}</h2></summary>`));
  assert.doesNotMatch(html, /<h2>7\. Other<\/h2>/);
  assert.match(html, /id="subs"/); // plans/subscriptions stay, inside the Harnesses card
  assert.match(html, /href="\/dependencies"/); // the dependency report link moved to Local AI
  assert.ok(html.indexOf('id="harnesses"') < html.indexOf('id="jev"') && html.indexOf('id="jev"') < html.indexOf('id="free"'));
});

test('first launch serves the normal dashboard (no redirect to Harness) and Setup still saves', async (t) => {
  const { home, env } = mk();
  const srv = spawn(process.execPath, ['app/server.mjs', '0'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { srv.kill(); if (srv.exitCode === null) await once(srv, 'exit'); fs.rmSync(home, { recursive: true, force: true }); });
  const port = await waitForServerReady(srv), base = `http://127.0.0.1:${port}`;
  const r = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<title>[^<]*AgentGlim/i);
  const cfg = (await (await fetch(base + '/api/setup')).json()).config;
  assert.equal(cfg.firstRun, true);
  const save = await fetch(base + '/api/setup', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ ...cfg, budget: { apiDailyUsd: 3 } }) });
  assert.equal(save.status, 200);
  const after = (await (await fetch(base + '/api/setup')).json()).config;
  assert.equal(after.firstRun, false); assert.equal(after.budget.apiDailyUsd, 3); assert.equal(after.setupComplete, true);
  assert.equal((await fetch(base + '/setup')).status, 200);
});
