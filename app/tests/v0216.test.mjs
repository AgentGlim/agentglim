// v0.2.16: portable worker launcher (fixture CLIs, no provider calls), turn-based delivery of dashboard requests,
// first-run doctor, Jev launch lines, and run-mode controls answering "not included" without a mode handler.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { waitForServerReady } from './helpers/server-ready.mjs';
import { parseArgs, buildCommand } from '../../harness/bin/worker-launch.mjs';
import { sendToAgent, sendConfig, pickAdapter } from '../send-to-agent.mjs';
import { register, deliverPending, readState, buildMessage, pending, unregister, MAX_FAILS } from '../turn-delivery.mjs';
import { watcherState } from '../watchers.mjs';
import { emptyModes } from '../empty-fallbacks.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const LAUNCH = path.join(REPO, 'harness/bin/worker-launch.sh');
const tmp = (p = 'ag-v0216-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const hasPy = ['python3', 'python'].some((p) => { try { return spawnSync(p, ['--version'], { stdio: 'ignore' }).status === 0; } catch { return false; } });

// a fake CLI: records argv, cwd and stdin as JSON on stdout; codex also writes its -o file; FAKE_SLEEP makes it hang.
// On Windows it is what npm installs there: <name>.cmd running node on the script, found through PATHEXT and started
// through cmd.exe by app/cli-spawn.mjs (an extensionless script cannot be started on Windows).
function fakeBin(dir, name) {
  const f = path.join(dir, name);
  const win = process.platform === 'win32';
  if (win) fs.writeFileSync(`${f}.cmd`, `@"${process.execPath}" "${f}.js" %*\r\n`);
  fs.writeFileSync(win ? `${f}.js` : f, `#!/usr/bin/env node
const fs = require('fs'); let input = '';
const done = () => {
  const rec = { name: ${JSON.stringify(name)}, argv: process.argv.slice(2), cwd: process.cwd(), stdin: input };
  const o = process.argv.indexOf('-o'); if (o > 0) fs.writeFileSync(process.argv[o + 1], 'LAST:' + input.trim());
  process.stdout.write(JSON.stringify(rec));
  if (process.env.FAKE_SLEEP) setTimeout(() => {}, 1e6); else process.exit(Number(process.env.FAKE_RC || 0));
};
if (fs.fstatSync(0).isCharacterDevice()) done(); else { process.stdin.on('data', (d) => input += d); process.stdin.on('end', done); }
`, { mode: 0o755 });
  return f;
}
function launchEnv(dir, extra = {}) {
  const env = { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, TMPDIR: process.env.TMPDIR, JOBS_TRACK_DIR: path.join(dir, 'jobs'), AGENTGLIM_PROC: path.join(dir, 'noproc'),
    FIXTURE_CRED: 'fixture-cred-value-never-stored', ...extra };
  for (const h of ['codex', 'claude', 'pi', 'opencode']) env[`AGENTGLIM_${h.toUpperCase()}_BIN`] = fakeBin(dir, `fake-${h}`);
  return env;
}
const runLaunch = (env, args) => spawnSync('bash', [LAUNCH, ...args], { env, encoding: 'utf8', timeout: 60e3 });

test('worker-launch: argument checks and per-harness commands (effort, model, prompt routing)', () => {
  assert.throws(() => parseArgs(['gemini', '.', 'p', 'o', '10', 'high']), /harness must be one of/);
  assert.throws(() => parseArgs(['codex', '.', 'p', 'o', 'ten', 'high']), /timeoutSeconds/);
  assert.throws(() => parseArgs(['codex', '.', 'p', 'o']), /usage/);
  assert.throws(() => parseArgs(['codex', '.', 'p', 'o', '10', 'high', '--plan', 'bad']), /NN-slug/);
  const o = (h, more = []) => parseArgs([h, '/w', '/p.md', '/out', '60', 'high', '--model', 'm1', ...more]);
  const env = {};
  const cx = buildCommand(o('codex'), 'PROMPT', env);
  assert.equal(cx.stdin, 'PROMPT'); assert.deepEqual(cx.args.slice(0, 4), ['exec', '--skip-git-repo-check', '-C', path.resolve('/w')]);
  assert.ok(cx.args.includes('model_reasoning_effort=high')); assert.ok(cx.args.includes('-m')); assert.equal(cx.args.at(-1), '-');
  const cl = buildCommand(o('claude'), 'PROMPT', env);
  assert.equal(cl.stdin, 'PROMPT'); assert.ok(cl.args.includes('-p')); assert.deepEqual(cl.args.slice(cl.args.indexOf('--effort'), cl.args.indexOf('--effort') + 2), ['--effort', 'high']);
  const pi = buildCommand(o('pi', ['--', '--provider', 'x']), 'PROMPT', env);
  assert.equal(pi.stdin, null); assert.match(pi.args.at(-1), /^Read the file .*p\.md/); assert.equal(pi.args.at(-2), '--'); assert.ok(!pi.args.includes('PROMPT')); assert.ok(pi.args.includes('--thinking')); assert.ok(pi.args.includes('--provider'));
  const oc = buildCommand(o('opencode'), 'PROMPT', env);
  assert.equal(oc.args[0], 'run'); assert.ok(oc.args.includes('--variant')); assert.equal(oc.args.at(-2), '--'); assert.match(oc.args.at(-1), /^Read the file /);
  assert.equal(buildCommand(o('codex'), 'P', { AGENTGLIM_CODEX_BIN: '/x/codex' }).bin, '/x/codex');
});

for (const h of ['codex', 'claude', 'pi', 'opencode']) {
  test(`worker-launch ${h}: runs the fixture CLI in cwd, writes pid/rc/last.txt/meta, never stores credentials`, () => {
    const dir = tmp(), cwd = path.join(dir, 'work'), out = path.join(dir, 'out'); fs.mkdirSync(cwd);
    const pf = path.join(dir, 'prompt.md'); fs.writeFileSync(pf, `[plan: 07-demo] do the ${h} job\n`);
    const r = runLaunch(launchEnv(dir, { AGENTGLIM_JOBS_TRACK: 'none' }), [h, cwd, pf, out, '30', 'medium', '--model', 'mx', '--label', 'demo job']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(fs.readFileSync(path.join(out, 'rc'), 'utf8').trim(), '0');
    assert.match(fs.readFileSync(path.join(out, 'pid'), 'utf8'), /^\d+\n$/);
    const last = fs.readFileSync(path.join(out, 'last.txt'), 'utf8');
    if (h === 'codex') assert.match(last, /^LAST:\[plan: 07-demo\] do the codex job/);
    else { const rec = JSON.parse(last); assert.equal(fs.realpathSync(rec.cwd), fs.realpathSync(cwd));
      if (h === 'claude') assert.match(rec.stdin, /do the claude job/); else { assert.equal(rec.stdin, ''); assert.equal(rec.argv.at(-2), '--'); assert.equal(rec.argv.at(-1), `Read the file ${pf} and do exactly what it says.`); } }
    const meta = JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8'));
    assert.equal(meta.harness, h); assert.equal(meta.effort, 'medium'); assert.equal(meta.rc, 0); assert.equal(meta.model, 'mx');
    for (const f of fs.readdirSync(out)) assert.doesNotMatch(fs.readFileSync(path.join(out, f), 'utf8'), /fixture-cred-value-never-stored/, `${f} holds a credential`);
    assert.doesNotMatch(JSON.stringify(meta.cmd), /do the .* job/, 'meta.cmd leaves the prompt out');
  });
}

test('worker-launch: timeout kills the worker and records rc 124; a missing CLI is rc 127 with the reason', () => {
  const dir = tmp(), out = path.join(dir, 'out'), pf = path.join(dir, 'p.md'); fs.writeFileSync(pf, 'hang');
  const env = launchEnv(dir, { AGENTGLIM_JOBS_TRACK: 'none', FAKE_SLEEP: '1' });
  const r = runLaunch(env, ['claude', dir, pf, out, '1', 'low']);
  assert.equal(r.status, 124, r.stderr); assert.equal(fs.readFileSync(path.join(out, 'rc'), 'utf8').trim(), '124');
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8')).timedOut, true);
  const r2 = runLaunch({ ...env, AGENTGLIM_PI_BIN: path.join(dir, 'no-such-pi') }, ['pi', dir, pf, path.join(dir, 'o2'), '5', 'low']);
  assert.equal(r2.status, 127); assert.match(fs.readFileSync(path.join(dir, 'o2', 'last.txt'), 'utf8'), /not installed/);
  const r3 = runLaunch(env, ['claude', dir, path.join(dir, 'missing.md'), out, '5', 'low']);
  assert.equal(r3.status, 2); assert.match(r3.stderr, /prompt file not found/);
});

test('worker-launch: --background returns at once and the job still finishes', async () => {
  const dir = tmp(), out = path.join(dir, 'out'), pf = path.join(dir, 'p.md'); fs.writeFileSync(pf, 'bg job');
  const r = runLaunch(launchEnv(dir, { AGENTGLIM_JOBS_TRACK: 'none' }), ['opencode', dir, pf, out, '30', 'low', '--background']);
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).background, true);
  for (let i = 0; i < 100 && !fs.existsSync(path.join(out, 'rc')); i++) await new Promise((res) => setTimeout(res, 100));
  assert.equal(fs.readFileSync(path.join(out, 'rc'), 'utf8').trim(), '0');
});

