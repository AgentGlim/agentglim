// Tests for the SuperAgent inbox resend job. Temp dirs only: no harness inbox, no live session, no port 18990.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BACKOFF_MS, DEFAULT_RESEND_SECS, buildNudge, dueState, makeInboxResend, nextDueAt,
  readResent, registerSession, resendConfig, scanInbox, scanResent, validateSession,
} from '../inbox-resend.mjs';
import { createScheduler } from '../scheduler.mjs';

const MIN = 60e3;
const AT = Date.parse('2026-11-12T12:00:00.000Z');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-inbox-resend-'));
  const plans = path.join(home, 'plans'), run = path.join(plans, '_run'), data = path.join(home, 'data');
  const inbox = path.join(run, 'chat_inbox');
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = { home, plans, run, data, inbox };
  const message = (id, at = AT, extra = {}) => {
    const file = path.join(inbox, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ at: new Date(at).toISOString(), from: 'control', text: 'Please check the build', ...extra }) + '\n');
    fs.utimesSync(file, at / 1000, at / 1000);
    return file;
  };
  return { ...paths, message };
}

function fakes(plans) {
  const pastes = [];
  const proc = {
    stat: (pid) => (Number(pid) === 4242 ? { pid: 4242, ppid: 1, comm: 'claude', starttime: 777 } : null),
    cwd: (pid) => (Number(pid) === 4242 ? plans : null),
    isAncestor: (a, b) => Number(a) === 4242 && Number(b) === 4242,
  };
  const tmux = {
    listPanes: async () => [{ id: '%5', pid: 4242, cmd: 'claude' }],
    paste: async (pane, text) => { pastes.push({ pane, text }); },
  };
  const session = { pid: 4242, procStart: '777', sessionId: 'session-test', name: 'plans-test', cwd: plans, tmux: '1:@1.%5', at: new Date(AT).toISOString() };
  return { proc, tmux, pastes, session };
}

function instance(f, over = {}) {
  const clock = { t: AT };
  const cfg = {
    inbox: f.inbox, sessionFile: path.join(f.data, 'inbox-session.json'), lockFile: path.join(f.data, 'inbox-resend.lock'),
    plans: f.plans, run: f.run, data: f.data, thresholdMs: DEFAULT_RESEND_SECS * 1000, maxAgeMs: 24 * 3600e3,
    backoffMs: BACKOFF_MS, enabled: true, tmux: true, dev: false,
  };
  const job = makeInboxResend({ env: {}, config: { ...cfg, ...over.config }, now: () => clock.t, proc: over.proc, tmux: over.tmux, session: over.session });
  return { job, clock, cfg: job.config };
}

test('config: 120 s default, 2/5/15/30 min backoff, env overrides and off switch', () => {
  const d = resendConfig({}, { plans: '/tmp/p', run: '/tmp/p/_run', data: '/tmp/d' });
  assert.equal(d.thresholdMs, 120000);
  assert.deepEqual(d.backoffMs, [2 * MIN, 5 * MIN, 15 * MIN, 30 * MIN]);
  assert.equal(d.inbox, path.join('/tmp/p/_run', 'chat_inbox'));
  assert.equal(d.enabled, true);
  assert.equal(d.dev, false);
  const e = resendConfig({ AGENTGLIM_INBOX_RESEND_SECS: '45', AGENTGLIM_INBOX_RESEND: 'off', AGENTGLIM_INBOX_RESEND_TMUX: '0', AGENTGLIM_INBOX_RESEND_MAX_HOURS: '6' }, { plans: '/tmp/p', run: '/tmp/p/_run', data: '/tmp/d' });
  assert.equal(e.thresholdMs, 45000);
  assert.equal(e.enabled, false);
  assert.equal(e.tmux, false);
  assert.equal(e.maxAgeMs, 6 * 3600e3);
});

test('only pending <ms>.json messages count; answered, accepted, temp and odd names are ignored', (t) => {
  const f = fixture(t);
  f.message('1794521154658');
  f.message('1794521154659');
  fs.writeFileSync(path.join(f.inbox, '1794521154659.json.answered'), '{}');
  fs.writeFileSync(path.join(f.inbox, '1794521154660.json.accepted'), '{}');
  fs.writeFileSync(path.join(f.inbox, '.1794521154661.json.tmp'), '{}');
  fs.writeFileSync(path.join(f.inbox, 'not-a-message.json'), '{}');
  fs.writeFileSync(path.join(f.inbox, '1794521154662.json'), 'not json');
  const scan = scanInbox(f.inbox);
  assert.equal(scan.exists, true);
  assert.deepEqual(scan.messages.map((m) => m.id).sort(), ['1794521154658', '1794521154662']);
  assert.equal(scanInbox(path.join(f.home, 'missing')).exists, false);
});