test('worker-launch: tracked by the shipped jobs-track (running record finished done, plan and launcher kept)', { skip: !hasPy && 'no Python' }, () => {
  const dir = tmp(), out = path.join(dir, 'out'), pf = path.join(dir, 'p.md'); fs.writeFileSync(pf, 'tracked job');
  const env = launchEnv(dir);
  const r = runLaunch(env, ['codex', dir, pf, out, '30', 'high', '--plan', '07-demo', '--label', 'tracked demo']);
  assert.equal(r.status, 0, r.stderr);
  const jobId = JSON.parse(r.stdout.trim().split('\n').pop()).jobId; assert.ok(jobId, r.stdout);
  const rec = JSON.parse(fs.readFileSync(path.join(env.JOBS_TRACK_DIR, `${jobId}.json`), 'utf8'));
  assert.equal(rec.status, 'done'); assert.equal(rec.rc, '0'); assert.equal(rec.harness, 'codex'); assert.equal(rec.project, '07-demo');
  assert.equal(rec.launcher, 'worker-launch'); assert.equal(rec.label, 'tracked demo');
});

test('Jev launch lines call the shipped worker-launch.sh, never the unshipped agent.sh; scaffold links it', () => {
  // harness/jev-routes.json is private (not in public.txt); the export only ships the example.
  for (const f of ['harness/jev-routes.json', 'app/jev-routes.example.json'].filter((f) => f.startsWith('app/') || fs.existsSync(path.join(REPO, f)))) {
    const j = JSON.parse(fs.readFileSync(path.join(REPO, f), 'utf8'));
    const launches = JSON.stringify(j).match(/"launch":"[^"]*"/g) || [];
    assert.ok(launches.length > 5, f);
    for (const l of launches) { assert.doesNotMatch(l, /agent\.sh/, `${f}: ${l}`); if (/bash /.test(l)) assert.match(l, /_run\/bin\/worker-launch\.sh (codex|claude|pi|opencode) <cwd> <promptfile> <outdir> <timeout> \{effort\}/); }
  }
  const scaffold = fs.readFileSync(path.join(REPO, 'tools/scaffold-harness.mjs'), 'utf8');
  assert.match(scaffold, /const tools = HARNESS_TOOLS;/); assert.match(fs.readFileSync(path.join(REPO, 'app/harness-tools.mjs'), 'utf8'), /'worker-launch\.sh', 'worker-launch\.mjs'/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(REPO, 'harness/manifest.json'), 'utf8')).pieces.some((p) => p.id === 'worker-launch'));
  const dir = tmp(), run = path.join(dir, 'run');
  const r = spawnSync(process.execPath, [path.join(REPO, 'tools/scaffold-harness.mjs'), '--run', run], { env: { PATH: process.env.PATH, HOME: dir, AGENTGLIM_DATA: path.join(dir, 'data'), AGENTGLIM_CONFIG: path.join(dir, 'h.json') }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const linked = spawnSync('bash', [path.join(run, 'bin', 'worker-launch.sh'), 'pi', dir, path.join(REPO, 'README.md'), path.join(dir, 'o'), '5', 'low', '--dry-run'], { encoding: 'utf8' });
  assert.equal(linked.status, 0, linked.stderr); assert.equal(JSON.parse(linked.stdout).dryRun, true);
});

test('send-to-agent: pi and opencode resume adapters send once with a closed stdin', async () => {
  assert.equal(pickAdapter({ kind: 'pi', session: 'agentglim-sa' }), 'pi');
  assert.equal(pickAdapter({ kind: 'opencode', session: 'ses_abc123' }), 'opencode');
  for (const [kind, session, want] of [['pi', 'agentglim-sa', ['--session', 'agentglim-sa', '-p']], ['opencode', 'ses_abc123', ['run', '--session', 'ses_abc123']]]) {
    const home = tmp(), calls = [];
    const cfg = sendConfig({ HOME: home }, { data: path.join(home, 'data'), runner: async (cmd, args, input) => { calls.push({ cmd, args, input }); return { code: 0, out: '' }; } });
    const r1 = await sendToAgent({ text: 'hello agent', source: { kind, session } }, cfg);
    const r2 = await sendToAgent({ text: 'hello agent', source: { kind, session } }, cfg);
    assert.equal(r1.state, 'read'); assert.equal(r2.state, 'read'); assert.equal(calls.length, 1, `${kind} sent twice`);
    assert.equal(calls[0].cmd, kind); assert.deepEqual(calls[0].args.slice(0, want.length), want); assert.equal(calls[0].args.at(-2), '--'); assert.equal(calls[0].input, null);
    const ref = /^Read the file (\S+) and do what it says/.exec(calls[0].args.at(-1)); assert.ok(ref, calls[0].args.at(-1)); assert.equal(fs.readFileSync(ref[1], 'utf8'), 'hello agent');
  }
});

function turnFixture() {
  const home = tmp(), data = path.join(home, 'data'), run = path.join(home, 'run');
  for (const d of ['status_ask', 'chat_inbox', 'owner_check', 'heartbeats', 'bin']) fs.mkdirSync(path.join(run, d), { recursive: true });
  return { home, data, run };
}