test('first resend at the threshold, then 2, 5, 15 and 30 min apart', (t) => {
  const f = fixture(t);
  f.message('1794521154658', AT);
  const msg = () => scanInbox(f.inbox).messages[0];
  const cfg = resendConfig({}, { plans: f.plans, run: f.run, data: f.data });
  const at = (ms) => new Date(AT + ms).toISOString();
  cfg.backoffMs = BACKOFF_MS;

  assert.equal(dueState(msg(), cfg, AT + 119e3).due, false);
  assert.equal(dueState(msg(), cfg, AT + 120e3).due, true);

  const withCount = (count, last) => ({ ...msg(), resent: count ? { count, at: at(last) } : null });
  assert.equal(nextDueAt(withCount(1, 130e3), cfg), AT + 130e3 + 2 * MIN);
  assert.equal(nextDueAt(withCount(2, 300e3), cfg), AT + 300e3 + 5 * MIN);
  assert.equal(nextDueAt(withCount(3, 1e6), cfg), AT + 1e6 + 15 * MIN);
  assert.equal(nextDueAt(withCount(4, 2e6), cfg), AT + 2e6 + 30 * MIN);
  assert.equal(nextDueAt(withCount(9, 3e6), cfg), AT + 3e6 + 30 * MIN, 'backoff caps at 30 min');
});

test('a due message gets one wake touch and one nudge; a second check right away does nothing', async (t) => {
  const f = fixture(t);
  const file = f.message('1794521154658', AT - 121e3);
  const before = fs.statSync(file).mtimeMs;
  const { proc, tmux, pastes, session } = fakes(f.plans);
  const { job, clock } = instance(f, { proc, tmux, session });

  const first = await job.runOnce();
  assert.equal(first.ran, true);
  assert.equal(first.resends.length, 1);
  assert.equal(first.resends[0].count, 1);
  assert.match(first.resends[0].reason, /^auto-resent: unanswered after \d+s$/);
  assert.equal(first.resends[0].via, 'wake+tmux');
  assert.ok(fs.statSync(file).mtimeMs > before, 'the wake file was touched');
  assert.equal(pastes.length, 1);
  assert.equal(pastes[0].pane, '%5');
  assert.match(pastes[0].text, /1794521154658/);
  assert.match(pastes[0].text, /same message, not new work/i);

  const mark = readResent(`${file}.resent`);
  assert.equal(mark.count, 1);
  assert.equal(mark.delivered, true);
  assert.ok(mark.at);
  assert.match(mark.reason, /unanswered after 121s/);

  const again = await job.runOnce();
  assert.equal(again.ran, false);
  assert.equal(again.reason, 'nothing due');
  assert.equal(readResent(`${file}.resent`).count, 1);
  assert.equal(pastes.length, 1);

  clock.t += 2 * MIN; // interval after resend #1
  const second = await job.runOnce();
  assert.equal(second.ran, true);
  assert.equal(second.resends[0].count, 2);
  assert.match(pastes[1].text, /resend 2/);
  assert.equal(readResent(`${file}.resent`).count, 2);
});

test('answered messages are never resent, and status counts pending resends plus the last resend', async (t) => {
  const f = fixture(t);
  const file = f.message('1794521154658', AT - 121e3);
  const { proc, tmux, session } = fakes(f.plans);
  const { job } = instance(f, { proc, tmux, session });
  await job.runOnce();
  const st1 = job.status({ fresh: true });
  assert.equal(st1.pending, 1);
  assert.equal(st1.pendingResends, 1);
  assert.equal(st1.recentResends, 1);
  assert.ok(st1.lastAt > 0);
  assert.equal(st1.lastId, 1794521154658);

  fs.renameSync(file, `${file}.answered`);
  const res = await job.runOnce();
  assert.equal(res.ran, false);
  assert.equal(res.pending, 0);
  assert.equal(res.reason === 'no chat_inbox', false);
  const st2 = job.status({ fresh: true });
  assert.equal(st2.pending, 0);
  assert.equal(st2.pendingResends, 0);
  assert.equal(st2.recentResends, 1, 'the resend mark survives the answer for the "last resend" line');
  assert.equal(st2.lastAt, st1.lastAt);
});

test('a message older than the max age is marked stale and no longer resent', async (t) => {
  const f = fixture(t);
  const file = f.message('1794521154658', AT - 25 * 3600e3);
  const { proc, tmux, pastes, session } = fakes(f.plans);
  const { job } = instance(f, { proc, tmux, session });
  const r = await job.runOnce();
  assert.equal(r.ran, false);
  assert.equal(fs.existsSync(`${file}.resent`), false);
  assert.equal(pastes.length, 0);
  const st = job.status({ fresh: true });
  assert.equal(st.messages[0].stale, true);
  assert.equal(st.messages[0].due, false);
});

test('without a registered session the wake file is still touched, with no keystroke', async (t) => {
  const f = fixture(t);
  const file = f.message('1794521154658', AT - 121e3);
  const { proc, tmux, pastes } = fakes(f.plans);
  const { job } = instance(f, { proc, tmux, session: null });
  const r = await job.runOnce();
  assert.equal(r.resends[0].count, 1);
  assert.equal(r.resends[0].via, 'wake');
  assert.equal(r.resends[0].error, null);
  assert.equal(pastes.length, 0);
  assert.ok(fs.existsSync(`${file}.resent`));
  const st = job.status({ fresh: true });
  assert.equal(st.identity.ok, false);
  assert.match(st.identity.reason, /no session registered/);
});

test('a reused pid, outside cwd or another pane gets no keystroke; the reason is recorded', async (t) => {
  const ids = { reused: '1794521154658', outside: '1794521154659', pane: '1794521154660' };
  for (const kind of ['reused', 'outside', 'pane']) {
    const f = fixture(t);
    f.message(ids[kind], AT - 121e3);
    const { proc, tmux, pastes, session } = fakes(f.plans);
    let over;
    if (kind === 'reused') over = { proc, tmux, session: { ...session, procStart: '999' } };
    else if (kind === 'outside') over = { proc: { ...proc, cwd: () => '/tmp/elsewhere' }, tmux, session };
    else over = { proc, tmux: { listPanes: async () => [{ id: '%9', pid: 999, cmd: 'bash' }], paste: async () => { pastes.push('bad'); } }, session };
    const { job } = instance(f, over);
    const r = await job.runOnce();
    assert.equal(r.resends.length, 1, kind);
    assert.equal(r.resends[0].via, 'wake', kind);
    const match = kind === 'reused' ? /pid was reused/ : kind === 'outside' ? /not in the plans folder/ : /recorded tmux pane is gone/;
    assert.match(r.resends[0].error, match, kind);
    assert.match(readResent(path.join(f.inbox, `${ids[kind]}.json.resent`)).error, match, kind);
    assert.equal(pastes.length, 0, kind);
  }
});

test('tmux nudges can be turned off while wake touches continue', async (t) => {
  const f = fixture(t);
  f.message('1794521154658', AT - 121e3);
  const { proc, tmux, pastes, session } = fakes(f.plans);
  const { job } = instance(f, { proc, tmux, session, config: { tmux: false } });
  const r = await job.runOnce();
  assert.equal(r.resends[0].via, 'wake');
  assert.equal(pastes.length, 0);
});

test('dev copy and the off switch never write or send', async (t) => {
  const f = fixture(t);
  const file = f.message('1794521154658', AT - 121e3);
  const { proc, tmux, pastes, session } = fakes(f.plans);
  for (const config of [{ dev: true }, { enabled: false }]) {
    const { job } = instance(f, { proc, tmux, session, config });
    const r = await job.runOnce();
    assert.equal(r.ran, false);
    assert.equal(fs.existsSync(`${file}.resent`), false);
  }
  assert.equal(pastes.length, 0);
});

test('a fresh check lock blocks a second process; a stale lock is cleared', async (t) => {
  const f = fixture(t);
  const file = f.message('1794521154658', AT - 121e3);
  const { proc, tmux, session } = fakes(f.plans);
  const { job, clock } = instance(f, { proc, tmux, session });
  fs.writeFileSync(job.config.lockFile, '{}');
  const r1 = await job.runOnce();
  assert.equal(r1.locked, true);
  assert.equal(fs.existsSync(`${file}.resent`), false);

  const old = (clock.t - 10 * MIN) / 1000;
  fs.utimesSync(job.config.lockFile, old, old);
  const r2 = await job.runOnce();
  assert.equal(r2.ran, true);
  assert.equal(fs.existsSync(job.config.lockFile), false, 'the lock is released after the run');
});