const codexRollout = (codexHome, sid, cwd, { source = 'cli', ageMs = 0 } = {}) => {
  const d = path.join(codexHome, 'sessions', '2026', '11'); fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, `rollout-2026-11-13T10-00-00-${sid}.jsonl`);
  fs.writeFileSync(f, JSON.stringify({ type: 'session_meta', payload: { id: sid, cwd, source } }) + '\n');
  if (ageMs) fs.utimesSync(f, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
  return f;
};
const answer = (run, key) => { const f = path.join(run, key); fs.renameSync(f, `${f}.answered`); };

test('turn delivery: registered Codex session gets each request once, in its own cwd, armed only after a real answer', async () => {
  const { home, data, run } = turnFixture();
  assert.equal((await deliverPending({ data, run })).state, 'off');
  const codexHome = path.join(home, '.codex'), sid = '0199aaaa-bbbb-4ccc-8ddd-eeeeffff0001', sa = path.join(home, 'sa'); fs.mkdirSync(sa);
  codexRollout(codexHome, sid, sa);
  const rec = register({ data, harness: 'codex', session: 'auto', cwd: sa, env: { HOME: home, CODEX_HOME: codexHome } });
  assert.equal(rec.session, sid); assert.equal(rec.cwd, sa); assert.match(rec.picked.file, new RegExp(sid));
  fs.writeFileSync(path.join(run, 'status_ask', '1763000000000.json'), '{"source":"status-refresh"}');
  fs.writeFileSync(path.join(run, 'chat_inbox', '1763000000001.json'), JSON.stringify({ text: 'Please check plan 07' }));
  const calls = [];
  const cfg = sendConfig({ HOME: home }, { data, run, codexHome, runner: async (cmd, args, input, o) => { calls.push({ cmd, args, input, cwd: o?.cwd }); return { code: 0, out: 'ok' }; } });
  const r = await deliverPending({ data, run, cfg });
  assert.equal(r.state, 'delivered'); assert.deepEqual(r.items, ['status_ask/1763000000000.json', 'chat_inbox/1763000000001.json']);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].args.slice(-3), ['resume', sid, '-']); assert.equal(calls[0].cwd, sa, 'resume runs in the session folder');
  for (const x of ['workspace-write', data, run, 'sandbox_workspace_write.network_access=true']) assert.ok(calls[0].args.includes(x), `codex resume args miss ${x}`);
  assert.match(calls[0].input, /STATUS: 1763000000000\.json/); assert.match(calls[0].input, /status-write\.mjs/);
  assert.match(calls[0].input, /CHAT 1763000000001: Please check plan 07/); assert.match(calls[0].input, /chat-write\.mjs'? --reply "\.\.\." --to 1763000000001/);
  assert.equal((await deliverPending({ data, run, cfg })).state, 'idle', 'already delivered requests are not sent again'); assert.equal(calls.length, 1);
  let w = watcherState({ data, run }); assert.equal(w.armed, false, 'delivered is not answered: not armed yet'); assert.equal(w.turn.verified, false);
  answer(run, 'status_ask/1763000000000.json');
  assert.equal((await deliverPending({ data, run, cfg })).state, 'answered');
  w = watcherState({ data, run }); assert.equal(w.armed, true, 'an answered round trip arms the header'); assert.equal(w.turn.harness, 'codex');
  // the v0.2.15 listener path still wins while it beats
  fs.writeFileSync(path.join(run, 'owner_check', '1763000000002.json'), '{}');
  fs.writeFileSync(path.join(run, 'heartbeats', 'auditq-wait'), '');
  assert.equal((await deliverPending({ data, run, cfg })).state, 'listener');
  fs.utimesSync(path.join(run, 'heartbeats', 'auditq-wait'), new Date(Date.now() - 11 * 60e3), new Date(Date.now() - 11 * 60e3));
  assert.equal((await deliverPending({ data, run, cfg })).state, 'delivered'); assert.match(calls[1].input, /CHECK: 1763000000002\.json/);
  unregister({ data }); assert.equal((await deliverPending({ data, run, cfg })).state, 'off');
});

test('turn delivery: unanswered requests are re-delivered once (new text, so not deduplicated), then marked failed', async () => {
  const { home, data, run } = turnFixture();
  register({ data, harness: 'opencode', session: 'ses_abc123', cwd: home });
  fs.writeFileSync(path.join(run, 'chat_inbox', '1763000000005.json'), JSON.stringify({ text: 'hi' }));
  const calls = [];
  const cfg = sendConfig({ HOME: home }, { data, run, runner: async (cmd, args) => { calls.push(fs.readFileSync(/Read the file (\S+) and/.exec(args.at(-1))[1], 'utf8')); return { code: 0, out: 'I cannot write there' }; } });
  const t0 = Date.now();
  assert.equal((await deliverPending({ data, run, cfg, now: t0 })).state, 'delivered');
  assert.equal((await deliverPending({ data, run, cfg, now: t0 + 5 * 60e3 })).state, 'idle');
  assert.equal((await deliverPending({ data, run, cfg, now: t0 + 11 * 60e3 })).state, 'delivered'); assert.equal(calls.length, 2);
  assert.match(calls[1], /Re-delivery/);
  const r = await deliverPending({ data, run, cfg, now: t0 + 22 * 60e3 });
  assert.equal(r.state, 'unanswered'); assert.equal(calls.length, 2, 'no third delivery');
  assert.equal(readState(data).items['chat_inbox/1763000000005.json'].reason, 'delivered twice, never answered');
  const w = watcherState({ data, run }); assert.equal(w.armed, false); assert.match(w.turn.reason, /no answer/);
});

test('turn delivery: failures back off exponentially and stop after the cap until re-registration; nothing is lost', async () => {
  const { home, data, run } = turnFixture();
  register({ data, harness: 'pi', session: 'agentglim-superagent', cwd: home });
  fs.writeFileSync(path.join(run, 'status_ask', '1763000000000.json'), '{}');
  let code = 1; const calls = [];
  const cfg = sendConfig({ HOME: home }, { data, run, runner: async (cmd, args) => { calls.push(args); return { code, out: 'no session' }; } });
  let t = Date.now();
  const r = await deliverPending({ data, run, cfg, now: t });
  assert.equal(r.state, 'failed'); assert.match(r.reason, /pi resume failed/);
  assert.equal(watcherState({ data, run }).armed, false);
  assert.equal((await deliverPending({ data, run, cfg, now: t + 60e3 })).state, 'waiting');
  const gaps = [];
  for (let i = 2; i <= MAX_FAILS; i++) { const st = readState(data); gaps.push(st.nextAt - t); t = st.nextAt; assert.equal((await deliverPending({ data, run, cfg, now: t })).state, i === MAX_FAILS ? 'stopped' : 'failed'); }
  assert.deepEqual(gaps, [2, 4, 8, 16].map((m) => m * 60e3), 'exponential backoff');
  const n = calls.length;
  assert.equal((await deliverPending({ data, run, cfg, now: t + 864e5 })).state, 'stopped'); assert.equal(calls.length, n, 'stopped: no more paid turns');
  code = 0; register({ data, harness: 'pi', session: 'agentglim-superagent', cwd: home });
  assert.equal((await deliverPending({ data, run, cfg })).state, 'delivered');
  assert.ok(readState(data).items['status_ask/1763000000000.json']);
  assert.throws(() => register({ data, harness: 'pi', session: 'auto' }), /Codex only/);
  assert.throws(() => register({ data, harness: 'cursor', session: 'abcdef' }), /--harness/);
});

test('turn delivery: a backlog over 16 KB goes in bounded batches; long chat text by file reference, untruncated', async () => {
  const { home, data, run } = turnFixture();
  register({ data, harness: 'claude', session: 'sess-fixture-9', cwd: home });
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(run, 'chat_inbox', `176300000001${i}.json`), JSON.stringify({ text: `chat ${i} ` + 'x'.repeat(4000) }));
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(run, 'status_ask', `17630000002${String(i).padStart(2, '0')}.json`), '{}');
  const sent = [];
  const send = async ({ text }) => { sent.push(text); assert.ok(text.length <= 16 * 1024, `message ${text.length} chars`); return { state: 'read' }; };
  for (let i = 0; i < 10; i++) { const r = await deliverPending({ data, run, send }); if (r.state !== 'delivered') break; }
  assert.ok(sent.length >= 1); const all = sent.join('\n');
  for (let i = 0; i < 5; i++) assert.match(all, new RegExp(`CHAT 176300000001${i}: \\(\\d+ characters; read the "text" field of .*176300000001${i}\\.json\\)`));
  for (let i = 0; i < 40; i++) assert.match(all, new RegExp(`17630000002${String(i).padStart(2, '0')}\\.json`));
  assert.equal(Object.keys(readState(data).items).length, 45, 'every request delivered exactly once');
  // a 600-item backlog really splits
  for (let i = 0; i < 150; i++) fs.writeFileSync(path.join(run, 'owner_check', `17630000100${String(i).padStart(2, '0')}.json`), '{}');
  sent.length = 0; for (let i = 0; i < 10; i++) { const r = await deliverPending({ data, run, send }); if (r.state !== 'delivered') break; }
  assert.ok(sent.length > 1, 'more than one batch');
});