test('status reports the next due time and the configured numbers, without message text', (t) => {
  const f = fixture(t);
  f.message('1794521154658', AT - 60e3, { text: 'private text must not reach the status line' });
  const { proc, tmux, session } = fakes(f.plans);
  const { job } = instance(f, { proc, tmux, session });
  const st = job.status({ fresh: true });
  assert.equal(st.thresholdSecs, 120);
  assert.deepEqual(st.backoffMinutes, [2, 5, 15, 30]);
  assert.equal(st.messages[0].dueInSec, 60);
  assert.equal(st.identity.ok, true);
  assert.ok(!JSON.stringify(st).includes('private text'), 'message text is never copied into status');
});

test('register writes the headed session identity from Claude\'s own registry, never a guessed session', (t) => {
  const f = fixture(t);
  const claudeHome = path.join(f.home, 'claude');
  fs.mkdirSync(path.join(claudeHome, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'sessions/4242.json'), JSON.stringify({ pid: 4242, sessionId: 'abc', cwd: f.plans, kind: 'interactive', tmux: '1:@1.%5', name: 'plans-53' }));
  const { proc } = fakes(f.plans);
  const roots = { plans: f.plans, run: f.run, data: f.data };
  const r = registerSession({ pid: 4242, env: {}, roots, proc, claudeHome });
  assert.equal(r.ok, true);
  const saved = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.equal(saved.pid, 4242);
  assert.equal(saved.procStart, '777');
  assert.equal(saved.tmux, '1:@1.%5');
  assert.equal((fs.statSync(r.file).mode & 0o777), 0o600);
  assert.equal(validateSession(saved, { proc, plans: f.plans }).ok, true);

  const other = registerSession({ pid: 9001, env: {}, roots, proc, claudeHome });
  assert.equal(other.ok, false);
  const outside = { ...saved, cwd: '/tmp/elsewhere' };
  assert.match(validateSession(outside, { proc: { ...proc, cwd: () => '/tmp/elsewhere' }, plans: f.plans }).reason, /not in the plans folder/);
  fs.writeFileSync(path.join(claudeHome, 'sessions/4243.json'), JSON.stringify({ pid: 4243, cwd: f.plans, kind: 'headless' }));
  const headless = registerSession({ pid: 4243, env: {}, roots, proc: { ...proc, stat: () => ({ starttime: 1 }) }, claudeHome });
  assert.match(headless.error, /not interactive/);
});

test('the nudge says it is the same message and gives the next interval', (t) => {
  const f = fixture(t);
  const msg = { id: '1794521154658', at: AT, resent: null };
  const cfg = resendConfig({}, { plans: f.plans, run: f.run, data: f.data });
  const text = buildNudge(msg, 3, cfg);
  assert.match(text, /1794521154658/);
  assert.match(text, /resend 3/);
  assert.match(text, /_run\/chat_inbox\/1794521154658\.json/);
  assert.match(text, /chat-write\.mjs --reply/);
  assert.match(text, /same message, not new work/i);
  assert.match(text, /Next resend in 15 min/);
});

test('the scheduler stub keeps one timer per job, records errors and supports runNow', async () => {
  const timers = [];
  let clock = 1000, next = 1;
  const s = createScheduler({ now: () => clock, setTimeoutFn: (fn, ms) => { timers.push({ fn, at: clock + ms, id: next }); return next++; }, clearTimeoutFn: () => {} });
  let runs = 0;
  s.register('inbox-resend', 30e3, async () => { runs++; return 'ok'; });
  assert.equal(s.status().started, false);
  s.start();
  assert.equal(s.status().jobs[0].nextRun, clock + 30e3);
  clock += 30e3;
  await timers[0].fn();
  assert.equal(runs, 1);
  assert.equal(s.status().jobs[0].lastRun, clock);
  assert.equal(await s.runNow('inbox-resend'), 'ok');
  assert.equal(runs, 2);
  s.register('bad', 1000, async () => { throw new Error('boom'); });
  await s.runNow('bad');
  assert.equal(s.status().jobs[1].failures, 1);
  assert.match(s.status().jobs[1].lastError, /boom/);
  s.stop();
  assert.equal(s.status().started, false);
});