test('codex --session auto: matches cwd and refuses ambiguity; workers (exec) never win', () => {
  const home = tmp(), data = path.join(home, 'data'), codexHome = path.join(home, '.codex'), a = path.join(home, 'a'), b = path.join(home, 'b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  const env = { HOME: home, CODEX_HOME: codexHome };
  codexRollout(codexHome, '0199aaaa-bbbb-4ccc-8ddd-000000000001', a, { ageMs: 60e3 });
  codexRollout(codexHome, '0199aaaa-bbbb-4ccc-8ddd-000000000002', b); // newer, other folder
  codexRollout(codexHome, '0199aaaa-bbbb-4ccc-8ddd-000000000003', a, { source: 'exec' }); // newest, a worker
  assert.equal(register({ data, harness: 'codex', session: 'auto', cwd: a, env }).session, '0199aaaa-bbbb-4ccc-8ddd-000000000001');
  assert.throws(() => register({ data, harness: 'codex', session: 'auto', cwd: home, env }), /no interactive Codex session with cwd/);
  codexRollout(codexHome, '0199aaaa-bbbb-4ccc-8ddd-000000000004', a);
  assert.throws(() => register({ data, harness: 'codex', session: 'auto', cwd: a, env }), /2 Codex sessions have cwd/);
  const cli = spawnSync(process.execPath, [path.join(REPO, 'app/turn-delivery.mjs'), 'register', '--harness', 'codex', '--session', 'auto', '--cwd', b], { env: { ...process.env, ...env, AGENTGLIM_DATA: data }, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); const j = JSON.parse(cli.stdout); assert.equal(j.session, '0199aaaa-bbbb-4ccc-8ddd-000000000002'); assert.equal(j.cwd, b); assert.ok(j.picked.file, 'prints the chosen session');
});

test('emptyModes says run modes are not included', () => { assert.equal(emptyModes().notIncluded, true); });

const doctorEnv = (home, extra = {}) => ({ PATH: process.env.PATH, HOME: home, USERPROFILE: home, AGENTGLIM_DATA: path.join(home, 'data'), AGENTGLIM_PLANS: path.join(home, 'plans'),
  AGENTGLIM_CONFIG: path.join(home, 'harness.json'), AGENTGLIM_ENV_FILE: path.join(home, 'env'), ...extra });
// async: the healthy test serves the dashboard fixture from this process, so a sync spawn would block it
const doctor = async (env) => { const c = spawn(process.execPath, [path.join(REPO, 'tools/first-run.mjs'), 'doctor', '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
  const [status] = await once(c, 'close'); return { status, j: JSON.parse(out || '{}'), stderr: err }; };

test('doctor: healthy scaffolded install with a reachable dashboard passes; heartbeat age is a warning', async (t) => {
  const home = tmp(); fs.writeFileSync(path.join(home, 'env'), '');
  const srv = http.createServer((req, res) => { res.writeHead(req.url === '/api/status-ask' ? 200 : 404); res.end('{}'); });
  srv.listen(0, '127.0.0.1'); await once(srv, 'listening'); t.after(() => srv.close());
  const env = doctorEnv(home, { AGENTGLIM_URL: `http://127.0.0.1:${srv.address().port}` });
  assert.equal(spawnSync(process.execPath, [path.join(REPO, 'tools/scaffold-harness.mjs')], { env, encoding: 'utf8' }).status, 0);
  const { status, j } = await doctor(env);
  const by = Object.fromEntries(j.checks.map((c) => [c.id, c]));
  for (const id of ['data-write', 'heartbeat-write', 'run-write', 'localhost', 'tool-links']) assert.equal(by[id].ok, true, `${id}: ${by[id].detail}`);
  assert.equal(by['superagent-heartbeat'].warn, true); assert.match(by['superagent-heartbeat'].fix, /touch .*heartbeats[\\/]superagent/);
  assert.equal(status, 0); assert.equal(j.ok, true);
});

test('doctor: blocked data folder, dashboard down and missing links print exact fixes', { skip: process.getuid?.() === 0 && 'root ignores modes' }, async () => {
  const home = tmp(); fs.writeFileSync(path.join(home, 'env'), '');
  const data = path.join(home, 'data'); fs.mkdirSync(data); fs.chmodSync(data, 0o500);
  try {
    const srv = spawnSync(process.execPath, ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();})"], { encoding: 'utf8' });
    const { status, j } = await doctor(doctorEnv(home, { AGENTGLIM_URL: `http://127.0.0.1:${srv.stdout.trim()}` }));
    const by = Object.fromEntries(j.checks.map((c) => [c.id, c]));
    assert.equal(status, 1); assert.equal(j.ok, false);
    // Windows has no POSIX folder modes: chmod 0500 does not stop a write there, so only the other checks fail
    if (process.platform !== 'win32') { assert.equal(by['data-write'].ok, false); assert.match(by['data-write'].fix, /codex --add-dir .*data/); assert.match(by['data-write'].fix, /claude --add-dir/); }
    assert.equal(by.localhost.ok, false); assert.match(by.localhost.detail, /ECONNREFUSED/); assert.match(by.localhost.fix, /start the dashboard: node .*server\.mjs/);
    assert.equal(by['tool-links'].ok, false); assert.match(by['tool-links'].fix, /npm run scaffold-harness/);
  } finally { fs.chmodSync(data, 0o700); }
});

test('server: mode clicks without a mode handler answer 501 "not included" instead of a 500', async (t) => {
  const home = tmp(); fs.writeFileSync(path.join(home, 'env'), '');
  const env = { ...doctorEnv(home), XDG_CONFIG_HOME: path.join(home, '.config'), AGENTGLIM_DEV: '1', AGENTGLIM_DEV_WRITES: '1' };
  const srv = spawn(process.execPath, ['app/server.mjs', '0'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { srv.kill(); if (srv.exitCode === null) await once(srv, 'exit'); });
  const base = `http://127.0.0.1:${await waitForServerReady(srv)}`;
  const modes = await (await fetch(base + '/api/modes')).json(); assert.equal(modes.notIncluded, true);
  const r = await fetch(base + '/api/mode', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ key: 'reaper', value: 'on' }) });
  assert.equal(r.status, 501); const b = await r.json(); assert.equal(b.notIncluded, true); assert.match(b.msg, /not included/);
});

// v0.2.15 VM-test follow-ups
const runAsync = async (args, env) => { const c = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
  const [status] = await once(c, 'close'); return { status, out, err }; };

test('status-write --help prints usage and writes nothing', async () => {
  const home = tmp(); fs.writeFileSync(path.join(home, 'env'), '');
  const env = doctorEnv(home);
  const r = await runAsync([path.join(REPO, 'harness/bin/status-write.mjs'), '--help'], env);
  assert.equal(r.status, 0); assert.match(r.out, /usage: node status-write\.mjs/);
  assert.equal(fs.existsSync(path.join(env.AGENTGLIM_DATA, 'status.json')), false);
});

test('status-write finds a dashboard on a non-default port via server-url.json, and warns when none answers', async (t) => {
  const home = tmp(); fs.writeFileSync(path.join(home, 'env'), '');
  const env = doctorEnv(home); fs.mkdirSync(env.AGENTGLIM_DATA, { recursive: true });
  let hits = 0;
  const srv = http.createServer((req, res) => { if (req.url === '/api/snapshot') hits++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ projects: [{ dir: '07-demo', active: true }] })); });
  srv.listen(0, '127.0.0.1'); await once(srv, 'listening'); t.after(() => srv.close());
  fs.writeFileSync(path.join(env.AGENTGLIM_DATA, 'server-url.json'), JSON.stringify({ url: `http://127.0.0.1:${srv.address().port}`, pid: process.pid }));
  const r = await runAsync([path.join(REPO, 'harness/bin/status-write.mjs'), '--done', 'x', '--running', 'y', '--blocked', 'none', '--next', 'z'], env);
  assert.equal(r.status, 0, r.err); assert.equal(hits, 1); assert.doesNotMatch(r.err, /did not answer/);
  fs.writeFileSync(path.join(env.AGENTGLIM_DATA, 'server-url.json'), JSON.stringify({ url: 'http://127.0.0.1:1', pid: process.pid }));
  const r2 = await runAsync([path.join(REPO, 'harness/bin/status-write.mjs'), '--done', 'x', '--running', 'y', '--blocked', 'none', '--next', 'z'], env);
  assert.match(r2.err, /did not answer at http:\/\/127\.0\.0\.1:1\/api\/snapshot.*AGENTGLIM_URL/s);
});

test('scaffold: a run/bin that is a file is reported once, naming the folder', () => {
  const dir = tmp(), run = path.join(dir, 'run'); fs.mkdirSync(run); fs.writeFileSync(path.join(run, 'bin'), 'not a folder');
  const r = spawnSync(process.execPath, [path.join(REPO, 'tools/scaffold-harness.mjs'), '--run', run], { env: { PATH: process.env.PATH, HOME: dir, AGENTGLIM_DATA: path.join(dir, 'data'), AGENTGLIM_CONFIG: path.join(dir, 'h.json') }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  // the cause is named once: ENOTDIR on POSIX, ENOENT on Windows (a path through a file)
  assert.equal((r.stderr.match(/ENOTDIR|ENOENT/g) || []).length, 1, r.stderr); assert.match(r.stderr, /is not a folder/);
});

test('header omits "run started" when no run has started; README and SETUP agree on node app/server.mjs', () => {
  const html = fs.readFileSync(path.join(REPO, 'app/index.html'), 'utf8');
  assert.match(html, /\$\{s\.started \? ` · run started \$\{s\.started\}` : ''\}/);
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /cd app\nnode server\.mjs/); assert.match(readme, /node app\/server\.mjs/);
});

// Upgrade cleanup: a v0.2.13/v0.2.14 install keeps a queued "goals-weekly-review skill (scheduled)" chat that prints
// before Refresh. Unanswered goals-app scheduled chats whose skill is missing move to chat_inbox/_archive (never deleted).
const STALE = 'Run the weekly goals review with the goals-weekly-review skill (scheduled). Refresh the goals data first, then record the outcome as JSON in the goals folder.';
function seedInbox(run) {
  const inbox = path.join(run, 'chat_inbox');
  fs.mkdirSync(inbox, { recursive: true });
  const put = (id, body, ...marks) => { fs.writeFileSync(path.join(inbox, `${id}.json`), JSON.stringify(body)); for (const m of marks) fs.writeFileSync(path.join(inbox, `${id}.json.${m}`), ''); };
  put('1763000000001', { from: 'goals-app', text: STALE }, 'resent');            // stale: archived with its mark
  put('1763000000002', { from: 'goals-app', text: STALE }, 'answered');          // answered: left alone
  put('1763000000003', { from: 'goals-app', text: STALE.replace('(scheduled)', '(owner)') }); // manual request: left alone
  put('1763000000004', { from: 'owner', text: STALE });                            // not goals-app: left alone
  put('1763000000005', { from: 'goals-app', text: 'Incident: refresh failed' });  // incident: left alone
  return inbox;
}

test('archiveStaleScheduledChats moves only unanswered scheduled chats whose skill is missing', async () => {
  const { archiveStaleScheduledChats } = await import('../goals-report.mjs');
  const run = tmp(); const inbox = seedInbox(run);
  assert.deepEqual(archiveStaleScheduledChats({ run, skills: [{ name: 'goals-weekly-review' }] }).archived, [], 'installed skill: kept');
  const r = archiveStaleScheduledChats({ run, skills: [] });
  assert.deepEqual(r.archived, [{ id: '1763000000001', skill: 'goals-weekly-review' }]);
  assert.deepEqual(fs.readdirSync(path.join(inbox, '_archive')).sort(), ['1763000000001.json', '1763000000001.json.resent']);
  for (const id of [2, 3, 4, 5]) assert.ok(fs.existsSync(path.join(inbox, `176300000000${id}.json`)));
  assert.equal(pending(run).some((p) => p.name === '1763000000001.json'), false, 'no longer delivered');
  assert.deepEqual(archiveStaleScheduledChats({ run, skills: [] }).archived, [], 'idempotent');
  assert.deepEqual(archiveStaleScheduledChats({ run: tmp(), skills: [] }).archived, [], 'no inbox is fine');
});

test('npm run update archives the stale scheduled chat from a v0.2.13 install', (t) => {
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('git is not available here');
  const root = tmp('ag-v0216-upd-');
  const genv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-global') };
  const g = (cwd, ...args) => { const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=test', '-c', 'commit.gpgsign=false', ...args], { cwd, env: genv, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  const src = path.join(root, 'src');
  fs.cpSync(path.join(REPO, 'app'), path.join(src, 'app'), { recursive: true, filter: (p) => !/[/\\](tests|node_modules)([/\\]|$)/.test(p) });
  for (const d of ['tools', 'harness', 'skills']) fs.cpSync(path.join(REPO, d), path.join(src, d), { recursive: true, filter: (p) => !/node_modules/.test(p) });
  g(src, 'init', '-q', '-b', 'main'); g(src, 'add', '-A'); g(src, 'commit', '-qm', 'base');
  const clone = path.join(root, 'clone'); g(root, 'clone', '-q', '--branch', 'main', src, clone);
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const run = path.join(root, 'run'); const inbox = seedInbox(run);
  const env = { ...genv, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), AGENTGLIM_DATA: path.join(home, 'data'), AGENTGLIM_PLANS: path.join(home, 'plans'), AGENTGLIM_RUN: run, AGENTGLIM_CONFIG: path.join(home, 'harness.json'), AGENTGLIM_ENV_FILE: path.join(home, 'env') };
  fs.writeFileSync(env.AGENTGLIM_CONFIG, '{}'); fs.writeFileSync(env.AGENTGLIM_ENV_FILE, '');
  let r = spawnSync(process.execPath, [path.join(clone, 'tools', 'update.mjs'), '--dry-run'], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(fs.existsSync(path.join(inbox, '1763000000001.json')), 'dry run moves nothing');
  r = spawnSync(process.execPath, [path.join(clone, 'tools', 'update.mjs')], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /archived 1 stale scheduled chat/);
  assert.ok(fs.existsSync(path.join(inbox, '_archive', '1763000000001.json')));
  assert.ok(!fs.existsSync(path.join(inbox, '1763000000001.json')));
  assert.ok(fs.existsSync(path.join(inbox, '1763000000002.json')));
});

test('server start runs the stale scheduled chat cleanup outside dev mode', () => {
  const src = fs.readFileSync(path.join(REPO, 'app/server.mjs'), 'utf8');
  assert.match(src, /if \(!DEV \|\| DEV_WRITES\) try \{ const a = archiveStaleScheduledChats\(\);/);
});
